from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path, summary
from media_workspace.scanner import enrich_raw_assets, scan_raw_directory


class ScannerTest(unittest.TestCase):
    def test_scan_raw_directory_reports_workers_and_indexes_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            raw_dir.mkdir()
            (raw_dir / "0Y1A6380.CR3").write_bytes(b"raw-binary-placeholder")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            result = scan_raw_directory(connection, raw_dir, workers=1)

            self.assertEqual(result["indexed"], 1)
            self.assertEqual(result["workers"], 1)
            self.assertEqual(result["fingerprint_mode"], "head-tail")
            self.assertEqual(result["metadata_profile"], "full")
            self.assertEqual(result["commits"], 1)
            self.assertEqual(summary(connection)["raw_assets"], 1)

    def test_scan_raw_directory_recurses_nested_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            nested = raw_dir / "2025" / "250119 SD"
            nested.mkdir(parents=True)
            (nested / "0Y1A6380.CR3").write_bytes(b"raw-binary-placeholder")
            (nested / "notes.txt").write_text("ignore me", encoding="utf-8")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            result = scan_raw_directory(connection, raw_dir, workers=1)

            self.assertEqual(result["indexed"], 1)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(summary(connection)["raw_assets"], 1)

    def test_enrich_raw_assets_upgrades_matcher_level_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            raw_dir.mkdir()
            raw_file = raw_dir / "0Y1A7001.CR3"
            raw_file.write_bytes(b"raw-binary-placeholder")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            scan_raw_directory(connection, raw_dir, workers=1, fingerprint_mode="head-only", metadata_profile="matcher")

            before = connection.execute(
                "SELECT metadata_level, enrichment_status, fingerprint_level FROM raw_metadata_cache WHERE path = ?",
                (str(raw_file.resolve()),),
            ).fetchone()
            self.assertEqual(before["metadata_level"], "matcher")
            self.assertEqual(before["enrichment_status"], "pending")
            self.assertEqual(before["fingerprint_level"], "head-only")

            result = enrich_raw_assets(connection, raw_dirs=[raw_dir], workers=1)

            self.assertEqual(result["queued"], 1)
            self.assertEqual(result["enriched"], 1)
            after = connection.execute(
                "SELECT metadata_level, enrichment_status, fingerprint_level FROM raw_metadata_cache WHERE path = ?",
                (str(raw_file.resolve()),),
            ).fetchone()
            self.assertEqual(after["metadata_level"], "full")
            self.assertEqual(after["enrichment_status"], "done")
            self.assertEqual(after["fingerprint_level"], "head-only")
            self.assertEqual(summary(connection)["raw_fast_only"], 0)
            self.assertEqual(summary(connection)["raw_enriched"], 1)


if __name__ == "__main__":
    unittest.main()
