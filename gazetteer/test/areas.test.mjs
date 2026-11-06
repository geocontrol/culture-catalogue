// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGazetteer, searchAreas, toAreaRef, inArea, codeName } from '../areas.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../dist/${f}`, import.meta.url)));
const gaz = await loadGazetteer('', {
  core: read('gazetteer-core.json'),
  villages: read('gazetteer-villages.json'),
});

const first = (q) => searchAreas(gaz, q)[0];

test('Frome is a town in Somerset, rolling up to the South West', () => {
  const ref = toAreaRef(gaz, first('Frome'));
  assert.equal(ref.label, 'Frome, Somerset');
  assert.equal(ref.level, 'town');
  assert.equal(ref.wikidata, 'Q1242441');
  assert.ok(inArea(ref, 'E06000066'), 'in Somerset');
  assert.ok(inArea(ref, 'E12000009'), 'in South West');
  assert.equal(ref.externalIds, undefined, 'a town has no code of its own');
  assert.equal('lat' in ref || 'lng' in ref, false, 'no coordinates in an areaRef');
});

test('Brighton: exact name first, the city of Brighton and Hove alongside', () => {
  const hit = first('Brighton');
  assert.equal(hit.label, 'Brighton, Brighton and Hove');
  assert.ok(inArea(toAreaRef(gaz, hit), 'E06000043'));
  const labels = searchAreas(gaz, 'brigh').map((h) => h.label);
  assert.ok(labels.includes('Brighton, Brighton and Hove'));
  assert.ok(labels.some((l) => l.startsWith('Brighton and Hove')));
});

test('Lewisham and Newham resolve to the London boroughs first', () => {
  for (const [q, code] of [['Lewisham', 'E09000023'], ['Newham', 'E09000025']]) {
    const hit = first(q);
    assert.equal(hit.k, 'local_authority');
    assert.equal(hit.gss, code);
    assert.ok(inArea(toAreaRef(gaz, hit), 'E12000007'), `${q} in London`);
  }
});

test('Bristol is one city choice carrying the council code', () => {
  const hit = first('Bristol');
  assert.equal(hit.k, 'city');
  assert.equal(hit.q, 'Q23154');
  assert.equal(hit.gss, 'E06000023');
});

test('London rolls up to Greater London, not the City of London', () => {
  const ref = toAreaRef(gaz, first('London'));
  assert.equal(ref.wikidata, 'Q84');
  assert.ok(inArea(ref, 'E12000007'));
  assert.equal(inArea(ref, 'E09000033'), false);
});

test('a neighbourhood rolls up to its borough', () => {
  const ref = toAreaRef(gaz, first('Peckham'));
  assert.equal(ref.label, 'Peckham, Southwark');
  assert.ok(inArea(ref, 'E09000028'));
  assert.equal(codeName(gaz, 'E09000028'), 'Southwark');
});

test('multi-word and accent-insensitive search', () => {
  assert.equal(first('upon hull').n, 'Kingston upon Hull');
  assert.ok(searchAreas(gaz, 'ystradgynlais').length || searchAreas(gaz, 'Ystrad').length);
});

test('Scotland, Wales and Northern Ireland are covered', () => {
  for (const [q, ctry] of [['Edinburgh', 'S92000003'], ['Cardiff', 'W92000004'], ['Belfast', 'N92000002']]) {
    assert.ok(inArea(toAreaRef(gaz, first(q)), ctry), q);
  }
});
