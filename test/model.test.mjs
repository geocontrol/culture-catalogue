import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoIndex, gaz } from './helpers.mjs';
import {
  facets, filterEntries, filterValueFor, filtersFromQuery, mapLayers, normalise, normaliseAll,
  queryFromFilters, summarise,
} from '../lib/model.js';
import { searchAreas } from '../gazetteer/areas.js';

const entries = normaliseAll(demoIndex, gaz);
const names = (es) => es.map((e) => e.name).sort();

test('the demo index normalises to people and places, sorted', () => {
  assert.equal(entries.length, 12);
  assert.equal(entries.filter((e) => e.kind === 'person').length, 6);
  assert.deepEqual(entries.map((e) => e.name), [...entries.map((e) => e.name)].sort((a, b) => a.localeCompare(b)));
});

test('filter by council area includes towns and neighbourhoods inside it', () => {
  assert.deepEqual(names(filterEntries(entries, { area: 'E09000028' })), ['Arch Nine Rehearsal Rooms', 'Hollis Byrne', 'Thread & Bobbin']);
});

test('filter by region counts people active there, not only based there', () => {
  const london = filterEntries(entries, { area: 'E12000007', who: 'person' });
  assert.ok(names(london).includes('Ines Varga'), 'Frome-based, active in London');
  assert.ok(names(london).includes('Tom Achterberg'));
});

test('filter by town uses its Wikidata id', () => {
  const frome = searchAreas(gaz, 'Frome')[0];
  assert.equal(filterValueFor(frome), 'Q1242441');
  assert.deepEqual(names(filterEntries(entries, { area: 'Q1242441' })), ['Cheap Street Makers', 'Ines Varga']);
});

test('text, kind of place, discipline and offers filters', () => {
  assert.deepEqual(names(filterEntries(entries, { q: 'recording' })), ['Arch Nine Rehearsal Rooms', 'Rosa Mendel', 'Stratford Sound Works', 'Tom Achterberg']);
  assert.deepEqual(names(filterEntries(entries, { type: 'recording_studio' })), ['Arch Nine Rehearsal Rooms', 'Stratford Sound Works']);
  assert.deepEqual(names(filterEntries(entries, { discipline: 'PRINTMAKING' })), ['Ines Varga', 'Mira Solberg']);
  assert.deepEqual(names(filterEntries(entries, { offers: true })), ["Arch Nine Rehearsal Rooms", "Rosa Mendel", "The Lodge Gallery", "Tom Achterberg"]);
});

test('facets count kinds and disciplines', () => {
  const f = facets(entries);
  assert.deepEqual(f.types.find((t) => t.code === 'recording_studio'), { code: 'recording_studio', label: 'Recording studio', n: 2 });
  assert.equal(f.disciplines.find((d) => d.label === 'printmaking').n, 2);
});

test('summary sentence', () => {
  assert.equal(summarise(entries), '6 places and 6 people');
  assert.equal(summarise(entries.filter((e) => e.kind === 'person').slice(0, 1), 'Frome'), '1 person in Frome');
  assert.equal(summarise([], 'Leeds'), 'Nothing listed in Leeds yet.');
});

test('the map pins places and counts people into areas, never pinning a person', () => {
  const { pins, areas } = mapLayers(entries, gaz);
  assert.equal(pins.length, 6);
  const total = areas.reduce((n, a) => n + a.count, 0);
  assert.equal(total, 6, 'every person counted once, in their home area');
  const lewisham = areas.find((a) => a.label === 'Lewisham');
  assert.ok(lewisham && Number.isFinite(lewisham.lat), 'council areas have a centre');
  const inLondon = mapLayers(filterEntries(entries, { area: 'E12000007' }), gaz, 'E12000007');
  assert.ok(!inLondon.areas.some((a) => a.label === 'Frome'), 'outside the filter, no circle');
});

test('records from the open network: odd shapes are dropped, not shown', () => {
  assert.equal(normalise({ kind: 'person', value: {} }, gaz), null, 'no name');
  assert.equal(normalise({ kind: 'robot', value: { name: 'x' } }, gaz), null);
  const e = normalise({ kind: 'place', uri: 'at://x/y/z', value: { name: 'X', spaceTypes: 'gallery',
    links: [{ uri: 'javascript:alert(1)' }, { uri: 'https://ok.example/' }] }, image: 'data:image/png;base64,xx' }, gaz);
  assert.deepEqual(e.spaceTypes, []);
  assert.deepEqual(e.links, ['https://ok.example/']);
  assert.equal(e.image, null);
});

test('an old CreativeID with only `based` is placed from the gazetteer', () => {
  const e = normalise({ kind: 'person', uri: 'at://x/p/self', value: { name: 'Mark', based: { name: 'London' } } }, gaz);
  assert.equal(e.basedIn[0].wikidata, 'Q84');
  assert.ok(e.basedIn[0].codes.includes('E12000007'));
  const odd = normalise({ kind: 'person', uri: 'at://x/p/self', value: { name: 'Y', based: { name: 'The Moon' } } }, gaz);
  assert.equal(odd.basedIn[0].label, 'The Moon');
  assert.deepEqual(odd.basedIn[0].codes, []);
});

test('filters round-trip through the URL; junk is ignored', () => {
  const f = { q: 'kiln', who: 'place', type: 'makerspace', discipline: '', area: 'Q1242441', offers: true, view: 'map', open: '' };
  assert.deepEqual(filtersFromQuery(queryFromFilters(f)), f);
  assert.equal(filtersFromQuery('?area=<script>&who=robots&view=x').area, '');
  assert.equal(queryFromFilters({ who: 'all', view: 'cards' }), '');
});
