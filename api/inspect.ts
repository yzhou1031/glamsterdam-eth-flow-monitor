import { inspectTx, TX_HASH_RE } from '../src/inspect.js';
import { getRpc, NO_STORE } from '../src/web-context.js';

/** GET /api/inspect?tx=0x…: a transaction's logs before EIP-7708 vs. its new ETH Transfer logs. */
export async function GET(request: Request): Promise<Response> {
  const tx = new URL(request.url).searchParams.get('tx') ?? '';
  if (!TX_HASH_RE.test(tx)) {
    return Response.json({ error: 'Enter a 0x-prefixed transaction hash (66 characters)' }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json(await inspectTx((h) => getRpc().getReceiptLogs(h), tx), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404, headers: NO_STORE });
  }
}
