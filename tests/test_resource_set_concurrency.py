import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from media_workspace.db import connect, init_db, list_image_assets, resource_sets


class ResourceSetConcurrencyTest(unittest.TestCase):
    def test_import_and_repair_cannot_create_two_sets_for_one_asset(self):
        self._assert_concurrent_creation(resource_sets.attach_asset_to_resource_set)

    def test_direct_creation_is_also_atomic(self):
        self._assert_concurrent_creation(resource_sets.create_resource_set)

    def _assert_concurrent_creation(self, operation):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.sqlite3"
            db = connect(path)
            init_db(db)
            db.execute("""INSERT INTO assets
                (asset_id, asset_type, canonical_path, stem, normalized_stem,
                 stem_key, extension, fingerprint, file_size, modified_time)
                VALUES ('photo', 'image', '/sample-01.jpg', 'sample-01',
                        'sample-01', 'sample-01', '.jpg', 'fingerprint', 100, '2026')""")
            db.execute("""INSERT INTO image_lookup_registry
                (image_path, image_asset_id, match_status, resolver_version)
                VALUES ('/sample-01.jpg', 'photo', 'unmatched', 'test')""")
            db.commit()
            start = threading.Barrier(2)
            lookup = resource_sets.get_resource_set_for_asset

            def delayed_lookup(connection, asset_id):
                result = lookup(connection, asset_id)
                if result is None:
                    # Widen the read-then-write gap shared by import and repair.
                    time.sleep(0.1)
                return result

            def attach():
                connection = connect(path)
                try:
                    start.wait(timeout=5)
                    return operation(connection, "photo")
                finally:
                    connection.close()

            try:
                with patch.object(resource_sets, "get_resource_set_for_asset", delayed_lookup):
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        sets = list(pool.map(lambda _: attach(), range(2)))
                self.assertEqual(len(set(sets)), 1)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM resource_sets").fetchone()[0], 1)
                self.assertEqual(len(list_image_assets(db, "all")), 1)
                # Nested callers can still own the transaction and roll back.
                resource_sets.create_resource_set(db, "photo", commit=False)
                self.assertTrue(db.in_transaction)
                db.rollback()
                self.assertFalse(db.in_transaction)
                with self.assertRaises(sqlite3.IntegrityError):
                    resource_sets.create_resource_set(db, "missing-photo")
                self.assertFalse(db.in_transaction)
            finally:
                db.close()
