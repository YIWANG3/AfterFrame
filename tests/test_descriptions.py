"""A photo's description: the one the user writes wins; the AI's caption fills
in where there is none, and an annotation run never overwrites the user's."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import annotation as ann
from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.assets import list_assets_for_annotation
from media_workspace.models import ImageCandidate, MatchDecision


def result(caption: str) -> ann.AnnotationResult:
    return ann.AnnotationResult(
        caption=caption, tags=[], location=None, detected_text=None,
        raw_response="{}", provider="mock", model="m",
    )


class DescriptionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.catalog = ensure_catalog(root / "descriptions.afcatalog")
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

    def run_cli(self, *argv: str):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def describe(self, text: str | None, *stems: str):
        argv = ["set-asset-description", "--reset"] if text is None else ["set-asset-description", "--text", text]
        for stem in stems or ("a",):
            argv += ["--asset-id", f"image_{stem}"]
        return self.run_cli(*argv)

    def shown(self, stem: str = "a"):
        rows = {row["asset_id"]: row for row in self.run_cli("browse-images", "--status", "all")}
        detail = self.run_cli("asset-detail", "--asset-id", f"image_{stem}")
        row = rows[f"image_{stem}"]
        self.assertEqual((row["description"], row["description_source"]), (detail["description"], detail["description_source"]))
        return row["description"], row["description_source"]

    def stems(self, **query):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", **query))

    def test_nothing_until_someone_describes_it(self):
        self.assertEqual(self.shown(), (None, None))

    def test_the_users_description_is_theirs_and_not_an_annotation(self):
        self.assertEqual(self.describe("  Grandma's 80th  ")["description"], "Grandma's 80th")
        self.assertEqual(self.shown(), ("Grandma's 80th", "user"))
        # Writing one is not an AI annotation: "annotate missing" still takes it.
        self.assertIsNone(ann.get_annotation(self.connection, "image_a"))
        self.assertIn("image_a", {r["asset_id"] for r in list_assets_for_annotation(self.connection, only_missing=True)})

    def test_the_ai_caption_fills_in_and_never_overwrites(self):
        ann.save_annotation(self.connection, "image_b", result("A dog on a beach"))
        self.assertEqual(self.shown("b"), ("A dog on a beach", "ai"))
        self.describe("Lucky at Bondi", "b")
        self.assertEqual(self.shown("b"), ("Lucky at Bondi", "user"))
        # Another run: the AI's own caption moves on, the user's stays shown.
        ann.save_annotation(self.connection, "image_b", result("A dog running on sand"))
        self.assertEqual(self.shown("b"), ("Lucky at Bondi", "user"))
        self.assertEqual(ann.get_annotation(self.connection, "image_b")["caption"], "A dog running on sand")
        # Cleared: empty is the user's choice — the AI's doesn't come back…
        self.describe("", "b")
        self.assertEqual(self.shown("b"), (None, "user"))
        # …until they hand the field back to it.
        self.describe(None, "b")
        self.assertEqual(self.shown("b"), ("A dog running on sand", "ai"))

    def test_search_and_the_description_filter_read_both(self):
        self.describe("Grandma's 80th", "a")
        ann.save_annotation(self.connection, "image_b", result("A dog on a beach"))
        self.assertEqual(self.stems(search="grandma"), ["a"])
        self.assertEqual(self.stems(search="dog"), ["b"])
        self.assertEqual(self.stems(filters={"caption_contains": "80th"}), ["a"])
        self.assertEqual(self.stems(filters={"caption_contains": "beach"}), ["b"])
        # The user's wins in the filter too: the AI's words stop matching,
        # an emptied one included.
        self.describe("Lucky", "b")
        self.assertEqual(self.stems(filters={"caption_contains": "beach"}), [])
        self.describe("", "b")
        self.assertEqual(self.stems(filters={"caption_contains": "beach"}), [])

    def test_several_at_once(self):
        self.assertEqual(self.describe("Trip to Kyoto", "a", "b")["updated"], 2)
        self.assertEqual(self.shown("a"), ("Trip to Kyoto", "user"))
        self.assertEqual(self.shown("b"), ("Trip to Kyoto", "user"))


if __name__ == "__main__":
    unittest.main()
