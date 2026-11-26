"""Folders on disk as a read-only mirror (db/folders.py,
docs/collections-and-folders-design.md §5): the tree derived from the photos'
paths, browsing one as a place, locating one that moved, and its Sync's
scoped verify."""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, set_catalog_path
from media_workspace.db.browse import count_image_assets
from media_workspace.db.folders import _volume_of, folder_clause, list_folders, locate_folder
from media_workspace.db.maintenance import verify_assets
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.reverse_lookup import resolve_image_batch

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"
DNG = FIXTURES / "raw" / "luna-morning.dng"
JPG = FIXTURES / "raw" / "luna-morning.jpg"
TINY_JPEG = bytes.fromhex("ffd8" "ffc0" "000b" "08" "0001" "0001" "01" "01" "1100" "ffd9")


class FoldersTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name).resolve()
        self.catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, self.catalog.root)
        self.photos = self.root / "Photos"

    def jpeg(self, relative: str, salt: int = 0) -> Path:
        path = self.photos / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(TINY_JPEG + bytes([salt]))
        return path

    def tree(self) -> dict[str, dict]:
        return {row["path"]: row for row in list_folders(self.connection)["folders"]}

    def in_folder(self, path: Path, descendants: bool = True) -> list[str]:
        base = {"status": "all", "filters": {"in_folder": str(path), "in_folder_descendants": descendants}}
        return sorted(Path(row["image_path"]).name for row in list_image_assets(self.connection, "all", base=base))

    # ── the tree ──
    def test_the_tree_folds_the_empty_chain_above_the_photos(self) -> None:
        self.jpeg("2024/Tokyo/a.jpg", 1)
        self.jpeg("2024/Tokyo/b.jpg", 2)
        self.jpeg("2024/Kyoto/c.jpg", 3)
        self.jpeg("2024/d.jpg", 4)
        resolve_image_batch(self.connection, [self.photos])

        rows = list_folders(self.connection)["folders"]
        tree = {row["path"]: row for row in rows}
        top = str(self.photos / "2024")
        # Nothing above 2024 (the temp dir, /private, …) is listed.
        self.assertEqual([row["path"] for row in rows if row["parent"] is None], [top])
        self.assertEqual((tree[top]["direct"], tree[top]["total"]), (1, 4))
        self.assertEqual(tree[str(self.photos / "2024" / "Tokyo")]["parent"], top)
        self.assertEqual(tree[str(self.photos / "2024" / "Tokyo")]["total"], 2)
        self.assertEqual(tree[str(self.photos / "2024" / "Kyoto")]["name"], "Kyoto")
        self.assertTrue(tree[top]["exists"])
        # Depth-first, children by name: Kyoto before Tokyo, under 2024.
        self.assertEqual([row["name"] for row in rows], ["2024", "Kyoto", "Tokyo"])

    def test_two_branches_without_a_photo_between_are_two_tops(self) -> None:
        self.jpeg("Trips/a.jpg", 1)
        self.jpeg("Work/b.jpg", 2)
        resolve_image_batch(self.connection, [self.photos])

        tops = [row["path"] for row in list_folders(self.connection)["folders"] if row["parent"] is None]
        # The fold stops at Photos, the first directory with two children.
        self.assertEqual(tops, [str(self.photos)])

    def test_the_catalogs_own_versions_are_not_a_folder(self) -> None:
        self.jpeg("Shoot/a.jpg", 1)
        crop = self.catalog.derived_dir / "a_crop1x1_0001.jpg"
        crop.write_bytes(TINY_JPEG + bytes([2]))
        resolve_image_batch(self.connection, [self.photos, crop])

        everything = [row["path"] for row in list_folders(self.connection)["folders"]]
        self.assertIn(str(self.catalog.derived_dir), everything)
        rows = list_folders(self.connection, exclude_under=self.catalog.root)["folders"]
        # The crop is the app's file, not a folder of the user's: without it
        # the fold goes all the way down to the shoot.
        self.assertEqual([row["path"] for row in rows], [str(self.photos / "Shoot")])
        self.assertEqual(rows[0]["total"], 1)

    def test_a_merged_pair_counts_once(self) -> None:
        shoot = self.photos / "Shoot"
        shoot.mkdir(parents=True)
        shutil.copyfile(DNG, shoot / "DSC_0001.dng")
        shutil.copyfile(JPG, shoot / "DSC_0001.JPG")
        resolve_image_batch(self.connection, [shoot])

        self.assertEqual(self.tree()[str(shoot)]["total"], 1)

    def test_volumes(self) -> None:
        self.assertEqual(_volume_of("/Volumes/T7/Shoots/a.jpg"), ("/Volumes/T7", "T7"))
        self.assertEqual(_volume_of("/Users/me/Pictures/a.jpg"), ("/", ""))
        self.assertEqual(_volume_of("D:\\Shoots\\a.jpg"), ("D:\\", "D:"))

    # ── a folder as a place ──
    def test_a_folder_shows_its_photos_with_or_without_the_ones_below(self) -> None:
        self.jpeg("2024/d.jpg", 1)
        self.jpeg("2024/Tokyo/a.jpg", 2)
        self.jpeg("2024 copy/x.jpg", 3)  # a sibling whose name starts the same
        resolve_image_batch(self.connection, [self.photos])

        self.assertEqual(self.in_folder(self.photos / "2024"), ["a.jpg", "d.jpg"])
        self.assertEqual(self.in_folder(self.photos / "2024", descendants=False), ["d.jpg"])
        base = {"status": "all", "filters": {"in_folder": str(self.photos / "2024")}}
        self.assertEqual(count_image_assets(self.connection, "all", base=base), 2)

    def test_a_windows_folder_clause_uses_backslashes(self) -> None:
        clause, params = folder_clause("D:\\Shoots", descendants=False)
        self.assertEqual(params[0], "D:\\\\Shoots\\\\%")
        self.assertEqual(params[1], "\\")
        self.assertIn("instr(substr(assets.canonical_path, 11), ?) = 0", clause)

    def test_a_smart_collection_cannot_keep_a_folder(self) -> None:
        with self.assertRaises(ValueError):
            normalize_rules({"status": "all", "filters": {"in_folder": "/x"}})

    # ── locate ──
    def test_locating_a_moved_folder_relinks_what_is_there(self) -> None:
        a = self.jpeg("Shoot/a.jpg", 1)
        self.jpeg("Shoot/Day 2/b.jpg", 2)
        self.jpeg("Shoot/c.jpg", 3)
        resolve_image_batch(self.connection, [self.photos])
        ids = {
            Path(row["image_path"]).relative_to(self.photos).as_posix(): row["asset_id"]
            for row in list_image_assets(self.connection, "all")
        }
        old = self.photos / "Shoot"
        new = self.root / "Archive" / "Shoot"
        new.parent.mkdir()
        old.rename(new)
        (new / "c.jpg").unlink()
        (new / "c.jpg").write_bytes(b"something else")
        verify_assets(self.connection)
        self.assertFalse(self.tree()[str(old)]["exists"])

        result = locate_folder(self.connection, old, new)

        self.assertEqual(
            {key: result[key] for key in ("relinked", "not_found", "mismatch", "in_use", "present")},
            {"relinked": 2, "not_found": 0, "mismatch": 1, "in_use": 0, "present": 0},
        )
        self.assertEqual(self.in_folder(new), ["a.jpg", "b.jpg"])
        self.assertEqual(
            self.connection.execute("SELECT canonical_path FROM assets WHERE asset_id = ?", (ids["Shoot/Day 2/b.jpg"],)).fetchone()[0],
            str(new / "Day 2" / "b.jpg"),
        )
        self.assertTrue(str(a) not in [row["image_path"] for row in list_image_assets(self.connection, "all")])

    def test_locating_a_moved_pair_counts_it_once(self) -> None:
        shoot = self.photos / "Shoot"
        shoot.mkdir(parents=True)
        shutil.copyfile(DNG, shoot / "DSC_0001.dng")
        shutil.copyfile(JPG, shoot / "DSC_0001.JPG")
        resolve_image_batch(self.connection, [shoot])
        new = self.root / "Moved"
        shoot.rename(new)

        result = locate_folder(self.connection, shoot, new)

        self.assertEqual(result["relinked"], 1)
        self.assertEqual(len(result["items"]), 2)
        paths = [Path(row[0]) for row in self.connection.execute("SELECT canonical_path FROM assets")]
        self.assertEqual(sum(1 for path in paths if path.parent == new), 2)

    # ── Sync's verify ──
    def test_verify_under_a_folder_checks_only_that_folder(self) -> None:
        inside = self.jpeg("In/a.jpg", 1)
        outside = self.jpeg("Out/b.jpg", 2)
        resolve_image_batch(self.connection, [self.photos])
        inside.unlink()
        outside.unlink()

        result = verify_assets(self.connection, under=str(self.photos / "In"))

        self.assertEqual((result["checked"], result["newly_missing"]), (1, 1))
        self.assertEqual(count_image_assets(self.connection, "missing"), 1)


if __name__ == "__main__":
    unittest.main()
