"""A photo's tags are one list: what the user typed and what AI proposed.

- A hand-added tag makes no annotation row (it used to make a stand-in one,
  so the photo counted as AI-annotated: "annotate missing" skipped it).
- An annotation run adds its tags and replaces only its own earlier ones;
  the user's stay, and an AI tag the user adds too becomes theirs.
- Catalogs with the old stand-ins lose them on the next open, tags kept."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import annotation as ann
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.assets import list_assets_for_annotation
from media_workspace.db.core import _drop_hand_tag_stand_ins
from media_workspace.models import ImageCandidate, MatchDecision


def result(*tags: str, caption: str = "A beach at dusk") -> ann.AnnotationResult:
    return ann.AnnotationResult(
        caption=caption, tags=list(tags), location=None, detected_text=None,
        raw_response="{}", provider="mock", model="m",
    )


class TagMergeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.catalog = ensure_catalog(root / "tags.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem in ("a", "b"):
            path = root / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time=None, rating=None, camera_make=None, camera_model=None,
                lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=600, height=400,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def sources(self, asset_id: str = "image_a") -> dict[str, str]:
        return dict(self.connection.execute("SELECT tag, source FROM asset_tags WHERE asset_id = ?", (asset_id,)).fetchall())

    def annotated(self) -> list[str]:
        return [r[0] for r in self.connection.execute("SELECT asset_id FROM asset_ai_annotations ORDER BY asset_id")]

    def test_a_hand_tag_leaves_the_photo_unannotated(self):
        self.assertEqual(ann.add_asset_tag(self.connection, "image_a", "family"), {"asset_id": "image_a", "tags": ["family"]})
        self.assertEqual(self.annotated(), [])
        self.assertIsNone(ann.get_annotation(self.connection, "image_a"))
        # "Annotate missing" still takes it; "without AI annotation" still finds it.
        missing = {row["asset_id"] for row in list_assets_for_annotation(self.connection, only_missing=True)}
        self.assertIn("image_a", missing)
        without = {row["asset_id"] for row in list_image_assets(self.connection, "all", filters={"annotated": "without"})}
        self.assertIn("image_a", without)
        # Browse hands the tags over all the same.
        row = next(r for r in list_image_assets(self.connection, "all") if r["asset_id"] == "image_a")
        self.assertEqual(json.loads(row["asset_tags_json"]), ["family"])

    def test_annotation_adds_its_tags_and_keeps_the_users(self):
        ann.add_asset_tag(self.connection, "image_a", "family")
        saved = ann.save_annotation(self.connection, "image_a", result("beach", "sunset"))
        self.assertEqual(saved["tags"], ["family", "beach", "sunset"])
        self.assertEqual(saved["ai_tags"], ["beach", "sunset"])
        self.assertEqual(self.sources(), {"family": "user", "beach": "ai", "sunset": "ai"})

    def test_a_new_run_replaces_its_own_tags_only(self):
        ann.add_asset_tag(self.connection, "image_a", "family")
        ann.save_annotation(self.connection, "image_a", result("beach", "sunset"))
        # The user keeps "sunset": adding it makes it theirs.
        self.assertEqual(ann.add_asset_tag(self.connection, "image_a", "Sunset")["tags"], ["family", "beach", "sunset"])
        saved = ann.save_annotation(self.connection, "image_a", result("sea"))
        self.assertEqual(saved["tags"], ["family", "sunset", "sea"])
        self.assertEqual(self.sources(), {"family": "user", "sunset": "user", "sea": "ai"})

    def test_an_ai_tag_spelled_like_the_users_is_the_users(self):
        ann.add_asset_tag(self.connection, "image_b", "Beach")
        ann.add_asset_tag(self.connection, "image_a", "family")
        saved = ann.save_annotation(self.connection, "image_a", result("beach"))
        # Library spelling: the run's "beach" is the library's "Beach".
        self.assertEqual(saved["tags"], ["family", "Beach"])

    def test_removing_takes_off_either_kind(self):
        ann.add_asset_tag(self.connection, "image_a", "family")
        ann.save_annotation(self.connection, "image_a", result("beach"))
        self.assertEqual(ann.remove_asset_tag(self.connection, "image_a", "BEACH")["tags"], ["family"])
        self.assertEqual(ann.remove_asset_tag(self.connection, "image_a", "family")["tags"], [])
        # The annotation itself (the caption) stays.
        self.assertEqual(ann.get_annotation(self.connection, "image_a")["caption"], "A beach at dusk")

    def test_old_stand_ins_go_and_their_tags_stay(self):
        # What add_asset_tag used to write for a photo with no annotation.
        self.connection.execute(
            "INSERT INTO asset_ai_annotations (asset_id, provider, model, schema_version, caption, tags_json, created_at, updated_at)"
            " VALUES ('image_a', 'user', 'manual', 2, '', '[\"family\", \"trip\"]', 'x', 'x')"
        )
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES ('image_a', 'family', 'user')")
        ann.save_annotation(self.connection, "image_b", result("beach"))
        self.connection.commit()

        # The next full init (here: forced) clears them.
        self.connection.execute("PRAGMA user_version = 0")
        self.connection.commit()
        init_db(self.connection)

        self.assertEqual(self.annotated(), ["image_b"])  # a real annotation is left alone
        self.assertEqual(self.sources(), {"family": "user", "trip": "user"})

    def test_an_annotations_tags_missing_from_asset_tags_are_copied_there(self):
        ann.save_annotation(self.connection, "image_b", result("beach"))
        # As an older build (or a hand-made fixture) might have left it.
        self.connection.execute("UPDATE asset_ai_annotations SET tags_json = '[\"beach\", \"city\"]' WHERE asset_id = 'image_b'")
        self.connection.execute("PRAGMA user_version = 0")
        self.connection.commit()
        init_db(self.connection)
        self.assertEqual(self.sources("image_b"), {"beach": "ai", "city": "ai"})
        _drop_hand_tag_stand_ins(self.connection)  # idempotent
        self.assertEqual(self.annotated(), ["image_b"])


if __name__ == "__main__":
    unittest.main()
