#!/usr/bin/env python3
"""Build the bundled UK gazetteer for the Culture Catalogue area picker.

People say where they are based by naming an area ("Frome", "Peckham",
"Brighton"), never by address. The picker needs every such name, the
Wikidata QID that is its portable identity, and the ONS codes of the areas
it sits inside, so a search for "Somerset" or "Southwark" finds people who
picked a town or neighbourhood within it.

Sources (all open data):
  - Wikidata: UK cities, towns, villages and neighbourhoods, with QID,
    English label, coordinates and population; plus the QIDs of ONS areas
    via the GSS code property (P836).
  - ONS Open Geography Portal: Local Authority District boundaries
    (December 2025, generalised) and the LAD -> county / region / country
    lookups. Each place is assigned to a local authority by point-in-polygon.

Usage:
    python build_gazetteer.py fetch     # download sources into raw/
    python build_gazetteer.py build     # write dist/ from raw/
    python build_gazetteer.py all

Requires: shapely (pip install shapely). Fetching needs network access to
query.wikidata.org and services1.arcgis.com.

Output (dist/):
  gazetteer-core.json      local authorities, counties, regions, countries,
                           cities, towns and neighbourhoods
  gazetteer-villages.json  villages, loaded on demand by the picker
Both are column-oriented JSON: {"fields": [...], "rows": [[...], ...]}.

Coordinates in the output are the public centroid of each named place,
rounded to ~100 m, for drawing "creatives in Frome" on a map. They never
go into a person's record: an areaRef carries no coordinates.
"""
from __future__ import annotations

import json
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
DIST = HERE / "dist"
QUERIES = HERE / "queries"

UA = "CultureCatalogueGazetteer/0.1 (https://www.cultureblocs.com)"
SPARQL = "https://query.wikidata.org/sparql"
ONS = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services"

ONS_SOURCES = {
    "lad_boundaries.geojson": (
        "Local_Authority_Districts_DEC_2025_Boundaries_UK_BGC",
        {"outFields": "LAD25CD,LAD25NM,LONG,LAT", "outSR": "4326", "f": "geojson"}),
    "lad_region.json": ("LAD25_RGN25_EN_LU_v2", {"outFields": "*", "f": "json"}),
    "lad_country.json": ("LAD25_CTRY25_UK_LU", {"outFields": "*", "f": "json"}),
    "lad_county.json": ("WD25_LAD25_CTY25_CED25_EN_LU",
                        {"outFields": "LAD25CD,CTY25CD,CTY25NM",
                         "returnDistinctValues": "true",
                         "returnGeometry": "false", "f": "json"}),
}
WIKIDATA_SOURCES = ["city", "town", "neighbourhood", "village", "gss"]

# Picker ranking: bigger kinds first when names tie.
KIND_WEIGHT = {"country": 7, "region": 6, "city": 5, "county": 4,
               "local_authority": 4, "town": 3, "neighbourhood": 2, "village": 1}


# ----------------------------------------------------------------- fetch

def _get(url: str, accept: str | None = None, tries: int = 4) -> bytes:
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                        timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — retry anything transient
            if attempt == tries:
                raise
            print(f"  retry {attempt} after {e!r}")
            time.sleep(20 * attempt)
    raise AssertionError("unreachable")


def fetch() -> None:
    RAW.mkdir(exist_ok=True)
    for name, (service, params) in ONS_SOURCES.items():
        q = {"where": "1=1", "resultRecordCount": "2000", **params}
        url = f"{ONS}/{service}/FeatureServer/0/query?{urllib.parse.urlencode(q)}"
        print(f"ONS {service}")
        (RAW / name).write_bytes(_get(url))
    for name in WIKIDATA_SOURCES:
        query = (QUERIES / f"{name}.rq").read_text()
        url = f"{SPARQL}?{urllib.parse.urlencode({'query': query})}"
        for attempt in range(4):
            print(f"Wikidata {name}")
            body = _get(url, accept="application/sparql-results+json")
            try:  # the endpoint can return a truncated 200 on timeout
                json.loads(body)
                break
            except json.JSONDecodeError:
                print("  truncated response, retrying")
                time.sleep(30)
        else:
            raise SystemExit(f"Wikidata query {name} kept failing")
        (RAW / f"wd_{name}.json").write_bytes(body)


# ----------------------------------------------------------------- build

def _bindings(name: str) -> list[dict]:
    return json.loads((RAW / f"wd_{name}.json").read_text())["results"]["bindings"]


