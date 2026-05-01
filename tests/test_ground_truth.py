from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.ground_truth import export_ground_truth
from media_workspace.reverse_lookup import resolve_export
from media_workspace.scanner import scan_raw_directory


class GroundTruthExportTest(unittest.TestCase):
    def test_export_ground_truth_writes_review_csv(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            (raw_dir / "B0023524.CR3").write_bytes(b"raw-binary-placeholder")

            matched_export = export_dir / "B0023524-2.jpg"
            matched_export.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )
            unmatched_export = export_dir / "cover-final.jpg"
            unmatched_export.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            scan_raw_directory(connection, raw_dir)
            resolve_export(connection, matched_export)
            resolve_export(connection, unmatched_export)

            output_csv = root / "truth.csv"
            result = export_ground_truth(connection, output_csv, statuses=["matched", "unmatched"])

            self.assertEqual(result["rows"], 2)
            with output_csv.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))

            self.assertTrue(rows[0]["notes"].startswith("reviewed-match-v0;score="))
            self.assertTrue(rows[0]["raw_path"])
            self.assertEqual(rows[1]["raw_path"], "")
            self.assertEqual(rows[1]["notes"], "reviewed-unmatched-v0;score=0.00")


if __name__ == "__main__":
    unittest.main()
