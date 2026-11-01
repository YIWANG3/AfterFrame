"""The Format facet speaks in the registry's families (docs/format-support-plan.md
§4.6, P2): .jpg and .jpeg count as one JPEG, .heic and .hif as one HEIF, and
a family in a filter stands for all its extensions — while a rule that names
one extension ("jpg", as saved before the families or by an agent) keeps
meaning that extension."""
import tempfile
import unittest
from pathlib import Path

from media_workspace import formats
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import get_facet_values
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (("a", ".jpg"), ("b", ".JPEG"), ("c", ".HIF"), ("d", ".heic"), ("e", ".png"), ("f", ".CR3"), ("g", ".tif"), ("h", ".xyz"))


class FormatFacetTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, extension in PHOTOS:
            path = Path(self.directory.name) / f"{stem}{extension}"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=extension, fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=None,
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def test_the_options_are_families_with_labels_and_counts(self):
        self.assertEqual(get_facet_values(self.connection)["extensions"], [
            {"value": "heif", "label": "HEIF", "count": 2},
            {"value": "jpeg", "label": "JPEG", "count": 2},
            {"value": "cr3", "label": "Canon CR3", "count": 1},
            {"value": "png", "label": "PNG", "count": 1},
            {"value": "tiff", "label": "TIFF", "count": 1},
            # An extension the registry doesn't know stays itself.
            {"value": "xyz", "label": "XYZ", "count": 1},
        ])

    def test_a_family_in_a_filter_stands_for_all_its_extensions(self):
        self.assertEqual(self.stems({"extension": "jpeg"}), ["a", "b"])
        self.assertEqual(self.stems({"extension": "HEIF"}), ["c", "d"])
        self.assertEqual(self.stems({"extension": ["tiff", "cr3"]}), ["f", "g"])
        self.assertEqual(self.stems({"extension": "xyz"}), ["h"])

    def test_a_rule_naming_one_extension_keeps_meaning_that_extension(self):
        self.assertEqual(self.stems({"extension": "JPG"}), ["a"])
        self.assertEqual(self.stems({"extension": ".jpg"}), ["a"])
        self.assertEqual(self.stems({"extension": "hif"}), ["c"])
        self.assertEqual(self.stems({"extension": "jpg", "exclude": ["extension"]}), ["b", "c", "d", "e", "f", "g", "h"])

    def test_the_helpers_behind_it(self):
        self.assertEqual(formats.format_label("jpeg"), "JPEG")
        self.assertEqual(formats.format_label("cr3"), "Canon CR3")
        self.assertEqual(formats.format_label(".JPG"), "JPG")
        self.assertEqual(formats.filter_extensions("jpeg"), frozenset({"jpg", "jpeg", "jfif", "jpe", "insp"}))
        self.assertEqual(formats.filter_extensions("JPG"), frozenset({"jpg"}))
        sql = formats.family_sql("x")
        self.assertTrue(sql.startswith("CASE x WHEN ") and sql.endswith(" ELSE x END"))
        self.assertIn(" WHEN 'hif' THEN 'heif'", sql)
        self.assertNotIn(" WHEN 'png' THEN 'png'", sql)


if __name__ == "__main__":
    unittest.main()
