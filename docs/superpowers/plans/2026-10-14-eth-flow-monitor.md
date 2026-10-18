# ETH Flow Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node/TypeScript app that streams every native ETH transfer on Sepolia from EIP-7708 logs, screens each one against OFAC and a watchlist, and shows alerts in a web dashboard.

**Architecture:** One process with these parts:

- A polling ingestor that decodes and classifies 7708 logs, writes them to SQLite and handles reorgs.
- A screener that raises alerts and pushes them out through SSE, a webhook and an email stub.
- A Fastify server that serves the REST API and a static HTML dashboard.

Every module takes its dependencies (db, rpc, sanctions) as arguments, so each one can be tested without the network.

**Tech Stack:** Node 24, TypeScript run with tsx, viem 2, the built-in `node:sqlite` (`DatabaseSync`), Fastify 5 with @fastify/static 8, vitest 3, and plain HTML, CSS and JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-14-eth-flow-monitor-design.md`

**Paths:** App root = `C:/Users/Zhou/FinTech-564/MVP/eth-flow-monitor` (written `APP` below). The folder is not a git repo, so the "Checkpoint" steps run the tests instead of committing.

---

## File map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md` | Project setup |
| `data/ofac_sdn_eth_addresses.csv`, `data/demo_screening_set.csv`, `data/mock_sanctions.csv` | Sanctions data |
| `src/config.ts` | Settings from `.env` |
| `src/csv.ts` | CSV parse and write |
| `src/decode.ts` | 7708 log decoding, constants, `Transfer` type |
| `src/classify.ts` | Top-level or internal labelling |
| `src/db.ts` | SQLite schema and queries |
| `src/sanctions.ts` | Load, version and refresh the sanctions lists |
| `src/screen.ts` | Sanctions and watchlist matching |
| `src/alerts.ts` | Record alerts, event bus, webhook, email stub |
| `src/rpc.ts` | The `Rpc` interface and its viem implementation |
| `src/ingest.ts` | Polling loop, block processing, reorgs |
| `src/server.ts` | REST, CSV, SSE and static files |
| `src/index.ts` | Wiring |
| `public/index.html`, `public/app.js`, `public/styles.css` | Dashboard |
| `scripts/smoke.ts`, `scripts/demo-internal-transfer.ts` | Live smoke test and demo |
| `test/*.test.ts` | Tests |

---

### Task 1: Scaffold the project

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/config.ts`, and the three `data/` files.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "eth-flow-monitor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Real-time ETH transfer monitoring on Sepolia using EIP-7708 logs",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx scripts/smoke.ts",
    "demo": "tsx scripts/demo-internal-transfer.ts"
  },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "fastify": "^5.2.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "test"]
}
```

- [ ] **Step 3: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
.env
*.db
*.db-wal
*.db-shm
```

`.env.example`:
```
# Sepolia JSON-RPC endpoint. The free public one works; any provider's Sepolia URL also works.
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
POLL_MS=2000
PORT=3000
# Start from this block on first run (default: the current head)
# START_BLOCK=
# POST every alert as JSON to this URL (for example a https://webhook.site URL)
# WEBHOOK_URL=

# Demo script only. Use a throwaway Sepolia test wallet, never a wallet holding real funds.
# DEMO_PRIVATE_KEY=
# DEMO_RECIPIENT=
# DEMO_AMOUNT_ETH=0.0001
# DEMO_FORWARDER=
```

- [ ] **Step 4: Write `src/config.ts`**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // no .env file: defaults apply
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  pollMs: Number(process.env.POLL_MS || 2000),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined,
  webhookUrl: process.env.WEBHOOK_URL || undefined,
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'flow-monitor.db'),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  maxBlocksPerPoll: 20,
};
```

- [ ] **Step 5: Set up the data files**

Run:
```bash
cd C:/Users/Zhou/FinTech-564/MVP/eth-flow-monitor && mkdir -p data && cp ../../data/ofac_sdn_eth_addresses.csv ../../data/demo_screening_set.csv data/ && node -e "const a='0x'+require('crypto').randomBytes(20).toString('hex');require('fs').writeFileSync('data/mock_sanctions.csv','address,name,program\n'+a+',DEMO SANCTIONED WALLET (mock),DEMO\n');console.log(a)"
```
Expected: one random `0x…` address is printed, and `data/` holds 3 CSV files.

- [ ] **Step 6: Install the packages**

Run: `npm install`
Expected: it finishes with no `ERR!` lines.

---

### Task 2: CSV helpers

**Files:** Create `src/csv.ts` and `test/csv.test.ts`.

- [ ] **Step 1: Write the failing test** in `test/csv.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, escaped quotes and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,,last\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', '', 'last'],
    ]);
  });

  it('returns no rows for empty text', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('toCsv', () => {
  it('round-trips through parseCsv', () => {
    const out = toCsv(['name', 'note'], [['LAZARUS GROUP', 'has, comma'], ['X', 'quote "q"']]);
    expect(parseCsv(out)).toEqual([['name', 'note'], ['LAZARUS GROUP', 'has, comma'], ['X', 'quote "q"']]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/csv.test.ts`
Expected: FAIL, because `../src/csv.js` cannot be resolved.

- [ ] **Step 3: Implement `src/csv.ts`**

```ts
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const cell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/csv.test.ts`
Expected: PASS, 3 tests.

---

### Task 3: Decode EIP-7708 logs

**Files:** Create `src/decode.ts` and `test/decode.test.ts`.

- [ ] **Step 1: Write the failing test.** The fixture is a real Sepolia log fetched on 2026-10-14.

```ts
import { describe, expect, it } from 'vitest';
import { decodeTransferLog, weiToEth, type RpcLog } from '../src/decode.js';

const sepoliaLog: RpcLog = {
  address: '0xfffffffffffffffffffffffffffffffffffffffe',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0x000000000000000000000000a3f4d738c97a6efb0ee936e3851c34d94b60aaac',
    '0x00000000000000000000000087a3effb84cbe1e4cab6ab430139ec41d156d55a',
  ],
  data: '0x0000000000000000000000000000000000000000000000000011c37937e08000',
  blockHash: '0x7878273aa8bd7677692d885b11440217808542eabcfe1c3811bd568d70de2212',
  blockNumber: '0xb5cd24',
  blockTimestamp: '0x6acfb174',
  transactionHash: '0x9d00804aee88a65af584223f2ad406465b78e66d19346a60c63561995d91cd12',
  logIndex: '0x5',
  removed: false,
};

describe('decodeTransferLog', () => {
  it('decodes a real Sepolia ETH transfer log', () => {
    expect(decodeTransferLog(sepoliaLog)).toEqual({
      from: '0xa3f4d738c97a6efb0ee936e3851c34d94b60aaac',
      to: '0x87a3effb84cbe1e4cab6ab430139ec41d156d55a',
      valueWei: 5_000_000_000_000_000n,
      txHash: '0x9d00804aee88a65af584223f2ad406465b78e66d19346a60c63561995d91cd12',
      blockNumber: 0xb5cd24,
      blockHash: '0x7878273aa8bd7677692d885b11440217808542eabcfe1c3811bd568d70de2212',
      logIndex: 5,
      timestamp: 0x6acfb174,
    });
  });

  it('ignores an ERC-20 Transfer emitted by a token contract', () => {
    expect(decodeTransferLog({ ...sepoliaLog, address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' })).toBeNull();
  });

  it('ignores a system-address log with a different topic', () => {
    const approval = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
    expect(decodeTransferLog({ ...sepoliaLog, topics: [approval, ...sepoliaLog.topics.slice(1)] })).toBeNull();
  });
});

describe('weiToEth', () => {
  it('converts wei to ETH', () => {
    expect(weiToEth(5_000_000_000_000_000n)).toBe(0.005);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/decode.test.ts`
Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement `src/decode.ts`**

```ts
import { formatEther } from 'viem';

/** EIP-7708: every ETH transfer emits an ERC-20-style Transfer log from this system address. */
export const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';
/** keccak256('Transfer(address,address,uint256)') */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type TransferKind = 'top-level' | 'internal';

export interface Transfer {
  from: string;
  to: string;
  valueWei: bigint;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  timestamp: number | null;
}

export type ClassifiedTransfer = Transfer & { kind: TransferKind };

/** A log as returned by JSON-RPC (hex strings). */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  logIndex: string | null;
  blockTimestamp?: string | null;
  removed?: boolean;
}

const topicToAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

export function decodeTransferLog(log: RpcLog): Transfer | null {
  if (log.address.toLowerCase() !== SYSTEM_ADDRESS) return null;
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!log.transactionHash || !log.blockNumber || !log.blockHash || !log.logIndex) return null;
  return {
    from: topicToAddress(log.topics[1]!),
    to: topicToAddress(log.topics[2]!),
    valueWei: log.data === '0x' ? 0n : BigInt(log.data),
    txHash: log.transactionHash.toLowerCase(),
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash.toLowerCase(),
    logIndex: Number(log.logIndex),
    timestamp: log.blockTimestamp ? Number(log.blockTimestamp) : null,
  };
}

export const weiToEth = (wei: bigint): number => Number(formatEther(wei));
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/decode.test.ts`
Expected: PASS, 4 tests.

---

### Task 4: Classify transfers as top-level or internal

