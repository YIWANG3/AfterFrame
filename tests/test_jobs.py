from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    connect,
    create_job,
    get_job,
    get_latest_job,
    init_db,
    list_active_jobs,
    list_jobs,
    request_job_pause,
    request_job_resume,
    set_catalog_path,
)
from media_workspace.job_runner import run_enrichment_job, run_import_job
from media_workspace.scanner import scan_raw_directory


class JobsTest(unittest.TestCase):
    def test_create_update_and_list_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            created = create_job(connection, "import", payload={"raw_dirs": ["/tmp/raw"]})

            self.assertEqual(created["job_type"], "import")
            self.assertEqual(created["status"], "queued")
            self.assertEqual(created["payload"]["raw_dirs"], ["/tmp/raw"])
            self.assertEqual(get_job(connection, created["job_id"])["job_id"], created["job_id"])
            self.assertEqual(get_latest_job(connection, "import")["job_id"], created["job_id"])
            self.assertEqual(len(list_jobs(connection, job_type="import", limit=5)), 1)

    def test_priority_pause_and_resume_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            maintenance = create_job(connection, "people_index", priority=10, resume_cursor={"offset": 12})
            interactive = create_job(connection, "people_index", priority=100)
            active = list_active_jobs(connection)
            self.assertEqual([job["job_id"] for job in active], [interactive["job_id"], maintenance["job_id"]])

            paused = request_job_pause(connection, maintenance["job_id"])
            self.assertEqual(paused["status"], "paused")
            self.assertTrue(paused["pause_requested"])

            resumed = request_job_resume(connection, maintenance["job_id"])
            self.assertEqual(resumed["status"], "queued")
            self.assertFalse(resumed["pause_requested"])
            self.assertEqual(resumed["resume_cursor"], {"offset": 12})

    def test_run_import_job_persists_phase_results(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            (raw_dir / "B0023524.CR3").write_bytes(b"raw-binary-placeholder")
            (export_dir / "B0023524-2.jpg").write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            job = create_job(connection, "import", payload={})

            with patch("media_workspace.job_runner.PreviewService.generate_batch", return_value={"generated": 1, "skipped": 0, "failed": 0}):
                result = run_import_job(connection, catalog.root, job["job_id"], [raw_dir], [export_dir])

            self.assertEqual(len(result["phase_results"]), 4)  # scan, match, preview, preview-hd
            recorded = get_job(connection, job["job_id"])
            self.assertEqual(recorded["status"], "succeeded")
            self.assertEqual(recorded["progress"], 1.0)
            self.assertEqual(len(recorded["result"]["phase_results"]), 4)

    def test_run_enrichment_job_marks_job_succeeded(self) -> None:
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

            job = create_job(connection, "enrichment", payload={})
            result = run_enrichment_job(connection, job["job_id"], raw_dirs=[raw_dir])

            self.assertEqual(result["enriched"], 1)
            recorded = get_job(connection, job["job_id"])
            self.assertEqual(recorded["status"], "succeeded")
            self.assertEqual(recorded["result"]["enriched"], 1)


if __name__ == "__main__":
    unittest.main()
