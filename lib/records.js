/* The join forms ⇄ CultureBlocs records.
 *
 * Pure functions, no DOM, tested with node --test and checked against the
 * real lexicons. Every builder lays the form over whatever the record held
 * before, so fields written by other apps (CreativeID Studio, Loom, a later
 * lexicon) survive an edit here. createdAt is set once and never changed.
 */
export const NSID = {
  person: 'com.cultureblocs.creative.profile',
  place: 'com.cultureblocs.place.profile',
  offer: 'com.cultureblocs.offer',
};
export const SPACE_TYPE_CODES = ['venue', 'gallery', 'museum', 'cinema', 'theatre', 'rehearsal_room',
  'recording_studio', 'artist_studio', 'makerspace', 'workshop', 'coworking', 'supplier', 'shop',
  'library', 'community_space'];
export const ACCESS_CODES = ['walk_in', 'by_appointment', 'bookable', 'online_only'];
export const OFFER_TYPE_CODES = ['service', 'space_to_let', 'hire', 'commission', 'collaboration',
  'workshop', 'residency', 'volunteer'];

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
export const graphemes = (s) => (seg ? [...seg.segment(String(s))].length : [...String(s)].length);
const clean = (s) => String(s ?? '').trim();
const setOrDelete = (rec, key, value) => {
  const empty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && !value.length);
  if (empty) delete rec[key]; else rec[key] = value;
};

/* "sculpture, sound design" → ['sculpture', 'sound design']: no blanks, no repeats. */
export function parseList(text, max = 8) {
  const out = [];
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const d = clean(part);
    if (d && !out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
  }
  return out.slice(0, max + 1); // one over, so validation can say "too many"
}

export function normaliseUrl(text) {
  let t = clean(text);
  if (!t) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.href : '';
  } catch {
    return '';
  }
}

/* The first link is the form's "website"; any others are kept as they were. */
function withWebsite(prevLinks, website) {
  const url = normaliseUrl(website);
  const rest = (prevLinks || []).slice(1);
  const first = prevLinks?.[0];
  return url ? [first && first.uri === url ? first : { uri: url }, ...rest] : rest;
}

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
export const formatPostcode = (s) => {
  const t = clean(s).toUpperCase().replace(/\s+/g, '');
  return t.length > 3 ? `${t.slice(0, -3)} ${t.slice(-3)}` : t;
};
export const isUkPostcode = (s) => UK_POSTCODE.test(clean(s));

/* ---------- people: com.cultureblocs.creative.profile ---------- */

export function personForm(record) {
  const r = record || {};
  return {
    name: r.name || '', bio: r.bio || '',
    disciplines: (r.disciplines || []).join(', '),
    basedIn: Array.isArray(r.basedIn) ? r.basedIn : [],
    activeIn: Array.isArray(r.activeIn) ? r.activeIn : [],
    website: r.links?.[0]?.uri || '',
  };
}

export function validatePerson(f) {
  const errs = [];
  const name = clean(f.name);
  if (!name) errs.push({ field: 'name', message: 'Add the name you work under.' });
  else if (graphemes(name) > 300) errs.push({ field: 'name', message: 'The name can be at most 300 characters.' });
  if (graphemes(clean(f.bio)) > 2000) errs.push({ field: 'bio', message: 'About can be at most 2,000 characters.' });
  const ds = parseList(f.disciplines);
  if (ds.length > 8) errs.push({ field: 'disciplines', message: 'Up to 8 disciplines.' });
  else if (ds.some((d) => graphemes(d) > 64)) errs.push({ field: 'disciplines', message: 'Each discipline can be at most 64 characters.' });
  if (!f.basedIn?.length) errs.push({ field: 'basedIn', message: 'Choose where you’re based, so people nearby can find you.' });
  if ((f.basedIn || []).length > 3) errs.push({ field: 'basedIn', message: 'Up to 3 areas.' });
  if ((f.activeIn || []).length > 8) errs.push({ field: 'activeIn', message: 'Up to 8 areas.' });
  if (clean(f.website) && !normaliseUrl(f.website)) errs.push({ field: 'website', message: 'That doesn’t look like a web address.' });
  return errs;
}

export function personRecord(f, existing, now = new Date().toISOString()) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const rec = { ...prev, $type: NSID.person, name: clean(f.name), createdAt: prev.createdAt || now };
  setOrDelete(rec, 'bio', clean(f.bio));
  setOrDelete(rec, 'disciplines', parseList(f.disciplines));
  setOrDelete(rec, 'basedIn', (f.basedIn || []).slice(0, 3));
  setOrDelete(rec, 'activeIn', (f.activeIn || []).slice(0, 8));
  setOrDelete(rec, 'links', withWebsite(prev.links, f.website));
  return rec;
}

