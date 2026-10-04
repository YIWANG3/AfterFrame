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
from media_workspace.raw_preview import embedded_preview, render_raw_preview

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


def _tiff_with_rgb_preview(width: int, height: int, bits: int, pixels: bytes, orientation: int = 1) -> bytes:
    """A little-endian TIFF shaped like a Hasselblad 3FR/FFF: IFD0 an
    uncompressed RGB preview, IFD1 the raw CFA data (which must be ignored)."""
    ifd0_entries = 10
    ifd0 = 8
    ifd1 = ifd0 + 2 + ifd0_entries * 12 + 4
    ifd1_entries = 8
    bits_at = ifd1 + 2 + ifd1_entries * 12 + 4
    pixels_at = bits_at + 6
    cfa_at = pixels_at + len(pixels)

    def entry(tag: int, kind: int, count: int, value: int) -> bytes:
        return struct.pack("<HHII", tag, kind, count, value)

    head = b"II*\x00" + struct.pack("<I", ifd0)
    first = struct.pack("<H", ifd0_entries) + b"".join([
        entry(0x00FE, 4, 1, 1), entry(0x0100, 4, 1, width), entry(0x0101, 4, 1, height),
        entry(0x0102, 3, 3, bits_at), entry(0x0103, 3, 1, 1), entry(0x0106, 3, 1, 2),
        entry(0x0111, 4, 1, pixels_at), entry(0x0112, 3, 1, orientation),
        entry(0x0115, 3, 1, 3), entry(0x0117, 4, 1, len(pixels)),
    ]) + struct.pack("<I", ifd1)
    second = struct.pack("<H", ifd1_entries) + b"".join([
        entry(0x00FE, 4, 1, 0), entry(0x0100, 4, 1, 400), entry(0x0101, 4, 1, 300),
        entry(0x0102, 3, 1, 16), entry(0x0103, 3, 1, 7), entry(0x0106, 3, 1, 32803),
        entry(0x0111, 4, 1, cfa_at), entry(0x0117, 4, 1, 1000),
    ]) + struct.pack("<I", 0)
    return head + first + second + struct.pack("<HHH", bits, bits, bits) + pixels + bytes(1000)


def _tiff_ifds_at_end(images: list[tuple[int, int, bytes, int]], pad: int = 0) -> bytes:
    """A little-endian TIFF laid out like FFF: `pad` bytes, the pixel data,
    then the IFD chain at the end of the file. One directory per (width,
    height, 8-bit RGB pixels, orientation)."""
    out = bytearray(b"II*\x00" + bytes(4) + bytes(pad))
    placed = []
    for width, height, pixels, orientation in images:
        bits_at = len(out)
        out += struct.pack("<HHH", 8, 8, 8)
        placed.append((width, height, len(out), len(pixels), orientation, bits_at))
        out += pixels
    struct.pack_into("<I", out, 4, len(out))
    for index, (width, height, pixels_at, size, orientation, bits_at) in enumerate(placed):
        entries = [
            (0x00FE, 4, 1, 1), (0x0100, 4, 1, width), (0x0101, 4, 1, height), (0x0102, 3, 3, bits_at),
            (0x0103, 3, 1, 1), (0x0106, 3, 1, 2), (0x0111, 4, 1, pixels_at), (0x0112, 3, 1, orientation),
            (0x0115, 3, 1, 3), (0x0117, 4, 1, size),
        ]
        out += struct.pack("<H", len(entries)) + b"".join(struct.pack("<HHII", *e) for e in entries)
        out += struct.pack("<I", len(out) + 4 if index + 1 < len(placed) else 0)
    return bytes(out)


def _halves(width: int, height: int, top: tuple[int, int, int], bottom: tuple[int, int, int], bits: int = 8) -> bytes:
    rows = []
    for y in range(height):
        colour = top if y < height // 2 else bottom
        if bits == 8:
            rows.append(bytes(colour) * width)
        else:
            rows.append(struct.pack("<HHH", *(c * 257 for c in colour)) * width)
    return b"".join(rows)


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
            data, orientation = embedded_preview(raw)
        self.assertEqual(data, large)
        self.assertEqual(orientation, 6)

    def test_a_truncated_jpeg_falls_back_to_the_next_largest(self) -> None:
        small = _jpeg((160, 120), (40, 40, 200))
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "cut.NEF", small, _jpeg((640, 480), (200, 40, 40))[:-500])
            data, orientation = embedded_preview(raw)
        self.assertEqual(data, small)
        self.assertIsNone(orientation)

    def test_no_embedded_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "bare.ARW", _tiff_header(1), _lossless_jpeg(6000, 4000))
            empty = Path(temp_dir) / "empty.ARW"
            empty.write_bytes(b"")
            self.assertIsNone(embedded_preview(raw))
            self.assertIsNone(embedded_preview(empty))
            with self.assertRaises(ValueError):
                render_raw_preview(raw, Path(temp_dir) / "out.jpg", 512)

    def test_a_real_dng_yields_its_preview(self) -> None:
        data, orientation = embedded_preview(DNG_FIXTURE)
        with Image.open(BytesIO(data)) as preview:
            self.assertEqual(preview.format, "JPEG")
            self.assertEqual(preview.size, (256, 144))
        self.assertEqual(orientation, 1)


