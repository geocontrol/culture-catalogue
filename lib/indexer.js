/* Build Culture Catalogue's index from the open network.
 *
 * 1. Ask a relay which repositories hold each CultureBlocs collection
 *    (com.atproto.sync.listReposByCollection).
 * 2. Read those records from each repository's own server.
 * 3. Add what a directory card needs: handle, Bluesky display name and
 *    avatar, coordinates for places with a UK postcode, open offers.
 *
 * Nothing is stored: the result is a snapshot, rebuilt on demand and cached
 * at the edge (api/catalogue.js), or written to a file by
 * scripts/build-index.mjs. Runs unchanged in Node, the browser and Vercel
 * edge functions; fetchFn is injectable so every path is tested offline.
 */
import { offerIsOpen } from './offers.js';

export const NSID = {
  person: 'com.cultureblocs.creative.profile',
  place: 'com.cultureblocs.place.profile',
  venue: 'com.cultureblocs.venue.profile', // deprecated; read as a place
  offer: 'com.cultureblocs.offer',
};
export const RELAY = 'https://relay1.us-east.bsky.network';
const PLC = 'https://plc.directory';
const BSKY = 'https://public.api.bsky.app/xrpc';
const POSTCODES = 'https://api.postcodes.io/postcodes';

async function getJson(fetchFn, url, init) {
  const r = await fetchFn(url, init);
  if (!r.ok) {
    const err = new Error(`${url.split('?')[0]}: ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/* Run fn over items, at most `limit` at once, keeping order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function reposWith(collection, { fetchFn = fetch, relay = RELAY, maxPages = 20 } = {}) {
  const dids = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const page = await getJson(fetchFn, `${relay}/xrpc/com.atproto.sync.listReposByCollection`
      + `?collection=${encodeURIComponent(collection)}&limit=500`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    for (const r of page.repos || []) if (r?.did) dids.push(r.did);
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return dids;
}

export function pdsFromDoc(doc) {
  const svc = (doc?.service || []).find((s) =>
    s?.id?.endsWith('#atproto_pds') || s?.type === 'AtprotoPersonalDataServer');
  const endpoint = svc?.serviceEndpoint;
  if (!endpoint) return null;
  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return endpoint.replace(/\/+$/, '');
}

export async function identity(did, { fetchFn = fetch } = {}) {
  const doc = did.startsWith('did:web:')
    ? await getJson(fetchFn, `https://${did.slice(8).replace(/:/g, '/')}/.well-known/did.json`)
    : await getJson(fetchFn, `${PLC}/${encodeURIComponent(did)}`);
  const aka = (doc.alsoKnownAs || []).find((a) => String(a).startsWith('at://'));
  return { did, pds: pdsFromDoc(doc), handle: aka ? aka.slice(5) : null };
}

async function listRecords(fetchFn, pds, did, collection, maxPages = 5) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    let page;
    try {
      page = await getJson(fetchFn, `${pds}/xrpc/com.atproto.repo.listRecords`
        + `?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&limit=100`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    } catch (e) {
      if (e.status === 400 || e.status === 404) return out; // collection absent
      throw e;
    }
    out.push(...(page.records || []));
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/* Display names and avatars from Bluesky's public view, 25 at a time.
 * Missing for accounts that never set one; that is fine. */
async function bskyProfiles(fetchFn, dids) {
  const out = {};
  for (let i = 0; i < dids.length; i += 25) {
    const batch = dids.slice(i, i + 25);
    try {
      const q = batch.map((d) => `actors=${encodeURIComponent(d)}`).join('&');
      const r = await getJson(fetchFn, `${BSKY}/app.bsky.actor.getProfiles?${q}`);
      for (const p of r.profiles || []) {
        out[p.did] = { displayName: p.displayName || '', avatar: p.avatar || '' };
      }
    } catch { /* cards fall back to the record's own name */ }
  }
  return out;
}

/* UK postcodes → coordinates, 100 at a time. Postcodes are public facts
 * about a place's address, which only public places publish. */
export async function geocodePostcodes(fetchFn, postcodes) {
  const out = {};
  const uniq = [...new Set(postcodes.map(normalisePostcode).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    try {
      const r = await getJson(fetchFn, POSTCODES, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postcodes: uniq.slice(i, i + 100) }),
      });
      for (const hit of r.result || []) {
        const res = hit.result;
        if (res) out[normalisePostcode(hit.query)] = { lat: res.latitude, lng: res.longitude };
      }
    } catch { /* places without coordinates still list; they just have no pin */ }
  }
  return out;
}

export const normalisePostcode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const blobUrl = (pds, did, image) => {
  const cid = image?.image?.ref?.$link || image?.image?.ref?.toString?.();
  return cid && typeof cid === 'string'
    ? `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
    : null;
};

function coordsOf(value, geo) {
  const loc = value?.location;
  if (loc && typeof loc.latitude !== 'undefined') {
    const lat = Number(loc.latitude), lng = Number(loc.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  if (loc?.postalCode && String(loc.country || '').toUpperCase() === 'GB') {
    return geo[normalisePostcode(loc.postalCode)] || null;
  }
  return null;
}

/* Everything one repository contributes: a person entry if it has a
 * CreativeID, a place entry per place (or its old venue record, if it has
 * no places yet), with open offers attached by the AppView's rule. */
export function entriesForRepo(repo, now = new Date()) {
  const { did, pds, handle, people, places, venues, offers, bsky } = repo;
  const base = { did, handle, pds, displayName: bsky?.displayName || '', avatar: bsky?.avatar || '' };
  const open = offers.filter((o) => offerIsOpen(o.value, now));
  const placeRecs = places.length ? places.map((p) => ({ ...p, legacyCollection: null }))
    : venues.slice(0, 1).map((v) => ({ ...v, legacyCollection: NSID.venue }));
  const placeUris = new Set(placeRecs.map((p) => p.uri));
  const out = [];
  const person = people.find((p) => p.uri.endsWith('/self')) || people[0];
  if (person) {
    out.push({ ...base, kind: 'person', uri: person.uri, cid: person.cid, value: person.value,
      offers: open.filter((o) => !o.value?.offeredBy?.uri) });
  }
  for (const p of placeRecs) {
    const value = p.legacyCollection ? venueAsPlace(p.value) : p.value;
    out.push({ ...base, kind: 'place', uri: p.uri, cid: p.cid, value,
      legacyCollection: p.legacyCollection || undefined,
      image: blobUrl(pds, did, value?.images?.[0]),
      offers: open.filter((o) => o.value?.offeredBy?.uri === p.uri && placeUris.has(p.uri)) });
  }
  return out;
}

const CARRIED = ['name', 'description', 'location', 'capacity', 'accessibility',
  'links', 'externalIds', 'tags', 'createdAt'];
export function venueAsPlace(v = {}) {
  const out = { $type: NSID.place, spaceTypes: ['venue'] };
  for (const k of CARRIED) if (k in v) out[k] = v[k];
  return out;
}

export async function buildIndex({ fetchFn = fetch, relay = RELAY, hidden = {}, now = new Date(),
  extraDids = [], concurrency = 8 } = {}) {
  const hiddenDids = new Set(hidden.dids || []);
  const hiddenUris = new Set(hidden.uris || []);
  const errors = [];
  const found = new Set(extraDids);
  for (const c of [NSID.person, NSID.place, NSID.venue, NSID.offer]) {
    try {
      for (const d of await reposWith(c, { fetchFn, relay })) found.add(d);
    } catch (e) {
      errors.push({ step: `discover ${c}`, message: e.message });
    }
  }
  const dids = [...found].filter((d) => !hiddenDids.has(d));

  const repos = (await pool(dids, concurrency, async (did) => {
    try {
      const id = await identity(did, { fetchFn });
      if (!id.pds) throw new Error('no reachable data server');
      const [people, places, venues, offers] = await Promise.all(
        [NSID.person, NSID.place, NSID.venue, NSID.offer]
          .map((c) => listRecords(fetchFn, id.pds, did, c)));
      return { ...id, people, places, venues, offers };
    } catch (e) {
      errors.push({ did, message: e.message });
      return null;
    }
  })).filter(Boolean);

  const bsky = await bskyProfiles(fetchFn, repos.map((r) => r.did));
  const postcodes = repos.flatMap((r) => [...r.places, ...r.venues])
    .map((p) => p.value?.location?.postalCode).filter(Boolean);
  const geo = await geocodePostcodes(fetchFn, postcodes);

  const entries = [];
  for (const r of repos) {
    for (const e of entriesForRepo({ ...r, bsky: bsky[r.did] }, now)) {
      if (hiddenUris.has(e.uri)) continue;
      if (e.kind === 'place') e.coords = coordsOf(e.value, geo);
      entries.push(e);
    }
  }
  return { built: now.toISOString(), relay, repos: repos.length, entries, errors };
}
