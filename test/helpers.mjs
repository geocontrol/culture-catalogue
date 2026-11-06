import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LexiconRegistry } from './vendor/lexicon.js';
import { loadGazetteer } from '../gazetteer/areas.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readLexicons(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...readLexicons(path));
    else if (entry.endsWith('.json')) out.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  return out;
}

export const registry = new LexiconRegistry();
registry.load(readLexicons(join(ROOT, 'lexicons')));

/* Problems the CultureBlocs validator finds in a record; [] when valid. */
export const problems = (record) => registry.validateRecord(record.$type, record);

const read = (f) => JSON.parse(readFileSync(join(ROOT, 'gazetteer/dist', f), 'utf8'));
export const gaz = await loadGazetteer('', { core: read('gazetteer-core.json'), villages: read('gazetteer-villages.json') });
export const demoIndex = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/demo-index.json'), 'utf8'));

/* A fetch stand-in answering from a table of URL prefixes. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const v = typeof routes[key] === 'function' ? routes[key](url, init) : routes[key];
    return { ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) };
  };
  fn.calls = calls;
  return fn;
}
