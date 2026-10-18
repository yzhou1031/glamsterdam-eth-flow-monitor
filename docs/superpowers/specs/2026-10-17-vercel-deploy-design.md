# ETH Flow Monitor on Vercel: design

Date: 2026-10-17. Approved in chat. This extends `2026-10-14-eth-flow-monitor-design.md`.

## Why a separate mode

Vercel functions run only per request, cannot keep a background poller alive, and lose anything written to disk. The local app relies on both, through its always-on ingestor and its SQLite store. The Vercel version therefore moves the polling into the browser and keeps per-viewer state in `localStorage`. The local app is unchanged.

## Pieces

| Piece | Purpose |
|---|---|
| `src/scan.ts` | `scanBlocks(rpc, sanctions, {from?, maxBlocks=5, confirmations=1, maxLag=50})`, a stateless scan of up to 5 confirmed blocks. For each block it makes 2 RPC calls: the block with its transactions, and the 7708 logs. It decodes, classifies and screens the sanctions, then returns transfers in TransferRow shape plus `matches`. With no `from`, it scans the last 3 confirmed blocks. If a viewer has fallen more than 50 blocks behind, it skips ahead and reports how many blocks it skipped. |
| `src/inspect.ts` | Shared tx-inspector logic for the local server and Vercel. |
| `src/web-context.ts` | Lazily creates a batched viem RPC client and loads the bundled sanctions snapshot, once per function instance. |
| `api/blocks.ts`, `api/inspect.ts`, `api/sanctions.ts` | Vercel Web-signature `GET` handlers. They set no-store caching and return 400 for bad input and 502 for RPC errors. |
| `web/` | The dashboard, with the same layout and five views. It polls `/api/blocks` every 6 s (every 30 s while the tab is hidden) and applies the watchlist in the browser. Watchlist and alerts are kept in `localStorage`, capped at 500 alerts. CSV export is built in the browser from the transfers seen this session. |
| `vercel.json` | No framework, output directory `web`, `data/**` included in the functions, `maxDuration` 30 s. |
| `scripts/web-preview.ts` | Serves `web/` and the `api/` handlers locally on port 3001 for testing before deploy. |

## Deliberate differences from the local app

- The sanctions list is the bundled OFAC snapshot from 2026-10-14. It is refreshed by redeploying.
- Instead of handling reorgs, the scan serves only blocks with at least 1 confirmation.
- The dashboard tiles count transfers seen in the current session, not all of today.
- There is no webhook or email stub. Alerts appear in the dashboard only.

## Testing

- Unit tests for `scanBlocks` (default range, block cap, catching up after lag, empty when caught up) and for `inspectTx`.
- A local preview in the browser pane against live Sepolia.
- A preview deploy, checked in the browser, then production.
