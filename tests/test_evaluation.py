from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.evaluation import evaluate_ground_truth
from media_workspace.reverse_lookup import resolve_export
from media_workspace.scanner import scan_raw_directory


class EvaluationTest(unittest.TestCase):
    def test_ground_truth_reports_correct_match(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            raw_file = raw_dir / "B0023524.CR3"
            raw_file.write_bytes(b"raw-binary-placeholder")

            export_file = export_dir / "B0023524-2.jpg"
            export_file.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )

            truth_csv = root / "truth.csv"
            with truth_csv.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["export_path", "raw_path", "notes"])
                writer.writeheader()
                writer.writerow(
                    {
                        "export_path": str(export_file.resolve()),
                        "raw_path": str(raw_file.resolve()),
                        "notes": "same-name-variant",
                    }
                )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            scan_raw_directory(connection, raw_dir)
            resolve_export(connection, export_file)

            result = evaluate_ground_truth(connection, truth_csv)
            self.assertEqual(result["summary"]["correct_match"], 1)
            self.assertEqual(result["summary"]["precision"], 1.0)
            self.assertEqual(result["summary"]["recall"], 1.0)


if __name__ == "__main__":
    unittest.main()
