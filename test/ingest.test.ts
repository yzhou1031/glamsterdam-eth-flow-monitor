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
