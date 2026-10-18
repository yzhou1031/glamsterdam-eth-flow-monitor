import { decodeTransferLog, SYSTEM_ADDRESS, weiToEth, type RpcLog } from './decode.js';

export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface Inspection {
  txHash: string;
  /** Logs a log-based tool could already read before EIP-7708. */
  visibleBefore: { address: string; topic0: string | null; logIndex: number }[];
  /** The ETH Transfer logs that EIP-7708 adds. */
  ethTransfers: { from: string; to: string; valueEth: number; logIndex: number }[];
}

export async function inspectTx(getReceiptLogs: (hash: string) => Promise<RpcLog[]>, tx: string): Promise<Inspection> {
  const logs = await getReceiptLogs(tx);
  const visibleBefore = logs
    .filter((l) => l.address.toLowerCase() !== SYSTEM_ADDRESS)
    .map((l) => ({ address: l.address.toLowerCase(), topic0: l.topics[0] ?? null, logIndex: Number(l.logIndex) }));
  const ethTransfers = logs.flatMap((l) => {
    const t = decodeTransferLog(l);
    return t ? [{ from: t.from, to: t.to, valueEth: weiToEth(t.valueWei), logIndex: t.logIndex }] : [];
  });
  return { txHash: tx.toLowerCase(), visibleBefore, ethTransfers };
}
