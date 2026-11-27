"""Importing a folder again reads only what changed: a file the catalog holds
as it is on disk is not read (ExifTool, fingerprint) or matched again, the
rule a watched folder already follows (watched.changed_media)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from media_workspace import cli, reverse_lookup
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.reverse_lookup import resolve_image_batch


def jpeg(path: Path, colour=(120, 90, 60)) -> Path:
    Image.new("RGB", (64, 48), colour).save(path, quality=90)
    return path


class ReimportTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        self.catalog = ensure_catalog(root / "demo.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, self.catalog.root)
        self.folder = root / "Shoot"
        self.folder.mkdir()
        self.photos = [jpeg(self.folder / f"IMG_{index}.jpg", (40 * index, 90, 60)) for index in range(3)]

    def resolve(self, **kwargs):
        """(result, files whose metadata was read)"""
        read: list[str] = []
        real = reverse_lookup.extract_image_candidate

        def spy(path, *args, **kw):
            read.append(Path(path).name)
            return real(path, *args, **kw)

        with mock.patch.object(reverse_lookup, "extract_image_candidate", spy):
            result = resolve_image_batch(self.connection, [self.folder], refresh=True, **kwargs)
        return result, sorted(read)

    def test_importing_again_reads_only_new_and_changed_files(self):
        _, read = self.resolve(skip_unchanged=True)
        self.assertEqual(read, ["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg"])

        jpeg(self.photos[1], (250, 250, 250))  # re-exported over itself
        os.utime(self.photos[1], (1_800_000_000, 1_800_000_000))
        jpeg(self.folder / "IMG_3.jpg")
        result, read = self.resolve(skip_unchanged=True)

        self.assertEqual(read, ["IMG_1.jpg", "IMG_3.jpg"])
        self.assertEqual((result["processed"], result["total"]), (4, 4))
        self.assertEqual((result["already_in_catalog"], result["newly_added"]), (3, 1))
        self.assertEqual(result["changed_paths"], [str(self.photos[1])])
        self.assertEqual(sum(result["status_counts"].values()), 4)

    def test_a_photo_marked_missing_is_read_again_and_comes_back(self):
        self.resolve(skip_unchanged=True)
        self.connection.execute("UPDATE assets SET exists_on_disk = 0 WHERE canonical_path = ?", (str(self.photos[0]),))
        self.connection.commit()
        _, read = self.resolve(skip_unchanged=True)
        self.assertEqual(read, ["IMG_0.jpg"])
        row = self.connection.execute("SELECT exists_on_disk FROM assets WHERE canonical_path = ?", (str(self.photos[0]),)).fetchone()
        self.assertEqual(row[0], 1)

    def test_a_photo_whose_sidecar_appeared_is_read_again(self):
        self.resolve(skip_unchanged=True)
        (self.folder / "IMG_2.xmp").write_text("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>", encoding="utf-8")
        _, read = self.resolve(skip_unchanged=True)
        self.assertIn("IMG_2.jpg", read)
        self.assertNotIn("IMG_0.jpg", read)

    def test_matching_against_raw_sources_again_reads_everything(self):
        self.resolve(skip_unchanged=True)
        _, read = self.resolve()
        self.assertEqual(read, ["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg"])

    def test_each_folder_is_walked_once(self):
        walks: list[list[Path]] = []
        real = reverse_lookup.iter_image_files

        def spy(paths, *args, **kwargs):
            walks.append(list(paths))
            return real(paths, *args, **kwargs)

        with mock.patch.object(reverse_lookup, "iter_image_files", spy):
            result = resolve_image_batch(self.connection, [self.folder], refresh=True, skip_unchanged=True)
        self.assertEqual(walks, [[self.folder]])
        self.assertEqual(result["total"], 3)


class ReimportJobTest(unittest.TestCase):
    """Through the import job: "Import a folder" skips what is as it was, and
    still repairs a thumbnail that went missing."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        self.catalog_root = root / "demo.afcatalog"
        ensure_catalog(self.catalog_root)
        self.folder = root / "Shoot"
        self.folder.mkdir()
        for index in range(3):
            jpeg(self.folder / f"IMG_{index}.jpg", (40 * index, 90, 60))

    def cli(self, *argv: str) -> dict:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIn(cli.main(["--catalog", str(self.catalog_root), *argv]), (0, None))
        return json.loads(out.getvalue())

    def import_folder(self) -> list[str]:
        read: list[str] = []
        real = reverse_lookup.extract_image_candidate

        def spy(path, *args, **kw):
            read.append(Path(path).name)
            return real(path, *args, **kw)

        job = self.cli("create-job", "--job-type", "import", "--payload-json",
                       json.dumps({"image_dirs": [str(self.folder)], "mode": "processed_only"}))
        with mock.patch.object(reverse_lookup, "extract_image_candidate", spy):
            self.cli("run-import-job", "--job-id", job["job_id"], "--mode", "processed_only", "--image-dir", str(self.folder))
        return sorted(read)

    def test_a_second_import_reads_nothing_and_repairs_a_missing_thumbnail(self):
        self.assertEqual(len(self.import_folder()), 3)
        previews = sorted((self.catalog_root / "previews").rglob("*.jpg"))
        self.assertEqual(len(previews), 3)
        previews[0].unlink()

        self.assertEqual(self.import_folder(), [])
        self.assertTrue(previews[0].exists())


if __name__ == "__main__":
    unittest.main()
