"""Gallery rank must match pagination under every supported sort/scope."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import browse_collection, connect, init_db, list_image_assets, locate_image_asset


class GalleryPositionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = connect(Path(self.temp.name) / "catalog.sqlite3")
        init_db(self.db)
        # Duplicate names, dates and ratings exercise the deterministic tie-breaker.
        for i in range(405):
            asset_id = f"asset-{i:04}"
            self.db.execute("""INSERT INTO assets
                (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
                 extension, fingerprint, file_size, modified_time, app_rating, metadata_json)
                VALUES (?, 'image', ?, ?, 'test', 'test', '.jpg', ?, 1, '2026', ?, ?)""",
                (asset_id, f"/images/{asset_id}.jpg", f"name-{i // 3:03}", asset_id, i % 5,
                 '{"capture_time":"2026-01-01","camera_model":"Camera"}'))
            self.db.execute("""INSERT INTO image_lookup_registry
                (image_path, image_asset_id, match_status, resolver_version)
                VALUES (?, ?, 'unmatched', 'test')""", (f"/images/{asset_id}.jpg", asset_id))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_position_matches_browse_for_all_sorts(self):
        for sort in [None, "name-asc", "name-desc", "imported-desc", "imported-asc",
                     "captured-desc", "captured-asc", "rating-desc"]:
            with self.subTest(sort=sort):
                rows = list_image_assets(self.db, "all", limit=500, sort=sort)
                for index in [0, 179, 180, 399, 404]:
                    asset_id = rows[index]["asset_id"]
                    self.assertEqual(locate_image_asset(self.db, asset_id, sort=sort), index)
                    page = list_image_assets(self.db, "all", limit=1, offset=index, sort=sort)
                    self.assertEqual(page[0]["asset_id"], asset_id)

    def test_search_status_facets_and_missing(self):
        for scope in [{"search": "name-"}, {"status": "rated"},
                      {"filters": {"rating_min": 3, "camera": "Camera"}}]:
            scope = {"status": "all", **scope}
            rows = list_image_assets(self.db, limit=500, **scope)
            self.assertEqual(locate_image_asset(self.db, rows[-1]["asset_id"], **scope), len(rows) - 1)
        self.assertIsNone(locate_image_asset(self.db, "asset-0000", search="not-present"))
        self.assertIsNone(locate_image_asset(self.db, "asset-0000", status="matched"))
        self.assertIsNone(locate_image_asset(self.db, "asset-0000", filters={"rating_min": 5}))
        self.assertIsNone(locate_image_asset(self.db, "deleted-asset"))

    def test_collection_order_matches_browse(self):
        # Use the real schema so the locate query cannot silently drift from
        # collection ordering or the gallery's supported asset types.
        self.db.execute("INSERT INTO collections (collection_id, name, kind) VALUES ('album', 'Album', 'manual')")
        self.db.executemany("INSERT INTO collection_items (collection_id, asset_id) VALUES ('album', ?)",
                            [(f"asset-{i:04}",) for i in [402, 3, 4]])
        rows = browse_collection(self.db, "album")
        for index, row in enumerate(rows):
            self.assertEqual(locate_image_asset(self.db, row["asset_id"], collection_id="album"), index)
        self.assertIsNone(locate_image_asset(self.db, "asset-0000", collection_id="album"))
