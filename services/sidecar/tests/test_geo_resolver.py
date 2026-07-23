"""Unit tests for the offline geo resolver (Phase 2).

Fixture gazetteer mirrors the real-world failure cases from
research/gazetteer-lab/FINDINGS.md: duplicate place names across countries,
descriptive suffixes, compound strings, v1 "region" fields.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from uuid import uuid4

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from media_workspace import geo_resolver  # noqa: E402
from media_workspace.db import (  # noqa: E402
    connect,
    init_db,
    list_map_points,
    upsert_ai_asset_location,
    upsert_asset_location_from_metadata,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.models import ImageCandidate, MatchDecision  # noqa: E402

FIXTURE = {
    "countries": [
        {"q": "Q39", "iso": "CH", "en": "Switzerland", "zh": "瑞士", "lat": 46.8, "lon": 8.2,
         "links": 300, "aliases": ["Swiss Confederation"]},
        {"q": "Q30", "iso": "US", "en": "United States of America", "zh": "美国", "lat": 39.8,
         "lon": -98.6, "links": 400, "aliases": ["United States", "USA", "US", "America"]},
        {"q": "Q16", "iso": "CA", "en": "Canada", "zh": "加拿大", "lat": 56.0, "lon": -109.0,
         "links": 350, "aliases": []},
    ],
    "admin1": [
        {"q": "Q99", "en": "California", "zh": "加利福尼亚州", "lat": 37.0, "lon": -120.0,
         "country": "Q30", "links": 285},
    ],
    "localities": [
        # The disambiguation trap from the real catalog: two Grindelwalds.
        {"q": "Q68096", "en": "Grindelwald", "lat": 46.624, "lon": 8.036, "country": "Q39", "links": 50},
        {"q": "Q1546963", "en": "Grindelwald", "lat": -41.35, "lon": 147.0, "country": "Q408", "links": 4},
        {"q": "Q62", "en": "San Francisco", "zh": "旧金山", "lat": 37.775, "lon": -122.419,
         "country": "Q30", "links": 235},
        {"q": "Q859413", "en": "Big Sur", "lat": 36.107, "lon": -121.626, "country": "Q30", "links": 34},
        {"q": "Q1026876", "en": "La Jolla", "lat": 32.8328, "lon": -117.2712, "country": "Q30", "links": 30},
        # Ambiguous name with NO dominant candidate: must not resolve without country.
        {"q": "Q100001", "en": "Springfield", "lat": 39.8, "lon": -89.6, "country": "Q30", "links": 12},
        {"q": "Q100002", "en": "Springfield", "lat": 44.05, "lon": -123.02, "country": "Q16", "links": 10},
    ],
    "landmarks": [
        {"q": "Q243", "en": "Eiffel Tower", "zh": "埃菲尔铁塔", "lat": 48.8583, "lon": 2.2945,
         "country": "Q142", "links": 189},
        {"q": "Q9188", "en": "Empire State Building", "lat": 40.7483, "lon": -73.9856,
         "country": "Q30", "links": 123},
    ],
}


def _image_candidate(asset_id: str, lat, lon) -> ImageCandidate:
    return ImageCandidate(
        asset_id=asset_id, path=Path(f"/photos/{asset_id}.jpg"), stem=asset_id,
        normalized_stem=asset_id, stem_key=asset_id, extension=".jpg",
        fingerprint=f"fp-{asset_id}", file_size=1, modified_time="2026-01-01",
        capture_time=None, rating=None, camera_make=None, camera_model=None,
        lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None,
        focal_length=None, flash=None, white_balance=None, color_space=None,
        lens_specification=None, gps_latitude=lat, gps_longitude=lon, width=1, height=1,
    )


class ResolverTestCase(unittest.TestCase):
    def setUp(self):
        geo_resolver.set_gazetteer_for_tests(FIXTURE)

    def tearDown(self):
        geo_resolver.set_gazetteer_for_tests(None)

    def resolve(self, **location):
        return geo_resolver.resolve_location(location)

    def test_landmark_resolves_to_exact_point(self):
        resolved = self.resolve(country="France", landmark="Eiffel Tower", confidence=90)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.precision_level, "exact")
        self.assertEqual(resolved.place_id, "wd:Q243")
        self.assertEqual(resolved.min_latitude, resolved.max_latitude)

    def test_chinese_label_resolves(self):
        resolved = self.resolve(landmark="埃菲尔铁塔", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q243")

    def test_country_disambiguates_duplicate_names(self):
        # The real-catalog trap: naked "Grindelwald" search favours Tasmania.
        swiss = self.resolve(country="Switzerland", locality="Grindelwald", confidence=90)
        self.assertEqual(swiss.place_id, "wd:Q68096")
        self.assertEqual(swiss.country_code, "CH")

    def test_country_alias_normalization(self):
        resolved = self.resolve(country="USA", locality="San Francisco", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q62")
        self.assertEqual(resolved.country_code, "US")

    def test_no_country_dominant_candidate_wins(self):
        # 50 vs 4 sitelinks: the Swiss Grindelwald clearly dominates.
        resolved = self.resolve(locality="Grindelwald", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q68096")

    def test_no_country_ambiguous_name_does_not_resolve(self):
        # 12 vs 10 sitelinks — no dominance, no country: must refuse, not guess.
        resolved = self.resolve(locality="Springfield", confidence=90)
        self.assertIsNone(resolved)

    def test_descriptive_suffix_stripped(self):
        resolved = self.resolve(country="United States", landmark="Big Sur coastline", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q859413")
        self.assertEqual(resolved.precision_level, "locality")

    def test_compound_string_resolves_first_part(self):
        resolved = self.resolve(
            country="United States",
            landmark="Empire State Building / Manhattan skyline", confidence=90,
        )
        self.assertEqual(resolved.place_id, "wd:Q9188")

    def test_comma_context_falls_back_to_containing_locality(self):
        # "Scripps Pier, La Jolla": the pier itself is unknown, but the comma
        # context names the containing locality — resolve there, not admin1.
        resolved = self.resolve(
            country="United States", landmark="Scripps Pier, La Jolla", confidence=90,
        )
        self.assertEqual(resolved.place_id, "wd:Q1026876")
        self.assertEqual(resolved.precision_level, "locality")

    def test_v1_region_field_resolves_as_locality(self):
        resolved = self.resolve(country="United States", region="San Francisco, California", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q62")
        self.assertEqual(resolved.precision_level, "locality")

    def test_admin1_fallback(self):
        resolved = self.resolve(country="United States", region="California", confidence=90)
        self.assertEqual(resolved.place_id, "wd:Q99")
        self.assertEqual(resolved.precision_level, "admin1")

    def test_country_fallback(self):
        resolved = self.resolve(country="Switzerland", confidence=90)
        self.assertEqual(resolved.precision_level, "country")
        self.assertEqual(resolved.place_id, "wd:Q39")

    def test_low_confidence_never_resolves(self):
        self.assertIsNone(self.resolve(country="Switzerland", landmark="Eiffel Tower", confidence=40))

    def test_unknown_everything_returns_none(self):
        self.assertIsNone(self.resolve(country="Atlantis", locality="Nowhere", confidence=95))


class AiLocationWriteTestCase(unittest.TestCase):
    def setUp(self):
        import tempfile

        geo_resolver.set_gazetteer_for_tests(FIXTURE)
        self._tempdir = tempfile.TemporaryDirectory()
        self.connection = connect(Path(self._tempdir.name) / "catalog.sqlite3")
        init_db(self.connection)

    def tearDown(self):
        geo_resolver.set_gazetteer_for_tests(None)
        self.connection.close()
        self._tempdir.cleanup()

    def _import_image(self, lat=None, lon=None) -> str:
        asset_id = f"asset_{uuid4().hex[:8]}"
        upsert_image_asset(self.connection, _image_candidate(asset_id, lat, lon), commit=False)
        upsert_registry(
            self.connection,
            MatchDecision(
                image_asset_id=asset_id, image_path=Path(f"/photos/{asset_id}.jpg"),
                status="unmatched", score=0.0, raw_asset_id=None, feature_vector={},
            ),
            commit=True,
        )
        return asset_id

    def _write_ai(self, asset_id: str, **location) -> bool:
        resolved = geo_resolver.resolve_location(location)
        self.assertIsNotNone(resolved)
        return upsert_ai_asset_location(
            self.connection, asset_id, resolved,
            location=location, resolver_version=geo_resolver.RESOLVER_VERSION, commit=True,
        )

    def test_ai_location_reaches_map_points(self):
        asset_id = self._import_image()
        self.assertTrue(self._write_ai(asset_id, country="Switzerland", locality="Grindelwald", confidence=90))
        points = {row["asset_id"]: row for row in list_map_points(self.connection, status="all")}
        self.assertIn(asset_id, points)
        self.assertEqual(points[asset_id]["source"], "ai")
        self.assertEqual(points[asset_id]["precision_level"], "locality")
        self.assertEqual(points[asset_id]["place_id"], "wd:Q68096")

    def test_ai_never_overwrites_exif(self):
        asset_id = self._import_image(48.8566, 2.3522)  # real GPS: Paris
        self.assertFalse(self._write_ai(asset_id, country="Switzerland", locality="Grindelwald", confidence=90))
        row = self.connection.execute(
            "SELECT source, latitude FROM asset_locations WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        self.assertEqual(row["source"], "exif")
        self.assertAlmostEqual(row["latitude"], 48.8566)

    def test_exif_upsert_upgrades_ai_row(self):
        asset_id = self._import_image()
        self._write_ai(asset_id, country="Switzerland", locality="Grindelwald", confidence=90)
        upsert_asset_location_from_metadata(
            self.connection, asset_id,
            {"gps_latitude": 48.8566, "gps_longitude": 2.3522}, commit=True,
        )
        row = self.connection.execute(
            "SELECT source, latitude FROM asset_locations WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        self.assertEqual(row["source"], "exif")
        self.assertAlmostEqual(row["latitude"], 48.8566)

    def test_ai_bbox_feeds_rtree_intersection(self):
        asset_id = self._import_image()
        self._write_ai(asset_id, country="United States", region="California", confidence=90)
        # admin1 bbox is ±1.5° around the centroid — a viewport overlapping the
        # box edge (not the centroid) must still match.
        from media_workspace.db.browse import _facet_clauses

        clause, params = _facet_clauses({"geo": {
            "mode": "bounds", "west": -119.0, "south": 35.0, "east": -118.0, "north": 36.0,
        }})
        rows = self.connection.execute(
            f"SELECT assets.asset_id FROM assets WHERE 1=1 {clause}", params
        ).fetchall()
        self.assertIn(asset_id, {row["asset_id"] for row in rows})

    def test_map_points_hide_sub_locality_precision_by_default(self):
        # An admin1-level guess drawn as a marker at the state centroid reads
        # as "taken in the middle of California" — hidden unless asked for.
        coarse = self._import_image()
        self._write_ai(coarse, country="United States", region="California", confidence=90)
        fine = self._import_image()
        self._write_ai(fine, country="United States", locality="San Francisco", confidence=90)

        default_ids = {row["asset_id"] for row in list_map_points(self.connection, status="all")}
        self.assertIn(fine, default_ids)
        self.assertNotIn(coarse, default_ids)

        opt_in_ids = {row["asset_id"] for row in list_map_points(
            self.connection, status="all", min_precision="admin1",
        )}
        self.assertIn(coarse, opt_in_ids)

    def test_include_ai_false_excludes_ai_rows(self):
        asset_id = self._import_image()
        self._write_ai(asset_id, country="United States", locality="San Francisco", confidence=90)
        from media_workspace.db.browse import _facet_clauses

        bounds = {"mode": "bounds", "west": -123.0, "south": 37.0, "east": -122.0, "north": 38.0}
        clause, params = _facet_clauses({"geo": {**bounds, "include_ai": False}})
        rows = self.connection.execute(
            f"SELECT assets.asset_id FROM assets WHERE 1=1 {clause}", params
        ).fetchall()
        self.assertNotIn(asset_id, {row["asset_id"] for row in rows})


if __name__ == "__main__":
    unittest.main()
