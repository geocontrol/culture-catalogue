/* The directory's model: index entries → what the page shows, filtered.
 *
 * Pure functions, no DOM, tested with node --test. Records come from the
 * open network, so nothing about their shape is assumed: every field is
 * checked before use, and anything odd is dropped rather than shown.
 */
import { fold, inArea, searchAreas, toAreaRef } from '../gazetteer/areas.js';

export const SPACE_TYPES = {
  venue: 'Venue', gallery: 'Gallery', museum: 'Museum', cinema: 'Cinema',
  theatre: 'Theatre', rehearsal_room: 'Rehearsal room', recording_studio: 'Recording studio',
  artist_studio: 'Artist studio', makerspace: 'Makerspace', workshop: 'Workshop',
  coworking: 'Co-working', supplier: 'Supplier', shop: 'Shop', library: 'Library',
  community_space: 'Community space',
};
export const OFFER_TYPES = {
  service: 'Service', space_to_let: 'Space to let', hire: 'For hire',
  commission: 'Commissions', collaboration: 'Collaboration', workshop: 'Workshop',
  residency: 'Residency', volunteer: 'Volunteering',
};
export const ACCESS = {
  walk_in: 'Open to walk in', by_appointment: 'By appointment',
  bookable: 'Bookable', online_only: 'Online only',
};

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v, max = 64, n = 8) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
export const label = (code, table) =>
  table[code] || String(code).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/* An areaRef from a record, kept only if it has a label; codes flattened. */
function area(ref) {
  if (!ref || typeof ref !== 'object' || !str(ref.label, 200)) return null;
  const codes = [...(ref.externalIds || []), ...(ref.within || [])]
    .filter((x) => x && x.scheme === 'gss' && typeof x.id === 'string').map((x) => x.id);
  return { label: str(ref.label, 200), wikidata: str(ref.wikidata, 32) || null, codes, ref };
}

/* An old CreativeID with only `based: { name: 'London' }`: find that name
 * in the gazetteer, so it can still be filtered and mapped. */
function legacyBased(based, gaz) {
  const name = str(based?.name, 300);
  if (!name || !gaz) return null;
  const hit = searchAreas(gaz, name, { limit: 1 })[0];
  if (!hit || fold(hit.n) !== fold(name.split(',')[0])) return { label: name, wikidata: null, codes: [], ref: null };
  return area(toAreaRef(gaz, hit));
}

function addressLine(loc) {
  if (!loc || typeof loc !== 'object') return '';
  return [loc.name, loc.street, loc.locality, loc.postalCode].map((x) => str(x, 200)).filter(Boolean).join(', ');
}

function offerView(o) {
  const v = o?.value || {};
  return {
    uri: o.uri, kind: v.kind === 'need' ? 'need' : 'offer', title: str(v.title, 200),
    description: str(v.description), type: str(v.offerType, 64), price: str(v.price, 200),
    remote: v.remote === true, until: str(v.validUntil, 40),
    links: (Array.isArray(v.links) ? v.links : []).map((l) => safeUrl(l?.uri)).filter(Boolean),
  };
}

/* One index entry → a directory entry, or null if it can't be shown. */
export function normalise(e, gaz) {
  if (!e || (e.kind !== 'person' && e.kind !== 'place')) return null;
  const v = e.value || {};
  const name = str(v.name, 300) || str(e.displayName, 300);
  if (!name) return null;
  const links = (Array.isArray(v.links) ? v.links : []).map((l) => safeUrl(l?.uri)).filter(Boolean);
  const common = {
    id: e.uri, uri: e.uri, did: e.did, handle: e.handle || '', kind: e.kind, name,
    avatar: safeUrl(e.avatar), links,
    offers: (Array.isArray(e.offers) ? e.offers : []).map(offerView).filter((o) => o.title),
  };
  if (e.kind === 'person') {
    let basedIn = (Array.isArray(v.basedIn) ? v.basedIn : []).map(area).filter(Boolean).slice(0, 3);
    if (!basedIn.length && v.based) basedIn = [legacyBased(v.based, gaz)].filter(Boolean);
    const activeIn = (Array.isArray(v.activeIn) ? v.activeIn : []).map(area).filter(Boolean).slice(0, 8);
    return { ...common, summary: str(v.bio), disciplines: strs(v.disciplines), tags: [],
      spaceTypes: [], basedIn, activeIn, areas: [...basedIn, ...activeIn], coords: null };
  }
  const placeArea = area(v.area);
  return { ...common, summary: str(v.description), disciplines: [], tags: strs(v.tags),
    spaceTypes: strs(v.spaceTypes), access: str(v.publicAccess, 32),
    address: addressLine(v.location), hours: str(v.hours, 500), accessibility: str(v.accessibility, 1000),
    capacity: Number.isInteger(v.capacity) ? v.capacity : null,
    serviceArea: (Array.isArray(v.serviceArea) ? v.serviceArea : []).map(area).filter(Boolean),
    basedIn: [], activeIn: [], areas: [placeArea].filter(Boolean),
    coords: e.coords && Number.isFinite(e.coords.lat) && Number.isFinite(e.coords.lng) ? e.coords : null,
    image: safeUrl(e.image), legacy: Boolean(e.legacyCollection) };
}

