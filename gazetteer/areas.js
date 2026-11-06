/* Area picker for Culture Catalogue: search the bundled UK gazetteer and
 * turn a choice into a com.cultureblocs.defs#areaRef.
 *
 *   import { loadGazetteer, searchAreas, toAreaRef, inArea } from './areas.js';
 *   const gaz = await loadGazetteer('/gazetteer');          // core only
 *   searchAreas(gaz, 'fro')    // → [{ label: 'Frome, Somerset', ... }, ...]
 *   toAreaRef(gaz, hit)        // → the record field value
 *
 * Villages (~19k) live in a second file. They are fetched the first time a
 * search finds too few matches in the core file, so most people never
 * download them.
 *
 * An areaRef never carries coordinates. The lng/lat in the gazetteer are
 * public place centroids for the map, and stay in the app.
 */

const LEVEL_LABEL = {
  country: 'country', region: 'region', county: 'county',
  local_authority: 'council area', city: 'city', town: 'town',
  neighbourhood: 'neighbourhood', village: 'village',
};
const KIND_WEIGHT = {
  country: 7, region: 6, city: 5, county: 4, local_authority: 4,
  town: 3, neighbourhood: 2, village: 1,
};

export function fold(s) {
  return s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function unpack(doc) {
  const f = doc.fields;
  return doc.rows.map((r) => {
    const e = Object.fromEntries(f.map((k, i) => [k, r[i]]));
    e.key = fold(e.n);
    e.words = e.key.split(' ');
    return e;
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gazetteer: ${url} → ${res.status}`);
  return res.json();
}

/** base: URL of the folder holding gazetteer-core.json and -villages.json.
 *  Pass preloaded docs instead (for tests or server use) as { core, villages }. */
export async function loadGazetteer(base, preloaded = null) {
  const core = preloaded?.core ?? await fetchJson(`${base}/gazetteer-core.json`);
  const gaz = { base, codes: core.codes, entries: unpack(core), villagesLoaded: false };
  if (preloaded?.villages) addVillages(gaz, preloaded.villages);
  return gaz;
}

function addVillages(gaz, doc) {
  gaz.entries = gaz.entries.concat(unpack(doc));
  gaz.villagesLoaded = true;
}

export async function ensureVillages(gaz) {
  if (!gaz.villagesLoaded) addVillages(gaz, await fetchJson(`${gaz.base}/gazetteer-villages.json`));
}

function score(e, q, qWords) {
  if (e.key === q) return 3;
  if (e.key.startsWith(q)) return 2;
  // every query word starts some word of the name: "upon hull" → Kingston upon Hull
  if (qWords.every((w) => e.words.some((x) => x.startsWith(w)))) return 1;
  return 0;
}

/** Ranked matches for what the person has typed so far. Each hit carries
 *  `label` ("Frome, Somerset") and `kindLabel` ("town") for display. */
export function searchAreas(gaz, query, { limit = 8 } = {}) {
  const q = fold(query);
  if (q.length < 2) return [];
  const qWords = q.split(' ');
  const hits = [];
  for (const e of gaz.entries) {
    const s = score(e, q, qWords);
    if (s) hits.push([s, e]);
  }
  hits.sort((a, b) => b[0] - a[0]
    || KIND_WEIGHT[b[1].k] - KIND_WEIGHT[a[1].k]
    || (b[1].pop || 0) - (a[1].pop || 0)
    || a[1].n.localeCompare(b[1].n));
  return hits.slice(0, limit).map(([, e]) => ({
    ...e,
    label: e.ctx ? `${e.n}, ${e.ctx}` : e.n,
    kindLabel: LEVEL_LABEL[e.k] ?? e.k,
  }));
}

/** searchAreas, pulling in villages when the core file has few matches. */
export async function searchAreasDeep(gaz, query, opts = {}) {
  let hits = searchAreas(gaz, query, opts);
  if (hits.length < 3 && fold(query).length >= 3 && !gaz.villagesLoaded) {
    await ensureVillages(gaz);
    hits = searchAreas(gaz, query, opts);
  }
  return hits;
}

const COUNTRY_ISO = { E92000001: 'GB', W92000004: 'GB', S92000003: 'GB', N92000002: 'GB' };

/** The value to write into creative.profile basedIn/activeIn, offer.areas
 *  or place.profile area. */
export function toAreaRef(gaz, hit) {
  const ref = {
    label: hit.label ?? (hit.ctx ? `${hit.n}, ${hit.ctx}` : hit.n),
    level: hit.k,
    country: COUNTRY_ISO[(hit.in || []).at(-1)] ?? COUNTRY_ISO[hit.gss] ?? 'GB',
  };
  if (hit.q) ref.wikidata = hit.q;
  if (hit.gss) ref.externalIds = [{ scheme: 'gss', id: hit.gss }];
  if (hit.in?.length) ref.within = hit.in.map((id) => ({ scheme: 'gss', id }));
  return ref;
}

/** Does an areaRef fall inside an area? For filters: inArea(ref, 'E09000028')
 *  is true for anyone who picked Peckham, or Southwark itself. Works on
 *  records written by any app that fills `externalIds`/`within`. */
export function inArea(ref, gssCode) {
  const codes = [...(ref.externalIds || []), ...(ref.within || [])]
    .filter((x) => x.scheme === 'gss').map((x) => x.id);
  return codes.includes(gssCode);
}

/** Name for an ONS code, for filter chips built from records. */
export function codeName(gaz, gssCode) {
  return gaz.codes?.[gssCode] ?? gssCode;
}
