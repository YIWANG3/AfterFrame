"""Smart collections: a saved filter evaluated by the ordinary browse path."""
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import count_image_assets
from media_workspace.db.collections import (
    add_collection_items,
    create_collection,
    list_collections,
    update_collection,
)
from media_workspace.db.facets import FACET_KEYS, _facet_clauses
from media_workspace.db.smart_rules import normalize_rules, parse_rules
from media_workspace.models import ImageCandidate, MatchDecision


def rules(**kwargs):
    return json.dumps({"version": 1, **kwargs})


class SmartCollectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        now = datetime.now(UTC)
        # (stem, rating, camera, captured)
        for stem, rating, camera, captured in (
            ("recent_five", 5, "Canon EOS R6m2", now - timedelta(days=3)),
            ("recent_two", 2, "Canon EOS R6m2", now - timedelta(days=10)),
            ("old_five", 5, "X-T3", now - timedelta(days=400)),
        ):
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"jpg")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time=captured.isoformat(),
                capture_time=captured.isoformat(), rating=None, camera_make=None, camera_model=camera,
                lens_model=None, software=None, iso=200, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
            self.connection.execute("UPDATE assets SET app_rating = ? WHERE asset_id = ?", (rating, candidate.asset_id))
        self.connection.commit()

    def stems(self, r):
        rows = list_image_assets(self.connection, r["status"], search=r["search"], filters=r["filters"])
        return sorted(row["stem"] for row in rows)

    def smart(self, name="Smart"):
        return next(c for c in list_collections(self.connection) if c["name"] == name)

    def test_count_matches_what_browse_returns(self):
        create_collection(self.connection, "Smart", "smart", rules(filters={"rating_min": 5}))
        smart = self.smart()
        self.assertEqual(self.stems(smart["rules"]), ["old_five", "recent_five"])
        self.assertEqual(smart["item_count"], 2)

    def test_the_count_is_live(self):
        create_collection(self.connection, "Smart", "smart", rules(filters={"rating_min": 5}))
        self.connection.execute("UPDATE assets SET app_rating = 5 WHERE stem = 'recent_two'")
        self.assertEqual(self.smart()["item_count"], 3)

    def test_date_within_days_is_relative_to_today(self):
        create_collection(self.connection, "Smart", "smart", rules(filters={"date_within_days": 30, "rating_min": 5}))
        self.assertEqual(self.stems(self.smart()["rules"]), ["recent_five"])
        self.assertEqual(count_image_assets(self.connection, "all", None, {"date_within_days": 7}), 1)
        self.assertEqual(count_image_assets(self.connection, "all", None, {"date_within_days": 0}), 3)

    def test_search_text_and_status_are_part_of_the_rules(self):
        create_collection(self.connection, "Smart", "smart", rules(status="rated", search="canon"))
        self.assertEqual(self.stems(self.smart()["rules"]), ["recent_five", "recent_two"])
        self.assertEqual(self.smart()["item_count"], 2)

    def test_photos_cannot_be_added_to_a_smart_collection(self):
        smart_id = create_collection(self.connection, "Smart", "smart", rules(filters={"rating_min": 5}))["collection_id"]
        folder_id = create_collection(self.connection, "Folder")["collection_id"]
        asset_id = self.connection.execute("SELECT asset_id FROM assets LIMIT 1").fetchone()[0]
        with self.assertRaisesRegex(ValueError, "fills itself"):
            add_collection_items(self.connection, smart_id, [asset_id])
        self.assertEqual(add_collection_items(self.connection, folder_id, [asset_id]), 1)

    def test_rules_are_validated_when_saved(self):
        for bad, message in (
            (rules(filters={"rating_minimum": 5}), "Unknown smart collection filter"),
            (rules(filters={"geo": {"mode": "bounds"}}), "Unknown smart collection filter"),
            (rules(status="bogus", filters={"rating_min": 5}), "unsupported status"),
            (rules(), "at least one condition"),
            ("not json", "not valid JSON"),
        ):
            with self.assertRaisesRegex(ValueError, message):
                create_collection(self.connection, "Bad", "smart", bad)
        smart_id = create_collection(self.connection, "Smart", "smart", rules(filters={"rating_min": 5}))["collection_id"]
        with self.assertRaisesRegex(ValueError, "Unknown smart collection filter"):
            update_collection(self.connection, smart_id, rules_json=rules(filters={"nope": 1}))
        update_collection(self.connection, smart_id, rules_json=rules(filters={"camera": "X-T3"}))
        self.assertEqual(self.smart()["item_count"], 1)

    def test_unreadable_rules_show_an_empty_collection(self):
        # The column's old default, and rules written by a newer app version.
        for stored in ("[]", json.dumps({"version": 2, "filters": {"rating_min": 5}}), "garbage"):
            self.assertIsNone(parse_rules(stored))
        create_collection(self.connection, "Legacy", "smart", rules(filters={"rating_min": 5}))
        self.connection.execute("UPDATE collections SET rules_json = '[]' WHERE name = 'Legacy'")
        legacy = self.smart("Legacy")
        self.assertIsNone(legacy["rules"])
        self.assertEqual(legacy["item_count"], 0)

    def test_normalize_drops_empty_values_and_keeps_sort(self):
        out = normalize_rules({"filters": {"camera": "X-T3", "lens": "", "tag": None}, "sort": "rating-desc"})
        self.assertEqual(out, {"version": 1, "status": "all", "search": "", "filters": {"camera": "X-T3"}, "sort": "rating-desc"})

    def test_every_facet_key_is_one_the_clause_builder_reads(self):
        # FACET_KEYS is what rules are validated against; a key listed there
        # but ignored by _facet_clauses would save a condition that does nothing.
        samples = {
            "orientation": "portrait", "asset_type": "image", "people": "with_faces", "annotated": "with",
            "location_source": "none", "caption_contains": "x", "ocr_contains": "x", "path_contains": "x",
            "geo": {"mode": "bounds", "west": 0, "south": 0, "east": 1, "north": 1}, "date_from": "2025-01-01",
            "date_to": "2025-12-31", "color": "#ff0000", "any_of": [{"rating_min": 1}],
        }
        from media_workspace.db.facets import FACET_MODIFIER_KEYS

        for key in FACET_KEYS - FACET_MODIFIER_KEYS:
            clause, _ = _facet_clauses({key: samples.get(key, 1)})
            self.assertTrue(clause, f"_facet_clauses ignores {key!r}")
        # A modifier tunes another key: nothing alone, a different clause with it.
        self.assertEqual(_facet_clauses({"tag_match": "all"}), ("", []))
        self.assertNotEqual(_facet_clauses({"tag": ["a", "b"]}), _facet_clauses({"tag": ["a", "b"], "tag_match": "all"}))
        self.assertEqual(_facet_clauses({"exclude": "camera"}), ("", []))
        self.assertNotEqual(_facet_clauses({"camera": "X"}), _facet_clauses({"camera": "X", "exclude": "camera"}))


if __name__ == "__main__":
    unittest.main()