/* ---------- places: com.cultureblocs.place.profile ---------- */

export function placeForm(record) {
  const r = record || {};
  const loc = r.location || {};
  const known = (r.spaceTypes || []).filter((t) => SPACE_TYPE_CODES.includes(t));
  const other = (r.spaceTypes || []).filter((t) => !SPACE_TYPE_CODES.includes(t));
  return {
    name: r.name || '', description: r.description || '',
    spaceTypes: known, otherTypes: other.join(', '),
    access: r.publicAccess || '',
    street: loc.street || '', locality: loc.locality || '', postcode: loc.postalCode || '',
    area: r.area || null, serviceArea: Array.isArray(r.serviceArea) ? r.serviceArea : [],
    capacity: Number.isInteger(r.capacity) ? String(r.capacity) : '',
    accessibility: r.accessibility || '', hours: r.hours || '',
    website: r.links?.[0]?.uri || '', tags: (r.tags || []).join(', '),
  };
}

const slugType = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
export const allSpaceTypes = (f) =>
  [...new Set([...(f.spaceTypes || []), ...parseList(f.otherTypes).map(slugType).filter(Boolean)])];

export function validatePlace(f) {
  const errs = [];
  const name = clean(f.name);
  if (!name) errs.push({ field: 'name', message: 'Add the place’s name.' });
  else if (graphemes(name) > 300) errs.push({ field: 'name', message: 'The name can be at most 300 characters.' });
  if (graphemes(clean(f.description)) > 2000) errs.push({ field: 'description', message: 'The description can be at most 2,000 characters.' });
  const types = allSpaceTypes(f);
  if (!types.length) errs.push({ field: 'spaceTypes', message: 'Choose at least one kind of place.' });
  if (types.length > 8) errs.push({ field: 'spaceTypes', message: 'Up to 8 kinds.' });
  if (!ACCESS_CODES.includes(f.access)) errs.push({ field: 'access', message: 'Say how people can visit or book.' });
  if (f.access === 'online_only') {
    if (!f.serviceArea?.length) errs.push({ field: 'serviceArea', message: 'Without an address, say which areas you serve.' });
  } else {
    if (!clean(f.street)) errs.push({ field: 'street', message: 'Add the street address.' });
    if (!clean(f.locality)) errs.push({ field: 'locality', message: 'Add the town or city.' });
    if (!isUkPostcode(f.postcode)) errs.push({ field: 'postcode', message: 'Add a UK postcode, like SE15 4ST.' });
    else if (!f.area) errs.push({ field: 'postcode', message: 'We couldn’t find that postcode. Check it and try again.' });
  }
  if (clean(f.capacity) && !/^\d{1,6}$/.test(clean(f.capacity))) errs.push({ field: 'capacity', message: 'Capacity is a whole number of people.' });
  if (graphemes(clean(f.accessibility)) > 1000) errs.push({ field: 'accessibility', message: 'Access notes can be at most 1,000 characters.' });
  if (graphemes(clean(f.hours)) > 500) errs.push({ field: 'hours', message: 'Hours can be at most 500 characters.' });
  if (clean(f.website) && !normaliseUrl(f.website)) errs.push({ field: 'website', message: 'That doesn’t look like a web address.' });
  if (parseList(f.tags).length > 8) errs.push({ field: 'tags', message: 'Up to 8 tags.' });
  return errs;
}

/* image: undefined keeps the current images; null removes the first; an
 * imageRef (from an upload) replaces the first and keeps any others. */
export function placeRecord(f, existing, { now = new Date().toISOString(), image } = {}) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const rec = { ...prev, $type: NSID.place, name: clean(f.name), spaceTypes: allSpaceTypes(f),
    publicAccess: f.access, createdAt: prev.createdAt || now };
  setOrDelete(rec, 'description', clean(f.description));
  if (f.access === 'online_only') {
    delete rec.location;
    delete rec.area;
  } else {
    const prevLoc = prev.location?.$type === 'community.lexicon.location.address' ? prev.location : {};
    rec.location = { ...prevLoc, $type: 'community.lexicon.location.address',
      street: clean(f.street), locality: clean(f.locality),
      postalCode: formatPostcode(f.postcode), country: 'GB' };
    setOrDelete(rec, 'area', f.area || null);
  }
  setOrDelete(rec, 'serviceArea', (f.serviceArea || []).slice(0, 8));
  setOrDelete(rec, 'capacity', clean(f.capacity) ? Number(clean(f.capacity)) : null);
  setOrDelete(rec, 'accessibility', clean(f.accessibility));
  setOrDelete(rec, 'hours', clean(f.hours));
  setOrDelete(rec, 'links', withWebsite(prev.links, f.website));
  setOrDelete(rec, 'tags', parseList(f.tags).slice(0, 8));
  if (image !== undefined) {
    const rest = (prev.images || []).slice(1);
    setOrDelete(rec, 'images', image ? [image, ...rest] : rest);
  }
  return rec;
}