**Files:** Create `src/classify.ts` and `test/classify.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import type { Transfer } from '../src/decode.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const mk = (from: string, to: string, valueWei: bigint, logIndex: number): Transfer => ({
  from, to, valueWei, logIndex, txHash: '0x01', blockNumber: 1, blockHash: '0xh1', timestamp: 1,
});

describe('classify', () => {
  it('labels a plain wallet-to-wallet send as top-level', () => {
    const out = classify([mk(A, B, 1n, 0)], { from: A, to: B, value: 1n });
    expect(out.map((t) => t.kind)).toEqual(['top-level']);
  });

  it('labels the forwarded leg of a contract call as internal', () => {
    const out = classify([mk(A, C, 5n, 0), mk(C, B, 5n, 1)], { from: A, to: C, value: 5n });
    expect(out.map((t) => t.kind)).toEqual(['top-level', 'internal']);
  });

  it('labels every transfer in a zero-value transaction as internal', () => {
    const out = classify([mk(C, B, 3n, 2)], { from: A, to: C, value: 0n });
    expect(out.map((t) => t.kind)).toEqual(['internal']);
  });

  it('orders by log index before deciding which transfer is first', () => {
    const out = classify([mk(C, B, 5n, 1), mk(A, C, 5n, 0)], { from: A, to: C, value: 5n });
    expect(out.map((t) => [t.logIndex, t.kind])).toEqual([[0, 'top-level'], [1, 'internal']]);
  });

  it('compares addresses case-insensitively', () => {
    const out = classify([mk(A, B, 1n, 0)], { from: A.toUpperCase().replace('0X', '0x'), to: B, value: 1n });
    expect(out[0]!.kind).toBe('top-level');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement `src/classify.ts`**

```ts
import type { ClassifiedTransfer, Transfer } from './decode.js';

export interface TxInfo {
  from: string;
  to: string | null;
  value: bigint;
}

/**
 * EIP-7708 emits the transaction's own value transfer before any other log, so the first Transfer log
 * that matches the transaction's sender, recipient and value is "top-level". Every other ETH movement
 * happened inside contract execution and is "internal".
 */
export function classify(transfers: Transfer[], tx: TxInfo): ClassifiedTransfer[] {
  const from = tx.from.toLowerCase();
  const to = tx.to?.toLowerCase() ?? null;
  return [...transfers]
    .sort((a, b) => a.logIndex - b.logIndex)
    .map((t, i) => {
      const isTopLevel =
        i === 0 &&
        tx.value > 0n &&
        to !== from &&
        t.from === from &&
        (to === null || t.to === to) &&
        t.valueWei === tx.value;
      return { ...t, kind: isTopLevel ? 'top-level' : 'internal' };
    });
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS, 5 tests.

---

### Task 5: SQLite storage

**Files:** Create `src/db.ts`. Its tests run through the ingest and server tests in Tasks 9 and 10.

- [ ] **Step 1: Implement `src/db.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { weiToEth, type ClassifiedTransfer } from './decode.js';

export type Db = DatabaseSync;
type Param = null | number | bigint | string;

export type AlertStatus = 'open' | 'reviewed' | 'escalated' | 'false_positive';
export const ALERT_STATUSES: AlertStatus[] = ['open', 'reviewed', 'escalated', 'false_positive'];
export type AlertReason = 'sanctions' | 'watchlist';

export interface TransferRow {
  id: number;
  block_number: number;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  from_addr: string;
  to_addr: string;
  value_wei: string;
  value_eth: number;
  kind: string;
  timestamp: number | null;
}

export interface AlertRow {
  id: number;
  transfer_id: number;
  reason: AlertReason;
  matched_address: string;
  matched_entry: string;
  list_version: string | null;
  status: AlertStatus;
  note: string;
  created_at: number;
  updated_at: number;
}

/** An alert joined with the fields of the transfer that triggered it. */
export interface AlertView extends AlertRow {
  tx_hash: string;
  block_number: number;
  from_addr: string;
  to_addr: string;
  value_wei: string;
  value_eth: number;
  kind: string;
  timestamp: number | null;
}

export interface WatchRow {
  address: string;
  label: string;
  min_wei: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  value_wei TEXT NOT NULL,
  value_eth REAL NOT NULL,
  kind TEXT NOT NULL,
  timestamp INTEGER,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers(from_addr);
CREATE INDEX IF NOT EXISTS transfers_to ON transfers(to_addr);
CREATE INDEX IF NOT EXISTS transfers_block ON transfers(block_number);
CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watchlist (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  min_wei TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  matched_address TEXT NOT NULL,
  matched_entry TEXT NOT NULL,
  list_version TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const now = () => Math.floor(Date.now() / 1000);

function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function getState(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, 'SELECT value FROM state WHERE key = ?', key)?.value;
}

export function setState(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Returns the new row, or undefined if this (tx_hash, log_index) was already stored. */
export function insertTransfer(db: Db, t: ClassifiedTransfer): TransferRow | undefined {
  return one<TransferRow>(
    db,
    `INSERT OR IGNORE INTO transfers (block_number, block_hash, tx_hash, log_index, from_addr, to_addr, value_wei, value_eth, kind, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    t.blockNumber, t.blockHash, t.txHash, t.logIndex, t.from, t.to, t.valueWei.toString(), weiToEth(t.valueWei), t.kind, t.timestamp,
  );
}

export function getBlockHash(db: Db, n: number): string | undefined {
  return one<{ hash: string }>(db, 'SELECT hash FROM blocks WHERE number = ?', n)?.hash;
}

export function saveBlock(db: Db, n: number, hash: string, parentHash: string): void {
  db.prepare('INSERT OR REPLACE INTO blocks (number, hash, parent_hash) VALUES (?, ?, ?)').run(n, hash, parentHash);
  db.prepare('DELETE FROM blocks WHERE number < ?').run(n - 64);
}

export function lowestStoredBlock(db: Db): number | undefined {
  return one<{ n: number | null }>(db, 'SELECT MIN(number) AS n FROM blocks')?.n ?? undefined;
}

/** Deletes transfers (and, by cascade, their alerts) and block hashes from block n upward. */
export function rollbackFrom(db: Db, n: number): void {
  db.prepare('DELETE FROM transfers WHERE block_number >= ?').run(n);
  db.prepare('DELETE FROM blocks WHERE number >= ?').run(n);
}

export function listWatch(db: Db): WatchRow[] {
  return all<WatchRow>(db, 'SELECT * FROM watchlist ORDER BY created_at DESC, address');
}

export function getWatch(db: Db, address: string): WatchRow | undefined {
  return one<WatchRow>(db, 'SELECT * FROM watchlist WHERE address = ?', address.toLowerCase());
}

export function upsertWatch(db: Db, address: string, label: string, minWei: bigint): void {
  db.prepare(
    `INSERT INTO watchlist (address, label, min_wei, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label, min_wei = excluded.min_wei`,
  ).run(address.toLowerCase(), label, minWei.toString(), now());
}

export function removeWatch(db: Db, address: string): boolean {
  return Number(db.prepare('DELETE FROM watchlist WHERE address = ?').run(address.toLowerCase()).changes) > 0;
}

export function insertAlert(
  db: Db,
  a: { transferId: number; reason: AlertReason; matchedAddress: string; matchedEntry: string; listVersion: string | null },
): AlertRow {
  const t = now();
  return one<AlertRow>(
    db,
    `INSERT INTO alerts (transfer_id, reason, matched_address, matched_entry, list_version, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', '', ?, ?) RETURNING *`,
    a.transferId, a.reason, a.matchedAddress, a.matchedEntry, a.listVersion, t, t,
  )!;
}

const ALERT_VIEW = `SELECT a.*, t.tx_hash, t.block_number, t.from_addr, t.to_addr, t.value_wei, t.value_eth, t.kind, t.timestamp
  FROM alerts a JOIN transfers t ON t.id = a.transfer_id`;

export function listAlerts(db: Db, status?: string, limit = 200): AlertView[] {
  return status
    ? all<AlertView>(db, `${ALERT_VIEW} WHERE a.status = ? ORDER BY a.id DESC LIMIT ?`, status, limit)
    : all<AlertView>(db, `${ALERT_VIEW} ORDER BY a.id DESC LIMIT ?`, limit);
}

export function getAlertView(db: Db, id: number): AlertView | undefined {
  return one<AlertView>(db, `${ALERT_VIEW} WHERE a.id = ?`, id);
}

