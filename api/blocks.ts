import { scanBlocks } from '../src/scan.js';
import { getRpc, getSanctions, NO_STORE } from '../src/web-context.js';

/** GET /api/blocks?from=N: decoded, classified and sanctions-screened ETH transfers for up to 5 confirmed blocks. */
export async function GET(request: Request): Promise<Response> {
  const fromParam = new URL(request.url).searchParams.get('from');
  const from = fromParam === null || fromParam === '' ? undefined : Number(fromParam);
  if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
    return Response.json({ error: 'from must be a block number' }, { status: 400, headers: NO_STORE });
  }
  try {
    return Response.json(await scanBlocks(getRpc(), getSanctions(), { from }), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: `Sepolia RPC error: ${(e as Error).message}` }, { status: 502, headers: NO_STORE });
  }
}
