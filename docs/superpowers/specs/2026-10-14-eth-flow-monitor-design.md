# ETH Flow Monitor prototype: design

Date: 2026-10-14. Source of requirements: the ETH Flow Monitor PRD (Claude Doc), with requirement IDs F1–F11.

## Goal

This is a demo-ready MVP running on Sepolia. Glamsterdam went live there on 2026-10-06. The prototype has three jobs:

- Stream every native ETH transfer by reading EIP-7708 logs.
- Flag transfers that touch a watched address or an address on the OFAC sanctions list.
- Let an analyst review the resulting alerts in a local web dashboard.

It runs as a single-user local app started with `npm start`.

Verified on 2026-10-14: the public endpoint `https://ethereum-sepolia-rpc.publicnode.com` returns 7708 logs for `eth_getLogs` filtered to address `0xfffffffffffffffffffffffffffffffffffffffe`.

## Stack

- Node 24 and TypeScript, run with `tsx`. There is no separate build step.
- `viem` for RPC calls and ABI and address helpers.
- `node:sqlite`, Node's built-in SQLite, so nothing native has to compile.
- `fastify` for the HTTP server, with SSE for live updates.
- The dashboard is static HTML, CSS and JavaScript served from `public/`.
- `vitest` for tests.

## Components (`src/`)

| File | Purpose | Depends on |
|---|---|---|
| `config.ts` | Reads `.env`: `RPC_URL`, `POLL_MS` (default 2000), `START_BLOCK` (default: latest), `WEBHOOK_URL` (optional), `PORT` (default 3000), `DB_PATH`. | none |
| `db.ts` | Opens SQLite, creates the schema, and holds typed query helpers. | `config` |
| `decode.ts` | `decodeTransferLog(log)` returns `{from, to, valueWei, txHash, blockNumber, blockHash, logIndex, timestamp}`, or `null` if the log does not come from the system address or does not use the Transfer topic. | `viem` |
| `classify.ts` | `classify(transfers, tx)` marks each transfer as `top-level` or `internal`. A transfer is `top-level` only if it is the first 7708 log in its transaction, `tx.value > 0`, `tx.to != tx.from`, and its from, to and value equal the transaction's. All other transfers are `internal`. | none |
| `sanctions.ts` | Loads `data/ofac_sdn_eth_addresses.csv` and `data/mock_sanctions.csv` into a lowercase address map and computes a list version (sha256 of the file contents plus the load date). `refreshFromOfac()` downloads `SDN.CSV` and pulls out the `Digital Currency Address - ETH` fields. It runs at startup if the file is more than 24 hours old, then every 24 hours. A failed refresh keeps the last good list and logs a warning. | `db` |
| `screen.ts` | `screen(transfer)` returns the matches. A sanctions match is either side on the list. A watchlist match is either side watched and the value at or above that entry's `minWei`. | `sanctions`, `db` |
| `ingest.ts` | The polling loop. See Data flow. | `decode`, `classify`, `screen`, `alerts`, `db` |
| `alerts.ts` | Creates alert rows, publishes them to the SSE bus, POSTs JSON to `WEBHOOK_URL` if it is set (with a 5 s timeout, and failures are logged without retry), and logs an email stub line. | `db` |
| `server.ts` | Fastify routes (see API) and the static `public/` folder. | everything |
| `index.ts` | Entry point that starts the sanctions load, the ingestor and the server. | everything |

## Data model (SQLite)

- `transfers(id, block_number, block_hash, tx_hash, log_index, from_addr, to_addr, value_wei TEXT, kind, timestamp)`, unique on `(tx_hash, log_index)`.
- `blocks(number PRIMARY KEY, hash, parent_hash)` keeps the last 64 blocks, for reorg detection.
- `watchlist(address PRIMARY KEY, label, min_wei TEXT DEFAULT '0', created_at)`.
- `alerts(id, transfer_id, reason ('sanctions'|'watchlist'), matched_address, matched_entry, list_version, status ('open'|'reviewed'|'escalated'|'false_positive'), note, created_at, updated_at)`.
- `state(key PRIMARY KEY, value)` stores `last_block`.

## Data flow (each poll)

1. Read the head block number. Process blocks from `last_block + 1` up to the head, at most 20 per poll.
2. For each block:
   1. Fetch the block header.
   2. If its `parentHash` does not equal the stored hash of block `n-1`, there is a reorg. Walk back until the hashes agree, delete the transfers and alerts in the replaced blocks, and set `last_block` to the common ancestor.
   3. Call `eth_getLogs` for that block, filtered to the system address and the Transfer topic.
   4. Group the logs by transaction and fetch each transaction to classify its transfers.
   5. Insert the transfers, then screen each one and create alerts.
   6. Store the block hash, then advance `last_block`.
3. Push new transfers and alerts to SSE subscribers.

An RPC error stops processing for that poll and retries on the next tick, so no block is skipped.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/transfers?address=&min=&from=&to=&limit=` | Search transfers. |
| `GET /api/transfers.csv?...` | Export transfers as CSV (F9). |
| `GET /api/alerts?status=` | List alerts. |
| `PATCH /api/alerts/:id` | Set `{status, note}` (F8). |
| `GET/POST/DELETE /api/watchlist` | Manage watched addresses. `POST /api/watchlist/upload` accepts CSV with columns `address,label,min_eth` (F4). |
| `GET /api/sanctions` | List size, version and last refresh time. |
| `GET /api/stats` | Numbers for the dashboard tiles. |
| `GET /api/inspect/:txHash` | Tx inspector (F10): the receipt's logs split into "visible before 7708" (non-system logs) and "7708 Transfer logs". |
| `GET /api/stream` | SSE events: `transfer` and `alert`. |

## Dashboard (`public/`)

The layout follows the PRD wireframe: a top bar, a left nav, and these views:

- **Alerts:** tiles, the queue and a detail panel with the Escalate, Mark reviewed, False positive and Export CSV actions.
- **Live feed**
- **Watchlist:** add, remove and CSV upload.
- **Sanctions list:** version and size.
- **Tx inspector**

Severity is always shown as text, not only colour. The dashboard is keyboard-navigable.

## Demo script (`scripts/demo-internal-transfer.ts`)

The script deploys a minimal `Forwarder` contract whose `forward(address to)` call passes on `msg.value`. It then calls the contract, which produces one top-level transfer (wallet to contract) and one internal transfer (contract to recipient). It finishes by printing the tx hash for the inspector.

The wallet key comes from `DEMO_PRIVATE_KEY` in `.env`, which the user fills in. The contract bytecode is precompiled and committed, so no Solidity toolchain is needed.

For the live sanctions demo, the user puts the recipient address in `data/mock_sanctions.csv`. No ETH is ever sent to a real SDN address.

## Testing

- **Unit tests:**
  - `decode` with a real Sepolia log fixture, a non-system emitter and the wrong topic
  - `classify` for a plain send, a contract forward, and a zero-value transaction with internal transfers
  - `screen` for sanctions and watchlist matches, the minimum-amount threshold, and case-insensitive addresses
  - reorg rollback against an in-memory database
- **Replay test:** synthetic transfers to and from each of the 15 addresses in `data/demo_screening_set.csv` must produce 15 sanctions alerts (100% recall).
- **Smoke test:** `npm run smoke` ingests the latest 5 Sepolia blocks against the configured RPC and reports how many transfers it found.

## Out of scope

Other chains, ERC-20 and NFT tokens, history from before the fork, authentication and multi-user support, real email delivery, and webhook retries.
