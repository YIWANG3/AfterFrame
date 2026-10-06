"""A rating cleared in the app stays cleared. Import seeds a photo's rating
from the stars its file carries (XMP/EXIF Rating) only while the catalog has
none for it; a clear is a rating of its own, so importing or refreshing the
photo again must not bring the file's stars back."""
from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, upsert_image_asset
from media_workspace.models import ImageCandidate


class ClearedRatingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.catalog = ensure_catalog(Path(self.directory.name) / "ratings.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)

    def import_photo(self, rating: int | None) -> None:
        path = Path(self.directory.name) / "rated.jpg"
        path.write_bytes(b"jpg")
        upsert_image_asset(self.connection, ImageCandidate(
            asset_id="image_rated", path=path, stem="rated", normalized_stem="rated", stem_key="rated",
            extension=".jpg", fingerprint="fp-rated", file_size=3, modified_time="2026-01-01T00:00:00",
            capture_time=None, rating=rating, camera_make=None, camera_model=None,
            lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
            flash=None, white_balance=None, color_space=None, lens_specification=None,
            gps_latitude=None, gps_longitude=None, width=600, height=400,
        ))

    def rate(self, rating: int) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main([
                "--catalog", str(self.catalog.root), "set-asset-rating", "--asset-id", "image_rated", "--rating", str(rating),
            ]), 0)

    def rating(self) -> int | None:
        return self.connection.execute("SELECT app_rating FROM assets WHERE asset_id = 'image_rated'").fetchone()[0]

    def test_import_seeds_the_files_stars(self) -> None:
        self.import_photo(rating=5)
        self.assertEqual(self.rating(), 5)

    def test_a_cleared_rating_survives_importing_the_photo_again(self) -> None:
        self.import_photo(rating=5)
        self.rate(0)
        self.assertEqual(self.rating(), 0)
        self.import_photo(rating=5)
        self.assertEqual(self.rating(), 0)

    def test_a_changed_rating_survives_importing_the_photo_again(self) -> None:
        self.import_photo(rating=5)
        self.rate(2)
        self.import_photo(rating=5)
        self.assertEqual(self.rating(), 2)


if __name__ == "__main__":
    unittest.main()
