"""Unit tests for the map location layer (schema v8).

Run with:  python -m unittest discover -s tests  (from services/sidecar,
with src on PYTHONPATH — tests/__init__ is not required, unittest discovery
handles the path via this file's sys.path bootstrap).
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from uuid import uuid4

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from media_workspace.db import (  # noqa: E402
    connect,
    delete_asset_location,
    delete_image_asset_from_catalog,
    init_db,
    list_map_points,
    upsert_asset_location_from_metadata,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.db.browse import _facet_clauses  # noqa: E402
from media_workspace.db.migrations import migrate  # noqa: E402
from media_workspace.models import ImageCandidate, MatchDecision  # noqa: E402
from media_workspace.schema import SCHEMA_VERSION  # noqa: E402


def _image_candidate(asset_id: str, path: str, lat: float | None, lon: float | None) -> ImageCandidate:
    return ImageCandidate(
        asset_id=asset_id,
        path=Path(path),
        stem=Path(path).stem,
        normalized_stem=Path(path).stem.lower(),
        stem_key=Path(path).stem.lower(),
        extension=".jpg",
        fingerprint=f"fp-{asset_id}",
        file_size=1234,
        modified_time="2026-07-21T00:00:00",
        capture_time="2026-07-20T12:00:00",
        rating=None,
        camera_make=None,
        camera_model="X100VI",
        lens_model=None,
        software=None,
        iso=200,
        aperture=2.0,
        shutter_speed=0.004,
        focal_length=23.0,
        flash=None,
        white_balance=None,
        color_space=None,
        lens_specification=None,
        gps_latitude=lat,
        gps_longitude=lon,
        width=6240,
        height=4160,
    )


class LocationTestCase(unittest.TestCase):
    def setUp(self):
        import tempfile

        self._tempdir = tempfile.TemporaryDirectory()
        root = Path(self._tempdir.name)
        self.connection = connect(root / "catalog.sqlite3")
        init_db(self.connection)

    def tearDown(self):
        self.connection.close()
        self._tempdir.cleanup()

    # -- helpers ---------------------------------------------------------

    def _import_image(self, lat: float | None, lon: float | None, *, rating: int | None = None) -> str:
        asset_id = f"asset_{uuid4().hex[:8]}"
        path = f"/photos/{asset_id}.jpg"
        candidate = _image_candidate(asset_id, path, lat, lon)
        upsert_image_asset(self.connection, candidate, commit=False)
        upsert_registry(
            self.connection,
            MatchDecision(
                image_asset_id=asset_id,
                image_path=Path(path),
                status="unmatched",
                score=0.0,
                raw_asset_id=None,
                feature_vector={},
            ),
            commit=False,
        )
        if rating is not None:
            self.connection.execute(
                "UPDATE assets SET app_rating = ? WHERE asset_id = ?", (rating, asset_id)
            )
        self.connection.commit()
        return asset_id

    def _locations(self) -> list[dict]:
        rows = self.connection.execute(
            "SELECT asset_id, latitude, longitude, source FROM asset_locations ORDER BY asset_id"
        ).fetchall()
        return [dict(row) for row in rows]

    def _rtree_count(self) -> int:
        return self.connection.execute(
            "SELECT COUNT(*) AS n FROM asset_location_rtree"
        ).fetchone()["n"]

    def _map_asset_ids(self, **kwargs) -> set[str]:
        return {row["asset_id"] for row in list_map_points(self.connection, **kwargs)}

    def _browse_geo_ids(self, geo: dict) -> set[str]:
        clause, params = _facet_clauses({"geo": geo})
        rows = self.connection.execute(
            f"SELECT assets.asset_id FROM assets WHERE 1=1 {clause}", params
        ).fetchall()
        return {row["asset_id"] for row in rows}

    # -- import / upsert -------------------------------------------------

    def test_import_with_gps_creates_location_and_rtree_row(self):
        asset_id = self._import_image(48.8566, 2.3522)
        locations = self._locations()
        self.assertEqual(len(locations), 1)
        self.assertEqual(locations[0]["asset_id"], asset_id)
        self.assertEqual(locations[0]["source"], "exif")
        self.assertAlmostEqual(locations[0]["latitude"], 48.8566)
        self.assertEqual(self._rtree_count(), 1)

    def test_import_without_gps_creates_no_location(self):
        self._import_image(None, None)
        self.assertEqual(self._locations(), [])
        self.assertEqual(self._rtree_count(), 0)

    def test_invalid_gps_is_rejected(self):
        for lat, lon in ((0.0, 0.0), (95.0, 10.0), (10.0, 200.0), ("x", "y")):
            upsert_asset_location_from_metadata(
                self.connection, "asset_bogus", {"gps_latitude": lat, "gps_longitude": lon}
            )
        self.assertEqual(self._locations(), [])
        self.assertEqual(self._rtree_count(), 0)

    def test_metadata_reread_updates_location(self):
        asset_id = self._import_image(48.8566, 2.3522)
        upsert_asset_location_from_metadata(
            self.connection, asset_id, {"gps_latitude": 35.6895, "gps_longitude": 139.6917}, commit=True
        )
        locations = self._locations()
        self.assertEqual(len(locations), 1)
        self.assertAlmostEqual(locations[0]["latitude"], 35.6895)
        self.assertEqual(self._rtree_count(), 1)
        # R*Tree row must follow the move
        row = self.connection.execute(
            "SELECT min_latitude FROM asset_location_rtree"
        ).fetchone()
        self.assertAlmostEqual(row["min_latitude"], 35.6895, places=4)

    def test_gps_removed_on_reread_drops_exif_row(self):
        asset_id = self._import_image(48.8566, 2.3522)
        upsert_asset_location_from_metadata(self.connection, asset_id, {}, commit=True)
        self.assertEqual(self._locations(), [])
        self.assertEqual(self._rtree_count(), 0)

    def test_exif_does_not_overwrite_manual(self):
        asset_id = self._import_image(48.8566, 2.3522)
        self.connection.execute(
            "UPDATE asset_locations SET source = 'manual' WHERE asset_id = ?", (asset_id,)
        )
        upsert_asset_location_from_metadata(
            self.connection, asset_id, {"gps_latitude": 1.0, "gps_longitude": 1.0}, commit=True
        )
        locations = self._locations()
        self.assertEqual(locations[0]["source"], "manual")
        self.assertAlmostEqual(locations[0]["latitude"], 48.8566)

    # -- delete ----------------------------------------------------------

    def test_delete_asset_clears_location_and_rtree(self):
        asset_id = self._import_image(48.8566, 2.3522)
        delete_image_asset_from_catalog(
            self.connection, Path(self._tempdir.name), asset_id, commit=True
        )
        self.assertEqual(self._locations(), [])
        self.assertEqual(self._rtree_count(), 0)

    def test_delete_asset_location_is_idempotent(self):
        asset_id = self._import_image(48.8566, 2.3522)
        delete_asset_location(self.connection, asset_id)
        delete_asset_location(self.connection, asset_id)
        self.assertEqual(self._locations(), [])
        self.assertEqual(self._rtree_count(), 0)

    # -- geo facet queries ----------------------------------------------

    def test_bounds_filter_matches_points_inside(self):
        paris = self._import_image(48.8566, 2.3522)
        tokyo = self._import_image(35.6895, 139.6917)
        europe = {"mode": "bounds", "west": -5.0, "south": 41.0, "east": 10.0, "north": 52.0}
        ids = self._browse_geo_ids(europe)
        self.assertIn(paris, ids)
        self.assertNotIn(tokyo, ids)

    def test_bounds_filter_across_antimeridian(self):
        fiji = self._import_image(-17.7134, 178.0650)      # east of the line
        samoa = self._import_image(-13.7590, -172.1046)    # west of the line
        paris = self._import_image(48.8566, 2.3522)
        pacific = {"mode": "bounds", "west": 170.0, "south": -30.0, "east": -160.0, "north": 0.0}
        ids = self._browse_geo_ids(pacific)
        self.assertIn(fiji, ids)
        self.assertIn(samoa, ids)
        self.assertNotIn(paris, ids)

    def test_source_and_precision_filters(self):
        paris = self._import_image(48.8566, 2.3522)
        bounds = {"mode": "bounds", "west": -5.0, "south": 41.0, "east": 10.0, "north": 52.0}
        self.assertEqual(self._browse_geo_ids({**bounds, "include_exif": False}), set())
        self.assertEqual(self._browse_geo_ids({**bounds, "min_precision": "exact"}), {paris})
        # ai row at locality precision is excluded by min_precision=exact
        self.connection.execute(
            "UPDATE asset_locations SET source = 'ai', precision_level = 'locality' WHERE asset_id = ?",
            (paris,),
        )
        self.assertEqual(self._browse_geo_ids({**bounds, "min_precision": "exact"}), set())
        self.assertEqual(self._browse_geo_ids({**bounds, "min_precision": "locality"}), {paris})
        self.assertEqual(self._browse_geo_ids({**bounds, "include_ai": False}), set())

    def test_place_filter(self):
        paris = self._import_image(48.8566, 2.3522)
        self.connection.execute(
            "UPDATE asset_locations SET place_id = 'fr-idf-paris' WHERE asset_id = ?", (paris,)
        )
        ids = self._browse_geo_ids({"mode": "place", "place_id": "fr-idf-paris"})
        self.assertEqual(ids, {paris})
        self.assertEqual(self._browse_geo_ids({"mode": "place", "place_id": "nope"}), set())

    # -- map points ------------------------------------------------------

    def test_map_points_ignore_geo_filter(self):
        paris = self._import_image(48.8566, 2.3522)
        tokyo = self._import_image(35.6895, 139.6917)
        europe = {"mode": "bounds", "west": -5.0, "south": 41.0, "east": 10.0, "north": 52.0}
        ids = self._map_asset_ids(status="all", filters={"geo": europe})
        self.assertEqual(ids, {paris, tokyo})

    def test_map_points_respect_status_and_facets(self):
        rated = self._import_image(48.8566, 2.3522, rating=5)
        unrated = self._import_image(35.6895, 139.6917)
        self.assertEqual(self._map_asset_ids(status="rated"), {rated})
        self.assertEqual(
            self._map_asset_ids(status="all", filters={"camera": "X100VI"}),
            {rated, unrated},
        )
        self.assertEqual(
            self._map_asset_ids(status="all", filters={"camera": "OtherCam"}), set()
        )

    def test_map_points_payload_shape(self):
        self._import_image(48.8566, 2.3522)
        rows = list_map_points(self.connection, status="all")
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertAlmostEqual(row["latitude"], 48.8566)
        self.assertAlmostEqual(row["longitude"], 2.3522)
        self.assertEqual(row["source"], "exif")
        self.assertEqual(row["precision_level"], "exact")
        self.assertIsNone(row["preview_relative_path"])

    # -- migration -------------------------------------------------------

    def test_migration_7_to_8_backfills_and_is_idempotent(self):
        # Simulate a v7 catalog: drop the v8 tables, reset the version marker.
        asset_id = self._import_image(48.8566, 2.3522)
        no_gps = self._import_image(None, None)
        self.connection.execute("DROP TABLE asset_location_rtree")
        self.connection.execute("DROP TABLE asset_locations")
        self.connection.execute(
            "UPDATE catalog_info SET schema_version = 7 WHERE catalog_id = 1"
        )

        migrate(self.connection, 7, SCHEMA_VERSION)
        self.connection.commit()
        locations = self._locations()
        self.assertEqual([loc["asset_id"] for loc in locations], [asset_id])
        self.assertEqual(locations[0]["source"], "exif")
        self.assertEqual(self._rtree_count(), 1)
        self.assertNotIn(no_gps, {loc["asset_id"] for loc in locations})

        # Re-running the v8 step must not duplicate anything.
        from media_workspace.db.migrations import _migrate_to_8

        _migrate_to_8(self.connection)
        self.assertEqual(len(self._locations()), 1)
        self.assertEqual(self._rtree_count(), 1)

        version = self.connection.execute(
            "SELECT schema_version FROM catalog_info WHERE catalog_id = 1"
        ).fetchone()["schema_version"]
        self.assertEqual(version, SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