/* The area a place sits in, from a postcode lookup: the nearest town or
 * neighbourhood inside the same council area, within 3 km of the postcode;
 * otherwise the council area itself. `lookup` is postcodes.io's result. */
export function areaForPostcode(gaz, lookup) {
  const code = lookup?.codes?.admin_district;
  const lat = Number(lookup?.latitude), lng = Number(lookup?.longitude);
  if (!code) return null;
  let best = null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const e of gaz.entries) {
      if (!['town', 'neighbourhood', 'city', 'village'].includes(e.k) || e.in?.[0] !== code) continue;
      if (!Number.isFinite(e.lat)) continue;
      const d = km(lat, lng, e.lat, e.lng);
      if (d <= 3 && (!best || d < best.d)) best = { e, d };
    }
  }
  return best?.e || gaz.entries.find((e) => e.gss === code) || null;
}

function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/* ---------- offers: com.cultureblocs.offer ---------- */

export function offerForm(record) {
  const r = record || {};
  return {
    kind: r.kind === 'need' ? 'need' : 'offer', offerType: r.offerType || '',
    title: r.title || '', description: r.description || '', price: r.price || '',
    areas: Array.isArray(r.areas) ? r.areas : [], remote: r.remote === true,
    until: typeof r.validUntil === 'string' ? r.validUntil.slice(0, 10) : '',
    status: ['open', 'paused', 'closed'].includes(r.status) ? r.status : 'open',
    link: r.links?.[0]?.uri || '', offeredBy: r.offeredBy?.uri || '',
  };
}

export function validateOffer(f, today = new Date().toISOString().slice(0, 10)) {
  const errs = [];
  const title = clean(f.title);
  if (!title) errs.push({ field: 'title', message: 'Say in one line what you’re offering or looking for.' });
  else if (graphemes(title) > 200) errs.push({ field: 'title', message: 'Keep the title to 200 characters.' });
  if (graphemes(clean(f.description)) > 2000) errs.push({ field: 'description', message: 'The description can be at most 2,000 characters.' });
  if (graphemes(clean(f.price)) > 200) errs.push({ field: 'price', message: 'Keep the price to 200 characters.' });
  if (f.until && !/^\d{4}-\d{2}-\d{2}$/.test(f.until)) errs.push({ field: 'until', message: 'Choose a date.' });
  else if (f.until && f.until <= today && f.status === 'open') errs.push({ field: 'until', message: 'That date has passed, so the offer would show as closed.' });
  if (clean(f.link) && !normaliseUrl(f.link)) errs.push({ field: 'link', message: 'That doesn’t look like a web address.' });
  if ((f.areas || []).length > 8) errs.push({ field: 'areas', message: 'Up to 8 areas.' });
  return errs;
}

export function offerRecord(f, existing, now = new Date().toISOString()) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const rec = { ...prev, $type: NSID.offer, kind: f.kind === 'need' ? 'need' : 'offer',
    title: clean(f.title), status: f.status || 'open', createdAt: prev.createdAt || now, updatedAt: now };
  setOrDelete(rec, 'offerType', f.offerType || '');
  setOrDelete(rec, 'description', clean(f.description));
  setOrDelete(rec, 'price', clean(f.price));
  setOrDelete(rec, 'areas', (f.areas || []).slice(0, 8));
  if (f.remote) rec.remote = true; else delete rec.remote;
  setOrDelete(rec, 'validUntil', f.until ? `${f.until}T23:59:59.000Z` : '');
  setOrDelete(rec, 'offeredBy', f.offeredBy ? { ...(prev.offeredBy?.uri === f.offeredBy ? prev.offeredBy : {}), uri: f.offeredBy } : null);
  const url = normaliseUrl(f.link);
  setOrDelete(rec, 'links', url ? [{ uri: url }, ...(prev.links || []).slice(1)] : (prev.links || []).slice(1));
  return rec;
}

/* Just the status changed: pause, reopen or close an offer in place. */
export const withStatus = (record, status, now = new Date().toISOString()) =>
  ({ ...record, status, updatedAt: now });
