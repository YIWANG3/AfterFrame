from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from media_workspace.benchmark import benchmark_dataset


class BenchmarkDatasetTest(unittest.TestCase):
    def test_benchmark_dataset_reports_stage_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = root / "bench.afcatalog"
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

            result = benchmark_dataset(
                catalog_path=catalog,
                raw_dirs=[raw_dir],
                export_dirs=[export_dir],
                truth_csv=truth_csv,
                include_previews=False,
            )

            self.assertEqual(result["dataset"]["raw_file_count"], 1)
            self.assertEqual(result["dataset"]["export_file_count"], 1)
            self.assertIn("metadata_analysis", result["stages"])
            self.assertIn("scan_raw", result["stages"])
            self.assertIn("resolve_exports", result["stages"])
            self.assertNotIn("generate_previews", result["stages"])
            self.assertEqual(result["summary"]["raw_assets"], 1)
            self.assertEqual(result["summary"]["export_assets"], 1)
            self.assertEqual(result["summary"]["confirmed_matches"], 1)
            self.assertEqual(result["evaluation"]["correct_match"], 1)


if __name__ == "__main__":
    unittest.main()
