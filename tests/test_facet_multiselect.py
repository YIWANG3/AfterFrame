"""Several values within one facet are OR; different facets stay AND."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import count_image_assets, get_facet_values
from media_workspace.db.facets import FACET_KEYS, FACET_OWN_KEYS, FACETS
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (  # stem, camera, rating, extension, tags
    ("a", "FC9113", 5, ".jpg", ("night", "neon")),
    ("b", "FC9184", 5, ".jpg", ("night",)),
    ("c", "FC9184", 2, ".png", ("neon",)),
    ("d", "Canon R6", 5, ".jpg", ("night", "neon")),
    ("e", "Canon R6", 1, ".png", ()),
)


class MultiSelectTests(unittest.TestCase):
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

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def test_several_values_in_one_facet_are_or(self):
        self.assertEqual(self.stems({"camera": ["FC9113", "FC9184"]}), ["a", "b", "c"])
        self.assertEqual(self.stems({"extension": ["png", "JPG"]}), ["a", "b", "c", "d", "e"])

    def test_different_facets_are_still_and(self):
        # "either drone" AND "five stars"
        self.assertEqual(self.stems({"camera": ["FC9113", "FC9184"], "rating_min": 5}), ["a", "b"])

    def test_a_scalar_is_a_list_of_one_so_old_filters_read_unchanged(self):
        self.assertEqual(self.stems({"camera": "FC9184"}), self.stems({"camera": ["FC9184"]}))
        self.assertEqual(self.stems({"tag": "night"}), self.stems({"tag": ["night"]}))
        self.assertEqual(self.stems({"camera": [], "tag": [""]}), ["a", "b", "c", "d", "e"])  # empty = no condition

    def test_tags_are_any_by_default_and_all_on_request(self):
        self.assertEqual(self.stems({"tag": ["night", "neon"]}), ["a", "b", "c", "d"])
        self.assertEqual(self.stems({"tag": ["night", "neon"], "tag_match": "all"}), ["a", "d"])
        self.assertEqual(self.stems({"tag_match": "all"}), ["a", "b", "c", "d", "e"])  # a modifier alone is not a condition

    def test_counts_beside_options_ignore_the_facets_own_picks(self):
        # With one drone picked, the other still says how many IT has, inside "five stars".
        cameras = {r["value"]: r["count"] for r in get_facet_values(self.connection, filters={"camera": ["FC9113"], "rating_min": 5})["cameras"]}
        self.assertEqual(cameras, {"FC9113": 1, "FC9184": 1, "Canon R6": 1})
        # And the grid count is the OR of the picks.
        self.assertEqual(count_image_assets(self.connection, "all", filters={"camera": ["FC9113", "FC9184"], "rating_min": 5}), 2)

    def test_rules_keep_a_single_pick_scalar_and_several_as_a_list(self):
        rules = normalize_rules({"filters": {"camera": ["FC9113"], "tag": ["night", "", "neon"], "lens": []}})
        self.assertEqual(rules["filters"], {"camera": "FC9113", "tag": ["night", "neon"]})
        with self.assertRaisesRegex(ValueError, "at least one condition"):
            normalize_rules({"filters": {"tag_match": "all"}})

    def test_the_registry_is_the_single_source(self):
        self.assertEqual(FACET_KEYS, {key for facet in FACETS for key in facet.keys})
        self.assertEqual(set(FACET_OWN_KEYS), {facet.name for facet in FACETS})
        self.assertEqual(len({facet.name for facet in FACETS}), len(FACETS))  # no duplicate names


if __name__ == "__main__":
    unittest.main()
