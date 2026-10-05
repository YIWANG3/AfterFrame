"""Nothing slow runs while a process holds the catalog's write lock.

The app is several processes on one SQLite catalog: the resident sidecar
(browse, detail, the job poll, the gallery's repairs) and detached job
runners (an import). Each waits at most its busy timeout for the write lock.
In the 0.5.8 report a mixed import failed with "database is locked" at
"Match with RAW · 48/75" and left 57 of 75 files in: a gallery repair
(refresh-assets) held one write transaction across the metadata reads and
renders of 40 big RAWs and TIFFs on a hard drive. These tests take the write
lock from a second connection, without waiting, at the moment the slow work
runs — the way the import runner would have needed it.
"""
from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from media_workspace import preview_service, reverse_lookup
from media_workspace.catalog import ensure_catalog
from media_workspace.cli import JOB_RUNNER_COMMAND
from media_workspace.db import connect, create_job, init_db, list_active_jobs, set_catalog_path
from media_workspace.preview_service import PreviewService
from media_workspace.reverse_lookup import resolve_image_batch


def _write_jpegs(folder: Path, count: int) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(count):
        path = folder / f"shot_{index}.jpg"
        Image.new("RGB", (320, 240), (index * 40 % 256, 90, 160)).save(path, quality=85)
        paths.append(path)
    return paths


class CatalogLockingTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name)
        self.catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, self.catalog.root)
        self.photos = _write_jpegs(self.root / "photos", 4)
        # Another process, as the import runner is: it takes the write lock
        # without waiting, so a lock held by the code under test shows.
        # Renders run on a worker thread, so it is used from there too.
        self.other = sqlite3.connect(self.catalog.db_path, timeout=0, isolation_level=None, check_same_thread=False)
        self.addCleanup(self.other.close)

    def _can_write(self) -> bool:
        # A held lock that is about to be released (the code under test is
        # between a write and its commit) gets a moment; a transaction held
        # across a slow render does not end in it.
        deadline = time.monotonic() + 0.2
        while True:
            try:
                self.other.execute("BEGIN IMMEDIATE")
                self.other.execute("ROLLBACK")
                return True
            except sqlite3.OperationalError:
                if time.monotonic() > deadline:
                    return False
                time.sleep(0.01)

    def test_indexing_reads_each_file_outside_a_write_transaction(self) -> None:
        seen: list[bool] = []
        extract = reverse_lookup.extract_image_candidate

        def slow_extract(*args, **kwargs):
            seen.append(self._can_write())
            time.sleep(0.25)  # ExifTool on a 200 MB RAW on a drive
            return extract(*args, **kwargs)

        with patch.object(reverse_lookup, "extract_image_candidate", slow_extract):
            # What refresh-assets runs: no progress callback that commits.
            resolve_image_batch(self.connection, [self.root / "photos"], refresh=True, persist_roots=False)
        self.assertGreaterEqual(len(seen), len(self.photos))
        self.assertTrue(all(seen), f"write lock held during a metadata read: {seen}")

    def test_no_preview_renders_inside_a_write_transaction(self) -> None:
        resolve_image_batch(self.connection, [self.root / "photos"], refresh=True, persist_roots=False)
        seen: list[bool] = []
        render = PreviewService.generate_for_row

        def slow_render(service, row, **kwargs):
            seen.append(self._can_write())
            time.sleep(0.25)  # a big RAW or TIFF
            return render(service, row, **kwargs)

        with patch.object(preview_service, "_MAX_WORKERS", 1), patch.object(PreviewService, "generate_for_row", slow_render):
            result = PreviewService(self.catalog).generate_batch(self.connection, kind="preview", force=True)
        self.assertEqual(result["generated"], len(self.photos))
        self.assertTrue(all(seen), f"write lock held during a render: {seen}")

    def test_the_job_poll_reads_without_the_write_lock(self) -> None:
        create_job(self.connection, "import", {"image_dirs": []})
        # Another process is writing; the poll must still answer at once.
        self.other.execute("BEGIN IMMEDIATE")
        try:
            reader = connect(self.catalog.db_path)
            reader.execute("PRAGMA busy_timeout=0")
            try:
                jobs = list_active_jobs(reader)
            finally:
                reader.close()
        finally:
            self.other.execute("ROLLBACK")
        self.assertEqual([job["job_type"] for job in jobs], ["import"])

    def test_background_jobs_wait_longer_than_the_apps_quick_commands(self) -> None:
        for command in ("run-import-job", "run-preview-job", "run-people-index-job", "run-ai-repaint-job"):
            self.assertTrue(JOB_RUNNER_COMMAND.match(command), command)
        for command in ("browse-images", "list-active-jobs", "refresh-assets", "serve"):
            self.assertFalse(JOB_RUNNER_COMMAND.match(command), command)


if __name__ == "__main__":
    unittest.main()
