import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from './helpers.mjs';
import { buildIndex, entriesForRepo, normalisePostcode, venueAsPlace } from '../lib/indexer.js';
import { offerIsOpen } from '../lib/offers.js';

const NOW = new Date('2026-11-06T18:00:00Z');
const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const H = 'did:plc:hhhhhhhhhhhhhhhhhhhhhhhh';
const PDS = 'https://pds.example';

const rec = (did, coll, rkey, value) => ({ uri: `at://${did}/${coll}/${rkey}`, cid: 'bafy', value: { $type: coll, createdAt: '2026-11-01T00:00:00Z', ...value } });

test('offers open only when status is open and inside their window', () => {
  assert.equal(offerIsOpen({ status: 'open' }, NOW), true);
  assert.equal(offerIsOpen({ status: 'paused' }, NOW), false);
  assert.equal(offerIsOpen({ status: 'new-thing' }, NOW), false);
  assert.equal(offerIsOpen({ status: 'open', validUntil: '2026-11-01T00:00:00Z' }, NOW), false);
  assert.equal(offerIsOpen({ status: 'open', validFrom: '2026-12-01T00:00:00Z' }, NOW), false);
  assert.equal(offerIsOpen({ status: 'open', validUntil: 'soon' }, NOW), true);
});

test('a repo gives a person and its places, with offers attached by the AppView rule', () => {
  const place = rec(A, 'com.cultureblocs.place.profile', 'self', { name: 'Arch Nine', spaceTypes: ['rehearsal_room'] });
  const out = entriesForRepo({
    did: A, pds: PDS, handle: 'a.example',
    people: [rec(A, 'com.cultureblocs.creative.profile', 'self', { name: 'Rosa' })],
    places: [place], venues: [rec(A, 'com.cultureblocs.venue.profile', 'self', { name: 'Old' })],
    offers: [
      rec(A, 'com.cultureblocs.offer', '1', { kind: 'offer', title: 'Mixing', status: 'open' }),
      rec(A, 'com.cultureblocs.offer', '2', { kind: 'offer', title: 'Room', status: 'open', offeredBy: { uri: place.uri } }),
      rec(A, 'com.cultureblocs.offer', '3', { kind: 'offer', title: 'Paused', status: 'paused' }),
      rec(A, 'com.cultureblocs.offer', '4', { kind: 'offer', title: 'Not mine', status: 'open', offeredBy: { uri: `at://${B}/com.cultureblocs.place.profile/self` } }),
    ],
  }, NOW);
  assert.deepEqual(out.map((e) => [e.kind, e.value.name]), [['person', 'Rosa'], ['place', 'Arch Nine']]);
  assert.deepEqual(out[0].offers.map((o) => o.value.title), ['Mixing']);
  assert.deepEqual(out[1].offers.map((o) => o.value.title), ['Room']);
});

test('an account with only an old venue record is read as a place', () => {
  const [e] = entriesForRepo({ did: B, pds: PDS, people: [], places: [], offers: [],
    venues: [rec(B, 'com.cultureblocs.venue.profile', 'self', { name: 'The Ivy House', address: '40 Stuart Rd', capacity: 200 })] }, NOW);
  assert.equal(e.kind, 'place');
  assert.deepEqual(e.value.spaceTypes, ['venue']);
  assert.equal(e.value.capacity, 200);
  assert.equal(e.value.address, undefined);
  assert.equal(e.legacyCollection, 'com.cultureblocs.venue.profile');
  assert.deepEqual(venueAsPlace({ name: 'x' }).spaceTypes, ['venue']);
});

test('buildIndex discovers repos, reads their own servers, geocodes postcodes, hides what is hidden', async () => {
  const repos = {
    'com.cultureblocs.creative.profile': [A, H],
    'com.cultureblocs.place.profile': [B],
  };
  const records = {
    [`${A}|com.cultureblocs.creative.profile`]: [rec(A, 'com.cultureblocs.creative.profile', 'self', { name: 'Rosa' })],
    [`${B}|com.cultureblocs.place.profile`]: [rec(B, 'com.cultureblocs.place.profile', 'self', { name: 'Arch Nine', spaceTypes: ['gallery'],
      location: { $type: 'community.lexicon.location.address', postalCode: 'se15 4st', country: 'GB' } })],
  };
  const fetchFn = fakeFetch({
    'https://relay.example/xrpc/com.atproto.sync.listReposByCollection': (url) => {
      const c = new URL(url).searchParams.get('collection');
      return { repos: (repos[c] || []).map((did) => ({ did })) };
    },
    'https://plc.directory/': (url) => {
      const did = decodeURIComponent(url.split('/').pop());
      return { alsoKnownAs: [`at://${did.slice(8, 12)}.example`], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] };
    },
    [`${PDS}/xrpc/com.atproto.repo.listRecords`]: (url) => {
      const q = new URL(url).searchParams;
      return { records: records[`${q.get('repo')}|${q.get('collection')}`] || [] };
    },
    'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles': { profiles: [{ did: A, displayName: 'Rosa M', avatar: 'https://cdn.example/a.jpg' }] },
    'https://api.postcodes.io/postcodes': { result: [{ query: 'SE154ST', result: { latitude: 51.47, longitude: -0.068 } }] },
  });
  const index = await buildIndex({ fetchFn, relay: 'https://relay.example', now: NOW, hidden: { dids: [H] } });
  assert.deepEqual(index.errors, []);
  assert.equal(index.repos, 2, 'hidden repo never read');
  const byName = Object.fromEntries(index.entries.map((e) => [e.value.name, e]));
  assert.equal(byName.Rosa.avatar, 'https://cdn.example/a.jpg');
  assert.equal(byName.Rosa.handle, 'aaaa.example');
  assert.deepEqual(byName['Arch Nine'].coords, { lat: 51.47, lng: -0.068 });
  assert.ok(!fetchFn.calls.some((c) => c.url.includes(H.slice(8))), 'nothing fetched for the hidden repo');
});

test('a repo whose server fails is reported, not fatal', async () => {
  const fetchFn = fakeFetch({
    'https://relay.example/': { repos: [{ did: A }] },
    'https://plc.directory/': { service: [] },
  });
  const index = await buildIndex({ fetchFn, relay: 'https://relay.example', now: NOW });
  assert.equal(index.entries.length, 0);
  assert.equal(index.errors[0].did, A);
});

test('postcodes normalise for lookup', () => {
  assert.equal(normalisePostcode(' se15 4st '), 'SE154ST');
});
