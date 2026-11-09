"""The has_raw facet: a bound RAW file as a condition, where "With Raw" used
to be a place of its own in the sidebar."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import get_facet_values
from media_workspace.db.facets import has_raw_value
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (  # stem, bound to a RAW
    ("paired", True),
    ("confirmed", True),
    ("jpeg_only", False),
)


class HasRawFacetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, bound in PHOTOS:
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            status = {"paired": "auto_bound", "confirmed": "manual_confirmed"}.get(stem, "unmatched")
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status=status, score=1.0 if bound else 0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def test_true_is_the_old_with_raw_scope_and_false_its_complement(self):
        matched = sorted(row["stem"] for row in list_image_assets(self.connection, "matched"))
        self.assertEqual(matched, ["confirmed", "paired"])
        self.assertEqual(self.stems({"has_raw": True}), matched)
        self.assertEqual(self.stems({"has_raw": "true"}), matched)
        self.assertEqual(self.stems({"has_raw": 1}), matched)
        self.assertEqual(self.stems({"has_raw": False}), ["jpeg_only"])
        self.assertEqual(self.stems({"has_raw": "0"}), ["jpeg_only"])
        # Both at once, or a value that means nothing, is no condition.
        self.assertEqual(self.stems({"has_raw": ["true", "false"]}), ["confirmed", "jpeg_only", "paired"])
        self.assertEqual(self.stems({"has_raw": "maybe"}), ["confirmed", "jpeg_only", "paired"])

    def test_value_words(self):
        self.assertTrue(has_raw_value("yes"))
        self.assertFalse(has_raw_value("without"))
        self.assertIsNone(has_raw_value(""))

    def test_options_are_counted_and_follow_the_other_filters(self):
        counts = {r["value"]: r["count"] for r in get_facet_values(self.connection)["has_raw"]}
        self.assertEqual(counts, {"true": 2, "false": 1})
        # Its own value does not narrow its options, so the other row stays pickable.
        narrowed = {r["value"]: r["count"] for r in get_facet_values(self.connection, filters={"has_raw": "true"})["has_raw"]}
        self.assertEqual(narrowed, {"true": 2, "false": 1})

    def test_a_jpeg_only_library_offers_nothing(self):
        self.connection.execute("UPDATE image_lookup_registry SET match_status = 'unmatched'")
        self.connection.commit()
        self.assertEqual(get_facet_values(self.connection)["has_raw"], [])

    def test_a_smart_collection_may_save_it(self):
        rules = normalize_rules({"filters": {"has_raw": "true"}})
        self.assertEqual(rules["filters"], {"has_raw": "true"})
        self.assertEqual(sorted(row["stem"] for row in list_image_assets(self.connection, "all", base=rules)), ["confirmed", "paired"])
