import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import type { TxInfo } from '../src/classify.js';
import { SYSTEM_ADDRESS, TRANSFER_TOPIC, type RpcLog } from '../src/decode.js';
import type { BlockHeader } from '../src/rpc.js';
import type { SanctionsList } from '../src/sanctions.js';
import { scanBlocks, type ScanRpc } from '../src/scan.js';

const A = '0x' + 'a'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const word = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2);

class FakeScan implements ScanRpc {
  head = 10;
  calls: number[] = [];
  blocks = new Map<number, { txs: Map<string, TxInfo>; logs: RpcLog[] }>();

  add(n: number, txHash: string, tx: TxInfo, legs: { from: string; to: string; value: bigint }[]) {
    this.blocks.set(n, {
      txs: new Map([[txHash, tx]]),
      logs: legs.map((l, i) => ({
        address: SYSTEM_ADDRESS,
        topics: [TRANSFER_TOPIC, word(l.from), word(l.to)],
        data: '0x' + l.value.toString(16).padStart(64, '0'),
        transactionHash: txHash,
        blockNumber: toHex(n),
        blockHash: `0xh${n}`,
        logIndex: toHex(i),
      })),
    });
  }

  async blockNumber() { return this.head; }
  async getBlockWithTxs(n: number) {
    this.calls.push(n);
    const header: BlockHeader = { number: n, hash: `0xh${n}`, parentHash: `0xh${n - 1}`, timestamp: 1_790_000_000 + n * 12 };
    return { header, txs: this.blocks.get(n)?.txs ?? new Map<string, TxInfo>() };
  }
  async getTransferLogs(n: number) { return this.blocks.get(n)?.logs ?? []; }
}

const sanctions: SanctionsList = {
  version: 'snap@2026-10-14', loadedAt: 0, ofacCount: 1, mockCount: 0,
  entries: new Map([[BAD, { address: BAD, name: 'LAZARUS GROUP', program: 'DPRK3', source: 'ofac' as const }]]),
};

describe('scanBlocks', () => {
  it('scans the last 3 confirmed blocks by default, classifying and screening each transfer', async () => {
    const rpc = new FakeScan();
    rpc.add(9, '0x09', { from: A, to: C, value: 5n }, [{ from: A, to: C, value: 5n }, { from: C, to: BAD, value: 5n }]);
    const r = await scanBlocks(rpc, sanctions);
    expect(r).toMatchObject({ head: 10, safeHead: 9, fromBlock: 7, toBlock: 9, skipped: 0, sanctionsVersion: 'snap@2026-10-14' });
    expect(rpc.calls.sort()).toEqual([7, 8, 9]);
    expect(r.transfers.map((t) => [t.from_addr, t.to_addr, t.kind])).toEqual([[A, C, 'top-level'], [C, BAD, 'internal']]);
    expect(r.transfers[1]).toMatchObject({ value_wei: '5', block_number: 9, timestamp: 1_790_000_108 });
    expect(r.transfers[1]!.matches).toEqual([
      { reason: 'sanctions', matchedAddress: BAD, matchedEntry: 'LAZARUS GROUP (DPRK3; OFAC SDN)', listVersion: 'snap@2026-10-14' },
    ]);
    expect(r.transfers[0]!.matches).toEqual([]);
  });

  it('scans at most maxBlocks blocks from the requested block', async () => {
    const rpc = new FakeScan();
    rpc.head = 100;
    const r = await scanBlocks(rpc, sanctions, { from: 80, maxBlocks: 5 });
    expect([r.fromBlock, r.toBlock]).toEqual([80, 84]);
  });

  it('returns nothing (and the same next block) when the caller is caught up', async () => {
    const rpc = new FakeScan();
    const r = await scanBlocks(rpc, sanctions, { from: 10 });
    expect(r).toMatchObject({ fromBlock: 10, toBlock: 9, transfers: [] });
    expect(rpc.calls).toEqual([]);
  });

  it('skips ahead when the caller has fallen too far behind', async () => {
    const rpc = new FakeScan();
    rpc.head = 1000;
    const r = await scanBlocks(rpc, sanctions, { from: 100, maxBlocks: 5, maxLag: 50 });
    expect(r).toMatchObject({ fromBlock: 995, toBlock: 999, skipped: 895 });
  });
});