class UncompressedPreviewTest(unittest.TestCase):
    """Hasselblad 3FR/FFF keep their preview as uncompressed RGB in a TIFF directory."""

    def test_an_rgb_preview_in_the_tiff_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = Path(temp_dir) / "B0000239.3FR"
            raw.write_bytes(_tiff_with_rgb_preview(320, 240, 8, _halves(320, 240, (200, 30, 30), (30, 30, 200)), orientation=6))
            data, orientation = embedded_preview(raw)
        with Image.open(BytesIO(data)) as preview:
            self.assertEqual(preview.size, (320, 240))
            self.assertEqual(preview.convert("RGB").getpixel((10, 10)), (200, 30, 30))
            self.assertEqual(preview.convert("RGB").getpixel((10, 230)), (30, 30, 200))
        self.assertEqual(orientation, 6)

    def test_a_sixteen_bit_preview_is_scaled_to_eight_bits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = Path(temp_dir) / "scan.fff"
            raw.write_bytes(_tiff_with_rgb_preview(64, 48, 16, _halves(64, 48, (128, 64, 32), (10, 250, 90), bits=16)))
            data, _orientation = embedded_preview(raw)
        with Image.open(BytesIO(data)) as preview:
            self.assertEqual(preview.convert("RGB").getpixel((5, 5)), (128, 64, 32))
            self.assertEqual(preview.convert("RGB").getpixel((5, 40)), (10, 250, 90))

    def test_the_orientation_is_read_from_an_ifd0_at_the_end_of_the_file(self) -> None:
        # FFF writes IFD0 after the raw data, megabytes in.
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = Path(temp_dir) / "B_00206.fff"
            raw.write_bytes(_tiff_ifds_at_end([(64, 48, _halves(64, 48, (9, 9, 9), (99, 99, 99)), 8)], pad=600_000))
            _data, orientation = embedded_preview(raw)
        self.assertEqual(orientation, 8)

    def test_an_already_rotated_copy_keeps_its_own_orientation(self) -> None:
        # IFD0 is stored landscape with the RAW's orientation 8; the larger
        # copy is already portrait and says 1. Rotating it again would be wrong.
        landscape = (64, 48, _halves(64, 48, (9, 9, 9), (99, 99, 99)), 8)
        portrait = (60, 80, _halves(60, 80, (9, 9, 9), (99, 99, 99)), 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = Path(temp_dir) / "Swiss.fff"
            raw.write_bytes(_tiff_ifds_at_end([landscape, portrait]))
            data, orientation = embedded_preview(raw)
        with Image.open(BytesIO(data)) as preview:
            self.assertEqual(preview.size, (60, 80))
        self.assertEqual(orientation, 1)

    def test_the_larger_of_a_jpeg_and_an_rgb_preview_wins(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            small_rgb = _tiff_with_rgb_preview(160, 120, 8, _halves(160, 120, (1, 2, 3), (4, 5, 6)))
            big_jpeg = _jpeg((640, 480), (90, 160, 90))
            jpeg_wins = Path(temp_dir) / "a.3fr"
            jpeg_wins.write_bytes(small_rgb + big_jpeg)
            big_rgb = _tiff_with_rgb_preview(640, 480, 8, _halves(640, 480, (1, 2, 3), (4, 5, 6)))
            rgb_wins = Path(temp_dir) / "b.3fr"
            rgb_wins.write_bytes(big_rgb + _jpeg((160, 120), (90, 160, 90)))
            self.assertEqual(embedded_preview(jpeg_wins)[0], big_jpeg)
            with Image.open(BytesIO(embedded_preview(rgb_wins)[0])) as preview:
                self.assertEqual((preview.format, preview.size), ("TIFF", (640, 480)))


class RawPreviewRenderTest(unittest.TestCase):
    def test_render_scales_and_carries_the_orientation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = _fake_raw(Path(temp_dir) / "IMG_0002.CR3", _tiff_header(8), _jpeg((1024, 768), (90, 160, 90)))
            target = Path(temp_dir) / "preview.jpg"
            render_raw_preview(raw, target, 512)
            with Image.open(target) as preview:
                self.assertEqual(preview.size, (512, 384))
                self.assertEqual(preview.getexif().get(0x0112), 8)

    def test_without_sips_both_tiers_come_from_the_embedded_preview(self) -> None:
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