export function updateAlert(db: Db, id: number, status: AlertStatus, note: string): boolean {
  return Number(db.prepare('UPDATE alerts SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, note, now(), id).changes) > 0;
}

export interface TransferQuery {
  address?: string;
  minEth?: number;
  fromTs?: number;
  toTs?: number;
  limit?: number;
}

export function queryTransfers(db: Db, q: TransferQuery): TransferRow[] {
  const where: string[] = [];
  const params: Param[] = [];
  if (q.address) {
    where.push('(from_addr = ? OR to_addr = ?)');
    params.push(q.address.toLowerCase(), q.address.toLowerCase());
  }
  if (q.minEth != null && !Number.isNaN(q.minEth)) {
    where.push('value_eth >= ?');
    params.push(q.minEth);
  }
  if (q.fromTs != null && !Number.isNaN(q.fromTs)) {
    where.push('timestamp >= ?');
    params.push(q.fromTs);
  }
  if (q.toTs != null && !Number.isNaN(q.toTs)) {
    where.push('timestamp < ?');
    params.push(q.toTs);
  }
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 5000);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return all<TransferRow>(db, `SELECT * FROM transfers ${clause} ORDER BY block_number DESC, log_index DESC LIMIT ?`, ...params, limit);
}

export function stats(db: Db, dayStart: number) {
  const count = (sql: string, ...p: Param[]) => one<{ n: number }>(db, sql, ...p)!.n;
  return {
    transfersToday: count('SELECT COUNT(*) AS n FROM transfers WHERE timestamp >= ?', dayStart),
    internalToday: count("SELECT COUNT(*) AS n FROM transfers WHERE timestamp >= ? AND kind = 'internal'", dayStart),
    openAlerts: count("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'"),
    sanctionsHits: count("SELECT COUNT(*) AS n FROM alerts WHERE reason = 'sanctions'"),
    lastBlock: Number(getState(db, 'last_block') ?? 0),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 6: Sanctions lists

**Files:** Create `src/sanctions.ts` and `test/sanctions.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEthFromSdnCsv, loadSanctions, refreshFromOfac, MOCK_FILE, OFAC_FILE } from '../src/sanctions.js';

const sdnRow = [
  '27307', 'LAZARUS GROUP', '-0- ', 'DPRK3] [CYBER2', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ', '-0- ',
  'Digital Currency Address - ETH 0x098B716B8Aaf21512996dC57EB0615e2383E2f96; Digital Currency Address - XBT bc1qexample; Digital Currency Address - ETH 0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B.',
].map((c) => `"${c}"`).join(',');
const otherRow = ['1', 'SOMEONE', 'individual', 'SDGT', '', '', '', '', '', '', '', 'Passport 123'].map((c) => `"${c}"`).join(',');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'efm-sanctions-'));

describe('extractEthFromSdnCsv', () => {
  it('pulls every ETH address out of the remarks column', () => {
    expect(extractEthFromSdnCsv(`${sdnRow}\n${otherRow}\n`)).toEqual([
      { sdn_entry_id: '27307', name: 'LAZARUS GROUP', program: 'DPRK3; CYBER2', eth_address: '0x098B716B8Aaf21512996dC57EB0615e2383E2f96' },
      { sdn_entry_id: '27307', name: 'LAZARUS GROUP', program: 'DPRK3; CYBER2', eth_address: '0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B' },
    ]);
  });
});

describe('loadSanctions', () => {
  it('merges OFAC and mock entries, lowercases addresses and versions the list', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, OFAC_FILE), 'sdn_entry_id,name,program,eth_address,source,retrieved\n27307,LAZARUS GROUP,DPRK3,0x098B716B8Aaf21512996dC57EB0615e2383E2f96,OFAC SDN.CSV,2026-10-14\n');
    fs.writeFileSync(path.join(dir, MOCK_FILE), 'address,name,program\n0x' + 'd'.repeat(40) + ',DEMO,DEMO\n');
    const list = loadSanctions(dir, Date.parse('2026-10-14T12:00:00Z'));
    expect(list.entries.size).toBe(2);
    expect(list.ofacCount).toBe(1);
    expect(list.mockCount).toBe(1);
    expect(list.entries.get('0x098b716b8aaf21512996dc57eb0615e2383e2f96')).toMatchObject({ name: 'LAZARUS GROUP', source: 'ofac' });
    expect(list.entries.get('0x' + 'd'.repeat(40))).toMatchObject({ source: 'mock' });
    expect(list.version).toMatch(/^[0-9a-f]{12}@2026-10-14$/);
  });

  it('returns an empty list when the files are missing', () => {
    expect(loadSanctions(tmp()).entries.size).toBe(0);
  });
});

describe('refreshFromOfac', () => {
  it('writes the extracted ETH addresses to the OFAC file', async () => {
    const dir = tmp();
    const fakeFetch = (async () => new Response(`${sdnRow}\n${otherRow}\n`)) as typeof fetch;
    expect(await refreshFromOfac(dir, fakeFetch)).toBe(2);
    expect(loadSanctions(dir).ofacCount).toBe(2);
  });

  it('keeps the previous file when the download fails', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, OFAC_FILE), 'old contents\n');
    const fakeFetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(refreshFromOfac(dir, fakeFetch)).rejects.toThrow('HTTP 503');
    expect(fs.readFileSync(path.join(dir, OFAC_FILE), 'utf8')).toBe('old contents\n');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/sanctions.test.ts`
Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement `src/sanctions.ts`**

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, toCsv } from './csv.js';

export const OFAC_FILE = 'ofac_sdn_eth_addresses.csv';
export const MOCK_FILE = 'mock_sanctions.csv';
export const SDN_CSV_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';

export interface SanctionEntry {
  address: string;
  name: string;
  program: string;
  source: 'ofac' | 'mock';
}

export interface SanctionsList {
  /** sha256 of both files (first 12 hex chars) + load date. Recorded on every alert for audit. */
  version: string;
  loadedAt: number;
  entries: Map<string, SanctionEntry>;
  ofacCount: number;
  mockCount: number;
}

const readIfExists = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

function rowsWithHeader(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  if (!head) return [];
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

export function loadSanctions(dataDir: string, nowMs = Date.now()): SanctionsList {
  const ofacText = readIfExists(path.join(dataDir, OFAC_FILE));
  const mockText = readIfExists(path.join(dataDir, MOCK_FILE));
  const entries = new Map<string, SanctionEntry>();
  let ofacCount = 0;
  let mockCount = 0;
  for (const r of rowsWithHeader(ofacText)) {
    if (!r.eth_address) continue;
    const address = r.eth_address.toLowerCase();
    entries.set(address, { address, name: r.name ?? '', program: r.program ?? '', source: 'ofac' });
    ofacCount++;
  }
  for (const r of rowsWithHeader(mockText)) {
    if (!r.address) continue;
    const address = r.address.toLowerCase();
    entries.set(address, { address, name: r.name ?? '', program: r.program ?? '', source: 'mock' });
    mockCount++;
  }
  const hash = crypto.createHash('sha256').update(ofacText).update('\n--mock--\n').update(mockText).digest('hex').slice(0, 12);
  return { version: `${hash}@${new Date(nowMs).toISOString().slice(0, 10)}`, loadedAt: nowMs, entries, ofacCount, mockCount };
}

export interface SdnEthRow {
  sdn_entry_id: string;
  name: string;
  program: string;
  eth_address: string;
}

const ETH_RE = /Digital Currency Address - ETH\s+(0x[0-9a-fA-F]{40})/g;

/** SDN.CSV has no header; column 0 = entry id, 1 = name, 3 = program(s), 11 = remarks holding the crypto addresses. */
export function extractEthFromSdnCsv(text: string): SdnEthRow[] {
  const out: SdnEthRow[] = [];
  for (const r of parseCsv(text)) {
    if (r.length < 12) continue;
    for (const m of r[11]!.matchAll(ETH_RE)) {
      out.push({ sdn_entry_id: r[0]!, name: r[1]!, program: r[3]!.replace(/\] \[/g, '; '), eth_address: m[1]! });
    }
  }
  return out;
}

/** Downloads the SDN list and rewrites the OFAC file. Throws (leaving the old file in place) on any failure. */
export async function refreshFromOfac(dataDir: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const res = await fetchFn(SDN_CSV_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`OFAC download failed: HTTP ${res.status}`);
  const text = new TextDecoder('latin1').decode(await res.arrayBuffer());
  const rows = extractEthFromSdnCsv(text);
  if (rows.length === 0) throw new Error('OFAC download contained no ETH addresses');
  const day = new Date().toISOString().slice(0, 10);
  const csv = toCsv(
    ['sdn_entry_id', 'name', 'program', 'eth_address', 'source', 'retrieved'],
    rows.map((r) => [r.sdn_entry_id, r.name, r.program, r.eth_address, 'OFAC SDN.CSV', day]),
  );
  fs.writeFileSync(path.join(dataDir, OFAC_FILE), csv);
  return rows.length;
}

export function ofacFileAgeMs(dataDir: string, nowMs = Date.now()): number {
  const file = path.join(dataDir, OFAC_FILE);
  return fs.existsSync(file) ? nowMs - fs.statSync(file).mtimeMs : Infinity;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/sanctions.test.ts`
Expected: PASS, 5 tests.

---

### Task 7: Screening and the 15-address replay

**Files:** Create `src/screen.ts`, `test/screen.test.ts` and `test/replay.test.ts`.

- [ ] **Step 1: Write the failing tests**

`test/screen.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { screen, type WatchEntry } from '../src/screen.js';
import type { SanctionsList } from '../src/sanctions.js';

const A = '0x' + 'a'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const W = '0x' + 'c'.repeat(40);
const sanctions: SanctionsList = {
  version: 'v1@2026-10-14', loadedAt: 0, ofacCount: 1, mockCount: 0,
  entries: new Map([[BAD, { address: BAD, name: 'LAZARUS GROUP', program: 'DPRK3', source: 'ofac' as const }]]),
};
const watch = new Map<string, WatchEntry>([[W, { address: W, label: 'Client treasury', minWei: 10n }]]);
const getWatch = (a: string) => watch.get(a);

describe('screen', () => {
  it('flags a transfer to a sanctioned address, whatever its letter case', () => {
    const m = screen({ from: A, to: BAD.toUpperCase().replace('0X', '0x'), valueWei: 1n }, sanctions, getWatch);
    expect(m).toEqual([{ reason: 'sanctions', matchedAddress: BAD, matchedEntry: 'LAZARUS GROUP (DPRK3; OFAC SDN)', listVersion: 'v1@2026-10-14' }]);
  });

  it('applies the watchlist minimum amount', () => {
    expect(screen({ from: W, to: A, valueWei: 5n }, sanctions, getWatch)).toEqual([]);
    expect(screen({ from: W, to: A, valueWei: 10n }, sanctions, getWatch)).toEqual([
      { reason: 'watchlist', matchedAddress: W, matchedEntry: 'Client treasury', listVersion: null },
    ]);
  });

  it('reports both a sanctions and a watchlist match on one transfer', () => {
    expect(screen({ from: BAD, to: W, valueWei: 20n }, sanctions, getWatch).map((m) => m.reason)).toEqual(['sanctions', 'watchlist']);
  });

  it('returns nothing for a clean transfer', () => {
    expect(screen({ from: A, to: '0x' + 'e'.repeat(40), valueWei: 1n }, sanctions, getWatch)).toEqual([]);
  });
});
```

`test/replay.test.ts`:
```ts
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';
import { loadSanctions } from '../src/sanctions.js';
import { screen } from '../src/screen.js';

const dataDir = fileURLToPath(new URL('../data', import.meta.url));

describe('replay of the demo screening set', () => {
  it('flags all 15 Lazarus Group and Garantex addresses (100% recall)', () => {
    const [head, ...rows] = parseCsv(fs.readFileSync(`${dataDir}/demo_screening_set.csv`, 'utf8'));
    const col = head!.indexOf('eth_address');
    const addresses = rows.map((r) => r[col]!);
    expect(addresses).toHaveLength(15);
    const sanctions = loadSanctions(dataDir);
    const sender = '0x' + '1'.repeat(40);
    const flagged = addresses.filter((to) =>
      screen({ from: sender, to, valueWei: 1n }, sanctions, () => undefined).some((m) => m.reason === 'sanctions'),
    );
    expect(flagged).toHaveLength(15);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/screen.test.ts test/replay.test.ts`
Expected: FAIL, because `../src/screen.js` cannot be found.

- [ ] **Step 3: Implement `src/screen.ts`**

```ts
import type { AlertReason } from './db.js';
import type { SanctionsList } from './sanctions.js';

export interface WatchEntry {
  address: string;
  label: string;
  minWei: bigint;
}

export interface Match {
  reason: AlertReason;
  matchedAddress: string;
  matchedEntry: string;
  listVersion: string | null;
}

export function screen(
  t: { from: string; to: string; valueWei: bigint },
  sanctions: SanctionsList,
  getWatch: (address: string) => WatchEntry | undefined,
): Match[] {
  const matches: Match[] = [];
  for (const side of new Set([t.from.toLowerCase(), t.to.toLowerCase()])) {
    const s = sanctions.entries.get(side);
    if (s) {
      const source = s.source === 'mock' ? 'mock list' : 'OFAC SDN';
      matches.push({ reason: 'sanctions', matchedAddress: side, matchedEntry: `${s.name} (${s.program}; ${source})`, listVersion: sanctions.version });
    }
    const w = getWatch(side);
    if (w && t.valueWei >= w.minWei) {
      matches.push({ reason: 'watchlist', matchedAddress: side, matchedEntry: w.label || side, listVersion: null });
    }
  }
  return matches;
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run test/screen.test.ts test/replay.test.ts`
Expected: PASS, 5 tests.

---

### Task 8: Alerts and RPC client

**Files:** Create `src/alerts.ts` and `src/rpc.ts`. Their tests run through the ingest tests in Task 9.

- [ ] **Step 1: Implement `src/alerts.ts`**

```ts
import { EventEmitter } from 'node:events';
import { getAlertView, insertAlert, type AlertView, type Db, type TransferRow } from './db.js';
import type { Match } from './screen.js';

/** Events: 'transfer' (TransferRow), 'alert' (AlertView), 'alert-updated' (AlertView). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export interface AlertOptions {
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

/** Inserts one alert per match. Call inside the block's DB transaction. */
export function recordAlerts(db: Db, transfer: TransferRow, matches: Match[]): AlertView[] {
  return matches.map((m) => {
    const row = insertAlert(db, {
      transferId: transfer.id,
      reason: m.reason,
      matchedAddress: m.matchedAddress,
      matchedEntry: m.matchedEntry,
      listVersion: m.listVersion,
    });
    return getAlertView(db, row.id)!;
  });
}

/** Sends committed alerts to the dashboard (SSE bus), the webhook and the email stub. */
export function notifyAlerts(alerts: AlertView[], opts: AlertOptions = {}): void {
  const log = opts.log ?? console.log;
  for (const a of alerts) {
    bus.emit('alert', a);
    log(`[email stub] Alert #${a.id} (${a.reason}): ${a.matched_entry}; ${a.value_eth} ETH ${a.from_addr} -> ${a.to_addr}; tx ${a.tx_hash}`);
    if (opts.webhookUrl) void postWebhook(opts.webhookUrl, a, opts.fetchFn ?? fetch, log);
  }
}

async function postWebhook(url: string, alert: AlertView, fetchFn: typeof fetch, log: (m: string) => void): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log(`[webhook] HTTP ${res.status} for alert #${alert.id}`);
  } catch (e) {
    log(`[webhook] failed for alert #${alert.id}: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 2: Implement `src/rpc.ts`**

```ts
import { createPublicClient, http, toHex, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import type { TxInfo } from './classify.js';
import { SYSTEM_ADDRESS, TRANSFER_TOPIC, type RpcLog } from './decode.js';

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

export interface Rpc {
  blockNumber(): Promise<number>;
  getBlock(n: number): Promise<BlockHeader>;
  /** EIP-7708 Transfer logs (system address + Transfer topic) in block n. */
  getTransferLogs(n: number): Promise<RpcLog[]>;
  getTx(hash: string): Promise<TxInfo>;
  getReceiptLogs(hash: string): Promise<RpcLog[]>;
}

export function makeRpc(url: string): Rpc {
  const client = createPublicClient({ chain: sepolia, transport: http(url, { retryCount: 2, timeout: 15_000 }) });
  return {
    async blockNumber() {
      return Number(await client.getBlockNumber({ cacheTime: 0 }));
    },
    async getBlock(n) {
      const b = await client.getBlock({ blockNumber: BigInt(n) });
      return { number: Number(b.number), hash: b.hash!.toLowerCase(), parentHash: b.parentHash.toLowerCase(), timestamp: Number(b.timestamp) };
    },
    async getTransferLogs(n) {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: toHex(n), toBlock: toHex(n), address: SYSTEM_ADDRESS as Hex, topics: [TRANSFER_TOPIC as Hex] }],
      });
      return logs as unknown as RpcLog[];
    },
    async getTx(hash) {
      const tx = await client.getTransaction({ hash: hash as Hex });
      return { from: tx.from.toLowerCase(), to: tx.to ? tx.to.toLowerCase() : null, value: tx.value };
    },
    async getReceiptLogs(hash) {
      const receipt = (await client.request({ method: 'eth_getTransactionReceipt', params: [hash as Hex] })) as unknown as { logs: RpcLog[] } | null;
      if (!receipt) throw new Error('Transaction not found on this network');
      return receipt.logs;
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

---

### Task 9: Ingestor with reorg handling

**Files:** Create `src/ingest.ts` and `test/ingest.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import type { TxInfo } from '../src/classify.js';
import { getState, listAlerts, openDb, queryTransfers } from '../src/db.js';
import { SYSTEM_ADDRESS, TRANSFER_TOPIC, type RpcLog } from '../src/decode.js';
import { pollOnce, type IngestContext } from '../src/ingest.js';
import type { BlockHeader, Rpc } from '../src/rpc.js';
import type { SanctionsList } from '../src/sanctions.js';

const A = '0x' + 'a'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const word = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2);

class FakeChain implements Rpc {
  head = 0;
  blocks = new Map<number, BlockHeader>();
  logs = new Map<number, RpcLog[]>();
  txs = new Map<string, TxInfo>();

  add(n: number, hash: string, parentHash: string, sends: { tx: string; from: string; to: string; value: bigint }[] = []) {
    this.blocks.set(n, { number: n, hash, parentHash, timestamp: 1_790_000_000 + n * 12 });
    this.logs.set(n, sends.map((s, i) => ({
      address: SYSTEM_ADDRESS,
      topics: [TRANSFER_TOPIC, word(s.from), word(s.to)],
      data: '0x' + s.value.toString(16).padStart(64, '0'),
      transactionHash: s.tx,
      blockNumber: toHex(n),
      blockHash: hash,
      logIndex: toHex(i),
    })));
    for (const s of sends) this.txs.set(s.tx, { from: s.from, to: s.to, value: s.value });
    this.head = Math.max(this.head, n);
  }

  async blockNumber() { return this.head; }
  async getBlock(n: number) {
    const b = this.blocks.get(n);
    if (!b) throw new Error(`no block ${n}`);
    return b;
  }
  async getTransferLogs(n: number) { return this.logs.get(n) ?? []; }
  async getTx(hash: string) { return this.txs.get(hash)!; }
  async getReceiptLogs() { return []; }
}

const sanctions: SanctionsList = {
  version: 'test@2026-10-14', loadedAt: 0, ofacCount: 0, mockCount: 1,
  entries: new Map([[BAD, { address: BAD, name: 'TEST SANCTIONED', program: 'TEST', source: 'mock' as const }]]),
};

const makeCtx = (chain: FakeChain): IngestContext => ({
  db: openDb(':memory:'), rpc: chain, getSanctions: () => sanctions, alertOpts: { log: () => {} }, startBlock: 1, log: () => {},
});

describe('pollOnce', () => {
  it('ingests new blocks, stores transfers and raises a sanctions alert', async () => {
    const chain = new FakeChain();
    chain.add(1, '0xh1', '0xh0');
    chain.add(2, '0xh2', '0xh1', [{ tx: '0x01', from: A, to: BAD, value: 10n }]);
    chain.add(3, '0xh3', '0xh2');
    const ctx = makeCtx(chain);

    expect(await pollOnce(ctx)).toBe(3);
    expect(getState(ctx.db, 'last_block')).toBe('3');
    const transfers = queryTransfers(ctx.db, {});
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ from_addr: A, to_addr: BAD, value_wei: '10', kind: 'top-level', timestamp: 1_790_000_024 });
    const alerts = listAlerts(ctx.db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ reason: 'sanctions', status: 'open', list_version: 'test@2026-10-14' });
  });

  it('stops at the per-poll limit and continues on the next poll', async () => {
    const chain = new FakeChain();
    for (let n = 1; n <= 5; n++) chain.add(n, `0xh${n}`, `0xh${n - 1}`);
    const ctx = { ...makeCtx(chain), maxBlocksPerPoll: 2 };
    expect(await pollOnce(ctx)).toBe(2);
    expect(await pollOnce(ctx)).toBe(2);
    expect(await pollOnce(ctx)).toBe(1);
    expect(getState(ctx.db, 'last_block')).toBe('5');
  });

  it('rolls back replaced blocks on a reorg and re-ingests the new chain', async () => {
    const chain = new FakeChain();
    chain.add(1, '0xh1', '0xh0');
    chain.add(2, '0xh2', '0xh1');
    chain.add(3, '0xh3', '0xh2', [{ tx: '0x03', from: A, to: BAD, value: 7n }]);
    const ctx = makeCtx(chain);
    await pollOnce(ctx);
    expect(queryTransfers(ctx.db, {})).toHaveLength(1);

    chain.add(3, '0xh3b', '0xh2');
    chain.add(4, '0xh4', '0xh3b');

    expect(await pollOnce(ctx)).toBe(0);
    expect(getState(ctx.db, 'last_block')).toBe('2');
    expect(queryTransfers(ctx.db, {})).toHaveLength(0);
    expect(listAlerts(ctx.db)).toHaveLength(0);

    expect(await pollOnce(ctx)).toBe(2);
    expect(getState(ctx.db, 'last_block')).toBe('4');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/ingest.test.ts`
Expected: FAIL, because `../src/ingest.js` cannot be found.

- [ ] **Step 3: Implement `src/ingest.ts`**

```ts
import { notifyAlerts, recordAlerts, bus, type AlertOptions } from './alerts.js';
import { classify } from './classify.js';
import {
  getBlockHash, getState, getWatch, insertTransfer, lowestStoredBlock, rollbackFrom, saveBlock, setState,
  type AlertView, type Db, type TransferRow,
} from './db.js';
import { decodeTransferLog, type Transfer } from './decode.js';
import type { BlockHeader, Rpc } from './rpc.js';
import type { SanctionsList } from './sanctions.js';
import { screen, type WatchEntry } from './screen.js';

export interface IngestContext {
  db: Db;
  rpc: Rpc;
  getSanctions: () => SanctionsList;
  alertOpts?: AlertOptions;
  startBlock?: number;
  maxBlocksPerPoll?: number;
  log?: (message: string) => void;
}

function watchLookup(db: Db) {
  return (address: string): WatchEntry | undefined => {
    const w = getWatch(db, address);
    return w ? { address: w.address, label: w.label, minWei: BigInt(w.min_wei) } : undefined;
  };
}

/** Fetches, classifies, stores and screens one block's ETH transfers in a single DB transaction. */
export async function processBlock(ctx: IngestContext, header: BlockHeader): Promise<TransferRow[]> {
  const logs = await ctx.rpc.getTransferLogs(header.number);
  const byTx = new Map<string, Transfer[]>();
  for (const log of logs) {
    if (log.removed) continue;
    const t = decodeTransferLog(log);
    if (!t) continue;
    const withTime = { ...t, timestamp: t.timestamp ?? header.timestamp };
    const list = byTx.get(t.txHash);
    if (list) list.push(withTime);
    else byTx.set(t.txHash, [withTime]);
  }
  const hashes = [...byTx.keys()];
  const txs = await Promise.all(hashes.map((h) => ctx.rpc.getTx(h)));
  const classified = hashes.flatMap((h, i) => classify(byTx.get(h)!, txs[i]!)).sort((a, b) => a.logIndex - b.logIndex);

  const sanctions = ctx.getSanctions();
  const lookup = watchLookup(ctx.db);
  const rows: TransferRow[] = [];
  const alerts: AlertView[] = [];
  ctx.db.exec('BEGIN');
  try {
    for (const t of classified) {
      const row = insertTransfer(ctx.db, t);
      if (!row) continue;
      rows.push(row);
      alerts.push(...recordAlerts(ctx.db, row, screen(t, sanctions, lookup)));
    }
    saveBlock(ctx.db, header.number, header.hash, header.parentHash);
    setState(ctx.db, 'last_block', String(header.number));
    ctx.db.exec('COMMIT');
  } catch (e) {
    ctx.db.exec('ROLLBACK');
    throw e;
  }
  for (const row of rows) bus.emit('transfer', row);
  notifyAlerts(alerts, ctx.alertOpts);
  return rows;
}

/** Walks back from `from` to the newest block whose stored hash still matches the chain, and deletes everything after it. */
async function handleReorg(ctx: IngestContext, from: number): Promise<void> {
  const lowest = lowestStoredBlock(ctx.db) ?? from;
  let k = from;
  while (k >= lowest) {
    const stored = getBlockHash(ctx.db, k);
    const onChain = (await ctx.rpc.getBlock(k)).hash;
    if (stored === onChain) break;
    k--;
  }
  rollbackFrom(ctx.db, k + 1);
  setState(ctx.db, 'last_block', String(k));
  (ctx.log ?? console.log)(`[ingest] reorg detected: rolled back blocks ${k + 1}..${from}`);
}

/** Processes up to maxBlocksPerPoll new blocks. Returns how many were processed (0 after a reorg rollback). */
export async function pollOnce(ctx: IngestContext): Promise<number> {
  const head = await ctx.rpc.blockNumber();
  let last = getState(ctx.db, 'last_block');
  if (last === undefined) {
    last = String((ctx.startBlock ?? head) - 1);
    setState(ctx.db, 'last_block', last);
  }
  const max = ctx.maxBlocksPerPoll ?? 20;
  let n = Number(last) + 1;
  let done = 0;
  while (n <= head && done < max) {
    const header = await ctx.rpc.getBlock(n);
    const storedParent = getBlockHash(ctx.db, n - 1);
    if (storedParent && storedParent !== header.parentHash) {
      await handleReorg(ctx, n - 1);
      return done;
    }
    await processBlock(ctx, header);
    n++;
    done++;
  }
  return done;
}

/** Polls forever. An RPC error skips the rest of that poll; the next tick retries from the last stored block. */
export function startIngest(ctx: IngestContext, pollMs: number): () => void {
  const log = ctx.log ?? console.log;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await pollOnce(ctx);
      if (n > 0) log(`[ingest] processed ${n} block(s); last block ${getState(ctx.db, 'last_block')}`);
    } catch (e) {
      log(`[ingest] RPC error, retrying next poll: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/ingest.test.ts`
Expected: PASS, 3 tests.

---

### Task 10: HTTP server

**Files:** Create `src/server.ts` and `test/server.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordAlerts } from '../src/alerts.js';
import { insertTransfer, openDb } from '../src/db.js';
import type { Rpc } from '../src/rpc.js';
import type { SanctionsList } from '../src/sanctions.js';
import { buildServer } from '../src/server.js';

const A = '0x' + 'a'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'efm-public-'));
const sanctions: SanctionsList = { version: 'v', loadedAt: 0, ofacCount: 0, mockCount: 0, entries: new Map() };
const rpc = {} as Rpc;

function setup() {
  const db = openDb(':memory:');
  const app = buildServer({ db, rpc, getSanctions: () => sanctions, publicDir, sanctionsMeta: () => ({ lastRefresh: null, lastRefreshError: null }) });
  return { db, app };
}

describe('watchlist API', () => {
  it('rejects an invalid address and stores a valid one with its minimum in wei', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/watchlist', payload: { address: 'nope' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/watchlist', payload: { address: A, label: 'Client A', min_eth: '0.5' } });
    expect(ok.statusCode).toBe(201);
    const list = (await app.inject({ url: '/api/watchlist' })).json();
    expect(list[0]).toMatchObject({ address: A, label: 'Client A', min_wei: '500000000000000000' });
  });

  it('imports a CSV and reports bad rows', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/api/watchlist/upload', headers: { 'content-type': 'text/csv' },
      payload: `address,label,min_eth\n${A},One,\nnot-an-address,Two,1\n`,
    });
    expect(res.json()).toEqual({ added: 1, errors: ['row 3: not a valid address: not-an-address'] });
  });
});

describe('alerts API', () => {
  it('updates status and note, and rejects an unknown status', async () => {
    const { db, app } = setup();
    const row = insertTransfer(db, { from: A, to: BAD, valueWei: 10n, txHash: '0x01', blockNumber: 1, blockHash: '0xh1', logIndex: 0, timestamp: 1, kind: 'internal' })!;
    const [alert] = recordAlerts(db, row, [{ reason: 'sanctions', matchedAddress: BAD, matchedEntry: 'TEST', listVersion: 'v' }]);
    const res = await app.inject({ method: 'PATCH', url: `/api/alerts/${alert!.id}`, payload: { status: 'escalated', note: 'sent to compliance lead' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'escalated', note: 'sent to compliance lead', to_addr: BAD });
    expect((await app.inject({ method: 'PATCH', url: `/api/alerts/${alert!.id}`, payload: { status: 'done' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/alerts/999', payload: { status: 'reviewed' } })).statusCode).toBe(404);
  });
});

describe('transfers CSV export', () => {
  it('returns a CSV with a header row', async () => {
    const { db, app } = setup();
    insertTransfer(db, { from: A, to: BAD, valueWei: 10n ** 18n, txHash: '0x02', blockNumber: 2, blockHash: '0xh2', logIndex: 0, timestamp: 1_790_000_000, kind: 'top-level' });
    const res = await app.inject({ url: `/api/transfers.csv?address=${A}` });
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('block_number,timestamp_utc,tx_hash,log_index,from,to,value_eth,value_wei,kind');
    expect(lines[1]).toContain(',1,1000000000000000000,top-level');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL, because `../src/server.js` cannot be found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { isAddress, parseEther } from 'viem';
import { bus } from './alerts.js';
import { parseCsv, toCsv } from './csv.js';
import {
  ALERT_STATUSES, getAlertView, listAlerts, listWatch, queryTransfers, removeWatch, stats, updateAlert, upsertWatch,
  type AlertStatus, type Db, type TransferQuery,
} from './db.js';
import { decodeTransferLog, SYSTEM_ADDRESS, weiToEth } from './decode.js';
import type { Rpc } from './rpc.js';
import type { SanctionsList } from './sanctions.js';

export interface ServerContext {
  db: Db;
  rpc: Rpc;
  getSanctions: () => SanctionsList;
  publicDir: string;
  sanctionsMeta: () => { lastRefresh: number | null; lastRefreshError: string | null };
}

type Query = Record<string, string | undefined>;

function parseTransferQuery(q: Query): TransferQuery {
  const day = (d?: string) => (d ? Math.floor(Date.parse(d) / 1000) : undefined);
  const to = day(q.to);
  return {
    address: q.address?.trim() || undefined,
    minEth: q.min ? Number(q.min) : undefined,
    fromTs: day(q.from),
    toTs: to === undefined ? undefined : to + 86_400,
    limit: q.limit ? Number(q.limit) : undefined,
  };
}

/** Returns an error message, or null when the entry was saved. */
function addWatchEntry(db: Db, address?: string, label?: string, minEth?: string | number): string | null {
  const a = (address ?? '').trim();
  if (!isAddress(a, { strict: false })) return `not a valid address: ${a || '(empty)'}`;
  let minWei = 0n;
  const m = String(minEth ?? '').trim();
  if (m) {
    try {
      minWei = parseEther(m);
    } catch {
      return `min_eth must be a number: ${m}`;
    }
    if (minWei < 0n) return 'min_eth cannot be negative';
  }
  upsertWatch(db, a, (label ?? '').trim(), minWei);
  return null;
}

export function buildServer(ctx: ServerContext) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.register(fastifyStatic, { root: ctx.publicDir });

  app.get('/api/transfers', async (req) => queryTransfers(ctx.db, parseTransferQuery(req.query as Query)));

  app.get('/api/transfers.csv', async (req, reply) => {
    const rows = queryTransfers(ctx.db, { ...parseTransferQuery(req.query as Query), limit: 5000 });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="eth-transfers.csv"');
    return toCsv(
      ['block_number', 'timestamp_utc', 'tx_hash', 'log_index', 'from', 'to', 'value_eth', 'value_wei', 'kind'],
      rows.map((r) => [
        r.block_number, r.timestamp ? new Date(r.timestamp * 1000).toISOString() : '', r.tx_hash, r.log_index,
        r.from_addr, r.to_addr, r.value_eth, r.value_wei, r.kind,
      ]),
    );
  });

  app.get('/api/alerts', async (req) => listAlerts(ctx.db, (req.query as Query).status || undefined));

  app.patch('/api/alerts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { status?: string; note?: string };
    const current = getAlertView(ctx.db, id);
    if (!current) return reply.code(404).send({ error: 'Alert not found' });
    const status = (body.status ?? current.status) as AlertStatus;
    if (!ALERT_STATUSES.includes(status)) return reply.code(400).send({ error: `status must be one of: ${ALERT_STATUSES.join(', ')}` });
    updateAlert(ctx.db, id, status, body.note ?? current.note);
    const updated = getAlertView(ctx.db, id)!;
    bus.emit('alert-updated', updated);
    return updated;
  });

  app.get('/api/watchlist', async () => listWatch(ctx.db));

  app.post('/api/watchlist', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: string; label?: string; min_eth?: string | number };
    const error = addWatchEntry(ctx.db, b.address, b.label, b.min_eth);
    if (error) return reply.code(400).send({ error });
    return reply.code(201).send(listWatch(ctx.db));
  });

  app.post('/api/watchlist/upload', async (req, reply) => {
    const [head, ...rows] = parseCsv(String(req.body ?? ''));
    const col = (name: string) => (head ?? []).findIndex((h) => h.trim().toLowerCase() === name);
    const ai = col('address');
    const li = col('label');
    const mi = col('min_eth');
    if (ai < 0) return reply.code(400).send({ error: 'The CSV needs a header row with an "address" column' });
    let added = 0;
    const errors: string[] = [];
    rows.forEach((r, i) => {
      const error = addWatchEntry(ctx.db, r[ai], li >= 0 ? r[li] : '', mi >= 0 ? r[mi] : '');
      if (error) errors.push(`row ${i + 2}: ${error}`);
      else added++;
    });
    return { added, errors };
  });

  app.delete('/api/watchlist/:address', async (req, reply) =>
    removeWatch(ctx.db, (req.params as { address: string }).address)
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'Not on the watchlist' }),
  );

  app.get('/api/sanctions', async () => {
    const s = ctx.getSanctions();
    return {
      version: s.version, loadedAt: s.loadedAt, size: s.entries.size, ofacCount: s.ofacCount, mockCount: s.mockCount,
      ...ctx.sanctionsMeta(), entries: [...s.entries.values()],
    };
  });

  app.get('/api/stats', async () => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return stats(ctx.db, Math.floor(dayStart.getTime() / 1000));
  });

  app.get('/api/inspect/:tx', async (req, reply) => {
    const tx = (req.params as { tx: string }).tx;
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return reply.code(400).send({ error: 'Enter a 0x-prefixed transaction hash (66 characters)' });
    try {
      const logs = await ctx.rpc.getReceiptLogs(tx);
      const visibleBefore = logs
        .filter((l) => l.address.toLowerCase() !== SYSTEM_ADDRESS)
        .map((l) => ({ address: l.address.toLowerCase(), topic0: l.topics[0] ?? null, logIndex: Number(l.logIndex) }));
      const ethTransfers = logs.flatMap((l) => {
        const t = decodeTransferLog(l);
        return t ? [{ from: t.from, to: t.to, valueEth: weiToEth(t.valueWei), logIndex: t.logIndex }] : [];
      });
      return { txHash: tx.toLowerCase(), visibleBefore, ethTransfers };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event: string) => (data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const handlers = { transfer: send('transfer'), alert: send('alert'), 'alert-updated': send('alert-updated') };
    for (const [event, fn] of Object.entries(handlers)) bus.on(event, fn);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      for (const [event, fn] of Object.entries(handlers)) bus.off(event, fn);
      clearInterval(ping);
    });
  });

  return app;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS, 4 tests.

---

### Task 11: Entry point and dashboard

**Files:** Create `src/index.ts`, `public/index.html`, `public/styles.css` and `public/app.js`.

- [ ] **Step 1: Write `src/index.ts`**

```ts
import path from 'node:path';
import { config, ROOT } from './config.js';
import { openDb } from './db.js';
import { startIngest } from './ingest.js';
import { makeRpc } from './rpc.js';
import { loadSanctions, ofacFileAgeMs, refreshFromOfac } from './sanctions.js';
import { buildServer } from './server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const db = openDb(config.dbPath);
const rpc = makeRpc(config.rpcUrl);
let sanctions = loadSanctions(config.dataDir);
const meta = { lastRefresh: null as number | null, lastRefreshError: null as string | null };

async function refreshSanctions() {
  try {
    const n = await refreshFromOfac(config.dataDir);
    sanctions = loadSanctions(config.dataDir);
    meta.lastRefresh = Date.now();
    meta.lastRefreshError = null;
    console.log(`[sanctions] refreshed from OFAC: ${n} ETH addresses, version ${sanctions.version}`);
  } catch (e) {
    meta.lastRefreshError = (e as Error).message;
    console.warn(`[sanctions] refresh failed, keeping the last good list: ${meta.lastRefreshError}`);
  }
}

console.log(`[sanctions] loaded ${sanctions.entries.size} addresses (${sanctions.ofacCount} OFAC, ${sanctions.mockCount} mock), version ${sanctions.version}`);
if (ofacFileAgeMs(config.dataDir) > DAY_MS) void refreshSanctions();
setInterval(() => void refreshSanctions(), DAY_MS).unref();

const stopIngest = startIngest(
  {
    db, rpc, getSanctions: () => sanctions, alertOpts: { webhookUrl: config.webhookUrl },
    startBlock: config.startBlock, maxBlocksPerPoll: config.maxBlocksPerPoll,
  },
  config.pollMs,
);

const app = buildServer({ db, rpc, getSanctions: () => sanctions, publicDir: path.join(ROOT, 'public'), sanctionsMeta: () => meta });
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`ETH Flow Monitor running at http://localhost:${config.port} (RPC: ${config.rpcUrl})`);

process.on('SIGINT', async () => {
  stopIngest();
  await app.close();
  db.close();
  process.exit(0);
});
```

- [ ] **Step 2: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ETH Flow Monitor</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="top">
    <strong>ETH Flow Monitor</strong>
    <form id="search" role="search">
      <input id="q" placeholder="Search address or tx hash" aria-label="Search address or transaction hash">
    </form>
    <span class="muted">Network: Sepolia</span>
  </header>
  <div class="layout">
    <nav aria-label="Main">
      <a href="#alerts">Alerts</a>
      <a href="#feed">Live feed</a>
      <a href="#watchlist">Watchlist</a>
      <a href="#sanctions">Sanctions list</a>
      <a href="#inspect">Tx inspector</a>
    </nav>
    <div class="content">
      <div id="live" class="status" role="status" aria-live="polite"></div>
      <main id="main" tabindex="-1"></main>
    </div>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `public/styles.css`**

```css
:root {
  --bg: #f7f7f5; --panel: #ffffff; --ink: #1d1d1b; --muted: #5f5f5a; --line: #d9d9d3;
  --accent: #2563eb; --accent-bg: #e8f0fe; --bad: #b42318; --bad-bg: #fdecea;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --panel: #1f1f1d; --ink: #eeeeea; --muted: #a3a39c; --line: #3a3a36;
    --accent: #7aa2ff; --accent-bg: #1e2a44; --bad: #ff8a80; --bad-bg: #3b1d1b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
a { color: var(--accent); }
.top { display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
.top form { flex: 1; display: flex; justify-content: center; }
.top input { width: min(420px, 100%); }
.layout { display: grid; grid-template-columns: 180px 1fr; min-height: calc(100vh - 54px); }
nav { border-right: 1px solid var(--line); padding: 12px 8px; display: flex; flex-direction: column; gap: 4px; background: var(--panel); }
nav a { color: var(--ink); text-decoration: none; padding: 6px 10px; border-radius: 6px; }
nav a[aria-current="page"] { background: var(--accent-bg); outline: 1.5px solid var(--accent); font-weight: 600; }
.content { min-width: 0; padding: 0 20px 20px; }
.status { min-height: 1.6em; padding: 8px 0; color: var(--muted); }
main:focus { outline: none; }
h2 { font-size: 16px; margin: 0; }
input, select, textarea, button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
button { cursor: pointer; }
button.primary { background: var(--accent-bg); border-color: var(--accent); font-weight: 600; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.tile span { color: var(--muted); font-size: 12px; }
.tile strong { display: block; font-size: 22px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
.table-wrap { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); }
.grid th, .grid td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.grid th { color: var(--muted); font-weight: 500; background: var(--bg); }
.grid tbody tr[tabindex] { cursor: pointer; }
.grid tbody tr[aria-selected="true"] { background: var(--accent-bg); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
.badge.sanctions { background: var(--bad-bg); color: var(--bad); border-color: var(--bad); font-weight: 600; }
.detail { margin-top: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.detail dl { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; margin: 12px 0; }
.detail dt { color: var(--muted); }
.detail dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.muted { color: var(--muted); }
.error { color: var(--bad); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; margin: 12px 0; }
form.inline label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .content { padding: 0 16px 16px; }
  .cols { grid-template-columns: 1fr; }
  .detail dl { grid-template-columns: 1fr; }
}
```

- [ ] **Step 4: Write `public/app.js`**

```js
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const ethFmt = (v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
const timeFmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
const txLink = (h) => `<a class="mono" href="https://sepolia.etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))}</a>`;
const REASON = { sanctions: 'Sanctions match', watchlist: 'Watchlist' };
const STATUS = { open: 'Open', reviewed: 'Reviewed', escalated: 'Escalated', false_positive: 'False positive' };
const KIND = { 'top-level': 'Top-level', internal: 'Internal' };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

const main = $('#main');
const live = $('#live');
let current = 'alerts';
let alertFilter = '';
let selectedId = null;
let feedQuery = { address: '', min: '' };

const views = { alerts: renderAlerts, feed: renderFeed, watchlist: renderWatchlist, sanctions: renderSanctions, inspect: renderInspect };

function route() {
  const [name, arg] = (location.hash.slice(1) || 'alerts').split('/');
  current = views[name] ? name : 'alerts';
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === `#${current}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  views[current](arg ? decodeURIComponent(arg) : undefined).catch((e) => {
    main.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`;
  });
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) location.hash = `#inspect/${q}`;
  else if (/^0x[0-9a-fA-F]{40}$/.test(q)) location.hash = `#feed/${q}`;
  else live.textContent = 'Enter a 0x address (42 characters) or a transaction hash (66 characters).';
});

const tile = (label, value) => `<div class="tile"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

async function renderAlerts() {
  const [s, alerts] = await Promise.all([api('/api/stats'), api(`/api/alerts${alertFilter ? `?status=${alertFilter}` : ''}`)]);
  const options = ['', 'open', 'escalated', 'reviewed', 'false_positive']
    .map((v) => `<option value="${v}" ${v === alertFilter ? 'selected' : ''}>${v ? STATUS[v] : 'All alerts'}</option>`).join('');
  const rows = alerts.map((a) => `
    <tr tabindex="0" data-id="${a.id}" aria-selected="${a.id === selectedId}">
      <td>${esc(timeFmt(a.timestamp))}</td><td class="mono">${esc(short(a.from_addr))}</td><td class="mono">${esc(short(a.to_addr))}</td>
      <td>${esc(ethFmt(a.value_eth))}</td><td>${esc(KIND[a.kind])}</td>
      <td><span class="badge ${esc(a.reason)}">${esc(REASON[a.reason])}</span></td><td>${esc(STATUS[a.status])}</td>
    </tr>`).join('');
  main.innerHTML = `
    <section class="tiles" aria-label="Summary">
      ${tile('Transfers today (UTC)', s.transfersToday)}${tile('Contract-internal today', s.internalToday)}
      ${tile('Open alerts', s.openAlerts)}${tile('Sanctions hits', s.sanctionsHits)}
    </section>
    <div class="bar"><h2>Alert queue</h2><label>Show <select id="filter">${options}</select></label></div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No alerts yet. Add a watched address, or wait for a sanctions hit.</td></tr>'}</tbody>
    </table></div>
    <section id="detail" class="detail" aria-live="polite"><p class="muted">Select an alert to see its detail.</p></section>
    <p class="muted">Last block processed: ${esc(s.lastBlock)}</p>`;
  $('#filter').addEventListener('change', (e) => { alertFilter = e.target.value; renderAlerts(); });
  main.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    const open = () => {
      selectedId = Number(tr.dataset.id);
      main.querySelectorAll('tbody tr').forEach((r) => r.setAttribute('aria-selected', String(r === tr)));
      showDetail(alerts.find((a) => a.id === selectedId));
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  const selected = alerts.find((a) => a.id === selectedId);
  if (selected) showDetail(selected);
}

function showDetail(a) {
  const d = $('#detail');
  d.innerHTML = `
    <h2>Alert #${a.id}: ${esc(REASON[a.reason])}</h2>
    <dl>
      <dt>From</dt><dd class="mono">${esc(a.from_addr)}</dd>
      <dt>To</dt><dd class="mono">${esc(a.to_addr)}</dd>
      <dt>Amount</dt><dd>${esc(ethFmt(a.value_eth))}</dd>
      <dt>Transfer type</dt><dd>${esc(KIND[a.kind])}${a.kind === 'internal' ? ' (made inside a contract; seen through its EIP-7708 log)' : ''}</dd>
      <dt>Transaction</dt><dd>${txLink(a.tx_hash)} · block ${esc(a.block_number)} · <a href="#inspect/${esc(a.tx_hash)}">inspect</a></dd>
      <dt>Matched</dt><dd>${esc(a.matched_entry)} <span class="mono">(${esc(a.matched_address)})</span></dd>
      ${a.list_version ? `<dt>List version</dt><dd class="mono">${esc(a.list_version)}</dd>` : ''}
      <dt>Status</dt><dd>${esc(STATUS[a.status])}</dd>
    </dl>
    <label for="note">Analyst note</label><br>
    <textarea id="note" rows="2" cols="60">${esc(a.note)}</textarea>
    <div class="actions">
      <button class="primary" data-status="escalated">Escalate</button>
      <button data-status="reviewed">Mark reviewed</button>
      <button data-status="false_positive">False positive</button>
      <a href="/api/transfers.csv?address=${esc(a.matched_address)}" download>Export CSV for this address</a>
    </div>`;
  d.querySelectorAll('button[data-status]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status, note: $('#note').value }) });
      live.textContent = `Alert #${a.id} marked ${STATUS[b.dataset.status]}.`;
      renderAlerts();
    } catch (e) {
      live.textContent = e.message;
    }
  }));
}

