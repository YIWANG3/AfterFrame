"""Two layers: WHERE the user is defines the base set (a smart collection's
rules); the filter bar and search only refine inside it."""
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, list_map_points, upsert_image_asset, upsert_registry
from media_workspace.db.browse import (
    browse_collection,
    count_image_assets,
    get_facet_values,
    locate_image_asset,
)
from media_workspace.db.collections import add_collection_items, create_collection, list_collections
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (  # stem, camera, rating, tags
    ("a", "CFV", 5, ("urban", "night")),
    ("b", "CFV", 5, ("urban",)),
    ("c", "CFV", 2, ("urban", "night")),
    ("d", "Canon", 5, ("night",)),
    ("e", "Canon", 1, ()),
)


class TwoLayerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for index, (stem, camera, rating, tags) in enumerate(PHOTOS):
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"jpg")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time="2026-01-01T00:00:00",
                capture_time=f"2026-01-0{index + 1}T00:00:00", rating=None, camera_make=None, camera_model=camera,
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
            self.connection.execute("UPDATE assets SET app_rating = ? WHERE asset_id = ?", (rating, candidate.asset_id))
            for tag in tags:
                self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'user')", (candidate.asset_id, tag))
        self.connection.commit()

    def stems(self, **view):
        return sorted(row["stem"] for row in list_image_assets(self.connection, view.pop("status", "all"), **view))

    def test_a_refinement_only_narrows_inside_the_base(self):
        urban = {"status": "all", "search": "", "filters": {"tag": "urban"}}
        self.assertEqual(self.stems(base=urban), ["a", "b", "c"])
        self.assertEqual(self.stems(base=urban, filters={"rating_min": 5}), ["a", "b"])
        # A refinement can never reach outside the base: d is five stars, not urban.
        self.assertNotIn("d", self.stems(base=urban, filters={"rating_min": 5}))
        self.assertEqual(self.stems(base=urban, search="canon"), [])

    def test_the_same_key_in_both_layers_means_both_must_hold(self):
        # Merging {tag: urban} with {tag: night} would keep one. Layers keep both.
        urban = {"filters": {"tag": "urban"}}
        self.assertEqual(self.stems(base=urban, filters={"tag": "night"}), ["a", "c"])

    def test_the_base_carries_its_own_status(self):
        rated = {"status": "rated", "filters": {"camera": "Canon"}}
        self.assertEqual(self.stems(status="all", base=rated), ["d", "e"])
        self.connection.execute("UPDATE assets SET app_rating = 0 WHERE stem = 'e'")
        self.assertEqual(self.stems(status="all", base=rated), ["d"])

    def test_bases_nest_and_are_validated_to_a_depth(self):
        nested = {"filters": {"rating_min": 5}, "base": {"filters": {"tag": "night"}, "base": {"filters": {"camera": "CFV"}}}}
        self.assertEqual(self.stems(base=nested), ["a"])
        normalized = normalize_rules(nested)
        self.assertEqual(normalized["base"]["base"]["filters"], {"camera": "CFV"})
        # A layer with no condition of its own is fine when it sits on a base.
        self.assertEqual(normalize_rules({"base": {"filters": {"tag": "urban"}}})["base"]["filters"], {"tag": "urban"})
        deep = {"filters": {"tag": "x"}}
        for _ in range(5):
            deep = {"filters": {"tag": "x"}, "base": deep}
        with self.assertRaisesRegex(ValueError, "nested too deeply"):
            normalize_rules(deep)
        with self.assertRaisesRegex(ValueError, "Unknown smart collection filter"):
            normalize_rules({"filters": {"tag": "x"}, "base": {"filters": {"nope": 1}}})

    def test_count_locate_map_and_facets_all_see_the_same_two_layers(self):
        urban = {"filters": {"tag": "urban"}}
        refine = {"rating_min": 5}
        shown = self.stems(base=urban, filters=refine, sort="name-asc")
        self.assertEqual(count_image_assets(self.connection, "all", filters=refine, base=urban), len(shown))
        self.assertEqual(locate_image_asset(self.connection, "image_b", filters=refine, base=urban, sort="name-asc"), 1)
        self.assertIsNone(locate_image_asset(self.connection, "image_d", filters=refine, base=urban, sort="name-asc"))
        self.assertEqual(list_map_points(self.connection, filters=refine, base=urban), [])  # none of them has a location
        facets = get_facet_values(self.connection, filters=refine, base=urban)
        # Counted inside the base: Canon has five-star photos, but none is urban.
        self.assertEqual({r["value"]: r["count"] for r in facets["cameras"]}, {"CFV": 2})
        # A facet ignores its OWN refinement, never the base's condition on the same key.
        tags = {r["value"]: r["count"] for r in get_facet_values(self.connection, filters={"tag": "night"}, base=urban)["tags"]}
        self.assertEqual(tags, {"urban": 3, "night": 2})

    def test_a_smart_collection_with_a_nested_base_counts_live(self):
        rules = {"filters": {"rating_min": 5}, "base": {"filters": {"tag": "urban"}}}
        create_collection(self.connection, "Best urban", "smart", json.dumps(rules))
        row = next(c for c in list_collections(self.connection) if c["name"] == "Best urban")
        self.assertEqual(row["item_count"], 2)
        self.assertEqual(row["rules"]["base"]["filters"], {"tag": "urban"})

    def test_folder_membership_is_a_condition_so_a_folder_view_can_be_saved(self):
        folder = create_collection(self.connection, "Trip")["collection_id"]
        add_collection_items(self.connection, folder, ["image_a", "image_d", "image_e"])
        rules = normalize_rules({"filters": {"in_collection": folder, "rating_min": 5}})
        self.assertEqual(self.stems(base=rules), ["a", "d"])
        # It follows the folder: a photo added later joins the smart collection.
        add_collection_items(self.connection, folder, ["image_b"])
        self.assertEqual(self.stems(base=rules), ["a", "b", "d"])

    def test_a_folder_honours_the_toolbar_sort_and_keeps_added_order_as_an_option(self):
        folder = create_collection(self.connection, "Trip")["collection_id"]
        for index, asset_id in enumerate(["image_c", "image_a", "image_d"]):
            add_collection_items(self.connection, folder, [asset_id])
            self.connection.execute(
                "UPDATE collection_items SET added_at = ? WHERE asset_id = ?", (f"2026-02-0{index + 1} 00:00:00", asset_id))
        order = lambda **kw: [r["stem"] for r in browse_collection(self.connection, folder, **kw)]  # noqa: E731
        self.assertEqual(order(), ["d", "a", "c"])  # default: most recently added first
        self.assertEqual(order(sort="added-asc"), ["c", "a", "d"])
        self.assertEqual(order(sort="name-asc"), ["a", "c", "d"])
        self.assertEqual(order(sort="captured-desc"), ["d", "c", "a"])
        self.assertEqual(order(sort="rating-desc"), ["a", "d", "c"])
        # locate agrees with browse for every order, or reveal lands on the wrong page.
        for sort in (None, "added-asc", "name-asc", "captured-desc"):
            for index, stem in enumerate(order(sort=sort)):
                self.assertEqual(locate_image_asset(self.connection, f"image_{stem}", collection_id=folder, sort=sort), index, sort)


if __name__ == "__main__":
    unittest.main()
