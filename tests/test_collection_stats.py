"""The folder page's columns (docs/folders-page-plan.md §4.1): list_collections
carries, per folder, when a photo last joined, the capture-time span and the
previews of the newest four photos — from two passes over collection_items,
never a query per folder."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db
from media_workspace.db.collections import (
    COVER_COUNT,
    add_collection_items,
    collection_stats,
    create_collection,
    list_collections,
)


def seed_asset(connection, asset_id, capture_time=None, preview=True, preview_status="ready"):
    metadata = f'{{"capture_time": "{capture_time}"}}' if capture_time is not None else "{}"
    connection.execute(
        """
        INSERT INTO assets (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
                            extension, fingerprint, file_size, modified_time, metadata_json)
        VALUES (?, 'image', ?, ?, ?, ?, '.jpg', ?, 1, '2026-01-01T00:00:00', ?)
        """,
        (asset_id, f"/photos/{asset_id}.jpg", asset_id, asset_id, asset_id, f"fp-{asset_id}", metadata),
    )
    if preview:
        connection.execute(
            "INSERT INTO preview_entries (cache_key, asset_id, kind, relative_path, status) VALUES (?, ?, 'preview', ?, ?)",
            (f"key-{asset_id}", asset_id, f"previews/{asset_id}.jpg", preview_status),
        )


def set_added_at(connection, collection_id, asset_id, added_at):
    connection.execute(
        "UPDATE collection_items SET added_at = ? WHERE collection_id = ? AND asset_id = ?",
        (added_at, collection_id, asset_id),
    )


class CollectionStatsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        init_db(self.connection)

    def by_id(self):
        return {row["collection_id"]: row for row in list_collections(self.connection)}

    def test_span_last_added_and_the_newest_four_covers(self):
        connection = self.connection
        # Six photos; "e" has no preview at all and "f" only a pending one, so
        # neither can be a cover, but both still count for the span.
        seed_asset(connection, "a", "2025-03-02T10:00:00")
        seed_asset(connection, "b", "2025-06-30T18:00:00")
        seed_asset(connection, "c", "2025-04-15T09:00:00")
        seed_asset(connection, "d", "")  # an empty capture time is "unknown", not the minimum
        seed_asset(connection, "e", "2025-01-01T00:00:00", preview=False)
        seed_asset(connection, "f", "2025-12-24T00:00:00", preview_status="pending")
        folder = create_collection(connection, "Tokyo")["collection_id"]
        add_collection_items(connection, folder, ["a", "b", "c", "d", "e", "f"])
        for asset_id, day in [("a", "01"), ("b", "02"), ("c", "03"), ("d", "04"), ("e", "05"), ("f", "06")]:
            set_added_at(connection, folder, asset_id, f"2026-10-{day} 12:00:00")
        connection.commit()

        row = self.by_id()[folder]
        self.assertEqual(row["item_count"], 6)
        self.assertEqual(row["last_added_at"], "2026-10-06 12:00:00")
        self.assertEqual(row["captured_from"], "2025-01-01T00:00:00")
        self.assertEqual(row["captured_to"], "2025-12-24T00:00:00")
        # Newest added first, skipping the two without a ready preview.
        self.assertEqual(
            row["cover_relative_paths"],
            ["previews/d.jpg", "previews/c.jpg", "previews/b.jpg", "previews/a.jpg"],
        )
        self.assertEqual(len(row["cover_relative_paths"]), COVER_COUNT)

    def test_empty_folders_and_smart_collections_carry_the_empty_shape(self):
        connection = self.connection
        seed_asset(connection, "a", "2025-03-02T10:00:00")
        empty = create_collection(connection, "Nothing yet")["collection_id"]
        smart = create_collection(connection, "Five stars", "smart", '{"filters": {"rating_min": 5}}')["collection_id"]
        one = create_collection(connection, "One")["collection_id"]
        add_collection_items(connection, one, ["a"])
        connection.commit()

        rows = self.by_id()
        for collection_id in (empty, smart):
            self.assertIsNone(rows[collection_id]["last_added_at"])
            self.assertIsNone(rows[collection_id]["captured_from"])
            self.assertIsNone(rows[collection_id]["captured_to"])
            self.assertEqual(rows[collection_id]["cover_relative_paths"], [])
        self.assertEqual(rows[one]["cover_relative_paths"], ["previews/a.jpg"])
        self.assertEqual(rows[one]["captured_from"], "2025-03-02T10:00:00")
        self.assertEqual(rows[one]["captured_to"], "2025-03-02T10:00:00")
        # The raw stats only name folders with items.
        self.assertEqual(set(collection_stats(connection)), {one})


if __name__ == "__main__":
    unittest.main()
