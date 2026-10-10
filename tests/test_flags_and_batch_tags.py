"""Pick / reject flags (Lightroom's P / X / U) and adding tags to many photos
at once. A flag is the catalog's own (never read from or written to the file);
"no flag" is NULL for a photo never flagged and 0 for one cleared."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.facets import FACET_KEYS
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

STEMS = ("a", "b", "c", "d")


class FlagsAndBatchTagsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.catalog = ensure_catalog(Path(self.directory.name) / "flags.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem in STEMS:
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=None,
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

    def run_cli(self, *argv: str) -> dict:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def flag(self, value: str, *stems: str) -> dict:
        argv = ["set-asset-flag", "--flag", value]
        for stem in stems:
            argv += ["--asset-id", f"image_{stem}"]
        return self.run_cli(*argv)

    def stems(self, filters: dict) -> list[str]:
        return sorted(row["stem"] for row in list_image_assets(self.connection, status="all", filters=filters))

    def test_flags_are_stored_as_one_minus_one_and_zero(self) -> None:
        self.assertEqual(self.flag("pick", "a", "b")["updated"], 2)
        self.flag("reject", "c")
        self.flag("pick", "d")
        self.flag("none", "d")
        rows = dict(self.connection.execute("SELECT stem, app_flag FROM assets").fetchall())
        self.assertEqual(rows, {"a": 1, "b": 1, "c": -1, "d": 0})

    def test_browse_and_detail_carry_the_flag(self) -> None:
        self.flag("reject", "a")
        rows = {row["stem"]: row["app_flag"] for row in list_image_assets(self.connection, status="all")}
        self.assertEqual(rows["a"], -1)
        self.assertIsNone(rows["b"])
        browsed = {row["asset_id"]: row for row in self.run_cli("browse-images", "--status", "all")}
        self.assertEqual(browsed["image_a"]["app_flag"], -1)
        self.assertEqual(self.run_cli("asset-detail", "--asset-id", "image_a")["app_flag"], -1)

    def test_the_flag_filter_reads_never_flagged_and_cleared_as_none(self) -> None:
        self.flag("pick", "a")
        self.flag("reject", "b")
        self.flag("reject", "c")
        self.flag("none", "c")
        self.assertEqual(self.stems({"flag": "pick"}), ["a"])
        self.assertEqual(self.stems({"flag": ["reject"]}), ["b"])
        self.assertEqual(self.stems({"flag": "none"}), ["c", "d"])
        self.assertEqual(self.stems({"flag": ["pick", "reject"]}), ["a", "b"])
        # Excluded: everything but the rejects (the cull's keepers).
        self.assertEqual(self.stems({"flag": "reject", "exclude": ["flag"]}), ["a", "c", "d"])

    def test_a_smart_collection_can_select_by_flag(self) -> None:
        self.assertIn("flag", FACET_KEYS)
        rules = normalize_rules({"status": "all", "filters": {"flag": "pick"}})
        self.assertEqual(rules["filters"]["flag"], "pick")

    def test_an_unknown_flag_is_refused(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["--catalog", str(self.catalog.root), "set-asset-flag", "--flag", "maybe", "--asset-id", "image_a"])

    def test_batch_tags_go_onto_every_photo_once(self) -> None:
        result = self.run_cli(
            "add-asset-tags",
            "--asset-id", "image_a", "--asset-id", "image_b", "--asset-id", "image_gone",
            "--tag", "trip", "--tag", " Trip ", "--tag", "beach", "--tag", "  ",
        )
        self.assertEqual(result["asset_ids"], ["image_a", "image_b"])
        self.assertEqual(result["tags"], ["trip", "beach"])
        self.assertEqual(result["missing"], ["image_gone"])
        tags = sorted(tuple(row) for row in self.connection.execute("SELECT asset_id, tag, source FROM asset_tags"))
        self.assertEqual(tags, [
            ("image_a", "beach", "user"), ("image_a", "trip", "user"),
            ("image_b", "beach", "user"), ("image_b", "trip", "user"),
        ])
        # A hand-tagged photo is still one AI hasn't described: no annotation row.
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM asset_ai_annotations").fetchone()[0], 0)
        self.assertEqual(self.run_cli("get-asset-tags", "--asset-id", "image_b")["tags"], ["trip", "beach"])
        self.assertEqual(self.stems({"tag": "trip"}), ["a", "b"])

    def test_batch_tags_keep_the_tags_a_photo_had(self) -> None:
        self.run_cli("add-asset-tag", "--asset-id", "image_a", "--tag", "old")
        self.run_cli("add-asset-tags", "--asset-id", "image_a", "--tag", "new", "--tag", "OLD")
        # "OLD" is the photo's "old": the library's spelling wins, once.
        self.assertEqual(self.run_cli("get-asset-tags", "--asset-id", "image_a")["tags"], ["old", "new"])

if __name__ == "__main__":
    unittest.main()
