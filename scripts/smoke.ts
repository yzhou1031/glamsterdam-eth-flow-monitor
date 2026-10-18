import { classify } from '../src/classify.js';
import { config } from '../src/config.js';
import { decodeTransferLog, type Transfer } from '../src/decode.js';
import { makeRpc } from '../src/rpc.js';

const rpc = makeRpc(config.rpcUrl);
const head = await rpc.blockNumber();
let total = 0;
let internal = 0;
for (let n = head - 4; n <= head; n++) {
  const transfers = (await rpc.getTransferLogs(n)).map(decodeTransferLog).filter((t): t is Transfer => t !== null);
  const byTx = new Map<string, Transfer[]>();
  for (const t of transfers) byTx.set(t.txHash, [...(byTx.get(t.txHash) ?? []), t]);
  for (const [hash, list] of byTx) {
    const kinds = classify(list, await rpc.getTx(hash)).map((t) => t.kind);
    internal += kinds.filter((k) => k === 'internal').length;
  }
  total += transfers.length;
  console.log(`block ${n}: ${transfers.length} ETH transfer log(s)`);
}
console.log(`Total: ${total} ETH transfers in 5 blocks (${internal} contract-internal) via ${config.rpcUrl}`);
if (total === 0) {
  console.error('No EIP-7708 logs found. Check that RPC_URL points at Sepolia (Glamsterdam is live there since 2026-10-06).');
  process.exit(1);
}
