"""Portrait / landscape as the photo shows, not as its pixels are stored.

A camera's upright shot is landscape pixels with a "rotate 90°" EXIF tag, and
the catalog's width/height (ExifTool's ImageSize) are the stored ones, so the
orientation filter read such a photo as landscape. The shape is now read off
the thumbnail — pixels turned by its tag, as the browser draws it — when the
thumbnail is made, and by a one-time job for thumbnails made before."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.assets import count_assets_missing_display_shape
from media_workspace.job_runner import run_orientation_job
from media_workspace.models import ImageCandidate, MatchDecision
from media_workspace.preview_service import PreviewService, preview_shape

ORIENTATION_TAG = 0x0112


def photo(path: Path, size: tuple[int, int], orientation: int = 1) -> None:
    image = Image.new("RGB", size, (90, 120, 160))
    if orientation != 1:
        exif = Image.Exif()
        exif[ORIENTATION_TAG] = orientation
        image.save(path, exif=exif.tobytes())
    else:
        image.save(path)


class PreviewShapeTest(unittest.TestCase):
    def test_the_tag_turns_the_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = {
                "plain.jpg": ((600, 400), 1, "landscape"),
                "upright.jpg": ((600, 400), 6, "portrait"),
                "upright-left.jpg": ((600, 400), 8, "portrait"),
                "upside-down.jpg": ((600, 400), 3, "landscape"),
                "tall.jpg": ((400, 600), 1, "portrait"),
                "square.jpg": ((500, 500), 6, "square"),
            }
            for name, (size, orientation, _) in cases.items():
                photo(root / name, size, orientation)
            for name, (_, _, shape) in cases.items():
                self.assertEqual(preview_shape(root / name), shape, name)
            (root / "broken.jpg").write_bytes(b"not an image")
            self.assertEqual(preview_shape(root / "broken.jpg"), "")
            self.assertEqual(preview_shape(root / "gone.jpg"), "")


class OrientationFilterTest(unittest.TestCase):
    # stem: stored size, EXIF orientation
    PHOTOS = {
        "wide": ((600, 400), 1),
        "upright": ((600, 400), 6),   # a camera's portrait shot
        "tall": ((400, 600), 1),
        "square": ((500, 500), 1),
    }

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.catalog = ensure_catalog(root / "shapes.afcatalog")
        self.connection = connect(self.catalog.root / "catalog.sqlite3")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, ((width, height), orientation) in self.PHOTOS.items():
            path = root / f"{stem}.jpg"
            photo(path, (width, height), orientation)
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                # As ExifTool reports them: the stored pixels.
                gps_latitude=None, gps_longitude=None, width=width, height=height,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def shapes(self):
        return dict(self.connection.execute("SELECT stem, display_shape FROM assets").fetchall())

    def render_previews(self):
        return PreviewService(self.catalog).generate_batch(self.connection, kind="preview", asset_type="image")

    def test_before_the_shape_is_known_the_stored_size_decides(self):
        self.assertEqual(self.stems({"orientation": "portrait"}), ["tall"])
        self.assertEqual(self.stems({"orientation": "landscape"}), ["upright", "wide"])

    def test_thumbnails_record_the_shape_and_the_filter_reads_it(self):
        self.render_previews()
        self.assertEqual(self.shapes(), {"wide": "landscape", "upright": "portrait", "tall": "portrait", "square": "square"})
        self.assertEqual(self.stems({"orientation": "portrait"}), ["tall", "upright"])
        self.assertEqual(self.stems({"orientation": "landscape"}), ["wide"])
        self.assertEqual(self.stems({"orientation": "square"}), ["square"])
        self.assertEqual(self.stems({"orientation": ["portrait", "square"]}), ["square", "tall", "upright"])
        self.assertEqual(self.stems({"orientation": "portrait", "exclude": ["orientation"]}), ["square", "wide"])
        # Browse hands the shape to the grid, which lays the photo out by it.
        rows = {row["stem"]: row for row in list_image_assets(self.connection, "all")}
        self.assertEqual(rows["upright"]["display_shape"], "portrait")

    def test_the_job_reads_the_shape_of_thumbnails_made_before_it_was_recorded(self):
        self.render_previews()
        self.connection.execute("UPDATE assets SET display_shape = NULL")
        self.connection.commit()
        self.assertEqual(count_assets_missing_display_shape(self.connection), 4)
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('job-1', 'orientation', 'queued', '{}', '{}')"
        )
        self.connection.commit()

        result = run_orientation_job(self.connection, self.catalog.root, "job-1")

        self.assertEqual(result, {"read": 4, "unreadable": 0, "total": 4})
        self.assertEqual(self.shapes()["upright"], "portrait")
        self.assertEqual(count_assets_missing_display_shape(self.connection), 0)
        self.assertEqual(self.connection.execute("SELECT status FROM jobs WHERE job_id = 'job-1'").fetchone()[0], "succeeded")

    def test_an_unreadable_thumbnail_is_not_retried_and_falls_back_to_the_size(self):
        self.render_previews()
        self.connection.execute("UPDATE assets SET display_shape = NULL WHERE stem = 'upright'")
        relative = self.connection.execute(
            "SELECT relative_path FROM preview_entries WHERE asset_id = 'image_upright' AND kind = 'preview'").fetchone()[0]
        (self.catalog.root / relative).write_bytes(b"broken")
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('job-2', 'orientation', 'queued', '{}', '{}')"
        )
        self.connection.commit()

        self.assertEqual(run_orientation_job(self.connection, self.catalog.root, "job-2")["unreadable"], 1)
        self.assertEqual(self.shapes()["upright"], "")
        self.assertEqual(count_assets_missing_display_shape(self.connection), 0)
        self.assertIn("upright", self.stems({"orientation": "landscape"}))


if __name__ == "__main__":
    unittest.main()
