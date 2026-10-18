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