const feedRow = (t) => `<tr>
  <td>${esc(timeFmt(t.timestamp))}</td><td>${esc(t.block_number)}</td>
  <td class="mono">${esc(short(t.from_addr))}</td><td class="mono">${esc(short(t.to_addr))}</td>
  <td>${esc(ethFmt(t.value_eth))}</td><td>${esc(KIND[t.kind])}</td><td>${txLink(t.tx_hash)}</td></tr>`;

async function renderFeed(address) {
  if (address !== undefined) feedQuery.address = address;
  const params = new URLSearchParams(Object.entries(feedQuery).filter(([, v]) => v));
  const rows = await api(`/api/transfers?${params}&limit=200`);
  main.innerHTML = `
    <div class="bar"><h2>Live feed</h2><a href="/api/transfers.csv?${params}" download>Export CSV</a></div>
    <form class="inline" id="ff">
      <label>Address<input name="address" value="${esc(feedQuery.address)}" size="44" placeholder="0x…"></label>
      <label>Minimum ETH<input name="min" value="${esc(feedQuery.min)}" size="8" inputmode="decimal"></label>
      <button>Filter</button>
    </form>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>Block</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Tx</th></tr></thead>
      <tbody id="feed-rows">${rows.map(feedRow).join('') || '<tr><td colspan="7" class="muted">No transfers yet. New blocks arrive about every 12 seconds.</td></tr>'}</tbody>
    </table></div>`;
  $('#ff').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    feedQuery = { address: String(f.get('address')).trim(), min: String(f.get('min')).trim() };
    if (location.hash !== '#feed') location.hash = '#feed';
    else renderFeed();
  });
}

