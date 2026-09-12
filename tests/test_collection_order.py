import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db
from media_workspace.db.collections import create_collection, list_collections, reorder_collections


class CollectionOrderTests(unittest.TestCase):
    def test_order_persists_and_new_folders_append(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'catalog.sqlite'
            connection = connect(path)
            init_db(connection)
            ids = [create_collection(connection, name)['collection_id'] for name in ['Zulu', 'Alpha', 'Middle']]
            reorder_collections(connection, [ids[2], ids[0], ids[1]])
            connection.close()
            connection = connect(path)
            self.addCleanup(connection.close)
            new_id = create_collection(connection, 'A new folder')['collection_id']
            self.assertEqual([row['collection_id'] for row in list_collections(connection)], [ids[2], ids[0], ids[1], new_id])

    def test_stale_or_duplicate_order_leaves_existing_order_intact(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = connect(Path(directory) / 'catalog.sqlite')
            self.addCleanup(connection.close)
            init_db(connection)
            ids = [create_collection(connection, name)['collection_id'] for name in ['B', 'A']]
            smart = create_collection(connection, 'Smart', 'smart')['collection_id']
            before = list_collections(connection)
            for invalid in ([ids[0]], [ids[0], ids[0]], [ids[1], 'missing'], [ids[0], smart]):
                with self.assertRaises(ValueError):
                    reorder_collections(connection, invalid)
                self.assertEqual(list_collections(connection), before)
            reorder_collections(connection, list(reversed(ids)))
            self.assertEqual([row['collection_id'] for row in list_collections(connection) if row['kind'] == 'manual'], list(reversed(ids)))
