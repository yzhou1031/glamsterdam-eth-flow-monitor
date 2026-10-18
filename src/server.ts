import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { isAddress, parseEther } from 'viem';
import { bus } from './alerts.js';
import { parseCsv, toCsv } from './csv.js';
import {
  ALERT_STATUSES, getAlertView, listAlerts, listWatch, queryTransfers, removeWatch, stats, updateAlert, upsertWatch,
  type AlertStatus, type Db, type TransferQuery,
} from './db.js';
import { inspectTx, TX_HASH_RE } from './inspect.js';
import type { Rpc } from './rpc.js';
import type { SanctionsList } from './sanctions.js';

export interface ServerContext {
  db: Db;
  rpc: Rpc;
  getSanctions: () => SanctionsList;
  publicDir: string;
  sanctionsMeta: () => { lastRefresh: number | null; lastRefreshError: string | null };
}

type Query = Record<string, string | undefined>;

function parseTransferQuery(q: Query): TransferQuery {
  const day = (d?: string) => (d ? Math.floor(Date.parse(d) / 1000) : undefined);
  const to = day(q.to);
  return {
    address: q.address?.trim() || undefined,
    minEth: q.min ? Number(q.min) : undefined,
    fromTs: day(q.from),
    toTs: to === undefined ? undefined : to + 86_400,
    limit: q.limit ? Number(q.limit) : undefined,
  };
}

/** Returns an error message, or null when the entry was saved. */
function addWatchEntry(db: Db, address?: string, label?: string, minEth?: string | number): string | null {
  const a = (address ?? '').trim();
  if (!isAddress(a, { strict: false })) return `not a valid address: ${a || '(empty)'}`;
  let minWei = 0n;
  const m = String(minEth ?? '').trim();
  if (m) {
    try {
      minWei = parseEther(m);
    } catch {
      return `min_eth must be a number: ${m}`;
    }
    if (minWei < 0n) return 'min_eth cannot be negative';
  }
  upsertWatch(db, a, (label ?? '').trim(), minWei);
  return null;
}

export function buildServer(ctx: ServerContext) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.register(fastifyStatic, { root: ctx.publicDir });

  app.get('/api/transfers', async (req) => queryTransfers(ctx.db, parseTransferQuery(req.query as Query)));

  app.get('/api/transfers.csv', async (req, reply) => {
    const rows = queryTransfers(ctx.db, { ...parseTransferQuery(req.query as Query), limit: 5000 });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="eth-transfers.csv"');
    return toCsv(
      ['block_number', 'timestamp_utc', 'tx_hash', 'log_index', 'from', 'to', 'value_eth', 'value_wei', 'kind'],
      rows.map((r) => [
        r.block_number, r.timestamp ? new Date(r.timestamp * 1000).toISOString() : '', r.tx_hash, r.log_index,
        r.from_addr, r.to_addr, r.value_eth, r.value_wei, r.kind,
      ]),
    );
  });

  app.get('/api/alerts', async (req) => listAlerts(ctx.db, (req.query as Query).status || undefined));

  app.patch('/api/alerts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { status?: string; note?: string };
    const current = getAlertView(ctx.db, id);
    if (!current) return reply.code(404).send({ error: 'Alert not found' });
    const status = (body.status ?? current.status) as AlertStatus;
    if (!ALERT_STATUSES.includes(status)) return reply.code(400).send({ error: `status must be one of: ${ALERT_STATUSES.join(', ')}` });
    updateAlert(ctx.db, id, status, body.note ?? current.note);
    const updated = getAlertView(ctx.db, id)!;
    bus.emit('alert-updated', updated);
    return updated;
  });

  app.get('/api/watchlist', async () => listWatch(ctx.db));

  app.post('/api/watchlist', async (req, reply) => {
    const b = (req.body ?? {}) as { address?: string; label?: string; min_eth?: string | number };
    const error = addWatchEntry(ctx.db, b.address, b.label, b.min_eth);
    if (error) return reply.code(400).send({ error });
    return reply.code(201).send(listWatch(ctx.db));
  });

  app.post('/api/watchlist/upload', async (req, reply) => {
    const [head, ...rows] = parseCsv(String(req.body ?? ''));
    const col = (name: string) => (head ?? []).findIndex((h) => h.trim().toLowerCase() === name);
    const ai = col('address');
    const li = col('label');
    const mi = col('min_eth');
    if (ai < 0) return reply.code(400).send({ error: 'The CSV needs a header row with an "address" column' });
    let added = 0;
    const errors: string[] = [];
    rows.forEach((r, i) => {
      const error = addWatchEntry(ctx.db, r[ai], li >= 0 ? r[li] : '', mi >= 0 ? r[mi] : '');
      if (error) errors.push(`row ${i + 2}: ${error}`);
      else added++;
    });
    return { added, errors };
  });

  app.delete('/api/watchlist/:address', async (req, reply) =>
    removeWatch(ctx.db, (req.params as { address: string }).address)
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'Not on the watchlist' }),
  );

  app.get('/api/sanctions', async () => {
    const s = ctx.getSanctions();
    return {
      version: s.version, loadedAt: s.loadedAt, size: s.entries.size, ofacCount: s.ofacCount, mockCount: s.mockCount,
      ...ctx.sanctionsMeta(), entries: [...s.entries.values()],
    };
  });

  app.get('/api/stats', async () => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    return stats(ctx.db, Math.floor(dayStart.getTime() / 1000));
  });

  app.get('/api/inspect/:tx', async (req, reply) => {
    const tx = (req.params as { tx: string }).tx;
    if (!TX_HASH_RE.test(tx)) return reply.code(400).send({ error: 'Enter a 0x-prefixed transaction hash (66 characters)' });
    try {
      return await inspectTx((h) => ctx.rpc.getReceiptLogs(h), tx);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event: string) => (data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const handlers = { transfer: send('transfer'), alert: send('alert'), 'alert-updated': send('alert-updated') };
    for (const [event, fn] of Object.entries(handlers)) bus.on(event, fn);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      for (const [event, fn] of Object.entries(handlers)) bus.off(event, fn);
      clearInterval(ping);
    });
  });

  return app;
}
