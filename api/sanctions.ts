import { getSanctions } from '../src/web-context.js';

/** GET /api/sanctions: the bundled OFAC snapshot plus the mock demo entry. */
export async function GET(): Promise<Response> {
  const s = getSanctions();
  return Response.json(
    {
      mode: 'snapshot', version: s.version, retrieved: s.retrieved ?? null, size: s.entries.size,
      ofacCount: s.ofacCount, mockCount: s.mockCount, entries: [...s.entries.values()],
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
