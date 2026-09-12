"""Unit tests for the Discover page collections (places + memories)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from media_workspace.discover import ReverseGeocoder, build_discover_collections  # noqa: E402

GAZETTEER = {
    "countries": [{"q": "Q30", "en": "United States", "zh": "美国", "lat": 39.8, "lon": -98.6}],
    "admin1": [{"q": "Q99", "en": "California", "zh": "加利福尼亚州", "lat": 37.2, "lon": -119.5, "country": "Q30"}],
    "localities": [
        {"q": "Q62", "en": "San Francisco", "zh": "旧金山", "lat": 37.7749, "lon": -122.4194, "country": "Q30", "links": 235},
        {"q": "Q1", "en": "Sausalito", "zh": "索萨利托", "lat": 37.8591, "lon": -122.4853, "country": "Q30", "links": 57},
        {"q": "Q2", "en": "Morro Bay", "zh": "莫罗贝", "lat": 35.3658, "lon": -120.8499, "country": "Q30", "links": 48},
        {"q": "Q3", "en": "Financial District", "zh": "金融区", "lat": 37.7952, "lon": -122.4029, "country": "Q30", "links": 10},
        {"q": "Q4", "en": "Marin City", "zh": "马林市", "lat": 37.8733, "lon": -122.5117, "country": "Q30", "links": 31},
    ],
}


def _pt(asset_id, lat, lon, day, rating=0, preview=True):
    return {
        "asset_id": asset_id,
        "latitude": lat,
        "longitude": lon,
        "capture_time": f"{day}T12:00:00+00:00",
        "app_rating": rating,
        "preview_path": f"/p/{asset_id}.jpg" if preview else None,
    }


class ReverseGeocodeTests(unittest.TestCase):
    def test_neighbouring_town_keeps_its_name(self):
        geo = ReverseGeocoder(GAZETTEER)
        hit = geo.lookup(37.86, -122.48)  # Sausalito waterfront, 10 km from SF
        self.assertEqual(hit["en"], "Sausalito")
        self.assertEqual(hit["country_zh"], "美国")
        self.assertEqual(geo.lookup(37.872, -122.510)["en"], "Marin City")

    def test_neighbourhood_folds_into_its_city(self):
        geo = ReverseGeocoder(GAZETTEER)
        # Standing in the Financial District: the city is 2 km away and far
        # more important than the district under your feet.
        self.assertEqual(geo.lookup(37.7955, -122.403)["en"], "San Francisco")

    def test_falls_back_to_admin1_then_country(self):
        geo = ReverseGeocoder(GAZETTEER)
        self.assertEqual(geo.lookup(36.5, -118.0)["en"], "California")  # Sierra: no town within 40 km
        self.assertEqual(geo.lookup(45.0, -100.0)["en"], "United States")
        self.assertIsNone(geo.lookup(-60.0, 20.0))  # Southern Ocean


class CollectionTests(unittest.TestCase):
    def test_places_and_memories(self):
        geo = ReverseGeocoder(GAZETTEER)
        points = [
            # A Sausalito day: 4 photos, one rated — becomes the cover.
            _pt("a1", 37.858, -122.486, "2026-08-08"),
            _pt("a2", 37.859, -122.484, "2026-08-08", rating=5),
            _pt("a3", 37.860, -122.485, "2026-08-08"),
            _pt("a4", 37.861, -122.483, "2026-08-09"),
            # Same place three weeks later: a separate memory (gap > 3 days).
            _pt("b1", 37.858, -122.486, "2026-08-30"),
            _pt("b2", 37.858, -122.486, "2026-08-31"),
            _pt("b3", 37.858, -122.486, "2026-09-01"),
            # Morro Bay: two photos only — a place, but too small for a memory.
            _pt("c1", 35.366, -120.850, "2026-08-18"),
            _pt("c2", 35.367, -120.851, "2026-08-18"),
            # Undated photo counts for the place, never for a memory.
            dict(_pt("d1", 37.775, -122.419, "2026-01-01"), capture_time=None),
        ]
        out = build_discover_collections(points, geo)

        names = [(p["name_en"], p["count"]) for p in out["places"]]
        self.assertEqual(names, [("Sausalito", 7), ("Morro Bay", 2), ("San Francisco", 1)])
        sausalito = out["places"][0]
        self.assertEqual(sausalito["cover_asset_id"], "a2")
        self.assertLess(sausalito["bounds"]["west"], -122.486)
        self.assertGreater(sausalito["bounds"]["north"], 37.861)

        memories = [(m["name_en"], m["date_from"], m["date_to"], m["count"]) for m in out["memories"]]
        self.assertEqual(memories, [
            ("Sausalito", "2026-08-30", "2026-09-01", 3),
            ("Sausalito", "2026-08-08", "2026-08-09", 4),
        ])
        self.assertEqual(out["memories"][1]["cover_asset_id"], "a2")

    def test_no_geocoder_means_empty(self):
        self.assertEqual(build_discover_collections([_pt("x", 1, 1, "2026-01-01")], None), {"places": [], "memories": []})


if __name__ == "__main__":
    unittest.main()