def _qid(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def _point(wkt: str) -> tuple[float, float] | None:
    # "Point(-2.32 51.23)" -> (lng, lat)
    if not wkt.startswith("Point("):
        return None
    lng, lat = wkt[6:-1].split()
    return float(lng), float(lat)


def _attrs(name: str) -> list[dict]:
    return [f["attributes"] for f in json.loads((RAW / name).read_text())["features"]]


def fold(s: str) -> str:
    """Search key: lowercase, accents and punctuation removed."""
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())


def display_name(ons_name: str) -> str:
    """ONS writes 'Bristol, City of' and 'Herefordshire, County of'; people
    write 'Bristol' and 'Herefordshire'."""
    name = ons_name.strip()
    for suffix in (", City of", ", County of"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def build() -> None:
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    # Local authorities and what they sit inside.
    lads = {}
    geoms, geom_codes = [], []
    # outFields=* on the boundary query brings LONG/LAT, the ONS centroid
    for f in json.loads((RAW / "lad_boundaries.geojson").read_text())["features"]:
        p = f["properties"]
        lads[p["LAD25CD"]] = {"name": display_name(p["LAD25NM"]),
                              "pt": (p.get("LONG"), p.get("LAT"))}
        geoms.append(shape(f["geometry"]))
        geom_codes.append(p["LAD25CD"])
    tree = STRtree(geoms)

    for a in _attrs("lad_country.json"):
        lads[a["LAD25CD"]]["ctry"] = (a["CTRY25CD"], a["CTRY25NM"])
    for a in _attrs("lad_region.json"):
        lads[a["LAD25CD"]]["rgn"] = (a["RGN25CD"], a["RGN25NM"])
    for a in _attrs("lad_county.json"):
        if a["LAD25CD"] in lads and a.get("CTY25CD"):
            lads[a["LAD25CD"]]["cty"] = (a["CTY25CD"], a["CTY25NM"])

    # ONS code -> Wikidata QID. Several items can carry one code (a borough
    # and its unitary-authority area); prefer the one whose label matches.
    gss_items: dict[str, list[tuple[str, str]]] = {}
    for b in _bindings("gss"):
        gss_items.setdefault(b["gss"]["value"], []).append(
            (_qid(b["item"]["value"]), b.get("label", {}).get("value", "")))

    def qid_for(code: str, name: str) -> str:
        items = gss_items.get(code, [])
        for q, label in items:
            if fold(label) == fold(name):
                return q
        return min(items, key=lambda x: int(x[0][1:]))[0] if items else ""

    def within(code: str) -> list[str]:
        """ONS codes of the LAD and every area above it, nearest first."""
        lad = lads[code]
        out = [code]
        for k in ("cty", "rgn", "ctry"):
            if k in lad:
                out.append(lad[k][0])
        return out

    def lad_context(code: str) -> str:
        """The name people add after a place: county for two-tier districts,
        the authority itself otherwise."""
        lad = lads[code]
        if code.startswith("E07") and "cty" in lad:
            return lad["cty"][1]
        return lad["name"]

    entries: list[dict] = []

    # Admin areas: countries, regions, counties, local authorities. Each
    # gets a centre for the map: the ONS centroid for a council area, the
    # mean of its councils' centroids for anything bigger.
    def centre(codes):
        pts = [lads[c]["pt"] for c in codes if all(v is not None for v in lads[c]["pt"])]
        if not pts:
            return {}
        return {"lng": round(sum(x for x, _ in pts) / len(pts), 3),
                "lat": round(sum(y for _, y in pts) / len(pts), 3)}
    members: dict[str, list[str]] = {}
    for code, lad in lads.items():
        for k in ("ctry", "rgn", "cty"):
            if k in lad:
                members.setdefault(lad[k][0], []).append(code)
    seen_admin = set()
    for code, lad in lads.items():
        for k, level in (("ctry", "country"), ("rgn", "region"), ("cty", "county")):
            if k in lad and lad[k][0] not in seen_admin:
                c, n = lad[k]
                seen_admin.add(c)
                parents = []
                if level == "county":
                    parents = [x for x in (lad.get("rgn", [None])[0], lad["ctry"][0]) if x]
                elif level == "region":
                    parents = [lad["ctry"][0]]
                entries.append({"q": qid_for(c, n), "n": n, "k": level,
                                "ctx": "" if level == "country" else lad["ctry"][1],
                                "gss": c, "in": parents, **centre(members.get(c, []))})
        entries.append({"q": qid_for(code, lad["name"]), "n": lad["name"],
                        "k": "local_authority",
                        "ctx": lad.get("cty", lad.get("rgn", lad["ctry"]))[1],
                        "gss": code, "in": within(code)[1:], **centre([code])})
    admin_qids = {e["q"] for e in entries if e["q"]}

    # Places from Wikidata. A QID can appear under several kinds (a city
    # that is also a town); keep the biggest kind, first coordinate,
    # largest population.
    places: dict[str, dict] = {}
    for kind in ("city", "town", "neighbourhood", "village"):
        for b in _bindings(kind):
            q = _qid(b["item"]["value"])
            pt = _point(b["coord"]["value"])
            if pt is None:
                continue
            pop = int(float(b["pop"]["value"])) if "pop" in b else 0
            cur = places.get(q)
            if cur is None:
                places[q] = {"q": q, "n": b["label"]["value"], "k": kind, "pt": pt, "pop": pop}
            else:
                if KIND_WEIGHT[kind] > KIND_WEIGHT[cur["k"]]:
                    cur["k"] = kind
                cur["pop"] = max(cur["pop"], pop)

    # A city and the admin area of the same name are one choice for a
    # person ("London", "Cardiff", "Bristol"): keep a single row with the
    # city's QID, which is the identity other apps will use, and the admin
    # area's ONS code and parents, so London rolls up to Greater London and
    # not to the City of London its centroid happens to sit in.
    admin_by_code = {e["gss"]: e for e in entries}

    unplaced = 0
    for p in places.values():
        if p["q"] in admin_qids:
            # The city item is itself the authority item: mark it a city.
            e = next(e for e in entries if e["q"] == p["q"])
            if p["k"] == "city":
                e.update({"k": "city", "lng": round(p["pt"][0], 3),
                          "lat": round(p["pt"][1], 3), "pop": p["pop"]})
            continue
        pt = Point(p["pt"])
        hit = None
        for i in tree.query(pt):
            if geoms[i].covers(pt):
                hit = geom_codes[i]
                break
        if hit is None:
            unplaced += 1  # offshore coordinate or bad data
            continue
        if p["k"] == "city":
            same = next((admin_by_code[c] for c in within(hit)
                         if c in admin_by_code and fold(admin_by_code[c]["n"]) == fold(p["n"])),
                        None)
            if same is not None:
                same.update({"q": p["q"], "k": "city", "lng": round(p["pt"][0], 3),
                             "lat": round(p["pt"][1], 3), "pop": p["pop"]})
                continue
        ctx = lad_context(hit)
        if p["k"] == "city" or fold(ctx) == fold(p["n"]):
            # Cities read better with their region ("Bristol, South West");
            # never "London, London".
            lad = lads[hit]
            ctx = lad.get("rgn", lad["ctry"])[1]
            if fold(ctx) == fold(p["n"]):
                ctx = lad["ctry"][1]
        entries.append({"q": p["q"], "n": p["n"], "k": p["k"], "ctx": ctx,
                        "gss": "", "in": within(hit),
                        "lng": round(p["pt"][0], 3), "lat": round(p["pt"][1], 3),
                        "pop": p["pop"]})

    entries.sort(key=lambda e: (-KIND_WEIGHT[e["k"]], -e.get("pop", 0), e["n"]))

    fields = ["q", "n", "k", "ctx", "gss", "in", "lng", "lat", "pop"]
    names = {e["gss"]: e["n"] for e in entries if e["gss"]}
    meta = {"built": date.today().isoformat(),
            "sources": ["Wikidata (CC0)",
                        "ONS Open Geography Portal, LAD Dec 2025 boundaries and lookups "
                        "(Open Government Licence v3.0; contains OS data © Crown copyright "
                        "and database right)"],
            "fields": fields}
    DIST.mkdir(exist_ok=True)
    core = [e for e in entries if e["k"] != "village"]
    villages = [e for e in entries if e["k"] == "village"]
    for name, rows in (("gazetteer-core.json", core), ("gazetteer-villages.json", villages)):
        extra = {"codes": names} if name == "gazetteer-core.json" else {}
        doc = {**meta, **extra, "rows": [[e.get(f, "" if f in ("q", "gss", "ctx") else None)
                                 for f in fields] for e in rows]}
        (DIST / name).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
        print(f"{name}: {len(rows)} areas, {(DIST / name).stat().st_size // 1024} KB")
    print(f"skipped {unplaced} places outside every local authority")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("fetch", "all"):
        fetch()
    if cmd in ("build", "all"):
        build()
