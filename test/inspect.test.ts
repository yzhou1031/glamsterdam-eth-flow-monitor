import { describe, expect, it } from 'vitest';
import { SYSTEM_ADDRESS, TRANSFER_TOPIC, type RpcLog } from '../src/decode.js';
import { inspectTx } from '../src/inspect.js';

const A = '0x' + 'a'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const word = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2);
const TX = '0x' + '1'.repeat(64);
const base = { transactionHash: TX, blockNumber: '0x1', blockHash: '0xh1' };

const logs: RpcLog[] = [
  { ...base, address: SYSTEM_ADDRESS, topics: [TRANSFER_TOPIC, word(A), word(C)], data: '0x' + (10n ** 18n).toString(16).padStart(64, '0'), logIndex: '0x0' },
  { ...base, address: '0x1C7D4B196Cb0C7B01d743Fbc6116a902379C7238', topics: [TRANSFER_TOPIC, word(C), word(A)], data: '0x' + '0'.repeat(63) + '1', logIndex: '0x1' },
];

describe('inspectTx', () => {
  it('splits a receipt into logs visible before 7708 and the new ETH Transfer logs', async () => {
    const r = await inspectTx(async () => logs, TX.toUpperCase().replace('0X', '0x'));
    expect(r).toEqual({
      txHash: TX,
      visibleBefore: [{ address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', topic0: TRANSFER_TOPIC, logIndex: 1 }],
      ethTransfers: [{ from: A, to: C, valueEth: 1, logIndex: 0 }],
    });
  });
});
