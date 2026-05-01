from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.preview_service import PreviewService


class PreviewServiceTest(unittest.TestCase):
    def test_output_path_shards_into_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            output = service.output_path("raw_abcdef123456", "preview")
            self.assertEqual(output.parent, catalog.previews_dir / "ra")
            self.assertEqual(output.name, "raw_abcdef123456.jpg")

    @patch("media_workspace.preview_service.subprocess.run")
    def test_quicklook_render_moves_result_into_catalog(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "sample.CR3"
            source.write_bytes(b"raw")
            output = service.output_path("raw_abcdef123456", "preview")

            def side_effect(cmd, check, capture_output, text):
                if cmd[0] == "qlmanage":
                    temp_dir_arg = Path(cmd[5])
                    (temp_dir_arg / f"{source.name}.png").write_bytes(b"png")
                elif cmd[0] == "sips":
                    Path(cmd[-2]).write_bytes(b"jpg")
                return None

            run_mock.side_effect = side_effect
            rendered = service._render_with_quicklook(source, output, 512)
            self.assertTrue(rendered.exists())
            self.assertEqual(rendered, output)


if __name__ == "__main__":
    unittest.main()
