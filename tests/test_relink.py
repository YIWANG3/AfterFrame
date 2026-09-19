from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.db.maintenance import relink_asset
from media_workspace.reverse_lookup import resolve_image_batch

# A JPEG the metadata reader accepts: SOI, a minimal SOF0 (1x1), EOI.
TINY_JPEG = bytes.fromhex(
    "ffd8" "ffc0" "000b" "08" "0001" "0001" "01" "01" "1100" "ffd9"
)


def _catalog(root: Path):
    catalog = ensure_catalog(root / "demo.afcatalog")
    connection = connect(catalog.db_path)
    init_db(connection)
    set_catalog_path(connection, catalog.root)
    return connection


def _asset_id_for(connection, path: Path) -> str:
    row = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?", (str(path.resolve()),)
    ).fetchone()
    assert row is not None, f"no asset for {path}"
    return str(row["asset_id"])


class RelinkAssetTests(unittest.TestCase):
    def test_relink_moves_every_path_column_and_keeps_the_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            original = root / "a.jpg"
            original.write_bytes(TINY_JPEG)
            connection = _catalog(root)
            resolve_image_batch(connection, [original], refresh=True)
            asset_id = _asset_id_for(connection, original)

            moved = root / "elsewhere" / "a.jpg"
            moved.parent.mkdir()
            original.rename(moved)
            result = relink_asset(connection, asset_id, moved)

            self.assertEqual(result["status"], "relinked")
            self.assertEqual(result["asset_id"], asset_id)
            self.assertEqual(_asset_id_for(connection, moved), asset_id)
            canonical = connection.execute(
                "SELECT canonical_path, exists_on_disk FROM assets WHERE asset_id = ?", (asset_id,)
            ).fetchone()
            self.assertEqual(canonical["canonical_path"], str(moved.resolve()))
            self.assertEqual(canonical["exists_on_disk"], 1)

    def test_relink_onto_a_path_another_asset_owns_is_refused_not_a_traceback(self) -> None:
        # A background refresh can register a file anew after its asset was
        # relinked away (the 12-missing-original race on the CI VM); the user
        # can also just pick a file that has its own entry. Either way: a
        # status the UI can explain, and nothing written.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first = root / "first.jpg"
            second = root / "second.jpg"
            first.write_bytes(TINY_JPEG)
            second.write_bytes(TINY_JPEG)
            connection = _catalog(root)
            resolve_image_batch(connection, [first, second], refresh=True)
            first_id = _asset_id_for(connection, first)
            second_id = _asset_id_for(connection, second)

            result = relink_asset(connection, first_id, second)

            self.assertEqual(result["status"], "path_in_use")
            self.assertEqual(result["owner_asset_id"], second_id)
            self.assertEqual(result["candidate_path"], str(second.resolve()))
            # Untouched: both assets still point where they did.
            self.assertEqual(_asset_id_for(connection, first), first_id)
            self.assertEqual(_asset_id_for(connection, second), second_id)


if __name__ == "__main__":
    unittest.main()
