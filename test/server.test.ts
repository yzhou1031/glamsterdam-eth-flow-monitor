import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordAlerts } from '../src/alerts.js';
import { insertTransfer, openDb } from '../src/db.js';
import type { Rpc } from '../src/rpc.js';
import type { SanctionsList } from '../src/sanctions.js';
import { buildServer } from '../src/server.js';

const A = '0x' + 'a'.repeat(40);
const BAD = '0x' + 'b'.repeat(40);
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'efm-public-'));
const sanctions: SanctionsList = { version: 'v', loadedAt: 0, ofacCount: 0, mockCount: 0, entries: new Map() };
const rpc = {} as Rpc;

function setup() {
  const db = openDb(':memory:');
  const app = buildServer({ db, rpc, getSanctions: () => sanctions, publicDir, sanctionsMeta: () => ({ lastRefresh: null, lastRefreshError: null }) });
  return { db, app };
}

describe('watchlist API', () => {
  it('rejects an invalid address and stores a valid one with its minimum in wei', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/watchlist', payload: { address: 'nope' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/watchlist', payload: { address: A, label: 'Client A', min_eth: '0.5' } });
    expect(ok.statusCode).toBe(201);
    const list = (await app.inject({ url: '/api/watchlist' })).json();
    expect(list[0]).toMatchObject({ address: A, label: 'Client A', min_wei: '500000000000000000' });
  });

  it('imports a CSV and reports bad rows', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST', url: '/api/watchlist/upload', headers: { 'content-type': 'text/csv' },
      payload: `address,label,min_eth\n${A},One,\nnot-an-address,Two,1\n`,
    });
    expect(res.json()).toEqual({ added: 1, errors: ['row 3: not a valid address: not-an-address'] });
  });
});

describe('alerts API', () => {
  it('updates status and note, and rejects an unknown status', async () => {
    const { db, app } = setup();
    const row = insertTransfer(db, { from: A, to: BAD, valueWei: 10n, txHash: '0x01', blockNumber: 1, blockHash: '0xh1', logIndex: 0, timestamp: 1, kind: 'internal' })!;
    const [alert] = recordAlerts(db, row, [{ reason: 'sanctions', matchedAddress: BAD, matchedEntry: 'TEST', listVersion: 'v' }]);
    const res = await app.inject({ method: 'PATCH', url: `/api/alerts/${alert!.id}`, payload: { status: 'escalated', note: 'sent to compliance lead' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'escalated', note: 'sent to compliance lead', to_addr: BAD });
    expect((await app.inject({ method: 'PATCH', url: `/api/alerts/${alert!.id}`, payload: { status: 'done' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/alerts/999', payload: { status: 'reviewed' } })).statusCode).toBe(404);
  });
});

describe('transfers CSV export', () => {
  it('returns a CSV with a header row', async () => {
    const { db, app } = setup();
    insertTransfer(db, { from: A, to: BAD, valueWei: 10n ** 18n, txHash: '0x02', blockNumber: 2, blockHash: '0xh2', logIndex: 0, timestamp: 1_790_000_000, kind: 'top-level' });
    const res = await app.inject({ url: `/api/transfers.csv?address=${A}` });
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('block_number,timestamp_utc,tx_hash,log_index,from,to,value_eth,value_wei,kind');
    expect(lines[1]).toContain(',1,1000000000000000000,top-level');
  });
});
