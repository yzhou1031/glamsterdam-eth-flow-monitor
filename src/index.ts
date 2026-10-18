import path from 'node:path';
import { config, ROOT } from './config.js';
import { openDb } from './db.js';
import { startIngest } from './ingest.js';
import { makeRpc } from './rpc.js';
import { loadSanctions, ofacFileAgeMs, refreshFromOfac } from './sanctions.js';
import { buildServer } from './server.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const db = openDb(config.dbPath);
const rpc = makeRpc(config.rpcUrl);
let sanctions = loadSanctions(config.dataDir);
const meta = { lastRefresh: null as number | null, lastRefreshError: null as string | null };

async function refreshSanctions() {
  try {
    const n = await refreshFromOfac(config.dataDir);
    sanctions = loadSanctions(config.dataDir);
    meta.lastRefresh = Date.now();
    meta.lastRefreshError = null;
    console.log(`[sanctions] refreshed from OFAC: ${n} ETH addresses, version ${sanctions.version}`);
  } catch (e) {
    meta.lastRefreshError = (e as Error).message;
    console.warn(`[sanctions] refresh failed, keeping the last good list: ${meta.lastRefreshError}`);
  }
}

console.log(`[sanctions] loaded ${sanctions.entries.size} addresses (${sanctions.ofacCount} OFAC, ${sanctions.mockCount} mock), version ${sanctions.version}`);
if (ofacFileAgeMs(config.dataDir) > DAY_MS) void refreshSanctions();
setInterval(() => void refreshSanctions(), DAY_MS).unref();

const stopIngest = startIngest(
  {
    db, rpc, getSanctions: () => sanctions, alertOpts: { webhookUrl: config.webhookUrl },
    startBlock: config.startBlock, maxBlocksPerPoll: config.maxBlocksPerPoll,
  },
  config.pollMs,
);

const app = buildServer({ db, rpc, getSanctions: () => sanctions, publicDir: path.join(ROOT, 'public'), sanctionsMeta: () => meta });
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`ETH Flow Monitor running at http://localhost:${config.port} (RPC: ${config.rpcUrl})`);

process.on('SIGINT', async () => {
  stopIngest();
  await app.close();
  db.close();
  process.exit(0);
});
