"""Collections for the 发现 (Discover) page: places and memories.

Both are derived from the same rows the map draws (list_map_points, locality
precision or better) and need no schema — every located asset is reverse-
geocoded against the offline gazetteer to its nearest locality, then:

- a PLACE is one locality: count, centroid, tight bounds around its photos,
  best cover;
- a MEMORY is one visit to a place: the photos of one locality split into
  runs of capture days where consecutive shots are at most MEMORY_GAP_DAYS
  apart. Runs shorter than MEMORY_MIN_PHOTOS are noise (one snapshot from a
  layover) and are dropped.

Every entry carries `bounds` so the app can open it as an ordinary gallery
filter (filters.geo mode=bounds, plus date_from/date_to for memories) — the
page never invents a filter the gallery can't express.

Reverse geocoding: the gazetteer's "localities" tier mixes cities with their
neighbourhoods (Financial District, Presidio, Times Square…), and a memory
titled "Financial District" is not what anyone calls a weekend in San
Francisco. So within LOCALITY_SEARCH_KM the winner is scored by importance
(Wikidata sitelinks) minus a distance penalty — a city a few km away beats
the neighbourhood you are standing in, but a real neighbouring town
(Sausalito, 10 km from San Francisco with a fraction of the links) keeps its
own name. Fallbacks: nearest locality inside NEAREST_LOCALITY_KM, nearest
admin1 inside NEAREST_ADMIN1_KM, nearest country centroid. The index is built
once per process; the sidecar is resident so the cost is paid once.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime
from typing import Any, Iterable

from .geo_resolver import load_gazetteer

MEMORY_GAP_DAYS = 3
MEMORY_MIN_PHOTOS = 3
LOCALITY_SEARCH_KM = 25.0
LOCALITY_KM_PENALTY = 0.25  # score = ln(2 + sitelinks) − penalty × km
NEAREST_LOCALITY_KM = 40.0
NEAREST_ADMIN1_KM = 400.0
_CELL_DEG = 0.5
_EARTH_KM = 6371.0


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Equirectangular approximation: plenty for "which town is this" at the
    # distances involved, and ~10x cheaper than haversine over 165k rows.
    x = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2.0))
    y = math.radians(lat2 - lat1)
    return _EARTH_KM * math.hypot(x, y)


class _GridIndex:
    """Bucket points by 0.5° cell; a query scans the 3×3 (or wider) block."""

    def __init__(self, items: Iterable[dict]):
        self.cells: dict[tuple[int, int], list[dict]] = defaultdict(list)
        for item in items:
            try:
                lat, lon = float(item["lat"]), float(item["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            self.cells[self._cell(lat, lon)].append(item)

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        return (math.floor(lat / _CELL_DEG), math.floor(lon / _CELL_DEG))

    def within(self, lat: float, lon: float, max_km: float) -> list[tuple[dict, float]]:
        rings = max(1, math.ceil(max_km / (_CELL_DEG * 111.0)))
        cy, cx = self._cell(lat, lon)
        hits: list[tuple[dict, float]] = []
        for dy in range(-rings, rings + 1):
            for dx in range(-rings, rings + 1):
                for item in self.cells.get((cy + dy, cx + dx), ()):
                    km = _distance_km(lat, lon, float(item["lat"]), float(item["lon"]))
                    if km <= max_km:
                        hits.append((item, km))
        return hits

    def nearest(self, lat: float, lon: float, max_km: float) -> tuple[dict | None, float]:
        # Widen the search ring until something is found or the ring exceeds
        # max_km (one ring ≈ 55 km of latitude).
        rings = max(1, math.ceil(max_km / (_CELL_DEG * 111.0)))
        cy, cx = self._cell(lat, lon)
        best: dict | None = None
        best_km = math.inf
        for ring in range(rings + 1):
            for dy in range(-ring, ring + 1):
                for dx in range(-ring, ring + 1):
                    if max(abs(dy), abs(dx)) != ring:
                        continue
                    for item in self.cells.get((cy + dy, cx + dx), ()):
                        km = _distance_km(lat, lon, float(item["lat"]), float(item["lon"]))
                        if km < best_km:
                            best, best_km = item, km
            # Anything in a farther ring is at least (ring × cell) away; stop
            # once the best hit is closer than that lower bound.
            if best is not None and best_km <= ring * _CELL_DEG * 111.0:
                break
        if best is None or best_km > max_km:
            return None, math.inf
        return best, best_km


class ReverseGeocoder:
    def __init__(self, payload: dict[str, Any]):
        self.localities = _GridIndex(payload.get("localities", []))
        self.admin1 = _GridIndex(payload.get("admin1", []))
        self.countries = _GridIndex(payload.get("countries", []))
        self.country_by_qid = {c["q"]: c for c in payload.get("countries", []) if c.get("q")}

    def lookup(self, lat: float, lon: float) -> dict | None:
        """→ {key, en, zh, country_en, country_zh} or None when the gazetteer
        has nothing anywhere near (open ocean)."""
        candidates = self.localities.within(lat, lon, LOCALITY_SEARCH_KM)
        scored = None
        if candidates:
            scored = max(candidates, key=lambda c: math.log(2 + (c[0].get("links") or 0)) - LOCALITY_KM_PENALTY * c[1])[0]
        for index, max_km, preset in ((self.localities, NEAREST_LOCALITY_KM, scored), (self.admin1, NEAREST_ADMIN1_KM, None)):
            item = preset if preset is not None else index.nearest(lat, lon, max_km)[0]
            if item is not None:
                country = self.country_by_qid.get(item.get("country") or "", {})
                return {
                    "key": item["q"],
                    "en": item.get("en") or item.get("zh") or item["q"],
                    "zh": item.get("zh") or item.get("en") or item["q"],
                    "country_en": country.get("en"),
                    "country_zh": country.get("zh"),
                }
        item, _km = self.countries.nearest(lat, lon, 3000.0)
        if item is None:
            return None
        return {
            "key": item["q"],
            "en": item.get("en") or item["q"],
            "zh": item.get("zh") or item.get("en") or item["q"],
            "country_en": None,
            "country_zh": None,
        }


_geocoder: ReverseGeocoder | None = None


def load_reverse_geocoder() -> ReverseGeocoder | None:
    global _geocoder
    if _geocoder is not None:
        return _geocoder
    gazetteer = load_gazetteer()
    if gazetteer is None:
        return None
    _geocoder = ReverseGeocoder(gazetteer.payload)
    return _geocoder


def set_reverse_geocoder_for_tests(payload: dict[str, Any] | None) -> None:
    global _geocoder
    _geocoder = ReverseGeocoder(payload) if payload is not None else None


def _capture_day(value: object) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _bounds(points: list[dict]) -> dict[str, float]:
    lats = [p["latitude"] for p in points]
    lons = [p["longitude"] for p in points]
    south, north, west, east = min(lats), max(lats), min(lons), max(lons)
    # Pad so the filter's R*Tree query comfortably contains every photo and a
    # single-photo place still has a non-degenerate box.
    pad_lat = max(0.02, (north - south) * 0.08)
    pad_lon = max(0.02, (east - west) * 0.08)
    return {
        "west": max(-180.0, west - pad_lon),
        "south": max(-90.0, south - pad_lat),
        "east": min(180.0, east + pad_lon),
        "north": min(90.0, north + pad_lat),
    }


def _cover(points: list[dict]) -> dict | None:
    with_preview = [p for p in points if p.get("preview_path")]
    if not with_preview:
        return None
    return max(with_preview, key=lambda p: ((p.get("app_rating") or 0), p.get("capture_time") or ""))


def _place_entry(place: dict, points: list[dict]) -> dict:
    cover = _cover(points)
    return {
        "key": place["key"],
        "name_en": place["en"],
        "name_zh": place["zh"],
        "country_en": place.get("country_en"),
        "country_zh": place.get("country_zh"),
        "count": len(points),
        "latitude": sum(p["latitude"] for p in points) / len(points),
        "longitude": sum(p["longitude"] for p in points) / len(points),
        "bounds": _bounds(points),
        "cover_asset_id": cover["asset_id"] if cover else None,
        "cover_preview_path": cover["preview_path"] if cover else None,
    }


def build_discover_collections(points: list[dict], geocoder: ReverseGeocoder | None) -> dict[str, list[dict]]:
    """points: list_map_points rows as dicts (latitude, longitude, capture_time,
    app_rating, preview_path, asset_id). Returns {"places": [...], "memories": [...]}."""
    if geocoder is None:
        return {"places": [], "memories": []}
    by_place: dict[str, tuple[dict, list[dict]]] = {}
    for p in points:
        try:
            lat, lon = float(p["latitude"]), float(p["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        place = geocoder.lookup(lat, lon)
        if place is None:
            continue
        row = dict(p, latitude=lat, longitude=lon)
        by_place.setdefault(place["key"], (place, []))[1].append(row)

    places = [_place_entry(place, rows) for place, rows in by_place.values()]
    places.sort(key=lambda e: (-e["count"], e["name_en"]))

    memories: list[dict] = []
    for place, rows in by_place.values():
        dated = [(d, r) for r in rows if (d := _capture_day(r.get("capture_time"))) is not None]
        dated.sort(key=lambda t: t[0])
        run: list[tuple[date, dict]] = []
        for entry in dated + [(None, None)]:
            day = entry[0]
            if run and (day is None or (day - run[-1][0]).days > MEMORY_GAP_DAYS):
                if len(run) >= MEMORY_MIN_PHOTOS:
                    run_rows = [r for _d, r in run]
                    cover = _cover(run_rows)
                    memories.append({
                        "key": f"{place['key']}:{run[0][0].isoformat()}",
                        "place_key": place["key"],
                        "name_en": place["en"],
                        "name_zh": place["zh"],
                        "country_en": place.get("country_en"),
                        "country_zh": place.get("country_zh"),
                        "date_from": run[0][0].isoformat(),
                        "date_to": run[-1][0].isoformat(),
                        "count": len(run_rows),
                        "bounds": _bounds(run_rows),
                        "cover_asset_id": cover["asset_id"] if cover else None,
                        "cover_preview_path": cover["preview_path"] if cover else None,
                    })
                run = []
            if day is not None:
                run.append((day, entry[1]))
    memories.sort(key=lambda m: m["date_to"], reverse=True)
    return {"places": places, "memories": memories}


__all__ = [
    "MEMORY_GAP_DAYS",
    "MEMORY_MIN_PHOTOS",
    "ReverseGeocoder",
    "build_discover_collections",
    "load_reverse_geocoder",
    "set_reverse_geocoder_for_tests",
]
