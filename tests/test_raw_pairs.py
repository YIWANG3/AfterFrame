"""Same-shot RAW+JPG pairs (db/raw_pairs.py, docs/raw-jpg-pairing-plan.md)."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    add_collection_items,
    connect,
    create_collection,
    init_db,
    list_image_assets,
    raw_pairs,
    set_catalog_path,
)
from media_workspace.db.browse import count_image_assets
from media_workspace.reverse_lookup import resolve_image_batch

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"
DNG = FIXTURES / "raw" / "luna-morning.dng"
JPG = FIXTURES / "raw" / "luna-morning.jpg"
HEIC = FIXTURES / "heic" / "iphone-style.heic"


class RawPairsTest(unittest.TestCase):
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
        folder.mkdir(exist_ok=True)
        target = folder / name
        shutil.copyfile(source, target)
        return target

    def imported(self, *paths: Path) -> dict:
        return resolve_image_batch(self.connection, list(paths))

    def names(self) -> list[str]:
        return sorted(Path(row["image_path"]).name for row in list_image_assets(self.connection, status="all"))

    def asset_id(self, name: str) -> str:
        rows = self.connection.execute("SELECT asset_id, canonical_path FROM assets").fetchall()
        matches = [str(row[0]) for row in rows if Path(str(row[1])).name == name]
        self.assertEqual(len(matches), 1, f"{name}: {matches}")
        return matches[0]

    def run_cli(self, *argv: str):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        self.connection.rollback()  # see the CLI's writes
        return json.loads(out.getvalue())

    def column(self, name: str, column: str):
        return self.connection.execute(f"SELECT {column} FROM assets WHERE asset_id = ?", (self.asset_id(name),)).fetchone()[0]

    def pair(self) -> tuple[str, str]:
        self.place(DNG, "DSC_0001.dng")
        self.place(JPG, "DSC_0001.JPG")
        result = self.imported(self.shoot)
        self.assertEqual(result["raw_pairs_made"], 1)
        return self.asset_id("DSC_0001.JPG"), self.asset_id("DSC_0001.dng")

    # ── finding pairs ──
    def test_a_new_library_shows_a_pair_as_its_jpg(self) -> None:
        image_id, raw_id = self.pair()
        self.assertEqual(self.names(), ["DSC_0001.JPG"])
        self.assertEqual(count_image_assets(self.connection, "all"), 1)
        row = list_image_assets(self.connection, status="all")[0]
        self.assertEqual(row["pair_raw_asset_id"], raw_id)
        self.assertTrue(str(row["pair_raw_path"]).endswith("DSC_0001.dng"))
        self.assertEqual(raw_pairs.status(self.connection), {"mode": "merge", "pairs": 1, "noticed": False})

    def test_the_order_of_import_does_not_matter(self) -> None:
        raw = self.place(DNG, "DSC_0002.dng")
        jpg = self.place(JPG, "dsc_0002.jpg")
        self.imported(raw)
        self.assertEqual(self.names(), ["DSC_0002.dng"])
        self.assertEqual(self.imported(jpg)["raw_pairs_made"], 1)
        self.assertEqual(self.names(), ["dsc_0002.jpg"])

    def test_other_folders_and_other_names_are_not_pairs(self) -> None:
        self.place(DNG, "DSC_0003.dng")
        self.place(JPG, "DSC_0003.jpg", self.root / "Elsewhere")
        self.place(JPG, "DSC_0003-edit.jpg")
        self.assertEqual(self.imported(self.shoot, self.root / "Elsewhere")["raw_pairs_made"], 0)
        self.assertEqual(len(self.names()), 3)

    def test_two_cover_candidates_make_no_pair(self) -> None:
        self.place(DNG, "IMG_1.dng")
        self.place(JPG, "IMG_1.jpg")
        self.place(HEIC, "IMG_1.heic")
        self.assertEqual(self.imported(self.shoot)["raw_pairs_made"], 0)
        self.assertEqual(len(self.names()), 3)

    def test_shots_apart_in_time_are_not_a_pair(self) -> None:
        jpg = self.place(JPG, "DSC_0004.jpg")
        self.imported(jpg)
        self.connection.execute(
            "UPDATE assets SET metadata_json = json_set(metadata_json, '$.capture_time', '2001-01-01T00:00:00') WHERE asset_id = ?",
            (self.asset_id("DSC_0004.jpg"),),
        )
        self.assertEqual(self.imported(self.place(DNG, "DSC_0004.dng"))["raw_pairs_made"], 0)
        self.assertEqual(len(self.names()), 2)

    # ── one photo while merged ──
    def test_pairing_brings_the_two_values_together(self) -> None:
        jpg = self.place(JPG, "DSC_0005.jpg")
        raw = self.place(DNG, "DSC_0005.dng")
        self.imported(jpg)
        image_id = self.asset_id("DSC_0005.jpg")
        folder = create_collection(self.connection, "Raw folder")["collection_id"]
        self.connection.execute("UPDATE assets SET app_rating = 2 WHERE asset_id = ?", (image_id,))
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'harbour', 'user')", (image_id,))
        # The RAW arrives, shown separately, with its own stars, a flag, a tag and a folder.
        raw_pairs.set_mode(self.connection, "separate")
        self.imported(raw)
        raw_id = self.asset_id("DSC_0005.dng")
        self.connection.execute("UPDATE assets SET app_rating = 4, app_flag = 1 WHERE asset_id = ?", (raw_id,))
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'dawn', 'user')", (raw_id,))
        add_collection_items(self.connection, folder, [raw_id])
        raw_pairs.set_mode(self.connection, "merge")
        for asset in (image_id, raw_id):
            row = self.connection.execute("SELECT app_rating, app_flag FROM assets WHERE asset_id = ?", (asset,)).fetchone()
            self.assertEqual(tuple(row), (2, 1), "the JPG's stars win, the RAW's flag fills the gap")
            tags = {r[0] for r in self.connection.execute("SELECT tag FROM asset_tags WHERE asset_id = ?", (asset,))}
            self.assertEqual(tags, {"harbour", "dawn"})
        members = {r[0] for r in self.connection.execute("SELECT asset_id FROM collection_items WHERE collection_id = ?", (folder,))}
        self.assertEqual(members, {image_id}, "the folder holds the JPG, not the hidden RAW")

    def test_writes_to_the_jpg_reach_the_raw(self) -> None:
        image_id, raw_id = self.pair()
        self.run_cli("set-asset-rating", "--asset-id", image_id, "--rating", "5")
        self.run_cli("set-asset-flag", "--asset-id", image_id, "--flag", "reject")
        self.run_cli("add-asset-tags", "--asset-id", image_id, "--tag", "night")
        self.run_cli("add-asset-tag", "--asset-id", image_id, "--tag", "street")
        for asset in (image_id, raw_id):
            self.assertEqual(self.connection.execute("SELECT app_rating, app_flag FROM assets WHERE asset_id = ?", (asset,)).fetchone()[:], (5, -1))
            tags = {r[0] for r in self.connection.execute("SELECT tag FROM asset_tags WHERE asset_id = ?", (asset,))}
            self.assertTrue({"night", "street"} <= tags)
        self.run_cli("remove-asset-tag", "--asset-id", image_id, "--tag", "street")
        self.assertIsNone(self.connection.execute("SELECT 1 FROM asset_tags WHERE asset_id = ? AND tag = 'street'", (raw_id,)).fetchone())

    def test_a_folder_holds_only_the_jpg(self) -> None:
        image_id, raw_id = self.pair()
        folder = create_collection(self.connection, "Picks")["collection_id"]
        self.connection.commit()
        self.run_cli("collection-add-items", "--collection-id", folder, "--asset-id", image_id, "--asset-id", raw_id)
        members = [r[0] for r in self.connection.execute("SELECT asset_id FROM collection_items WHERE collection_id = ?", (folder,))]
        self.assertEqual(members, [image_id])
        rows = self.run_cli("browse-collection", "--collection-id", folder)
        self.assertEqual([row["asset_id"] for row in rows], [image_id])

    def test_removing_the_photo_removes_both(self) -> None:
        image_id, raw_id = self.pair()
        self.assertEqual(
            self.run_cli("raw-pair-files", "--asset-id", image_id)[0]["raw_asset_id"], raw_id,
        )
        self.run_cli("delete-image-assets", "--asset-id", image_id)
        self.assertIsNone(self.connection.execute("SELECT 1 FROM assets WHERE asset_id IN (?, ?)", (image_id, raw_id)).fetchone())
        self.assertIsNone(self.connection.execute("SELECT 1 FROM raw_pairs").fetchone())

    def test_the_jpg_has_a_raw_for_the_filter(self) -> None:
        self.pair()
        self.place(JPG, "lonely.jpg")
        self.imported(self.shoot / "lonely.jpg")
        with_raw = list_image_assets(self.connection, status="all", filters={"has_raw": True})
        self.assertEqual([Path(row["image_path"]).name for row in with_raw], ["DSC_0001.JPG"])

    # ── separate ──
    def test_separate_shows_both_with_what_they_were_given(self) -> None:
        image_id, raw_id = self.pair()
        folder = create_collection(self.connection, "Picks")["collection_id"]
        add_collection_items(self.connection, folder, [image_id])
        self.run_cli("set-asset-rating", "--asset-id", image_id, "--rating", "3")
        status = self.run_cli("set-raw-pairs-mode", "--mode", "separate")
        self.assertEqual(status, {"mode": "separate", "pairs": 1, "noticed": True})
        self.assertEqual(self.names(), ["DSC_0001.JPG", "DSC_0001.dng"])
        self.assertEqual(self.column("DSC_0001.dng", "app_rating"), 3)
        members = {r[0] for r in self.connection.execute("SELECT asset_id FROM collection_items WHERE collection_id = ?", (folder,))}
        self.assertEqual(members, {image_id, raw_id})
        # Separate, a write is the photo's own.
        self.run_cli("set-asset-rating", "--asset-id", image_id, "--rating", "1")
        self.assertEqual(self.column("DSC_0001.dng", "app_rating"), 3)

    def test_a_pair_split_by_an_earlier_build_stays_two_photos(self) -> None:
        # No command splits a pair any more; a catalog from a pre-release
        # build may still hold one.
        image_id, raw_id = self.pair()
        self.connection.execute("UPDATE raw_pairs SET state = 'split' WHERE image_asset_id = ?", (image_id,))
        self.connection.commit()
        self.assertEqual(len(self.names()), 2)
        self.assertEqual(raw_pairs.pair_all(self.connection), 0)
        self.imported(self.shoot)
        self.assertEqual(len(self.names()), 2)
        self.run_cli("set-asset-rating", "--asset-id", image_id, "--rating", "5")
        self.assertNotEqual(self.column("DSC_0001.dng", "app_rating"), 5)

    def test_noticing(self) -> None:
        self.pair()
        self.assertTrue(self.run_cli("notice-raw-pairs")["noticed"])
        self.assertEqual(raw_pairs.get_mode(self.connection), "merge")


class RawPairsMigrationTest(unittest.TestCase):
    def test_an_upgraded_library_pairs_its_photos_and_keeps_showing_two(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shoot = root / "Shoot"
            shoot.mkdir()
            shutil.copyfile(DNG, shoot / "A.dng")
            shutil.copyfile(JPG, shoot / "A.jpg")
            catalog = ensure_catalog(root / "old.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            with raw_pairs_mode(connection, "separate"):
                resolve_image_batch(connection, [shoot])
            # Back to schema 14: no pairs table, no setting.
            connection.execute("DROP TABLE raw_pairs")
            connection.execute("DELETE FROM app_settings WHERE setting_key = 'raw_pairs'")
            connection.execute("UPDATE catalog_info SET schema_version = 14")
            connection.commit()
            connection.close()

            connection = connect(catalog.db_path)
            init_db(connection)
            self.assertEqual(raw_pairs.status(connection), {"mode": "separate", "pairs": 1, "noticed": False})
            self.assertEqual(len(list_image_assets(connection, status="all")), 2)
            connection.close()

    def test_an_upgraded_library_without_pairs_merges_from_now_on(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            catalog = ensure_catalog(root / "old.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            connection.execute("DROP TABLE raw_pairs")
            connection.execute("UPDATE catalog_info SET schema_version = 14")
            connection.commit()
            connection.close()
            connection = connect(catalog.db_path)
            init_db(connection)
            self.assertEqual(raw_pairs.status(connection)["mode"], "merge")
            self.assertIsNone(connection.execute("SELECT 1 FROM app_settings WHERE setting_key = 'raw_pairs'").fetchone())
            connection.close()


@contextlib.contextmanager
def raw_pairs_mode(connection, mode: str):
    """Import with the library set to `mode`, then set it back to merge
    without the side effects set_mode has (merging what was imported)."""
    raw_pairs._write_setting(connection, {"mode": mode})
    try:
        yield
    finally:
        connection.execute("DELETE FROM app_settings WHERE setting_key = 'raw_pairs'")
        connection.commit()


if __name__ == "__main__":
    unittest.main()
