"""The catalog's write lock is held for writes, not for the work around them.

Every sidecar command opens the catalog through init_db, and imports write
previews from another process. A full init_db takes the write lock, and an
import held it while it rendered a batch of 50 previews: every other command
(the sidebar's summary, browse, job polls) waited out busy_timeout and failed
"database is locked", so the sidebar read 0 photos and the gallery stopped
loading during imports (Windows dev box, 2026-10-04).
"""
from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, upsert_image_asset, upsert_registry
from media_workspace.db.core import INIT_STAMP
from media_workspace.models import ImageCandidate, MatchDecision
from media_workspace.preview_service import _MAX_WORKERS, PreviewService


def write_lock_free(db_path: Path, wait: float) -> bool:
    """Whether another connection gets the write lock within `wait` seconds."""
    probe = sqlite3.connect(db_path, timeout=wait)
    try:
        probe.execute("BEGIN IMMEDIATE")
        probe.rollback()
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        probe.close()


class CatalogTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.db = self.catalog.root / "catalog.sqlite3"
        self.connection = connect(self.db)
        self.addCleanup(self.connection.close)
        init_db(self.connection)


class InitDbTest(CatalogTestCase):
    def test_an_up_to_date_catalog_opens_while_another_process_writes(self) -> None:
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute("BEGIN IMMEDIATE")  # an import, mid-batch
        reader = connect(self.db)
        self.addCleanup(reader.close)
        reader.execute("PRAGMA busy_timeout=200")  # fail in 0.2 s, not 5
        init_db(reader)
        self.assertEqual(reader.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)
        writer.rollback()

    def test_a_catalog_without_the_stamp_gets_one_full_init(self) -> None:
        # Every catalog written before the stamp existed reads 0.
        self.connection.execute("PRAGMA user_version = 0")
        init_db(self.connection)
        self.assertEqual(self.connection.execute("PRAGMA user_version").fetchone()[0], INIT_STAMP)

    def test_a_catalog_whose_place_data_is_stale_is_not_taken_as_current(self) -> None:
        self.connection.execute("UPDATE catalog_info SET place_data_version = 'old' WHERE catalog_id = 1")
        self.connection.commit()
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute("BEGIN IMMEDIATE")
        reader = connect(self.db)
        self.addCleanup(reader.close)
        reader.execute("PRAGMA busy_timeout=200")
        # Refreshing the place fields is a write, so this one does wait.
        with self.assertRaises(sqlite3.OperationalError):
            init_db(reader)
        writer.rollback()


class PreviewBatchTest(CatalogTestCase):
    def setUp(self) -> None:
        super().setUp()
        # More photos than render workers, so some renders start after the
        # first results were written.
        self.count = _MAX_WORKERS * 2 + 1
        for i in range(self.count):
            stem = f"photo-{i:02}"
            path = self.root / f"{stem}.jpg"
            Image.new("RGB", (120, 80), (40 * (i % 6), 90, 160)).save(path)
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=120, height=80,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def test_previews_render_with_the_write_lock_free(self) -> None:
        render = PreviewService.generate_for_row
        free: list[bool] = []

        def slow_render(service, row, **kwargs):
            time.sleep(0.15)
            free.append(write_lock_free(self.db, wait=1.0))
            return render(service, row, **kwargs)

        with patch.object(PreviewService, "generate_for_row", slow_render):
            result = PreviewService(self.catalog).generate_batch(self.connection, kind="preview", asset_type="image")

        self.assertEqual(result["generated"], self.count)
        self.assertEqual(free, [True] * self.count)
        colors = self.connection.execute("SELECT COUNT(DISTINCT asset_id) FROM asset_colors").fetchone()[0]
        self.assertEqual(colors, self.count)  # colours still land with their preview


if __name__ == "__main__":
    unittest.main()
