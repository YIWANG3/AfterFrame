from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path, summary
from media_workspace.reverse_lookup import resolve_image_batch

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"


class BrowseCountTest(unittest.TestCase):
    def test_all_assets_counts_the_raw_files_and_videos_imported_as_photos(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            trip = root / "Trip"
            trip.mkdir()
            Image.new("RGB", (64, 48), (90, 120, 160)).save(trip / "IMG_0001.jpg", "JPEG")
            shutil.copyfile(FIXTURES / "raw" / "luna-morning.dng", trip / "luna-morning.dng")
            shutil.copyfile(FIXTURES / "test-videos" / "Z-sample-video.mp4", trip / "clip.mp4")
            catalog = ensure_catalog(root / "demo.afcatalog")
            connection = connect(catalog.db_path)
            self.addCleanup(connection.close)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            resolve_image_batch(connection, [trip])

            counts = summary(connection)
            # All Assets shows all three; RAW matching cares about the export.
            self.assertEqual(counts["browse_assets"], 3)
            self.assertEqual((counts["image_assets"], counts["raw_assets"]), (1, 1))
            # A missing file stays in All Assets, marked offline.
            (trip / "clip.mp4").unlink()
            connection.execute("UPDATE assets SET exists_on_disk = 0 WHERE asset_type = 'video'")
            self.assertEqual(summary(connection)["browse_assets"], 3)


if __name__ == "__main__":
    unittest.main()
