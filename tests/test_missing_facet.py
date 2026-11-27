"""The missing facet: an original gone from disk as a condition, where
"Missing Originals" used to be a place of its own (status "missing")."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    add_collection_items,
    connect,
    create_collection,
    init_db,
    list_image_assets,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.db.browse import get_facet_values
from media_workspace.db.facets import names_facet
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

STEMS = ("kept", "moved", "deleted")


class MissingFacetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.catalog = ensure_catalog(Path(self.directory.name) / "missing.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        self.paths = {}
        for stem in STEMS:
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"x")
            self.paths[stem] = path
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        # What the last check found: two of them gone.
        self.connection.execute("UPDATE assets SET exists_on_disk = 0 WHERE asset_id IN ('image_moved', 'image_deleted')")
        self.connection.commit()

    def stems(self, filters=None, **kwargs):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters, **kwargs))

    def run_cli(self, *argv: str) -> list[dict]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def test_true_is_the_old_missing_scope_and_false_its_complement(self):
        old_view = sorted(row["stem"] for row in list_image_assets(self.connection, "missing"))
        self.assertEqual(old_view, ["deleted", "moved"])
        self.assertEqual(self.stems({"missing": True}), old_view)
        self.assertEqual(self.stems({"missing": "true"}), old_view)
        self.assertEqual(self.stems({"missing": False}), ["kept"])
        # "Not missing", flipped, is missing again.
        self.assertEqual(self.stems({"missing": False, "exclude": ["missing"]}), old_view)
        # Both at once, or a word that means nothing, is no condition.
        self.assertEqual(self.stems({"missing": ["true", "false"]}), ["deleted", "kept", "moved"])
        self.assertEqual(self.stems({"missing": "maybe"}), ["deleted", "kept", "moved"])

    def test_options_are_counted_only_while_something_is_missing(self):
        counts = {r["value"]: r["count"] for r in get_facet_values(self.connection)["missing"]}
        self.assertEqual(counts, {"true": 2, "false": 1})
        # Its own value does not narrow its options, so the other row stays pickable.
        narrowed = {r["value"]: r["count"] for r in get_facet_values(self.connection, filters={"missing": "true"})["missing"]}
        self.assertEqual(narrowed, {"true": 2, "false": 1})
        self.connection.execute("UPDATE assets SET exists_on_disk = 1")
        self.connection.commit()
        self.assertEqual(get_facet_values(self.connection)["missing"], [])

    def test_a_smart_collection_may_save_it(self):
        rules = normalize_rules({"filters": {"missing": True}})
        self.assertEqual(rules["filters"], {"missing": True})
        self.assertEqual(self.stems(base=rules), ["deleted", "moved"])

    def test_names_facet_looks_into_any_of_groups(self):
        self.assertTrue(names_facet({"missing": True}, "missing"))
        self.assertTrue(names_facet({"any_of": [{"rating_min": 4}, {"missing": "true"}]}, "missing"))
        self.assertFalse(names_facet({"missing": ["true", "false"]}, "missing"))
        self.assertFalse(names_facet({"rating_min": 4}, "missing"))
        self.assertFalse(names_facet(None, "missing"))

    def test_browsing_for_missing_checks_the_disk_first(self):
        # Since the last check: "moved" was put back, "kept" was deleted.
        self.paths["kept"].unlink()
        self.paths["deleted"].unlink()
        # A browse that does not ask leaves the flags as they were.
        self.assertEqual({row["asset_id"] for row in self.run_cli("browse-images", "--status", "all")},
                         {"image_kept", "image_moved", "image_deleted"})
        self.assertEqual(self.stems({"missing": True}), ["deleted", "moved"])

        rows = self.run_cli("browse-images", "--status", "all", "--filters", json.dumps({"missing": True}))
        self.assertEqual(sorted(row["asset_id"] for row in rows), ["image_deleted", "image_kept"])

    def test_a_smart_collection_of_missing_checks_the_disk_first(self):
        # The flags say moved and deleted; on disk only kept is gone.
        self.paths["kept"].unlink()
        base = normalize_rules({"filters": {"missing": True}})
        rows = self.run_cli("browse-images", "--status", "all", "--base", json.dumps(base))
        self.assertEqual([row["asset_id"] for row in rows], ["image_kept"])

    def test_a_collection_filtered_to_missing_checks_the_disk_first(self):
        collection_id = create_collection(self.connection, "Trip")["collection_id"]
        add_collection_items(self.connection, collection_id, ["image_kept", "image_moved"])
        self.connection.commit()
        self.paths["kept"].unlink()
        rows = self.run_cli("browse-collection", "--collection-id", collection_id, "--filters", json.dumps({"missing": True}))
        self.assertEqual([row["asset_id"] for row in rows], ["image_kept"])


if __name__ == "__main__":
    unittest.main()
