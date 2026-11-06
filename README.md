# Culture Catalogue

A directory of creative people and places: music venues, rehearsal rooms, recording studios, artist studios, galleries, suppliers and shops, plus the people who make culture happen. You can browse it as a list, as index cards or on a map, and filter it by area, kind of place, discipline and open offers.

Culture Catalogue is its own brand, but it doesn't own the data. Every entry is a [CultureBlocs](https://www.cultureblocs.com) record published by that person or place in their own [AT Protocol](https://atproto.com) account:

| Record | What it is |
|---|---|
| `com.cultureblocs.creative.profile` (CreativeID) | A person. Located by area only (`basedIn`, `activeIn`), never by address |
| `com.cultureblocs.place.profile` | A place the public can visit or book, with its kinds of space and an address |
| `com.cultureblocs.offer` | An offer or a need that comes and goes: open, paused or closed, with an optional end date |
| `com.cultureblocs.venue.profile` | Deprecated. Old venue records are shown as places |

Schemas: <https://www.cultureblocs.com/lexicons.html>

## How it works

- **The index.** `api/catalogue.js` is a stateless Vercel edge function. It asks a relay which accounts hold these records (`com.atproto.sync.listReposByCollection`) and reads them from each account's own server. It then adds Bluesky display names and avatars, and map coordinates for UK postcodes from postcodes.io. Nothing is stored. The edge cache keeps each build for 10 minutes and serves the old one while the next is made. Hide an account or a record from the directory with `data/hidden.json`.
- **The directory** (`index.html`, `app.js`, `lib/model.js`) shows one filtered query three ways. Every filter is in the URL. Places are pinned at their address. People are counted into the areas they are based in and never pinned.
- **Adding yourself** (`join/`): sign in with an existing account, or create one during the flow on Bluesky, Eurosky or another host that supports it. Then publish a CreativeID or a place, and add offers that can be paused and reopened. Records are written only to the person's own account, with permission for just these record types where the server supports narrow permissions. Edits keep any fields other apps wrote.
- **Areas** come from the bundled UK gazetteer in [`gazetteer/`](gazetteer/). A person picks "Frome" or "Peckham", which is stored as an `areaRef` with a Wikidata ID and the ONS codes it sits within. A place's area comes from its postcode.

## Run it

```sh
npm run dev               # http://127.0.0.1:8787, live index from the network
node scripts/serve.mjs --demo   # invented demo entries, for layout work
npm run index             # build the index once and list what was found
npm test
```

Use `127.0.0.1` rather than `localhost`. ATProto sign-in then works from the dev server as a loopback client, without a deployed metadata file.

## Deploy

1. Import the repo into Vercel as a static project (no framework, no build step).
2. Point sign-in at the real address: `node scripts/set-origin.mjs https://your.domain`, then commit. ATProto identifies an app by the URL of its `join/client-metadata.json`, so it must match where the site is served. It's currently set to `https://culture-catalogue.vercel.app`.

## Layout

```
index.html, app.js, style.css   the directory
join/                           "Add yourself": sign-in, forms, offers
api/catalogue.js                the index (edge function)
lib/indexer.js                  discovery and reads (Node, browser and edge)
lib/model.js                    entries, filters, facets, map layers
lib/records.js                  forms ⇄ records, postcode → area
lib/oauth.js                    ATProto OAuth (PKCE, PAR, DPoP) with sign-up
lib/area-picker.js, lib/map.js  the area combobox; the MapLibre map
gazetteer/                      UK area gazetteer and its build script
lexicons/                       copies of the CultureBlocs lexicons, for tests
test/                           node --test suites; test/fixtures is invented data
```

## Licences and credits

Areas: Wikidata (CC0) and Office for National Statistics boundaries, licensed under the Open Government Licence v3.0, containing OS data © Crown copyright and database right. Postcodes: postcodes.io. Map: OpenFreeMap and © OpenStreetMap contributors.
