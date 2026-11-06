# Culture Catalogue — UK area gazetteer

The bundled place list behind Culture Catalogue's area picker. People say where they are based by naming an area (Frome, Peckham, Brighton), never by address. The picker turns that choice into a `com.cultureblocs.defs#areaRef`:

```json
{
  "label": "Frome, Somerset",
  "level": "town",
  "country": "GB",
  "wikidata": "Q1242441",
  "within": [
    { "scheme": "gss", "id": "E06000066" },
    { "scheme": "gss", "id": "E12000009" },
    { "scheme": "gss", "id": "E92000001" }
  ]
}
```

`wikidata` is the portable identity. `within` lists the ONS codes of the council area, county (for two-tier districts), region and country, nearest first. Any reader can then filter "everyone in Somerset" without a gazetteer of its own. An areaRef carries no coordinates.

## What's in it

| File | Contents | Size (gzip) |
|---|---|---|
| `dist/gazetteer-core.json` | 4 countries, 8 English regions (London is merged with the city), 21 counties, ~300 council areas, 150 cities, ~1,600 towns, ~4,250 neighbourhoods | ~700 KB (~140 KB) |
| `dist/gazetteer-villages.json` | ~19,400 villages, fetched on demand | ~2.1 MB (~410 KB) |

Each place is assigned to a council area by point-in-polygon against the ONS December 2025 boundaries. Labels add the context people actually use:
- the county for two-tier districts ("Ashford, Kent");
- the borough or unitary authority otherwise ("Peckham, Southwark", "Frome, Somerset");
- the region for cities ("Bristol, South West").

A city and the council area of the same name are merged into one choice. "London" therefore rolls up to Greater London rather than the City of London borough that its centroid sits in.

Hamlets and civil parishes are left out. Someone in a hamlet picks the nearest village or town.

## Use

```js
import { loadGazetteer, searchAreasDeep, toAreaRef, inArea } from './areas.js';

const gaz = await loadGazetteer('/gazetteer');   // folder holding dist/*.json
const hits = await searchAreasDeep(gaz, 'fro');  // ranked: label, kindLabel
const ref = toAreaRef(gaz, hits[0]);             // → write into basedIn / activeIn
inArea(ref, 'E09000028');                        // filter: is this in Southwark?
```

## Rebuild

```sh
pip install shapely
python build_gazetteer.py all      # fetch (Wikidata + ONS) then build
python build_gazetteer.py build    # rebuild from raw/ only
node --test test/
```

Rebuild when ONS publishes new boundaries, which usually happens each December: update the `LAD25` service names in `build_gazetteer.py`. The Wikidata endpoint sometimes times out, and the script retries.

## Licences

- Wikidata: CC0.
- ONS boundaries and lookups: Open Government Licence v3.0. Source: Office for National Statistics; contains OS data © Crown copyright and database right. This attribution has to appear somewhere in Culture Catalogue, for example in the footer or the about page.

## Known gaps

- Wikidata has no ONS code for two council areas, Barnsley and Sheffield; Sheffield is covered through the city merge.
- About 130 Wikidata places sit outside every council boundary (offshore or bad coordinates) and are skipped.
- Same-name pairs that aren't cities, such as Ashford the town and Ashford the district, appear as two choices. The picker shows the kind ("town" / "council area") next to each.
- EU coverage comes later. The plan is the same, with Eurostat LAU codes under a `lau` scheme in `within`.
