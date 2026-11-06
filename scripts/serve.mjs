#!/usr/bin/env node
/* Local development server.
 *
 *   node scripts/serve.mjs            # live index from the network
 *   node scripts/serve.mjs --demo     # invented demo entries (test/fixtures)
 *   PORT=8080 node scripts/serve.mjs
 *
 * Serves the static site and runs api/catalogue.js the way Vercel would.
 * Open http://127.0.0.1:<port>/ — use 127.0.0.1, not localhost, so ATProto
 * loopback sign-in works on the "Add yourself" page.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/catalogue.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DEMO = process.argv.includes('--demo');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function api(req, res) {
  if (DEMO) {
    res.writeHead(200, { 'content-type': TYPES['.json'] });
    res.end(await readFile(join(ROOT, 'test/fixtures/demo-index.json')));
    return;
  }
  const r = await handler(new Request(`http://127.0.0.1:${PORT}${req.url}`));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/api/catalogue') return await api(req, res);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(e.code === 'ENOENT' ? 'not found' : String(e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Culture Catalogue on http://127.0.0.1:${PORT}/${DEMO ? '  (demo data)' : ''}`);
});
