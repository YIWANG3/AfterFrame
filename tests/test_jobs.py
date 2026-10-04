from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

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
from media_workspace.db.jobs import STALL_MINUTES_BY_JOB_TYPE, STALL_MINUTES_DEFAULT
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
            connection.close()

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
            connection.close()

    def test_stall_reaper_uses_a_per_type_window(self) -> None:
        """A job that reports progress per batch is dead after 10 silent minutes;
        one that blocks inside a single remote call is not.

        run_ai_repaint_job writes status='running' once and then waits on the
        provider. The Jimeng sync2async poll alone runs 180 x 2s plus 5s per
        concurrency-limit response, so a healthy generation can be silent for
        ~20 minutes — reaping it at 10 would show the user a phantom failure.
        """
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            batch = create_job(connection, "import", status="running")
            generation = create_job(connection, "ai_repaint", status="running")

            def age(job_id: str, minutes: int) -> None:
                connection.execute(
                    "UPDATE jobs SET updated_at = datetime('now', ?) WHERE job_id = ?",
                    (f"-{minutes} minutes", job_id),
                )
                connection.commit()

            # Past the batch window, well inside the generation one.
            age(batch["job_id"], STALL_MINUTES_DEFAULT + 5)
            age(generation["job_id"], STALL_MINUTES_DEFAULT + 5)
            list_active_jobs(connection)

            self.assertEqual(get_job(connection, batch["job_id"])["status"], "failed")
            self.assertEqual(get_job(connection, generation["job_id"])["status"], "running")

            # Past its own window, the generation job is reaped too.
            age(generation["job_id"], STALL_MINUTES_BY_JOB_TYPE["ai_repaint"] + 5)
            list_active_jobs(connection)
            reaped = get_job(connection, generation["job_id"])
            self.assertEqual(reaped["status"], "failed")
            self.assertIn("no heartbeat", reaped["error"])
            connection.close()

    def test_stall_reaper_leaves_fresh_jobs_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            queued = create_job(connection, "import")
            running = create_job(connection, "annotation", status="running")

            active = {job["job_id"] for job in list_active_jobs(connection)}

            self.assertIn(queued["job_id"], active)
            self.assertIn(running["job_id"], active)
            self.assertEqual(get_job(connection, queued["job_id"])["status"], "queued")
            self.assertEqual(get_job(connection, running["job_id"])["status"], "running")
            connection.close()

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
            connection.close()

    def test_an_import_makes_each_batchs_thumbnails_before_indexing_the_next(self) -> None:
        # A drive import used to index every file first: hours of an empty
        # gallery (#130). Each batch is now indexed, then previewed.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            photos = root / "trip"
            photos.mkdir()
            for index in range(5):
                Image.new("RGB", (64, 48), (index * 40, 90, 160)).save(photos / f"IMG_{index:04d}.jpg", "JPEG")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            job = create_job(connection, "import", payload={})
            seen = []

            def record(service, conn, kind, asset_type=None, paths=None, **kwargs):
                indexed = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
                seen.append((kind, asset_type, sorted(p.name for p in (paths or [])), indexed))
                return {"generated": 0, "skipped": 0, "failed": 0, "deferred": 0, "total": 0}

            with patch("media_workspace.reverse_lookup.IMPORT_BATCH_SIZE", 2), \
                    patch("media_workspace.job_runner.PreviewService.generate_batch", autospec=True, side_effect=record):
                run_import_job(connection, catalog.root, job["job_id"], [], [photos], mode="processed_only", generate_hd=False)
            connection.close()

        batches = [entry for entry in seen if entry[2] and entry[2][0].startswith("IMG_")]
        self.assertEqual([names for _kind, _type, names, _count in batches],
                         [["IMG_0000.jpg", "IMG_0001.jpg"], ["IMG_0002.jpg", "IMG_0003.jpg"], ["IMG_0004.jpg"]])
        # Each batch's previews ran when only that much had been indexed.
        self.assertEqual([count for *_rest, count in batches], [2, 4, 5])
        self.assertTrue(all(kind == "preview" and asset_type is None for kind, asset_type, *_ in batches))


    def test_the_thumbnail_phase_counts_what_the_batches_made(self) -> None:
        # The batches make the thumbnails as they index; the import's result
        # still says it made them, rather than "skipped, already there".
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            photos = root / "trip"
            photos.mkdir()
            for index in range(3):
                Image.new("RGB", (64, 48), (index * 60, 90, 160)).save(photos / f"IMG_{index:04d}.jpg", "JPEG")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            job = create_job(connection, "import", payload={})
            run_import_job(connection, catalog.root, job["job_id"], [], [photos], mode="processed_only", generate_hd=False)
            result = get_job(connection, job["job_id"])["result"]
            connection.close()
        phases = {phase["key"]: phase["result"] for phase in result["phase_results"]}
        self.assertEqual(
            {key: phases["generate_previews"][key] for key in ("generated", "skipped", "failed")},
            {"generated": 3, "skipped": 0, "failed": 0},
        )

    def _import_trip_both_ways(self, folder_first: bool):
        # A trip folder imported as photos and added as a RAW source, in
        # either order: each RAW is one asset, still a matching candidate.
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        trip = root / "Trip"
        trip.mkdir()
        fixture = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"
        shutil.copyfile(fixture, trip / "luna-morning.dng")
        catalog = ensure_catalog(root / "demo.afcatalog")
        connection = connect(catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, catalog.root)
        self.addCleanup(connection.close)
        runs = [([], [trip], "processed_only"), ([trip], [trip], "combined")]
        statuses = []
        with patch("media_workspace.job_runner.PreviewService.generate_batch", return_value={"generated": 0, "skipped": 0, "failed": 0}):
            for raw_dirs, image_dirs, mode in (runs if folder_first else runs[::-1]):
                job = create_job(connection, "import", payload={})
                run_import_job(connection, catalog.root, job["job_id"], raw_dirs, image_dirs, mode=mode, generate_hd=False)
                statuses.append(get_job(connection, job["job_id"])["status"])
        raws = connection.execute("SELECT asset_id FROM assets WHERE asset_type = 'raw'").fetchall()
        sources = connection.execute("SELECT raw_asset_id FROM raw_metadata_cache").fetchall()
        return statuses, [r[0] for r in raws], [r[0] for r in sources]

    def test_adding_a_raw_source_after_importing_the_folder(self) -> None:
        # Used to fail the whole import: UNIQUE constraint failed: raw_metadata_cache.path.
        statuses, raws, sources = self._import_trip_both_ways(folder_first=True)
        self.assertEqual(statuses, ["succeeded", "succeeded"])
        self.assertEqual(len(raws), 1)
        self.assertEqual(sources, raws)

    def test_importing_the_folder_after_adding_it_as_a_raw_source(self) -> None:
        # A later folder import must not quietly unregister the source.
        statuses, raws, sources = self._import_trip_both_ways(folder_first=False)
        self.assertEqual(statuses, ["succeeded", "succeeded"])
        self.assertEqual(len(raws), 1)
        self.assertEqual(sources, raws)

    def test_rescanning_a_raw_source_after_the_file_changed(self) -> None:
        # Lightroom writing XMP into a DNG changes its bytes, so its
        # fingerprint: the rescan keeps the same asset rather than adding a
        # second one for the path (which failed the import).
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        trip = root / "Trip"
        trip.mkdir()
        fixture = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"
        raw = trip / "luna-morning.dng"
        shutil.copyfile(fixture, raw)
        catalog = ensure_catalog(root / "demo.afcatalog")
        connection = connect(catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, catalog.root)
        self.addCleanup(connection.close)
        statuses = []
        with patch("media_workspace.job_runner.PreviewService.generate_batch", return_value={"generated": 0, "skipped": 0, "failed": 0}):
            for _ in range(2):
                job = create_job(connection, "import", payload={})
                run_import_job(connection, catalog.root, job["job_id"], [trip], [trip], mode="combined", generate_hd=False)
                statuses.append(get_job(connection, job["job_id"])["status"])
                with raw.open("r+b") as handle:  # rewrite the head in place, as an XMP update does
                    handle.seek(64)
                    handle.write(b"edited")
        self.assertEqual(statuses, ["succeeded", "succeeded"])
        self.assertEqual(connection.execute("SELECT count(*) FROM assets WHERE asset_type = 'raw'").fetchone()[0], 1)

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
            connection.close()


if __name__ == "__main__":
    unittest.main()
