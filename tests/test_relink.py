from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.db.browse import count_image_assets, list_image_assets
from media_workspace.db.maintenance import relink_asset, relink_assets_from_folder, verify_assets
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
            connection.close()

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
            connection.close()


class RelinkFromFolderTests(unittest.TestCase):
    """The Missing view's batch relink: find each missing original by name
    under a folder, link it only when its fingerprint matches."""

    def _missing(self, root: Path, names: list[str]):
        library = root / "library"
        library.mkdir()
        paths = []
        for index, name in enumerate(names):
            path = library / name
            # Different bytes per file, so each has its own fingerprint.
            path.write_bytes(TINY_JPEG + bytes([index]))
            paths.append(path)
        connection = _catalog(root)
        resolve_image_batch(connection, paths, refresh=True)
        ids = {path.name: _asset_id_for(connection, path) for path in paths}
        return connection, paths, ids

    def test_relinks_by_name_and_fingerprint_and_reports_the_rest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, paths, ids = self._missing(root, ["a.jpg", "b.jpg", "c.jpg"])
            connection.execute("UPDATE assets SET app_rating = 4 WHERE asset_id = ?", (ids["a.jpg"],))
            connection.commit()
            moved = root / "backup" / "2026" / "trip"
            moved.mkdir(parents=True)
            # a.jpg moved (renamed to upper case on the way): same bytes.
            paths[0].rename(moved / "A.JPG")
            # b.jpg is gone; a different file with its name sits in the folder.
            paths[1].unlink()
            (moved / "b.jpg").write_bytes(b"something else")
            # c.jpg is gone and nowhere to be found.
            paths[2].unlink()
            verify_assets(connection)
            self.assertEqual(count_image_assets(connection, "missing"), 3)

            result = relink_assets_from_folder(connection, root / "backup", list(ids.values()))

            self.assertEqual(
                {key: result[key] for key in ("relinked", "not_found", "mismatch", "in_use", "present")},
                {"relinked": 1, "not_found": 1, "mismatch": 1, "in_use": 0, "present": 0},
            )
            by_id = {item["asset_id"]: item for item in result["items"]}
            self.assertEqual(by_id[ids["a.jpg"]]["status"], "relinked")
            self.assertEqual(by_id[ids["a.jpg"]]["new_path"], str((moved / "A.JPG").resolve()))
            self.assertEqual(by_id[ids["b.jpg"]]["status"], "mismatch")
            self.assertEqual(by_id[ids["c.jpg"]]["status"], "not_found")
            # Same record, new path, rating kept; out of the Missing view.
            row = connection.execute(
                "SELECT canonical_path, exists_on_disk, app_rating FROM assets WHERE asset_id = ?", (ids["a.jpg"],)
            ).fetchone()
            self.assertEqual(row["canonical_path"], str((moved / "A.JPG").resolve()))
            self.assertEqual(row["exists_on_disk"], 1)
            self.assertEqual(row["app_rating"], 4)
            self.assertEqual(_asset_id_for(connection, moved / "A.JPG"), ids["a.jpg"])
            missing = [r["asset_id"] for r in list_image_assets(connection, "missing")]
            self.assertEqual(sorted(missing), sorted([ids["b.jpg"], ids["c.jpg"]]))
            # The same-named stranger was not linked.
            self.assertEqual(
                connection.execute("SELECT canonical_path FROM assets WHERE asset_id = ?", (ids["b.jpg"],)).fetchone()[0],
                str(paths[1].resolve()),
            )
            connection.close()

    def test_without_ids_looks_for_every_missing_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, paths, ids = self._missing(root, ["a.jpg", "b.jpg"])
            target = root / "moved"
            target.mkdir()
            paths[0].rename(target / "a.jpg")
            verify_assets(connection)

            result = relink_assets_from_folder(connection, target)

            self.assertEqual(result["relinked"], 1)
            self.assertEqual([item["asset_id"] for item in result["items"]], [ids["a.jpg"]])
            self.assertEqual(count_image_assets(connection, "missing"), 0)
            connection.close()

    def test_a_file_back_at_its_old_path_counts_as_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, paths, ids = self._missing(root, ["a.jpg"])
            connection.execute("UPDATE assets SET exists_on_disk = 0")
            connection.commit()

            result = relink_assets_from_folder(connection, root, [ids["a.jpg"]])

            self.assertEqual(result["present"], 1)
            self.assertEqual(result["relinked"], 0)
            self.assertEqual(count_image_assets(connection, "missing"), 0)
            connection.close()

    def test_a_file_another_record_holds_is_in_use_not_relinked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, paths, ids = self._missing(root, ["a.jpg"])
            # Moved, then imported again at the new place: a second record.
            moved = root / "moved"
            moved.mkdir()
            paths[0].rename(moved / "a.jpg")
            resolve_image_batch(connection, [moved / "a.jpg"], refresh=True)
            verify_assets(connection)

            result = relink_assets_from_folder(connection, moved, [ids["a.jpg"]])

            self.assertEqual(result["in_use"], 1)
            self.assertEqual(
                connection.execute("SELECT exists_on_disk FROM assets WHERE asset_id = ?", (ids["a.jpg"],)).fetchone()[0],
                0,
            )
            connection.close()

    def test_refuses_a_folder_that_is_not_there(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            connection = _catalog(Path(temp_dir))
            with self.assertRaises(ValueError):
                relink_assets_from_folder(connection, Path(temp_dir) / "nope", [])
            connection.close()


if __name__ == "__main__":
    unittest.main()
