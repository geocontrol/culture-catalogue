#!/usr/bin/env node
/* Build the directory index once and print a summary, or write it to a file.
 *
 *   node scripts/build-index.mjs                 # summary only
 *   node scripts/build-index.mjs out.json        # also write the index
 *   node scripts/build-index.mjs --fresh did:plc:…
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildIndex } from '../lib/indexer.js';

const args = process.argv.slice(2);
const fi = args.indexOf('--fresh');
const extraDids = fi >= 0 ? [args.splice(fi, 2)[1]] : [];
const out = args[0];
const hidden = JSON.parse(readFileSync(new URL('../data/hidden.json', import.meta.url), 'utf8'));

const index = await buildIndex({ hidden, extraDids });
for (const e of index.entries) {
  const v = e.value || {};
  console.log(`${e.kind.padEnd(6)} ${String(v.name || '(no name)').padEnd(28)} @${e.handle || e.did}`
    + `${e.legacyCollection ? '  [old venue record]' : ''}${e.offers.length ? `  ${e.offers.length} open offer(s)` : ''}`);
}
console.log(`\n${index.entries.length} entries from ${index.repos} repositories; ${index.errors.length} errors`);
for (const err of index.errors) console.log('  !', err.did || err.step, err.message);
if (out) {
  writeFileSync(out, JSON.stringify(index, null, 2));
  console.log(`wrote ${out}`);
}
