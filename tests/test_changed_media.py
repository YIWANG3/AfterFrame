"""A watched folder reports files whose only change is their extended
attributes: AirDrop records whom it sent a photo to on the photo itself.
changed-media says which of the reported files an import would change."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, get_registry, init_db, set_catalog_path
from media_workspace.reverse_lookup import resolve_image_batch


def mark_sent_by_airdrop(path: Path) -> None:
    if sys.platform == "darwin":
        subprocess.run(
            ["xattr", "-w", "com.apple.metadata:kMDItemUserSharedSentTransport", "com.apple.AirDrop", str(path)],
            check=True,
        )


class ChangedMediaTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name).resolve()
        self.catalog = ensure_catalog(root / "demo.afcatalog")
        self.folder = root / "Exports"
        self.folder.mkdir()
        self.elsewhere = root / "Elsewhere"
        self.elsewhere.mkdir()

    def export(self, name: str, content: bytes = b"\xff\xd8an-export\xff\xd9") -> Path:
        path = self.folder / name
        path.write_bytes(content)
        return path

    def run_cli(self, *argv: str) -> object:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def import_files(self, *paths: Path) -> list[str]:
        connection = connect(self.catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, self.catalog.root)
        resolve_image_batch(connection, list(paths), refresh=True)
        asset_ids = [get_registry(connection, path)["image_asset_id"] for path in paths]
        connection.close()
        return asset_ids

    def changed(self, *paths: Path) -> dict:
        argv = [arg for path in paths for arg in ("--path", str(path))]
        return self.run_cli("changed-media", *argv)

    def test_a_photo_sent_by_airdrop_has_nothing_to_import(self) -> None:
        photo = self.export("sent.jpg")
        [asset_id] = self.import_files(photo)
        mark_sent_by_airdrop(photo)

        self.assertEqual(self.changed(photo), {"changed": [], "unchanged": 1, "present_asset_ids": [asset_id]})

    def test_new_rewritten_and_retouched_files_are_kept(self) -> None:
        rewritten = self.export("rewritten.jpg")
        retouched = self.export("retouched.jpg")
        self.import_files(rewritten, retouched)
        new = self.export("new.jpg")
        rewritten.write_bytes(b"\xff\xd8a-longer-second-export\xff\xd9")
        stat = retouched.stat()
        os.utime(retouched, (stat.st_atime, stat.st_mtime + 60))  # same size, later save
        gone = self.folder / "gone.jpg"

        result = self.changed(new, rewritten, retouched, gone)

        self.assertEqual(result["changed"], [str(new), str(rewritten), str(retouched), str(gone)])
        self.assertEqual(result["unchanged"], 0)

    def test_a_photo_back_from_elsewhere_is_kept_until_reimported(self) -> None:
        photo = self.export("moved.jpg")
        self.import_files(photo)
        shutil.move(photo, self.elsewhere / photo.name)
        self.run_cli("verify-assets")
        shutil.move(self.elsewhere / photo.name, photo)  # size and mtime as imported

        result = self.changed(photo)
        self.assertEqual(result["changed"], [str(photo)])
        self.assertEqual(result["present_asset_ids"], [])

    def test_a_photo_put_back_before_any_verify_is_dropped_by_its_asset(self) -> None:
        # Browsing stats files without recording what it finds, so a photo
        # moved out and back unchanged was never gone as far as the catalog
        # knows. Nothing to import; its asset id lets the app re-check a card
        # that was browsed while it was away and shows it missing.
        photo = self.export("put-back.jpg")
        [asset_id] = self.import_files(photo)
        shutil.move(photo, self.elsewhere / photo.name)
        shutil.move(self.elsewhere / photo.name, photo)

        self.assertEqual(self.changed(photo), {"changed": [], "unchanged": 1, "present_asset_ids": [asset_id]})

    def test_a_removed_photo_stays_out_until_rewritten(self) -> None:
        photo = self.export("removed.jpg")
        [asset_id] = self.import_files(photo)
        self.run_cli("delete-image-assets", "--asset-id", asset_id)
        mark_sent_by_airdrop(photo)

        self.assertEqual(self.changed(photo), {"changed": [], "unchanged": 1, "present_asset_ids": []})

        photo.write_bytes(b"\xff\xd8a-new-export-over-it\xff\xd9")
        self.assertEqual(self.changed(photo)["changed"], [str(photo)])


if __name__ == "__main__":
    unittest.main()
