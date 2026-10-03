from __future__ import annotations

import struct
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.preview_service import PreviewService
from media_workspace.raw_preview import embedded_jpeg, render_raw_preview

DNG_FIXTURE = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"


def _jpeg(size: tuple[int, int], colour: tuple[int, int, int], **save) -> bytes:
    out = BytesIO()
    Image.new("RGB", size, colour).save(out, "JPEG", **save)
    return out.getvalue()


def _tiff_header(orientation: int) -> bytes:
    """A little-endian TIFF whose IFD0 holds only Orientation, as a RAW's does (among much else)."""
    entry = struct.pack("<HHIHH", 0x0112, 3, 1, orientation, 0)
    return b"II*\x00" + struct.pack("<I", 8) + struct.pack("<H", 1) + entry + struct.pack("<I", 0)


def _lossless_jpeg(width: int, height: int) -> bytes:
    """The header of a lossless (SOF3) JPEG like CR2's raw data: no decoder here reads it."""
    sof3 = b"\xff\xc3" + struct.pack(">HBHHB", 11, 14, height, width, 1) + b"\x01\x11\x00"
    sos = b"\xff\xda" + struct.pack(">HB", 8, 1) + b"\x01\x00\x01\x00\x00"
    return b"\xff\xd8" + sof3 + sos + bytes(range(1, 255)) * 64 + b"\xff\xd9"


def _fake_raw(path: Path, *parts: bytes) -> Path:
    filler = bytes((i * 37) % 251 for i in range(4096))  # not JPEG, no 0xFF
    path.write_bytes(filler.join(parts))
    return path


class EmbeddedJpegTest(unittest.TestCase):
    def test_the_largest_decodable_jpeg_and_the_raws_orientation(self) -> None:
        large = _jpeg((640, 480), (200, 40, 40), progressive=True)
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(
                Path(temp_dir) / "IMG_0001.CR2",
                _tiff_header(6),
                _jpeg((160, 120), (40, 40, 200)),
                _lossless_jpeg(6000, 4000),
                large,
            )
            data, orientation = embedded_jpeg(raw)
        self.assertEqual(data, large)
        self.assertEqual(orientation, 6)

    def test_a_truncated_jpeg_falls_back_to_the_next_largest(self) -> None:
        small = _jpeg((160, 120), (40, 40, 200))
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "cut.NEF", small, _jpeg((640, 480), (200, 40, 40))[:-500])
            data, orientation = embedded_jpeg(raw)
        self.assertEqual(data, small)
        self.assertIsNone(orientation)

    def test_no_embedded_jpeg(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "bare.ARW", _tiff_header(1), _lossless_jpeg(6000, 4000))
            empty = Path(temp_dir) / "empty.ARW"
            empty.write_bytes(b"")
            self.assertIsNone(embedded_jpeg(raw))
            self.assertIsNone(embedded_jpeg(empty))
            with self.assertRaises(ValueError):
                render_raw_preview(raw, Path(temp_dir) / "out.jpg", 512)

    def test_a_real_dng_yields_its_preview(self) -> None:
        data, orientation = embedded_jpeg(DNG_FIXTURE)
        with Image.open(BytesIO(data)) as preview:
            self.assertEqual(preview.format, "JPEG")
            self.assertEqual(preview.size, (256, 144))
        self.assertEqual(orientation, 1)


class RawPreviewRenderTest(unittest.TestCase):
    def test_render_scales_and_carries_the_orientation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "IMG_0002.CR3", _tiff_header(8), _jpeg((1024, 768), (90, 160, 90)))
            target = Path(temp_dir) / "preview.jpg"
            render_raw_preview(raw, target, 512)
            with Image.open(target) as preview:
                self.assertEqual(preview.size, (512, 384))
                self.assertEqual(preview.getexif().get(0x0112), 8)

    def test_without_sips_both_tiers_come_from_the_embedded_jpeg(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            raw = _fake_raw(Path(temp_dir) / "DSC0001.ARW", _tiff_header(1), _jpeg((3000, 2000), (90, 160, 90)))
            service = PreviewService(catalog)
            row = {"asset_id": "raw_1", "canonical_path": str(raw), "width": 6000, "height": 4000}
            with patch("media_workspace.preview_service.shutil.which", return_value=None), \
                    patch("media_workspace.preview_service.subprocess.run") as run_mock:
                thumb = service.generate_for_row(row, "preview", force=True)
                full = service.generate_for_row(row, "preview-hd", force=True)
            run_mock.assert_not_called()
            with Image.open(catalog.root / thumb.relative_path) as preview:
                self.assertEqual(max(preview.size), 512)
            with Image.open(catalog.root / full.relative_path) as preview:
                self.assertEqual(preview.size, (3000, 2000))


if __name__ == "__main__":
    unittest.main()
