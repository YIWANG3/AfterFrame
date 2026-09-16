import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace import annotation
from media_workspace.annotation_location import _nearby_labels, effective_location, gps_location
from media_workspace.cli import _annotation_from_row, _cmd_annotate_asset
from media_workspace.db import connect, init_db, list_image_assets, upsert_asset_location_from_metadata

GPS = {"gps_latitude": 20.8795, "gps_longitude": -156.6899}
WRONG = {"country": "United Kingdom", "admin1": "Scotland", "landmark": "Glen Coe", "confidence": 75}


class AnnotationGPSTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = connect(Path(self.temp.name) / "catalog.sqlite3")
        init_db(self.db)
        self.db.execute("""INSERT INTO assets
            (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
             extension, fingerprint, file_size, modified_time, metadata_json)
            VALUES ('gps', 'image', '/image.jpg', 'image', 'image', 'image', '.jpg', 'gps', 1, '2026', ?)""",
            (json.dumps(GPS),))
        self.db.execute("""INSERT INTO image_lookup_registry
            (image_path, image_asset_id, match_status, resolver_version)
            VALUES ('/image.jpg', 'gps', 'unmatched', 'test')""")
        upsert_asset_location_from_metadata(self.db, "gps", GPS)
        self.result = annotation.AnnotationResult("Landscape", [], WRONG, None, "{}", "openai", "test")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_hawaii_coordinate_overrides_uk(self):
        loc = gps_location(GPS)
        self.assertEqual((loc["country"], loc["admin1"], loc["locality"]), ("United States", "Hawaii", "Lahaina"))
        self.assertIsNone(loc["landmark"])
        self.assertIsNone(loc["confidence"])

    def test_old_annotation_read_and_browse_agree_without_rewrite(self):
        annotation.save_annotation(self.db, "gps", self.result)
        self.db.execute("UPDATE asset_ai_annotations SET location_json = ?", (json.dumps(WRONG),))
        detail = annotation.get_annotation(self.db, "gps")["location"]
        inline = _annotation_from_row(list_image_assets(self.db, "all")[0])["location"]
        self.assertEqual(detail, inline)
        self.assertEqual(detail["source"], "exif")
        self.assertEqual(detail["admin1"], "Hawaii")
        self.assertEqual(json.loads(self.db.execute("SELECT location_json FROM asset_ai_annotations").fetchone()[0]), WRONG)

    def test_save_cannot_override_gps_and_map(self):
        saved = annotation.save_annotation(self.db, "gps", self.result)
        self.assertEqual(saved["location"]["admin1"], "Hawaii")
        point = self.db.execute("SELECT * FROM asset_locations").fetchone()
        self.assertEqual(point["source"], "exif")
        self.assertEqual(point["longitude"], GPS["gps_longitude"])

    def test_missing_invalid_gps_preserves_visual_guess(self):
        for metadata in ({}, {"gps_latitude": 91, "gps_longitude": 1},
                         {"gps_latitude": 0, "gps_longitude": 0},
                         {"gps_latitude": "NaN", "gps_longitude": 1}, "broken"):
            self.assertIsNone(gps_location(metadata))
            self.assertEqual(effective_location(metadata, WRONG), WRONG)
        self.assertIsNone(effective_location({}, gps_location(GPS)))

    def test_missing_gazetteer_keeps_coordinates_not_ai_guess(self):
        _nearby_labels.cache_clear()
        with patch("media_workspace.discover.load_reverse_geocoder", return_value=None):
            loc = effective_location(GPS, WRONG)
        _nearby_labels.cache_clear()
        self.assertEqual(loc["source"], "exif")
        self.assertNotIn("country", loc)

    def test_both_provider_prompts_and_noncompliant_response(self):
        for provider, adapter in (("openai", "call_openai_compatible"), ("anthropic", "call_anthropic")):
            with patch.object(annotation, "encode_image_for_llm", return_value=("image", "image/jpeg")), \
                 patch.object(annotation, adapter, return_value=json.dumps({"location": WRONG})) as call:
                result = annotation.annotate(image_paths=[Path("test.jpg")], provider=provider,
                    api_key="test", model="test", location_context=gps_location(GPS), location_hint="Scotland")
                self.assertIn("20.8795", call.call_args.kwargs["prompt_text"])
                self.assertIn("Hawaii", call.call_args.kwargs["prompt_text"])
                self.assertIn("priority", call.call_args.kwargs["system_prompt"])
                self.assertEqual(result.location["admin1"], "Hawaii")

    def test_batch_passes_gps_to_worker(self):
        rows = self.db.execute("SELECT * FROM assets").fetchall()
        with patch.object(annotation, "_batch_image_path", return_value=Path("test.jpg")), \
             patch.object(annotation, "annotate", return_value=self.result) as call:
            result = annotation.annotate_batch(self.db, Path(self.temp.name), rows,
                provider="openai", api_key="test", model="test")
        self.assertEqual(result["succeeded"], 1)
        self.assertEqual(call.call_args.kwargs["location_context"]["admin1"], "Hawaii")

    def test_no_gps_keeps_guess_but_cannot_claim_exif_provenance(self):
        with patch.object(annotation, "encode_image_for_llm", return_value=("image", "image/jpeg")), \
             patch.object(annotation, "call_openai_compatible", return_value=json.dumps({
                 "location": {**WRONG, "source": "exif", "latitude": 20.8, "longitude": -156.6}
             })):
            result = annotation.annotate(image_paths=[Path("test.jpg")], provider="openai", api_key="test", model="test")
        self.assertEqual(result.location, WRONG)

    def test_single_command_passes_gps(self):
        from types import SimpleNamespace
        args = SimpleNamespace(languages="en", image="image.jpg", provider="openai", api_key="test",
            model="test", base_url=None, max_tags=10, max_caption_chars=200, custom_instructions=None,
            hint=None, asset_id="gps")
        with patch.object(annotation, "annotate", return_value=self.result) as call, patch("builtins.print"):
            _cmd_annotate_asset(args, self.db, None, None)
        self.assertEqual(call.call_args.kwargs["location_context"]["latitude"], GPS["gps_latitude"])
