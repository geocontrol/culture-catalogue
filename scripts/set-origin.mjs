#!/usr/bin/env node
/* Point the sign-in client at the site's real address.
 *
 *   node scripts/set-origin.mjs https://culturecatalogue.org
 *
 * ATProto sign-in identifies an app by the URL of its client metadata, so
 * join/client-metadata.json and the <link rel="atproto-client"> in
 * join/index.html must name the address the site is served from.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const origin = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(origin)) {
  console.error('usage: node scripts/set-origin.mjs https://your.domain');
  process.exit(1);
}
const files = ['join/client-metadata.json', 'join/index.html'];
for (const f of files) {
  const path = new URL(`../${f}`, import.meta.url);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?=\/(join\/|favicon|about|"|\s))/gi, origin)
    .replace(/"client_uri": "https:\/\/[^"]+"/, `"client_uri": "${origin}"`);
  writeFileSync(path, after);
  console.log(`${f}: ${before === after ? 'unchanged' : 'updated'}`);
}
