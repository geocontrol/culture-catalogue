/* GET /api/catalogue: the directory's index, built from the open network.
 *
 * Stateless, like the CultureBlocs feed service: nothing is stored here.
 * Each build asks the relay which repositories hold CultureBlocs people,
 * places and offers, and reads them from their owners' servers. The edge
 * cache keeps a build for ten minutes and serves the old one while the next
 * is made, so the network is asked at most a few times an hour.
 *
 * ?fresh=did:plc:… adds that repository even if the relay hasn't seen it
 * yet, which is what the "Add yourself" journey links to after publishing.
 * Responses with ?fresh are not cached.
 */
import { buildIndex } from '../lib/indexer.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const fresh = url.searchParams.get('fresh');
  const extraDids = fresh && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(fresh) ? [fresh] : [];

  let hidden = {};
  try {
    const r = await fetch(`${url.origin}/data/hidden.json`);
    if (r.ok) hidden = await r.json();
  } catch { /* nothing hidden */ }

  try {
    const index = await buildIndex({ hidden, extraDids });
    return new Response(JSON.stringify(index), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': extraDids.length
          ? 'no-store'
          : 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'IndexUnavailable', message: e.message }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
