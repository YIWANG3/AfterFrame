from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from media_workspace.file_types import is_raw_file, is_source_file
from media_workspace.reverse_lookup import iter_image_files
from media_workspace.scanner import scan_raw_directory
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db


class MacMetadataTests(unittest.TestCase):
    def test_folder_and_direct_import_ignore_companions_but_keep_real_hidden_images(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            names = ['portrait.png', '._portrait.png', 'raw.CR3', '._raw.CR3', '.hidden.png', '__MACOSX/copy.png']
            for name in names:
                path = root / name
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(b'\x00\x05\x16\x07' + b'\x00' * 20)
            expected = {root / name for name in ['portrait.png', 'raw.CR3', '.hidden.png']}
            self.assertEqual(set(iter_image_files([root])), expected)
            self.assertEqual(set(iter_image_files([root / name for name in names])), expected)
            self.assertFalse(is_raw_file(root / '._raw.CR3'))
            self.assertFalse(is_source_file(root / '._portrait.png'))

    def test_raw_scan_does_not_index_appledouble_raws(self):
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = root / 'raw'
            raw.mkdir()
            (raw / 'photo.CR3').write_bytes(b'raw-placeholder')
            (raw / '._photo.CR3').write_bytes(b'\x00\x05\x16\x07' + b'\x00' * 4092)
            catalog = ensure_catalog(root / 'demo.afcatalog')
            connection = connect(catalog.db_path)
            self.addCleanup(connection.close)
            init_db(connection)
            result = scan_raw_directory(connection, raw, workers=1)
            self.assertEqual(result['indexed'], 1)
