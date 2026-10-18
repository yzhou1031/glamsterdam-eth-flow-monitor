// Runs the Vercel version locally: serves web/ and calls the api/ handlers the way Vercel does.
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import path from 'node:path';
import * as blocks from '../api/blocks.js';
import * as inspect from '../api/inspect.js';
import * as sanctions from '../api/sanctions.js';
import { ROOT } from '../src/config.js';

const port = Number(process.env.WEB_PREVIEW_PORT || 3001);
const handlers: Record<string, (req: Request) => Promise<Response>> = { blocks: blocks.GET, inspect: inspect.GET, sanctions: sanctions.GET };

const app = Fastify({ logger: false });
app.register(fastifyStatic, { root: path.join(ROOT, 'web') });
for (const [name, handler] of Object.entries(handlers)) {
  app.get(`/api/${name}`, async (req, reply) => {
    const res = await handler(new Request(`http://localhost:${port}${req.url}`));
    reply.code(res.status);
    res.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(await res.text());
  });
}
await app.listen({ port, host: '127.0.0.1' });
console.log(`Vercel-mode preview at http://localhost:${port}`);
