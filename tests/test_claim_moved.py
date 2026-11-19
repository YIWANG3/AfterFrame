"""An import that meets a moved original relinks its old record instead of
making a second one (db.maintenance.claim_moved_original); the Missing view's
batch relink brings a photo's paired RAW along.
docs/collections-and-folders-design.md §5.5."""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    add_collection_items,
    connect,
    create_collection,
    init_db,
    list_image_assets,
    set_catalog_path,
)
from media_workspace.db.browse import count_image_assets
from media_workspace.db.maintenance import relink_assets_from_folder, verify_assets
from media_workspace.reverse_lookup import resolve_image_batch

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"
DNG = FIXTURES / "raw" / "luna-morning.dng"
JPG = FIXTURES / "raw" / "luna-morning.jpg"


class ClaimMovedTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name)
        self.shoot = self.root / "Shoot"
        self.shoot.mkdir()
        self.catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, self.catalog.root)

    # ── helpers ──
    def place(self, source: Path, name: str, folder: Path | None = None) -> Path:
        folder = folder or self.shoot
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / name
        shutil.copyfile(source, target)
        return target

    def imported(self, *paths: Path) -> dict:
        return resolve_image_batch(self.connection, list(paths))

    def asset(self, asset_id: str):
        return self.connection.execute(
            "SELECT canonical_path, exists_on_disk, app_rating FROM assets WHERE asset_id = ?", (asset_id,)
        ).fetchone()

    def id_at(self, path: Path) -> str:
        row = self.connection.execute(
            "SELECT asset_id FROM asset_files WHERE path = ?", (str(path.resolve()),)
        ).fetchone()
        self.assertIsNotNone(row, f"no record at {path}")
        return str(row[0])

    def asset_count(self) -> int:
        return self.connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0]

    def move_shoot(self) -> Path:
        """The shoot's folder moved deeper, the way a reorganised archive is."""
        target = self.root / "Archive" / "2026" / "Shoot"
        target.parent.mkdir(parents=True)
        self.shoot.rename(target)
        return target

    # ── import ──
    def test_a_moved_photo_imported_again_keeps_its_record(self) -> None:
        photo = self.place(JPG, "a.jpg")
        self.imported(self.shoot)
        asset_id = self.id_at(photo)
        self.connection.execute("UPDATE assets SET app_rating = 4 WHERE asset_id = ?", (asset_id,))
        collection_id = create_collection(self.connection, "Trip")["collection_id"]
        add_collection_items(self.connection, collection_id, [asset_id])
        self.connection.commit()

        moved = self.move_shoot()
        result = self.imported(moved)

        self.assertEqual(result["claimed_moved"], 1)
        self.assertEqual(result["newly_added"], 0)
        self.assertEqual(result["already_in_catalog"], 0)
        self.assertEqual(self.asset_count(), 1)
        self.assertEqual(self.id_at(moved / "a.jpg"), asset_id)
        row = self.asset(asset_id)
        self.assertEqual(row["canonical_path"], str((moved / "a.jpg").resolve()))
        self.assertEqual(row["exists_on_disk"], 1)
        self.assertEqual(row["app_rating"], 4)
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM collection_items WHERE collection_id = ? AND asset_id = ?",
                (collection_id, asset_id),
            ).fetchone()[0],
            1,
        )
        # The gallery reads the registry's path.
        self.assertEqual([r["image_path"] for r in list_image_assets(self.connection, status="all")],
                         [str((moved / "a.jpg").resolve())])
        verify_assets(self.connection)
        self.assertEqual(count_image_assets(self.connection, "missing"), 0)

    def test_a_copy_is_a_new_photo(self) -> None:
        photo = self.place(JPG, "a.jpg")
        self.imported(self.shoot)
        copy = self.place(JPG, "a.jpg", self.root / "Backup")

        result = self.imported(copy.parent)

        self.assertEqual(result["claimed_moved"], 0)
        self.assertEqual(result["newly_added"], 1)
        self.assertNotEqual(self.id_at(copy), self.id_at(photo))

    def test_a_moved_and_renamed_photo_is_claimed(self) -> None:
        photo = self.place(JPG, "a.jpg")
        self.imported(self.shoot)
        asset_id = self.id_at(photo)
        target = self.root / "Picks" / "best.jpg"
        target.parent.mkdir()
        photo.rename(target)

        result = self.imported(target.parent)

        self.assertEqual(result["claimed_moved"], 1)
        self.assertEqual(self.id_at(target), asset_id)

    def test_of_two_gone_records_with_the_same_name_neither_is_claimed(self) -> None:
        first = self.place(JPG, "a.jpg", self.root / "one")
        second = self.place(JPG, "a.jpg", self.root / "two")
        self.imported(first.parent, second.parent)
        first.unlink()
        second.unlink()
        arrived = self.place(JPG, "a.jpg", self.root / "three")

        result = self.imported(arrived.parent)

        self.assertEqual(result["claimed_moved"], 0)
        self.assertEqual(result["newly_added"], 1)
        self.assertEqual(self.asset_count(), 3)

    def test_of_two_gone_records_the_one_with_the_name_is_claimed(self) -> None:
        first = self.place(JPG, "a.jpg", self.root / "one")
        second = self.place(JPG, "b.jpg", self.root / "two")
        self.imported(first.parent, second.parent)
        second_id = self.id_at(second)
        first.unlink()
        second.unlink()
        arrived = self.place(JPG, "b.jpg", self.root / "three")

        result = self.imported(arrived.parent)

        self.assertEqual(result["claimed_moved"], 1)
        self.assertEqual(self.id_at(arrived), second_id)

    def test_with_many_copies_of_the_same_bytes_nothing_is_claimed(self) -> None:
        from media_workspace.db import maintenance

        folder = self.root / "copies"
        folder.mkdir()
        for index in range(maintenance.CLAIM_MAX_COPIES + 1):
            (folder / f"copy_{index:03d}.jpg").write_bytes(JPG.read_bytes())
        self.imported(folder)
        (folder / "copy_000.jpg").unlink()
        arrived = self.place(JPG, "copy_000.jpg", self.root / "elsewhere")

        result = self.imported(arrived.parent)

        # One of them is gone, but past the limit no record is looked at.
        self.assertEqual(result["claimed_moved"], 0)
        self.assertEqual(result["newly_added"], 1)

    def test_a_moved_pair_comes_back_as_the_same_pair(self) -> None:
        self.place(DNG, "DSC_0001.dng")
        jpg = self.place(JPG, "DSC_0001.JPG")
        self.assertEqual(self.imported(self.shoot)["raw_pairs_made"], 1)
        jpg_id = self.id_at(jpg)
        raw_id = self.id_at(self.shoot / "DSC_0001.dng")

        moved = self.move_shoot()
        result = self.imported(moved)

        self.assertEqual(result["claimed_moved"], 2)
        self.assertEqual(result["newly_added"], 0)
        self.assertEqual(self.asset_count(), 2)
        self.assertEqual(self.id_at(moved / "DSC_0001.JPG"), jpg_id)
        self.assertEqual(self.id_at(moved / "DSC_0001.dng"), raw_id)
        pair = self.connection.execute(
            "SELECT raw_asset_id, state FROM raw_pairs WHERE image_asset_id = ?", (jpg_id,)
        ).fetchone()
        self.assertEqual((pair["raw_asset_id"], pair["state"]), (raw_id, "paired"))
        rows = list_image_assets(self.connection, status="all")
        self.assertEqual([Path(r["image_path"]).name for r in rows], ["DSC_0001.JPG"])
        self.assertEqual(rows[0]["pair_raw_path"], str((moved / "DSC_0001.dng").resolve()))

    # ── the Missing view's batch relink ──
    def test_relinking_a_photo_brings_its_paired_raw_along(self) -> None:
        self.place(DNG, "DSC_0001.dng")
        jpg = self.place(JPG, "DSC_0001.JPG")
        self.imported(self.shoot)
        jpg_id = self.id_at(jpg)
        raw_id = self.id_at(self.shoot / "DSC_0001.dng")
        moved = self.move_shoot()
        verify_assets(self.connection)

        result = relink_assets_from_folder(self.connection, self.root / "Archive", [jpg_id])

        # Counted as the gallery shows it: one photo.
        self.assertEqual(result["relinked"], 1)
        by_id = {item["asset_id"]: item for item in result["items"]}
        self.assertEqual(by_id[raw_id]["status"], "relinked")
        self.assertTrue(by_id[raw_id]["paired_raw"])
        self.assertEqual(self.asset(raw_id)["canonical_path"], str((moved / "DSC_0001.dng").resolve()))
        self.assertEqual(self.asset(raw_id)["exists_on_disk"], 1)
        # A RAW rides the registry too: its row moved with it.
        self.assertEqual(
            self.connection.execute(
                "SELECT image_path FROM image_lookup_registry WHERE image_asset_id = ?", (raw_id,)
            ).fetchone()[0],
            str((moved / "DSC_0001.dng").resolve()),
        )

    def test_relinking_every_missing_photo_counts_a_pair_once(self) -> None:
        self.place(DNG, "DSC_0001.dng")
        self.place(JPG, "DSC_0001.JPG")
        self.imported(self.shoot)
        self.move_shoot()
        verify_assets(self.connection)

        result = relink_assets_from_folder(self.connection, self.root / "Archive")

        self.assertEqual(result["relinked"], 1)
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM assets WHERE exists_on_disk = 0").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
