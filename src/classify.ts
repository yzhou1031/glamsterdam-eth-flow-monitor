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
