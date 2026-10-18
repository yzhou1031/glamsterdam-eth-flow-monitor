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
