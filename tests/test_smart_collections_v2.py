"""Smart collections v2: excluding a facet, rating ceilings and "unrated", and
groups of conditions of which any one may hold (db/facets.py)."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import count_image_assets, get_facet_values
from media_workspace.db.collections import add_collection_items, create_collection
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (  # stem, camera, rating, extension, tags
    ("a", "FC9113", 5, ".jpg", ("night", "neon")),
    ("b", "FC9184", 5, ".jpg", ("night",)),
    ("c", "FC9184", 2, ".png", ("neon",)),
    ("d", "Canon R6", 3, ".jpg", ("night", "neon")),
    ("e", "Canon R6", 0, ".png", ()),
    ("f", None, None, ".jpg", ()),  # no camera recorded, never rated
)
ALL = ["a", "b", "c", "d", "e", "f"]


class SmartCollectionsV2Tests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, camera, rating, extension, tags in PHOTOS:
            path = Path(self.directory.name) / f"{stem}{extension}"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=extension, fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=camera,
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
        self.folder = create_collection(self.connection, "Published")["collection_id"]
        add_collection_items(self.connection, self.folder, ["image_a", "image_c"])

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    # ── exclude ──────────────────────────────────────────────────────────
    def test_excluding_a_facet_flips_it_and_a_missing_value_is_not_a_match(self):
        self.assertEqual(self.stems({"camera": "FC9184"}), ["b", "c"])
        # "f" has no camera at all: it is not an FC9184 either.
        self.assertEqual(self.stems({"camera": "FC9184", "exclude": "camera"}), ["a", "d", "e", "f"])
        self.assertEqual(self.stems({"camera": ["FC9184", "Canon R6"], "exclude": ["camera"]}), ["a", "f"])

    def test_excluded_tags_are_none_of_them(self):
        self.assertEqual(self.stems({"tag": ["night", "neon"], "exclude": "tag"}), ["e", "f"])

    def test_not_in_a_folder(self):
        self.assertEqual(self.stems({"in_collection": self.folder, "exclude": "in_collection"}), ["b", "d", "e", "f"])

    def test_exclude_only_touches_the_facets_it_names(self):
        # Five-star photos not in the published folder.
        self.assertEqual(self.stems({"rating_min": 5, "in_collection": self.folder, "exclude": "in_collection"}), ["b"])
        # Naming a facet with no condition changes nothing.
        self.assertEqual(self.stems({"exclude": "camera"}), ALL)

    def test_counts_beside_an_excluded_facet_are_still_per_option(self):
        cameras = {r["value"]: r["count"] for r in get_facet_values(
            self.connection, filters={"camera": "FC9184", "exclude": "camera", "rating_min": 5})["cameras"]}
        self.assertEqual(cameras, {"FC9113": 1, "FC9184": 1})

    # ── rating ───────────────────────────────────────────────────────────
    def test_unrated_is_a_ceiling_of_zero_and_null_counts_as_zero(self):
        self.assertEqual(self.stems({"rating_max": 0}), ["e", "f"])

    def test_exactly_and_at_most(self):
        self.assertEqual(self.stems({"rating_min": 5, "rating_max": 5}), ["a", "b"])
        self.assertEqual(self.stems({"rating_max": 3}), ["c", "d", "e", "f"])
        self.assertEqual(self.stems({"rating_min": 2, "rating_max": 3}), ["c", "d"])

    # ── any_of ───────────────────────────────────────────────────────────
    def test_any_one_group_may_hold(self):
        # (an FC9184 with five stars) or a PNG
        groups = [{"camera": "FC9184", "rating_min": 5}, {"extension": "png"}]
        self.assertEqual(self.stems({"any_of": groups}), ["b", "c", "e"])
        self.assertEqual(count_image_assets(self.connection, "all", filters={"any_of": groups}), 3)

    def test_groups_sit_on_top_of_the_other_conditions(self):
        groups = [{"camera": "FC9184", "rating_min": 5}, {"extension": "png"}]
        self.assertEqual(self.stems({"tag": "neon", "any_of": groups}), ["c"])

    def test_a_group_can_exclude(self):
        groups = [{"tag": "night", "exclude": "tag"}, {"rating_min": 5}]
        self.assertEqual(self.stems({"any_of": groups}), ["a", "b", "c", "e", "f"])

    def test_empty_groups_are_ignored_not_match_everything(self):
        self.assertEqual(self.stems({"any_of": [{}]}), ALL)
        self.assertEqual(self.stems({"any_of": [{}, {"camera": "FC9113"}]}), ["a"])
        self.assertEqual(self.stems({"any_of": [{"tag_match": "all"}, {"camera": "FC9113"}]}), ["a"])

    # ── saving ───────────────────────────────────────────────────────────
    def test_rules_check_what_is_excluded(self):
        rules = normalize_rules({"filters": {"camera": ["FC9184"], "exclude": ["camera", "tag"]}})
        # The tag has no condition to flip, so it is dropped; one name stays a scalar.
        self.assertEqual(rules["filters"], {"camera": "FC9184", "exclude": "camera"})
        with self.assertRaisesRegex(ValueError, "Unknown filter"):
            normalize_rules({"filters": {"camera": "X", "exclude": "cameras"}})
        with self.assertRaisesRegex(ValueError, "at least one condition"):
            normalize_rules({"filters": {"exclude": "camera"}})

    def test_rules_keep_groups_drop_empty_ones_and_refuse_nesting(self):
        rules = normalize_rules({"filters": {"any_of": [{"camera": ["FC9113"]}, {"tag": []}, {"rating_max": 0}]}})
        self.assertEqual(rules["filters"], {"any_of": [{"camera": "FC9113"}, {"rating_max": 0}]})
        with self.assertRaisesRegex(ValueError, "do not nest"):
            normalize_rules({"filters": {"any_of": [{"any_of": [{"camera": "X"}]}]}})
        with self.assertRaisesRegex(ValueError, "list of filter groups"):
            normalize_rules({"filters": {"any_of": {"camera": "X"}}})
        with self.assertRaisesRegex(ValueError, "at least one condition"):
            normalize_rules({"filters": {"any_of": [{}]}})


if __name__ == "__main__":
    unittest.main()
