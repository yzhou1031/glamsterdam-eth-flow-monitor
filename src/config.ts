import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // no .env file: defaults apply
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  pollMs: Number(process.env.POLL_MS || 2000),
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined,
  webhookUrl: process.env.WEBHOOK_URL || undefined,
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'flow-monitor.db'),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  maxBlocksPerPoll: 20,
};
