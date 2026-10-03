from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageCms

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.preview_service import (
    PreviewService,
    SourceNotReadyError,
    _register_heif,
    render_pillow_preview,
    transcode_to_jpeg,
)

GENERIC_CMYK = Path("/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc")
HEIC_FIXTURE = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "heic" / "iphone-style.heic"


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

    @patch("media_workspace.preview_service.render_pillow_preview")
    def test_source_change_during_render_discards_temp_preview(self, render_mock) -> None:
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

            def side_effect(source_path, target, size):
                Path(target).write_bytes(b"new-preview")
                source.write_bytes(b"\xff\xd8second-complete-and-larger\xff\xd9")

            render_mock.side_effect = side_effect
            with self.assertRaises(SourceNotReadyError):
                service.generate_for_row(row, "preview", force=True)

            self.assertEqual(output.read_bytes(), b"last-known-good")
            self.assertEqual([p.name for p in output.parent.iterdir()], [output.name])


class PillowPreviewTest(unittest.TestCase):
    """Processed images render with Pillow on every platform (Windows has no
    sips), matching what sips -Z produced on macOS."""

    def render(self, source: Path, size: int = 512) -> Image.Image:
        target = source.with_name(f"preview-{source.stem}.jpg")
        render_pillow_preview(source, target, size)
        # A copy (info and EXIF included) so the file is closed before the
        # temp dir goes: Windows can't delete an open file.
        with Image.open(target) as image:
            return image.copy()

    def test_orientation_tag_and_icc_profile_carry_over_like_sips(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "portrait.jpg"
            exif = Image.Exif()
            exif[0x0112] = 6  # stored landscape, shown rotated 90 degrees
            icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
            Image.new("RGB", (1200, 800), (40, 90, 200)).save(source, exif=exif.tobytes(), icc_profile=icc)

            preview = self.render(source)
            self.assertEqual(preview.size, (512, 341), "pixels stay as stored; viewers rotate")
            self.assertEqual(preview.getexif().get(0x0112), 6)
            self.assertEqual(preview.info.get("icc_profile"), icc)

    def test_cmyk_never_keeps_a_cmyk_profile_on_an_rgb_preview(self) -> None:
        """A print export: the preview is RGB, so a CMYK profile can't ride along."""
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "print.jpg"
            Image.new("CMYK", (400, 300), (0, 255, 255, 0)).save(source, icc_profile=b"not a usable profile")
            preview = self.render(source)
            self.assertEqual(preview.mode, "RGB")
            self.assertIsNone(preview.info.get("icc_profile"))

    @unittest.skipUnless(GENERIC_CMYK.exists(), "needs macOS's Generic CMYK profile")
    def test_cmyk_is_colour_managed_like_colorsync(self) -> None:
        """C0 M100 Y100 K0 under Generic CMYK is (216, 35, 42) in sRGB through
        ColorSync (what sips and Preview show); a plain convert gives 254, 0, 0."""
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "print.jpg"
            Image.new("CMYK", (400, 300), (0, 255, 255, 0)).save(source, icc_profile=GENERIC_CMYK.read_bytes())
            preview = self.render(source)
            self.assertIsNone(preview.info.get("icc_profile"))
            for got, want in zip(preview.getpixel((200, 150)), (216, 35, 42), strict=True):
                self.assertAlmostEqual(got, want, delta=6)

    def test_transparency_flattens_onto_white_and_small_images_are_not_enlarged(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "logo.png"
            image = Image.new("RGBA", (300, 200), (0, 128, 0, 0))
            image.paste((255, 0, 0, 255), (100, 50, 200, 150))
            image.save(source)

            preview = self.render(source)
            self.assertEqual(preview.size, (300, 200))
            self.assertEqual(preview.mode, "RGB")
            corner = preview.getpixel((0, 0))
            centre = preview.getpixel((150, 100))
            self.assertTrue(all(c > 245 for c in corner), corner)
            self.assertGreater(centre[0], 200)
            self.assertLess(centre[1], 60)

    def test_heic_decodes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "heic-preview.jpg"
            render_pillow_preview(HEIC_FIXTURE, target, 256)
            # Closed before the temp dir goes: Windows can't delete an open file.
            with Image.open(target) as preview:
                self.assertEqual(max(preview.size), 256)
                self.assertEqual(preview.format, "JPEG")

    def test_heic_transcodes_to_a_full_size_jpeg(self) -> None:
        """What media:// serves in place of a HEIC original where there is no sips."""
        _register_heif()
        with Image.open(HEIC_FIXTURE) as original:
            full_size = original.size
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "original.jpg"
            transcode_to_jpeg(HEIC_FIXTURE, target)
            with Image.open(target) as jpeg:
                self.assertEqual(jpeg.format, "JPEG")
                self.assertEqual(jpeg.size, full_size)
            self.assertEqual(sorted(p.name for p in Path(temp_dir).iterdir()), ["original.jpg"])

    def test_transcode_image_needs_no_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = Path(temp_dir) / "never.afcatalog"
            target = Path(temp_dir) / "original.jpg"
            out = io.StringIO()
            with redirect_stdout(out):
                code = cli.main(["transcode-image", "--catalog", str(catalog), "--source", str(HEIC_FIXTURE), "--output", str(target)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue()), {"output": str(target)})
            self.assertTrue(target.is_file())
            self.assertFalse(catalog.exists())

    def test_a_failed_transcode_leaves_nothing_behind(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "broken.heic"
            source.write_bytes(b"not an image")
            target = Path(temp_dir) / "out" / "original.jpg"
            target.parent.mkdir()
            with self.assertRaises(OSError):
                transcode_to_jpeg(source, target)
            self.assertEqual(list(target.parent.iterdir()), [])

    def test_sixteen_bit_greyscale_is_scaled_not_clipped(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "scan.png"
            Image.new("I;16", (64, 64), 32768).save(source)
            preview = self.render(source)
            self.assertAlmostEqual(preview.getpixel((10, 10))[0], 127, delta=2)

    @patch("media_workspace.preview_service.subprocess.run")
    def test_jpeg_previews_need_no_external_tool(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "photo.jpg"
            Image.new("RGB", (3000, 2000), (200, 120, 40)).save(source)
            row = {"asset_id": "img_0123456789ab", "canonical_path": str(source), "width": 3000, "height": 2000}

            result = service.generate_for_row(row, "preview-hd", force=True)

            run_mock.assert_not_called()
            with Image.open(catalog.root / result.relative_path) as preview:
                self.assertEqual(preview.size, (2000, 1333))

    @patch("media_workspace.preview_service.shutil.which", return_value="/usr/bin/sips")
    @patch("media_workspace.preview_service.subprocess.run")
    def test_a_file_pillow_cannot_read_falls_back_to_sips_where_it_exists(self, run_mock, _which) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "layered.tif"
            source.write_bytes(b"not something Pillow can open")
            output = service.output_path("img_0123456789ab", "preview")

            def sips(cmd, check, capture_output, text):
                Path(cmd[cmd.index("--out") + 1]).write_bytes(b"jpg-from-sips")

            run_mock.side_effect = sips
            rendered = service._render_image(source, output, 512)
            self.assertEqual(rendered.read_bytes(), b"jpg-from-sips")
            self.assertEqual(run_mock.call_args.args[0][0], "sips")

    @patch("media_workspace.preview_service.shutil.which", return_value=None)
    def test_without_sips_an_unreadable_file_fails_without_leftovers(self, _which) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            service = PreviewService(catalog)
            source = Path(temp_dir) / "layered.tif"
            source.write_bytes(b"not something Pillow can open")
            output = service.output_path("img_0123456789ab", "preview")
            with self.assertRaises(OSError):  # PIL.UnidentifiedImageError
                service._render_image(source, output, 512)
            self.assertEqual(list(output.parent.iterdir()), [])

if __name__ == "__main__":
    unittest.main()
