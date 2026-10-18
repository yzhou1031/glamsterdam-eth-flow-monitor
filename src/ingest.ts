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