async function renderWatchlist() {
  const rows = await api('/api/watchlist');
  main.innerHTML = `
    <h2>Watchlist</h2>
    <form class="inline" id="wf">
      <label>Address<input name="address" required size="44" placeholder="0x…"></label>
      <label>Label<input name="label" size="20"></label>
      <label>Alert at or above (ETH)<input name="min_eth" size="8" placeholder="0" inputmode="decimal"></label>
      <button class="primary">Add</button>
    </form>
    <form class="inline" id="uf">
      <label>Upload CSV (columns: address, label, min_eth)<input type="file" id="csv" accept=".csv,text/csv"></label>
      <button>Upload</button>
    </form>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Address</th><th>Label</th><th>Minimum</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows.map((w) => `<tr><td class="mono">${esc(w.address)}</td><td>${esc(w.label)}</td><td>${esc(ethFmt(Number(w.min_wei) / 1e18))}</td>
        <td>${esc(timeFmt(w.created_at))}</td><td><button data-del="${esc(w.address)}">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No watched addresses yet.</td></tr>'}</tbody>
    </table></div>`;
  $('#wf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/watchlist', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      live.textContent = 'Address added to the watchlist.';
      renderWatchlist();
    } catch (err) {
      live.textContent = err.message;
    }
  });
  $('#uf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#csv').files[0];
    if (!file) return;
    try {
      const r = await api('/api/watchlist/upload', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
      live.textContent = `Added ${r.added} address(es).${r.errors.length ? ` Problems: ${r.errors.join('; ')}` : ''}`;
      renderWatchlist();
    } catch (err) {
      live.textContent = err.message;
    }
  });
  main.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/watchlist/${b.dataset.del}`, { method: 'DELETE' });
    live.textContent = 'Address removed.';
    renderWatchlist();
  }));
}