export function normaliseAll(index, gaz) {
  const seen = new Set();
  const out = [];
  for (const e of index?.entries || []) {
    const n = normalise(e, gaz);
    if (n && !seen.has(n.id)) { seen.add(n.id); out.push(n); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

const words = (s) => fold(s).split(' ').filter(Boolean);
function haystack(e) {
  return fold([e.name, e.handle, e.summary, ...e.disciplines, ...e.tags,
    ...e.spaceTypes.map((t) => label(t, SPACE_TYPES)),
    ...e.areas.map((a) => a.label), ...e.offers.map((o) => o.title)].join(' '));
}

/* Does an area (as normalised above) fall within the filter area? The
 * filter is an ONS code (a council area, county, region) or a Wikidata QID
 * (a town or neighbourhood, which has no code of its own). */
export function areaMatches(a, filterArea) {
  if (!filterArea) return true;
  return /^Q\d+$/.test(filterArea) ? a.wikidata === filterArea : a.codes.includes(filterArea);
}

/* filters: { q, who: 'all'|'person'|'place', type, discipline, area (ONS code or QID), offers: bool } */
export function filterEntries(entries, f = {}) {
  const q = words(f.q || '');
  const disc = fold(f.discipline || '');
  return entries.filter((e) => {
    if (f.who && f.who !== 'all' && e.kind !== f.who) return false;
    if (f.type && !e.spaceTypes.includes(f.type)) return false;
    if (disc && !e.disciplines.some((d) => fold(d) === disc)) return false;
    if (f.area && !e.areas.some((a) => areaMatches(a, f.area))
      && !(e.serviceArea || []).some((a) => areaMatches(a, f.area))) return false;
    if (f.offers && !e.offers.length) return false;
    if (q.length) {
      const h = haystack(e);
      if (!q.every((w) => h.includes(w))) return false;
    }
    return true;
  });
}

/* Counts for the filter menus, over the entries currently in view. */
export function facets(entries) {
  const types = {};
  const disc = {};
  for (const e of entries) {
    for (const t of e.spaceTypes) types[t] = (types[t] || 0) + 1;
    for (const d of e.disciplines) {
      const k = fold(d);
      disc[k] = disc[k] || { label: d, n: 0 };
      disc[k].n += 1;
    }
  }
  return {
    types: Object.entries(types).map(([code, n]) => ({ code, label: label(code, SPACE_TYPES), n }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    disciplines: Object.values(disc).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
  };
}

export function summarise(entries, areaName = '') {
  const people = entries.filter((e) => e.kind === 'person').length;
  const places = entries.length - people;
  const parts = [];
  if (places) parts.push(`${places} ${places === 1 ? 'place' : 'places'}`);
  if (people) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  if (!parts.length) return areaName ? `Nothing listed in ${areaName} yet.` : 'Nothing matches yet.';
  return `${parts.join(' and ')}${areaName ? ` in ${areaName}` : ''}`;
}

/* Map layers. Places are pins at their own address. People are never
 * pinned: they are counted into the areas they are based in, drawn at the
 * gazetteer centroid of that area. */
export function mapLayers(entries, gaz, filterArea = '') {
  const pins = entries.filter((e) => e.kind === 'place' && e.coords)
    .map((e) => ({ id: e.id, name: e.name, lat: e.coords.lat, lng: e.coords.lng,
      types: e.spaceTypes.map((t) => label(t, SPACE_TYPES)) }));
  const byQ = gaz ? gazByQid(gaz) : new Map();
  const groups = new Map();
  for (const e of entries) {
    if (e.kind !== 'person') continue;
    for (const a of e.basedIn) {
      // inside an area filter, draw only the home areas that fall in it:
      // someone active in London but based in Frome stays in the London list
      if (filterArea && !areaMatches(a, filterArea)) continue;
      const g = (a.wikidata && byQ.get(a.wikidata)) || (gaz && gazByCode(gaz, a.codes[0]));
      if (!g || !Number.isFinite(g.lat)) continue;
      const key = g.q || g.gss;
      const cur = groups.get(key) || { key, label: a.label.split(',')[0], lat: g.lat, lng: g.lng,
        code: g.gss || a.codes[0] || null, people: [] };
      cur.people.push(e.id);
      groups.set(key, cur);
    }
  }
  return { pins, areas: [...groups.values()].map((g) => ({ ...g, count: g.people.length })) };
}

const qidCache = new WeakMap();
function gazByQid(gaz) {
  if (!qidCache.has(gaz)) {
    const m = new Map();
    for (const e of gaz.entries) if (e.q && !m.has(e.q)) m.set(e.q, e);
    qidCache.set(gaz, m);
  }
  return qidCache.get(gaz);
}
function gazByCode(gaz, code) {
  if (!code) return null;
  return gaz.entries.find((e) => e.gss === code && Number.isFinite(e.lat)) || null;
}

/* The filter value for a gazetteer hit: its own ONS code when it has one
 * (council areas, and cities merged with theirs), otherwise its QID. */
export const filterValueFor = (hit) => (hit ? hit.gss || hit.q || '' : '');

export { inArea };

/* URL state ⇄ filters, so every view of the directory is a link. */
export function filtersFromQuery(search) {
  const q = new URLSearchParams(search);
  const who = ['person', 'place'].includes(q.get('who')) ? q.get('who') : 'all';
  const view = ['list', 'cards', 'map'].includes(q.get('view')) ? q.get('view') : 'cards';
  return { q: q.get('q') || '', who, type: q.get('type') || '', discipline: q.get('discipline') || '',
    area: /^([EWSN]\d{8}|Q\d+)$/.test(q.get('area') || '') ? q.get('area') : '', offers: q.get('offers') === '1',
    view, open: q.get('u') || '' };
}
export function queryFromFilters(f) {
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.who && f.who !== 'all') q.set('who', f.who);
  if (f.type) q.set('type', f.type);
  if (f.discipline) q.set('discipline', f.discipline);
  if (f.area) q.set('area', f.area);
  if (f.offers) q.set('offers', '1');
  if (f.view && f.view !== 'cards') q.set('view', f.view);
  if (f.open) q.set('u', f.open);
  const s = q.toString();
  return s ? `?${s}` : '';
}
