import { createPublicClient, http, toHex, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import type { TxInfo } from './classify.js';
import { SYSTEM_ADDRESS, TRANSFER_TOPIC, type RpcLog } from './decode.js';
import type { ScanRpc } from './scan.js';

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

/** `batch` groups concurrent calls into one HTTP request (used on Vercel, where each poll scans several blocks at once). */
export function makeRpc(url: string, opts: { batch?: boolean } = {}): Rpc & ScanRpc {
  const client = createPublicClient({ chain: sepolia, transport: http(url, { retryCount: 2, timeout: 15_000, batch: opts.batch ?? false }) });
  return {
    async getBlockWithTxs(n) {
      const b = await client.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
      const txs = new Map<string, TxInfo>();
      for (const tx of b.transactions) {
        txs.set(tx.hash.toLowerCase(), { from: tx.from.toLowerCase(), to: tx.to ? tx.to.toLowerCase() : null, value: tx.value });
      }
      const header = { number: Number(b.number), hash: b.hash!.toLowerCase(), parentHash: b.parentHash.toLowerCase(), timestamp: Number(b.timestamp) };
      return { header, txs };
    },
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