async function renderSanctions() {
  const s = await api('/api/sanctions');
  const refresh = s.lastRefreshError
    ? `The last refresh failed (${esc(s.lastRefreshError)}), so the last good list is in use.`
    : s.lastRefresh
      ? `Refreshed from OFAC ${esc(new Date(s.lastRefresh).toLocaleString())}.`
      : 'Using the saved list. It refreshes from OFAC when it is more than a day old.';
  main.innerHTML = `
    <h2>Sanctions list</h2>
    <p>${esc(s.size)} ETH addresses: ${esc(s.ofacCount)} from the OFAC SDN list and ${esc(s.mockCount)} from the mock demo list.
      Version <span class="mono">${esc(s.version)}</span>, loaded ${esc(new Date(s.loadedAt).toLocaleString())}.</p>
    <p class="muted">${refresh} OFAC says its address listings are not exhaustive, so a clean result does not prove an address is safe.</p>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Address</th><th>Name</th><th>Program</th><th>Source</th></tr></thead>
      <tbody>${s.entries.map((e) => `<tr><td class="mono">${esc(e.address)}</td><td>${esc(e.name)}</td><td>${esc(e.program)}</td>
        <td>${e.source === 'mock' ? 'Mock (demo)' : 'OFAC SDN'}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

async function renderInspect(hash) {
  main.innerHTML = `
    <h2>Tx inspector</h2>
    <p class="muted">Compare what a log-based tool could see before EIP-7708 with the ETH Transfer logs that Glamsterdam adds.</p>
    <form class="inline" id="if">
      <label>Transaction hash<input name="tx" size="70" value="${esc(hash ?? '')}" placeholder="0x…" required></label>
      <button class="primary">Inspect</button>
    </form>
    <div id="ir"></div>`;
  $('#if').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#inspect/${String(new FormData(e.target).get('tx')).trim()}`;
  });
  if (!hash) return;
  const r = $('#ir');
  r.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api(`/api/inspect/${hash}`);
    const before = d.visibleBefore.length
      ? `<ul>${d.visibleBefore.map((l) => `<li><span class="mono">${esc(short(l.address))}</span> log #${esc(l.logIndex)}</li>`).join('')}</ul>`
      : '<p>No logs. Any ETH this transaction moved inside contracts left no record a log-based tool could read.</p>';
    const after = d.ethTransfers.length
      ? `<ul>${d.ethTransfers.map((t) => `<li><span class="mono">${esc(short(t.from))} → ${esc(short(t.to))}</span>: ${esc(ethFmt(t.valueEth))} (log #${esc(t.logIndex)})</li>`).join('')}</ul>`
      : '<p>This transaction moved no ETH.</p>';
    r.innerHTML = `
      <div class="cols">
        <section class="detail"><h2>Before 7708: other logs (${d.visibleBefore.length})</h2>${before}</section>
        <section class="detail"><h2>With 7708: ETH Transfer logs (${d.ethTransfers.length})</h2>${after}</section>
      </div>
      <p>${txLink(d.txHash)}</p>`;
  } catch (e) {
    r.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`;
  }
}

const events = new EventSource('/api/stream');
events.addEventListener('alert', (e) => {
  const a = JSON.parse(e.data);
  live.textContent = `New alert: ${REASON[a.reason]}, ${a.matched_entry}, ${ethFmt(a.value_eth)}.`;
  if (current === 'alerts') renderAlerts();
});
events.addEventListener('alert-updated', () => { if (current === 'alerts') renderAlerts(); });
events.addEventListener('transfer', (e) => {
  if (current !== 'feed') return;
  const t = JSON.parse(e.data);
  const a = feedQuery.address.toLowerCase();
  if (a && t.from_addr !== a && t.to_addr !== a) return;
  if (feedQuery.min && t.value_eth < Number(feedQuery.min)) return;
  const body = $('#feed-rows');
  if (!body) return;
  if (body.querySelector('td[colspan]')) body.innerHTML = '';
  body.insertAdjacentHTML('afterbegin', feedRow(t));
  while (body.rows.length > 200) body.deleteRow(-1);
});

window.addEventListener('hashchange', route);
route();
```

- [ ] **Step 5: Typecheck and run all the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, and all 29 tests PASS.

---

### Task 12: Smoke test and demo script

**Files:** Create `scripts/smoke.ts`, `scripts/demo-internal-transfer.ts` and `README.md`.

- [ ] **Step 1: Write `scripts/smoke.ts`**

```ts
import { classify } from '../src/classify.js';
import { config } from '../src/config.js';
import { decodeTransferLog, type Transfer } from '../src/decode.js';
import { makeRpc } from '../src/rpc.js';

const rpc = makeRpc(config.rpcUrl);
const head = await rpc.blockNumber();
let total = 0;
let internal = 0;
for (let n = head - 4; n <= head; n++) {
  const transfers = (await rpc.getTransferLogs(n)).map(decodeTransferLog).filter((t): t is Transfer => t !== null);
  const byTx = new Map<string, Transfer[]>();
  for (const t of transfers) byTx.set(t.txHash, [...(byTx.get(t.txHash) ?? []), t]);
  for (const [hash, list] of byTx) {
    const kinds = classify(list, await rpc.getTx(hash)).map((t) => t.kind);
    internal += kinds.filter((k) => k === 'internal').length;
  }
  total += transfers.length;
  console.log(`block ${n}: ${transfers.length} ETH transfer log(s)`);
}
console.log(`Total: ${total} ETH transfers in 5 blocks (${internal} contract-internal) via ${config.rpcUrl}`);
if (total === 0) {
  console.error('No EIP-7708 logs found. Check that RPC_URL points at Sepolia (Glamsterdam is live there since 2026-10-06).');
  process.exit(1);
}
```

- [ ] **Step 2: Run the smoke test**

Run: `npm run smoke`
Expected: 5 `block N:` lines, then `Total: X ETH transfers…` with X > 0, and exit code 0.

- [ ] **Step 3: Write `scripts/demo-internal-transfer.ts`**

The forwarder is 23 bytes of hand-assembled EVM bytecode: `CALL(gas, calldataload(0), callvalue, 0, 0, 0, 0)`, and `REVERT` if the call fails. The 11-byte init code in front of it copies the runtime code and returns it.

```ts
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, formatEther, http, isAddress, pad, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { config } from '../src/config.js';
import { parseCsv } from '../src/csv.js';
import { MOCK_FILE } from '../src/sanctions.js';

/** init code (601780600b6000396000f3) + runtime (forward msg.value to the address in calldata[0:32]). */
const FORWARDER_DEPLOY_CODE: Hex = '0x601780600b6000396000f36000600060006000346000355af1601557600080fd5b00';

const key = process.env.DEMO_PRIVATE_KEY as Hex | undefined;
if (!key) {
  console.error('Set DEMO_PRIVATE_KEY in .env to the key of a throwaway Sepolia test wallet (never a wallet with real funds).');
  process.exit(1);
}

function firstMockAddress(): string | undefined {
  const file = path.join(config.dataDir, MOCK_FILE);
  if (!fs.existsSync(file)) return undefined;
  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows[0]?.[head!.indexOf('address')];
}

const recipient = process.env.DEMO_RECIPIENT || firstMockAddress();
if (!recipient || !isAddress(recipient, { strict: false })) {
  console.error('Set DEMO_RECIPIENT in .env, or put an address in data/mock_sanctions.csv.');
  process.exit(1);
}

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(config.rpcUrl) });
console.log(`Wallet ${account.address}: ${formatEther(await publicClient.getBalance({ address: account.address }))} Sepolia ETH`);

let forwarder = process.env.DEMO_FORWARDER as Hex | undefined;
if (!forwarder) {
  console.log('Deploying the forwarder contract…');
  const deployHash = await wallet.deployContract({ abi: [], bytecode: FORWARDER_DEPLOY_CODE });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  forwarder = receipt.contractAddress!;
  console.log(`Forwarder deployed at ${forwarder}. Add DEMO_FORWARDER=${forwarder} to .env to reuse it next time.`);
}

const amount = parseEther(process.env.DEMO_AMOUNT_ETH || '0.0001');
console.log(`Sending ${formatEther(amount)} ETH: wallet -> forwarder -> ${recipient}`);
const hash = await wallet.sendTransaction({ to: forwarder, value: amount, data: pad(recipient as Hex, { size: 32 }) });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') {
  console.error(`Transaction reverted: ${hash}`);
  process.exit(1);
}
console.log(`Done in block ${receipt.blockNumber}. Transaction: ${hash}`);
console.log(`The wallet -> forwarder leg is top-level; the forwarder -> recipient leg is contract-internal.`);
console.log(`Inspect it: http://localhost:${config.port}/#inspect/${hash}`);
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Write `README.md`**

````markdown
# ETH Flow Monitor (prototype)

This app tracks every native ETH transfer on Sepolia, including transfers made inside smart contracts, using the logs that EIP-7708 (Glamsterdam) adds. It flags transfers that touch the OFAC sanctions list or your watchlist and shows them in a local dashboard.

## Run it

```bash
npm install
npm test
npm run smoke
npm start
```

Then open http://localhost:3000. Settings are in `.env` (copy `.env.example`). The default RPC is a free public Sepolia endpoint.

## Live demo of a contract-internal transfer

1. Create a throwaway Sepolia wallet, fund it from a Sepolia faucet, and put its key in `.env` as `DEMO_PRIVATE_KEY`. Never use a wallet that holds real funds.
2. With `npm start` running, run `npm run demo` in a second terminal. It deploys a tiny forwarder contract and sends ETH through it to the mock sanctioned address in `data/mock_sanctions.csv`.
3. Within about 15 seconds the dashboard shows a sanctions alert for the contract-internal leg. Open the tx inspector link the script prints to see the before/after comparison.

The real SDN addresses (`data/demo_screening_set.csv`: Lazarus Group and Garantex) are used only in the replay test (`npm test`). The demo never sends ETH to them.

## Data

- `data/ofac_sdn_eth_addresses.csv` holds the ETH addresses on the OFAC SDN list. It refreshes daily, and if a refresh fails the last good copy is kept.
- `data/mock_sanctions.csv` holds the mock list for the live demo.
- `flow-monitor.db` is the SQLite store. Delete it to start fresh.
````

---

### Task 13: End-to-end check

- [ ] **Step 1: Full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: everything PASSES.

- [ ] **Step 2: Start the app**

Run (in the background): `npm start`
Expected log lines:
- `[sanctions] loaded 88 addresses (87 OFAC, 1 mock)…`
- `ETH Flow Monitor running at http://localhost:3000`
- within about 30 seconds, `[ingest] processed 1 block(s)…`

- [ ] **Step 3: Exercise the dashboard in a browser**

Open http://localhost:3000 and check each view:
- **Live feed:** rows appear as new blocks arrive.
- **Watchlist:** add the `to` address of a recent feed row with minimum 0. The next transfer to that address raises a watchlist alert.
- **Alerts:** select the alert, click Mark reviewed, and confirm the status changes.
- **Tx inspector:** paste a feed row's tx hash and confirm the right column lists its ETH Transfer logs.

- [ ] **Step 4: Live demo (needs the user's test-wallet key)**

The user sets `DEMO_PRIVATE_KEY` and runs `npm run demo`. Expected: a sanctions alert whose Type is "Internal" and whose Matched entry is "DEMO SANCTIONED WALLET (mock)".
