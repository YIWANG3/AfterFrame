from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.cli import _live_source_state
from media_workspace.db import (
    connect,
    dedupe_preview_entries,
    init_db,
    list_image_assets,
    remove_raw_from_resource_sets,
    set_catalog_path,
    split_shared_asset_ids,
    upsert_preview_entry,
)
from media_workspace.reverse_lookup import index_raw_file

FIXTURE = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"


def _content_only_id(prefix: str, fingerprint: str, path: str | None = None) -> str:
    # How imported RAWs were keyed before they were keyed by path.
    return f"{prefix}_{fingerprint[:24]}"


class DuplicateRawsTest(unittest.TestCase):
    """Byte-identical RAW copies imported as photos, e.g. B0000333.3FR and a
    re-downloaded "B0000333 (1).3FR" with its own mtime."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        folder = root / "Samples"
        folder.mkdir()
        self.original = folder / "luna-morning.dng"
        self.copy = folder / "luna-morning (1).dng"
        shutil.copyfile(FIXTURE, self.original)
        shutil.copyfile(FIXTURE, self.copy)
        os.utime(self.original, (1_700_000_000, 1_700_000_000))
        os.utime(self.copy, (1_700_000_004, 1_700_000_004))
        catalog = ensure_catalog(root / "demo.afcatalog")
        self.connection = connect(catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, catalog.root)

    def _cards(self) -> dict[str, tuple[str, bool]]:
        """file name -> (asset_id, source_changed), as the gallery gets them."""
        rows = list_image_assets(self.connection, status="all")
        cards = {Path(row["image_path"]).name: (row["asset_id"], _live_source_state(row)[1]) for row in rows}
        self.assertEqual(len(rows), len(cards), "a photo shows up more than once")
        return cards

    def _write_previews(self, asset_id: str) -> None:
        for kind in ("preview", "preview-hd"):
            upsert_preview_entry(self.connection, asset_id, kind, f"{kind}/{asset_id}.jpg", 512, 384, "ready")

    def test_each_copy_is_its_own_photo(self) -> None:
        index_raw_file(self.connection, self.original)
        index_raw_file(self.connection, self.copy)
        cards = self._cards()
        self.assertEqual(len(cards), 2)
        self.assertNotEqual(cards[self.original.name][0], cards[self.copy.name][0])
        # Neither reads as changed on disk: nothing for the gallery to repair.
        self.assertEqual([changed for _, changed in cards.values()], [False, False])

    def test_reimporting_keeps_the_id(self) -> None:
        first = index_raw_file(self.connection, self.copy).image_asset_id
        self.assertEqual(index_raw_file(self.connection, self.copy).image_asset_id, first)

    def _legacy_shared_catalog(self) -> str:
        with patch("media_workspace.reverse_lookup.stable_asset_id", _content_only_id):
            index_raw_file(self.connection, self.original)
            shared = index_raw_file(self.connection, self.copy).image_asset_id
        self._write_previews(shared)
        cards = self._cards()
        self.assertEqual({asset_id for asset_id, _ in cards.values()}, {shared})
        # The asset has the copy's mtime: the original's card was stale forever.
        self.assertTrue(cards[self.original.name][1])
        return shared

    def _repair_until_healthy(self) -> dict[str, tuple[str, bool]]:
        # What the gallery does for a stale card: refresh it from disk.
        for _ in range(3):
            stale = [name for name, (_, changed) in self._cards().items() if changed]
            if not stale:
                break
            for name in stale:
                # refresh-assets: re-read the file, then regenerate its previews.
                self._write_previews(index_raw_file(self.connection, self.original.with_name(name)).image_asset_id)
        return self._cards()

    def _open_catalog(self) -> int:
        # What the app runs when a catalog opens (split-shared-assets).
        split = split_shared_asset_ids(self.connection)
        remove_raw_from_resource_sets(self.connection)
        dedupe_preview_entries(self.connection)
        return split

    def test_the_split_made_on_open_survives_the_repair(self) -> None:
        # The app splits shared assets when a catalog opens. Re-indexing the
        # split copy to repair its stale size/mtime used to key it by content
        # again and merge it straight back: two cards, one asset, a loop.
        shared = self._legacy_shared_catalog()
        self.assertEqual(self._open_catalog(), 1)
        cards = self._repair_until_healthy()
        self.assertEqual(cards[self.copy.name][0], shared)
        self.assertNotEqual(cards[self.original.name][0], shared)
        self.assertEqual([changed for _, changed in cards.values()], [False, False])
        self.assertEqual(self._open_catalog(), 0)

    def test_a_split_that_was_merged_back_is_adopted_again(self) -> None:
        # The catalog in the bug report: an older build split the copies on
        # open, the repair regenerated the split one's previews and then
        # merged it back, leaving it with no card and two rows per preview.
        shared = self._legacy_shared_catalog()
        split_shared_asset_ids(self.connection)
        orphan = self._cards()[self.original.name][0]
        for kind in ("preview", "preview-hd"):
            self.connection.execute(
                "UPDATE preview_entries SET cache_key = ? WHERE asset_id = ? AND kind = ?",
                (f"{orphan}_{kind}", orphan, kind),  # the key the older split shared them under
            )
        self._write_previews(orphan)
        self.connection.execute(
            "UPDATE image_lookup_registry SET image_asset_id = ? WHERE image_path = ?",
            (shared, str(self.original.resolve())),
        )
        self.connection.execute(
            "UPDATE asset_files SET asset_id = ? WHERE path = ?", (shared, str(self.original.resolve()))
        )
        index_raw_file(self.connection, self.original)
        index_raw_file(self.connection, self.copy)
        self.assertEqual({asset_id for asset_id, _ in self._cards().values()}, {shared})

        self.assertEqual(self._open_catalog(), 1)
        cards = self._repair_until_healthy()
        self.assertEqual(cards[self.original.name][0], orphan)
        self.assertEqual([changed for _, changed in cards.values()], [False, False])


if __name__ == "__main__":
    unittest.main()
