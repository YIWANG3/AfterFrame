"""Nested folders (collections.parent_collection_id): a folder inside a
folder, any depth. The tree operations, and the one line every folder-scoped
query draws when asked for the subtree (db/collection_scope.py)."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import (
    connect,
    count_assets_for_annotation,
    init_db,
    list_assets_for_annotation,
    list_map_points,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.db.browse import browse_collection, get_facet_values, list_image_assets, locate_image_asset
from media_workspace.db.collection_scope import subtree_ids
from media_workspace.db.collections import (
    add_collection_items,
    create_collection,
    delete_collection,
    list_collections,
    move_collection,
    reorder_collections,
)
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

STEMS = ("a", "b", "c", "d", "e")


class NestedCollectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for index, stem in enumerate(STEMS):
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"jpg")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time="2026-01-01T00:00:00",
                capture_time=f"2026-01-0{index + 1}T00:00:00", rating=None, camera_make=None, camera_model="CFV",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=35.0 + index, gps_longitude=139.0, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()
        # Trips / Japan / Kyoto, with Trips also holding a sibling-less Europe.
        c = self.connection
        self.trips = create_collection(c, "Trips")["collection_id"]
        self.japan = create_collection(c, "Japan", parent_id=self.trips)["collection_id"]
        self.kyoto = create_collection(c, "Kyoto", parent_id=self.japan)["collection_id"]
        self.europe = create_collection(c, "Europe", parent_id=self.trips)["collection_id"]
        self.other = create_collection(c, "Other")["collection_id"]
        # "a" sits in Trips itself and again in Kyoto: the subtree view must
        # show it once.
        add_collection_items(c, self.trips, ["image_a"])
        add_collection_items(c, self.japan, ["image_b"])
        add_collection_items(c, self.kyoto, ["image_a", "image_c"])
        add_collection_items(c, self.europe, ["image_d"])
        add_collection_items(c, self.other, ["image_e"])

    def by_id(self):
        return {row["collection_id"]: row for row in list_collections(self.connection)}

    def stems(self, rows):
        return sorted(row["stem"] for row in rows)

    # ── the tree ──────────────────────────────────────────────────────────

    def test_rows_carry_their_place_and_their_subtree_count(self):
        rows = self.by_id()
        self.assertEqual(rows[self.kyoto]["path"], "Trips / Japan / Kyoto")
        self.assertEqual(rows[self.kyoto]["depth"], 2)
        self.assertEqual(rows[self.kyoto]["parent_collection_id"], self.japan)
        self.assertEqual(rows[self.trips]["depth"], 0)
        self.assertEqual(rows[self.trips]["path"], "Trips")
        # Direct members stay the count; the subtree is every photo under it, once.
        self.assertEqual(rows[self.trips]["item_count"], 1)
        self.assertEqual(rows[self.trips]["subtree_count"], 4)
        self.assertEqual(rows[self.japan]["subtree_count"], 3)
        self.assertEqual(rows[self.kyoto]["subtree_count"], 2)
        self.assertEqual(rows[self.other]["subtree_count"], 1)

    def test_a_new_folder_goes_on_top_of_its_own_level(self):
        newer = create_collection(self.connection, "Osaka", parent_id=self.japan)["collection_id"]
        rows = self.by_id()
        self.assertLess(rows[newer]["sort_order"], rows[self.kyoto]["sort_order"])
        self.assertEqual(rows[newer]["parent_collection_id"], self.japan)
        with self.assertRaises(ValueError):
            create_collection(self.connection, "Nowhere", parent_id="col_missing")
        smart = create_collection(self.connection, "Stars", "smart", '{"filters": {"rating_min": 5}}')["collection_id"]
        with self.assertRaises(ValueError):
            create_collection(self.connection, "Under smart", parent_id=smart)
        with self.assertRaises(ValueError):
            create_collection(self.connection, "Smart child", "smart", '{"filters": {"rating_min": 5}}', parent_id=self.trips)

    def test_move_changes_the_parent_and_refuses_cycles(self):
        self.assertTrue(move_collection(self.connection, self.kyoto, self.europe)["moved"])
        self.assertEqual(self.by_id()[self.kyoto]["path"], "Trips / Europe / Kyoto")
        self.assertTrue(move_collection(self.connection, self.kyoto, None)["moved"])
        self.assertEqual(self.by_id()[self.kyoto]["path"], "Kyoto")
        self.assertFalse(move_collection(self.connection, self.kyoto, None)["moved"])
        for bad_parent in (self.trips, self.japan, self.europe):
            with self.assertRaises(ValueError):
                move_collection(self.connection, self.trips, bad_parent)
        smart = create_collection(self.connection, "Stars", "smart", '{"filters": {"rating_min": 5}}')["collection_id"]
        with self.assertRaises(ValueError):
            move_collection(self.connection, smart, self.trips)
        with self.assertRaises(ValueError):
            move_collection(self.connection, self.other, smart)
        self.assertEqual(subtree_ids(self.connection, self.trips), [self.trips, self.japan, self.europe])

    def test_reorder_is_one_level_at_a_time(self):
        reorder_collections(self.connection, [self.europe, self.japan], parent_id=self.trips)
        children = [row["collection_id"] for row in list_collections(self.connection) if row["parent_collection_id"] == self.trips]
        self.assertEqual(children, [self.europe, self.japan])
        with self.assertRaises(ValueError):
            reorder_collections(self.connection, [self.europe, self.japan])  # the top level is Trips and Other
        with self.assertRaises(ValueError):
            reorder_collections(self.connection, [self.europe], parent_id=self.trips)
        reorder_collections(self.connection, [self.other, self.trips])
        top = [row["collection_id"] for row in list_collections(self.connection) if row["parent_collection_id"] is None]
        self.assertEqual(top, [self.other, self.trips])

    def test_deleting_a_folder_takes_the_folders_under_it(self):
        deleted = delete_collection(self.connection, self.japan)
        self.assertEqual(deleted, [self.japan, self.kyoto])
        rows = self.by_id()
        self.assertNotIn(self.japan, rows)
        self.assertNotIn(self.kyoto, rows)
        self.assertIn(self.europe, rows)
        self.assertEqual(rows[self.trips]["subtree_count"], 2)  # a, d
        # The photos themselves stay.
        self.assertEqual(self.stems(list_image_assets(self.connection, "all")), list(STEMS))
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM collection_items").fetchone()[0], 3)

    # ── the subtree as a view ─────────────────────────────────────────────

    def test_browsing_with_descendants_shows_every_photo_under_the_folder_once(self):
        self.assertEqual(self.stems(browse_collection(self.connection, self.trips)), ["a"])
        rows = browse_collection(self.connection, self.trips, include_descendants=True)
        self.assertEqual(self.stems(rows), ["a", "b", "c", "d"])
        self.assertEqual(len(rows), 4)
        self.assertEqual(self.stems(browse_collection(self.connection, self.japan, include_descendants=True)), ["a", "b", "c"])
        # The leaf's view is the same either way.
        self.assertEqual(self.stems(browse_collection(self.connection, self.kyoto, include_descendants=True)), ["a", "c"])
        # The folder order sorts by the latest time a photo joined any of them.
        self.connection.execute("UPDATE collection_items SET added_at = '2030-01-01 00:00:00' WHERE collection_id = ? AND asset_id = 'image_a'", (self.kyoto,))
        self.connection.execute("UPDATE collection_items SET added_at = '2020-01-01 00:00:00' WHERE collection_id = ? AND asset_id = 'image_a'", (self.trips,))
        ordered = [row["stem"] for row in browse_collection(self.connection, self.trips, include_descendants=True)]
        self.assertEqual(ordered[0], "a")
        # Search and facets still narrow inside the subtree.
        self.assertEqual(self.stems(browse_collection(self.connection, self.trips, search="b.jpg", include_descendants=True)), ["b"])

    def test_every_folder_scoped_query_draws_the_same_line(self):
        c = self.connection
        self.assertEqual(locate_image_asset(c, "image_c", collection_id=self.trips), None)
        self.assertIsNotNone(locate_image_asset(c, "image_c", collection_id=self.trips, include_descendants=True))
        self.assertEqual(get_facet_values(c, self.trips)["cameras"][0]["count"], 1)
        self.assertEqual(get_facet_values(c, self.trips, include_descendants=True)["cameras"][0]["count"], 4)
        self.assertEqual(len(list_map_points(c, collection_id=self.trips, min_precision="exact")), 1)
        self.assertEqual(len(list_map_points(c, collection_id=self.trips, min_precision="exact", include_descendants=True)), 4)
        self.assertEqual(count_assets_for_annotation(c, collection_id=self.trips), 1)
        self.assertEqual(count_assets_for_annotation(c, collection_id=self.trips, include_descendants=True), 4)
        annotate = list_assets_for_annotation(c, collection_id=self.japan, include_descendants=True)
        self.assertEqual(sorted(row["asset_id"] for row in annotate), ["image_a", "image_b", "image_c"])

    def test_the_in_collection_facet_can_take_the_subtree(self):
        rules = normalize_rules({"filters": {"in_collection": self.trips, "in_collection_descendants": True}})
        self.assertEqual(rules["filters"]["in_collection_descendants"], True)
        self.assertEqual(self.stems(list_image_assets(self.connection, "all", filters=rules["filters"])), ["a", "b", "c", "d"])
        self.assertEqual(self.stems(list_image_assets(self.connection, "all", filters={"in_collection": self.trips})), ["a"])
        excluded = {"in_collection": self.trips, "in_collection_descendants": True, "exclude": ["in_collection"]}
        self.assertEqual(self.stems(list_image_assets(self.connection, "all", filters=excluded)), ["e"])
        # The modifier alone is no condition.
        self.assertEqual(self.stems(list_image_assets(self.connection, "all", filters={"in_collection_descendants": True})), list(STEMS))


if __name__ == "__main__":
    unittest.main()
