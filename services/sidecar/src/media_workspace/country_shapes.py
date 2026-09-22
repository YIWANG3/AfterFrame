"""Which country a coordinate is in, from offline borders.

The gazetteer only has centroids, and "nearest centroid" is wrong anywhere
near a border (Shangri-La, 300 km from the Kachin State centroid and 360 km
from Yunnan's, came out as Myanmar). Natural Earth's 50m country polygons
(data/countries.json.gz, built by research/gazetteer-lab/build_countries.py)
settle it by point-in-polygon. Hong Kong, Macau and Taiwan are their own
features there, with the same ISO codes the AI resolver produces.
"""
from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

COUNTRIES_PATH = Path(__file__).parent / "data" / "countries.json.gz"

Ring = list[float]  # lon, lat, lon, lat, …
Bounds = tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat
# Edges bucketed by the latitude band they cross, so a point only meets the
# few edges at its own latitude instead of a whole coastline.
Edges = dict[int, list[tuple[float, float, float, float]]]
_BAND_DEG = 0.5


def _band(lat: float) -> int:
    return math.floor(lat / _BAND_DEG)


def _bucket(ring: Ring) -> Edges:
    edges: Edges = {}
    n = len(ring) // 2
    j = n - 1
    for i in range(n):
        xi, yi, xj, yj = ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]
        j = i
        if yi == yj:
            continue  # a horizontal edge never crosses a ray
        for band in range(_band(min(yi, yj)), _band(max(yi, yj)) + 1):
            edges.setdefault(band, []).append((xi, yi, xj, yj))
    return edges


def _inside(edges: Edges, x: float, y: float) -> bool:
    """Ray casting: count the edges left of the point that straddle its latitude."""
    inside = False
    for xi, yi, xj, yj in edges.get(_band(y), ()):
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


class CountryShapes:
    def __init__(self, payload: dict):
        self.names: dict[str, dict[str, str | None]] = {}
        # (iso, bounds, outer ring, holes) per polygon; bounds keep the
        # ray casting to the few polygons a point can possibly be in.
        self.polygons: list[tuple[str, Bounds, Edges, list[Edges]]] = []
        for country in payload.get("countries", []):
            self.names[country["iso"]] = {"en": country.get("en"), "zh": country.get("zh")}
            for rings in country.get("polygons", []):
                if not rings or len(rings[0]) < 6:
                    continue
                outer = rings[0]
                lons, lats = outer[0::2], outer[1::2]
                bounds = (min(lons), min(lats), max(lons), max(lats))
                self.polygons.append((country["iso"], bounds, _bucket(outer), [_bucket(hole) for hole in rings[1:]]))

    def country_at(self, lat: float, lon: float) -> str | None:
        """ISO 3166-1 alpha-2 of the country containing the point, or None
        at sea. The first polygon that contains the point wins; enclaves
        (Lesotho, San Marino) are holes in their neighbour, so the order
        does not matter."""
        for iso, bounds, outer, holes in self.polygons:
            if not (bounds[0] <= lon <= bounds[2] and bounds[1] <= lat <= bounds[3]):
                continue
            if _inside(outer, lon, lat) and not any(_inside(hole, lon, lat) for hole in holes):
                return iso
        return None


_shapes: CountryShapes | None = None
_load_failed = False


def load_country_shapes() -> CountryShapes | None:
    """Lazy singleton; None when the data file is absent, so a checkout
    without it degrades to the gazetteer's centroid guess."""
    global _shapes, _load_failed
    if _shapes is not None or _load_failed:
        return _shapes
    try:
        with gzip.open(COUNTRIES_PATH, "rb") as f:
            _shapes = CountryShapes(json.load(f))
    except OSError:
        _load_failed = True
    return _shapes


def set_country_shapes_for_tests(payload: dict | None) -> None:
    global _shapes, _load_failed
    _shapes = CountryShapes(payload) if payload is not None else None
    _load_failed = False
