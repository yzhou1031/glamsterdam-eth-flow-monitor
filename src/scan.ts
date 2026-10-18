import { classify, type TxInfo } from './classify.js';
import { decodeTransferLog, weiToEth, type ClassifiedTransfer, type RpcLog, type Transfer } from './decode.js';
import type { BlockHeader } from './rpc.js';
import type { SanctionsList } from './sanctions.js';
import { screen, type Match } from './screen.js';

/** The RPC calls a stateless scan needs: 2 per block. */
export interface ScanRpc {
  blockNumber(): Promise<number>;
  getBlockWithTxs(n: number): Promise<{ header: BlockHeader; txs: Map<string, TxInfo> }>;
  getTransferLogs(n: number): Promise<RpcLog[]>;
}

/** Same field names as a stored TransferRow, so the dashboards can share rendering code. */
export interface ScannedTransfer {
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
  matches: Match[];
}

export interface ScanResult {
  head: number;
  /** Newest block with enough confirmations to be served. */
  safeHead: number;
  fromBlock: number;
  /** Last block scanned; the caller asks for toBlock + 1 next time. */
  toBlock: number;
  /** Blocks skipped because the caller had fallen more than maxLag blocks behind. */
  skipped: number;
  sanctionsVersion: string;
  transfers: ScannedTransfer[];
}

export interface ScanOptions {
  from?: number;
  maxBlocks?: number;
  confirmations?: number;
  maxLag?: number;
}

async function scanOne(rpc: ScanRpc, sanctions: SanctionsList, n: number): Promise<ScannedTransfer[]> {
  const [{ header, txs }, logs] = await Promise.all([rpc.getBlockWithTxs(n), rpc.getTransferLogs(n)]);
  const byTx = new Map<string, Transfer[]>();
  for (const log of logs) {
    if (log.removed) continue;
    const t = decodeTransferLog(log);
    if (!t) continue;
    const list = byTx.get(t.txHash) ?? [];
    list.push({ ...t, timestamp: t.timestamp ?? header.timestamp });
    byTx.set(t.txHash, list);
  }
  const out: ScannedTransfer[] = [];
  for (const [hash, list] of byTx) {
    const tx = txs.get(hash);
    const classified: ClassifiedTransfer[] = tx ? classify(list, tx) : list.map((t) => ({ ...t, kind: 'internal' }));
    for (const t of classified) {
      out.push({
        block_number: t.blockNumber, block_hash: t.blockHash, tx_hash: t.txHash, log_index: t.logIndex,
        from_addr: t.from, to_addr: t.to, value_wei: t.valueWei.toString(), value_eth: weiToEth(t.valueWei),
        kind: t.kind, timestamp: t.timestamp, matches: screen(t, sanctions, () => undefined),
      });
    }
  }
  return out.sort((a, b) => a.log_index - b.log_index);
}

/** Stateless scan for serverless hosting: no database, no background loop. Watchlists are applied by the caller. */
export async function scanBlocks(rpc: ScanRpc, sanctions: SanctionsList, opts: ScanOptions = {}): Promise<ScanResult> {
  const maxBlocks = opts.maxBlocks ?? 5;
  const maxLag = opts.maxLag ?? 50;
  const head = await rpc.blockNumber();
  const safeHead = head - (opts.confirmations ?? 1);
  let from = opts.from ?? safeHead - 2;
  let skipped = 0;
  if (safeHead - from + 1 > maxLag) {
    const caughtUp = safeHead - maxBlocks + 1;
    skipped = caughtUp - from;
    from = caughtUp;
  }
  const to = Math.min(from + maxBlocks - 1, safeHead);
  const numbers: number[] = [];
  for (let n = from; n <= to; n++) numbers.push(n);
  const perBlock = await Promise.all(numbers.map((n) => scanOne(rpc, sanctions, n)));
  return {
    head, safeHead, fromBlock: from, toBlock: Math.max(to, from - 1), skipped,
    sanctionsVersion: sanctions.version, transfers: perBlock.flat(),
  };
}
