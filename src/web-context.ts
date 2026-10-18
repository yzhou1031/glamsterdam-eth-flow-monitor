import { config } from './config.js';
import { makeRpc } from './rpc.js';
import { loadSanctions, type SanctionsList } from './sanctions.js';

// Created once per serverless instance and reused across requests.
let rpc: ReturnType<typeof makeRpc> | undefined;
let sanctions: SanctionsList | undefined;

export const getRpc = () => (rpc ??= makeRpc(config.rpcUrl, { batch: true }));
export const getSanctions = () => (sanctions ??= loadSanctions(config.dataDir));

export const NO_STORE = { 'Cache-Control': 'no-store' };
