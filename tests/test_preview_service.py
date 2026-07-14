from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.preview_service import PreviewService, SourceNotReadyError


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

    # Concurrent renders of the same asset (editor quick-register + watched-import
    # batch, separate processes) must not corrupt the preview: each writes a temp
    # then atomically replaces the final path.
    @patch("media_workspace.preview_service.subprocess.run")
    def test_sips_render_writes_temp_then_atomically_replaces(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "src.jpg"
            source.write_bytes(b"jpg")
            output = service.output_path("img_abcdef123456", "preview")
            seen = {}

            def side_effect(cmd, check, capture_output, text):
                out = Path(cmd[cmd.index("--out") + 1])
                seen["out"] = out
                out.write_bytes(b"jpgdata")
                return None

            run_mock.side_effect = side_effect
            rendered = service._render_with_sips(source, output, 512)

            # sips wrote to a TEMP path in the same directory, not the final file.
            self.assertNotEqual(seen["out"], output)
            self.assertEqual(seen["out"].parent, output.parent)
            self.assertEqual(rendered, output)
            self.assertEqual(output.read_bytes(), b"jpgdata")
            # No leftover temp files after the atomic replace.
            self.assertEqual([p.name for p in output.parent.iterdir()], [output.name])

    @patch("media_workspace.preview_service.subprocess.run")
    def test_failed_render_leaves_no_temp_and_no_output(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "src.jpg"
            source.write_bytes(b"jpg")
            output = service.output_path("img_abcdef123456", "preview")
            run_mock.side_effect = subprocess.CalledProcessError(1, "sips")

            with self.assertRaises(subprocess.CalledProcessError):
                service._render_with_sips(source, output, 512)
            # A failed render must not create the final file nor leak a temp.
            self.assertFalse(output.exists())
            self.assertEqual(list(output.parent.iterdir()), [])

    # Self-heal: a "ready" preview whose file went missing/empty must be treated
    # as needing a re-render (not trusted from the stale DB status).
    def test_preview_on_disk_flags_missing_or_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            self.assertFalse(service._preview_on_disk("img_x0", "preview"))  # missing
            out = service.output_path("img_x0", "preview")
            out.write_bytes(b"")
            self.assertFalse(service._preview_on_disk("img_x0", "preview"))  # empty
            out.write_bytes(b"data")
            self.assertTrue(service._preview_on_disk("img_x0", "preview"))

    @patch("media_workspace.preview_service.subprocess.run")
    def test_incomplete_jpeg_never_replaces_existing_preview(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "lightroom-export.jpg"
            source.write_bytes(b"\xff\xd8partial-jpeg-without-eoi")
            output = service.output_path("img_abcdef123456", "preview")
            output.write_bytes(b"last-known-good")
            row = {
                "asset_id": "img_abcdef123456",
                "canonical_path": str(source),
                "width": 100,
                "height": 100,
            }

            with self.assertRaises(SourceNotReadyError):
                service.generate_for_row(row, "preview", force=True)

            run_mock.assert_not_called()
            self.assertEqual(output.read_bytes(), b"last-known-good")

    @patch("media_workspace.preview_service.subprocess.run")
    def test_source_change_during_render_discards_temp_preview(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "lightroom-export.jpg"
            source.write_bytes(b"\xff\xd8first-complete\xff\xd9")
            output = service.output_path("img_abcdef123456", "preview")
            output.write_bytes(b"last-known-good")
            row = {
                "asset_id": "img_abcdef123456",
                "canonical_path": str(source),
                "width": 100,
                "height": 100,
            }

            def side_effect(cmd, check, capture_output, text):
                Path(cmd[cmd.index("--out") + 1]).write_bytes(b"new-preview")
                source.write_bytes(b"\xff\xd8second-complete-and-larger\xff\xd9")
                return None

            run_mock.side_effect = side_effect
            with self.assertRaises(SourceNotReadyError):
                service.generate_for_row(row, "preview", force=True)

            self.assertEqual(output.read_bytes(), b"last-known-good")
            self.assertEqual([p.name for p in output.parent.iterdir()], [output.name])


if __name__ == "__main__":
    unittest.main()
