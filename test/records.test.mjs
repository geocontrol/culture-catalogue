import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaz, problems } from './helpers.mjs';
import { searchAreas, toAreaRef } from '../gazetteer/areas.js';
import {
  areaForPostcode, formatPostcode, isUkPostcode, offerForm, offerRecord, parseList, personForm,
  personRecord, placeForm, placeRecord, validateOffer, validatePerson, validatePlace, withStatus,
} from '../lib/records.js';

const T = '2026-11-06T18:00:00.000Z';
const area = (q) => toAreaRef(gaz, searchAreas(gaz, q)[0]);

test('a new CreativeID with areas validates against the lexicon', () => {
  const f = { name: 'Ines Varga', bio: 'Painter.', disciplines: 'painting, Painting, printmaking',
    basedIn: [area('Frome')], activeIn: [area('London')], website: 'inesvarga.example.org' };
  assert.deepEqual(validatePerson(f), []);
  const rec = personRecord(f, null, T);
  assert.deepEqual(rec.disciplines, ['painting', 'printmaking'], 'repeats dropped, case-insensitively');
  assert.equal(rec.links[0].uri, 'https://inesvarga.example.org/');
  assert.equal(rec.basedIn[0].label, 'Frome, Somerset');
  assert.deepEqual(problems(rec), []);
});

test('editing a CreativeID keeps what other apps wrote, and createdAt', () => {
  const existing = { $type: 'com.cultureblocs.creative.profile', name: 'Old', createdAt: '2026-01-01T00:00:00.000Z',
    based: { name: 'London' }, externalIds: [{ scheme: 'isni', id: '0000000121032683' }],
    links: [{ uri: 'https://a.example/' }, { uri: 'https://b.example/', title: 'Shop' }] };
  const rec = personRecord({ ...personForm(existing), name: 'New', basedIn: [area('Lewisham')] }, existing, T);
  assert.equal(rec.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(rec.based, { name: 'London' }, 'legacy field left as it was');
  assert.deepEqual(rec.externalIds, existing.externalIds);
  assert.deepEqual(rec.links, existing.links);
  assert.deepEqual(problems(rec), []);
});

test('a person must say where they are based', () => {
  assert.ok(validatePerson({ name: 'X', basedIn: [] }).some((e) => e.field === 'basedIn'));
});

test('a place with an address gets a GB address location and validates', () => {
  const f = { ...placeForm(null), name: 'Arch Nine', spaceTypes: ['rehearsal_room'], otherTypes: 'Pottery kiln hire',
    access: 'bookable', street: 'Arch 9, Station Approach', locality: 'London', postcode: 'se154st',
    area: area('Peckham'), capacity: '12', website: 'archnine.example.org' };
  assert.deepEqual(validatePlace(f), []);
  const rec = placeRecord(f, null, { now: T });
  assert.deepEqual(rec.spaceTypes, ['rehearsal_room', 'pottery_kiln_hire']);
  assert.equal(rec.location.postalCode, 'SE15 4ST');
  assert.equal(rec.location.country, 'GB');
  assert.equal(rec.capacity, 12);
  assert.deepEqual(problems(rec), []);
});

test('an online-only supplier has no address and must give a service area', () => {
  const f = { ...placeForm(null), name: 'Selvedge', spaceTypes: ['supplier'], access: 'online_only' };
  assert.ok(validatePlace(f).some((e) => e.field === 'serviceArea'));
  const rec = placeRecord({ ...f, serviceArea: [area('London')] }, { location: { $type: 'community.lexicon.location.address', country: 'GB' } }, { now: T });
  assert.equal(rec.location, undefined, 'an old address is removed');
  assert.deepEqual(problems(rec), []);
});

test('a place needs a postcode we could place', () => {
  const f = { ...placeForm(null), name: 'X', spaceTypes: ['gallery'], access: 'walk_in', street: '1 Rd', locality: 'Town' };
  assert.ok(validatePlace({ ...f, postcode: 'nonsense' }).some((e) => e.field === 'postcode'));
  assert.ok(validatePlace({ ...f, postcode: 'SE15 4ST', area: null }).some((e) => /couldn’t find/.test(e.message)));
});

test('replacing a place image keeps any further images', () => {
  const img = (n) => ({ image: { $type: 'blob', ref: { $link: `bafy${n}` }, mimeType: 'image/jpeg', size: 10 }, alt: '' });
  const existing = { images: [img(1), img(2)], createdAt: T };
  const f = { ...placeForm(existing), name: 'X', spaceTypes: ['gallery'], access: 'online_only', serviceArea: [area('Leeds')] };
  assert.deepEqual(placeRecord(f, existing, { image: img(3) }).images.map((i) => i.image.ref.$link), ['bafy3', 'bafy2']);
  assert.deepEqual(placeRecord(f, existing, { image: null }).images.map((i) => i.image.ref.$link), ['bafy2']);
  assert.equal(placeRecord(f, existing, {}).images.length, 2);
});

test('postcode → area: nearest neighbourhood in the same council, else the council', () => {
  const peckham = areaForPostcode(gaz, { codes: { admin_district: 'E09000028' }, latitude: 51.4698, longitude: -0.068 });
  assert.equal(peckham.n, 'Peckham');
  const frome = areaForPostcode(gaz, { codes: { admin_district: 'E06000066' }, latitude: 51.2289, longitude: -2.322 });
  assert.equal(frome.n, 'Frome');
  const council = areaForPostcode(gaz, { codes: { admin_district: 'E09000023' } });
  assert.equal(council.gss, 'E09000023', 'no coordinates: the council area');
  assert.equal(areaForPostcode(gaz, {}), null);
});

test('postcode helpers', () => {
  assert.equal(formatPostcode(' ba111aa '), 'BA11 1AA');
  assert.ok(isUkPostcode('EC1A 1BB'));
  assert.ok(!isUkPostcode('12345'));
  assert.deepEqual(parseList('a, b,, A'), ['a', 'b']);
});

test('offers: build, validate, pause and reopen in place', () => {
  const f = { ...offerForm(null), offerType: 'hire', title: 'Mixing and mastering', price: 'from £40/hr',
    areas: [area('Lewisham')], remote: true, until: '2027-03-01', link: 'rosamendel.example.org/book' };
  assert.deepEqual(validateOffer(f, '2026-11-06'), []);
  const rec = offerRecord(f, null, T);
  assert.equal(rec.validUntil, '2027-03-01T23:59:59.000Z');
  assert.equal(rec.status, 'open');
  assert.deepEqual(problems(rec), []);
  const paused = withStatus(rec, 'paused', '2026-12-01T00:00:00.000Z');
  assert.equal(paused.createdAt, T);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(problems(paused), []);
  assert.deepEqual(offerForm(rec).until, '2027-03-01');
});

test('an offer from a place points at it; a past date is caught', () => {
  const f = { ...offerForm(null), title: 'Desk to let', offeredBy: 'at://did:plc:x/com.cultureblocs.place.profile/self' };
  assert.equal(offerRecord(f, null, T).offeredBy.uri, f.offeredBy);
  assert.ok(validateOffer({ ...f, until: '2026-01-01' }, '2026-11-06').some((e) => e.field === 'until'));
  assert.equal(offerRecord({ ...f, offeredBy: '' }, null, T).offeredBy, undefined);
});
