# Culture Catalogue

A directory of creative people and places: music venues, rehearsal rooms, recording studios, artist studios, galleries, suppliers and shops, plus the people who make culture happen. You can browse it as a list, as cards or on a map, and filter it by area, type and tags.

Culture Catalogue is its own brand and keeps its own index, but it doesn't own the data. Every entry is a [CultureBlocs](https://www.cultureblocs.com) record published by that person or place in their own [AT Protocol](https://atproto.com) repository:

- `com.cultureblocs.creative.profile` (CreativeID): people, located by area only (`basedIn`, `activeIn`), never by address
- `com.cultureblocs.place.profile`: places the public can visit or book, with space types and an address
- `com.cultureblocs.offer`: offers and needs that come and go (open, paused or closed, with optional expiry)

Schemas: <https://www.cultureblocs.com/lexicons.html>

New people sign in with an existing Atmosphere account (Bluesky or similar), or create one during onboarding. They then publish their CreativeID or place profile, and any app built on CultureBlocs can read it, not only this one.

## In this repo

- [`gazetteer/`](gazetteer/): the bundled UK area gazetteer and picker. People choose "Frome" or "Peckham", and it is stored as an `areaRef` with a Wikidata ID and ONS codes for the council area, county, region and country.

## Status

Early. UK-wide from the start, with most of the first data in London. EU coverage is planned.
