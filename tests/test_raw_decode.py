from __future__ import annotations

import json
import struct
import subprocess
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import rawpy
from PIL import Image, ImageCms

from media_workspace import raw_decode
from media_workspace.catalog import ensure_catalog
from media_workspace.color_profiles import adobe_rgb_icc
from media_workspace.db import connect, init_db
from media_workspace.preview_service import BlackRenderError, PreviewService, _reject_black
from media_workspace.reverse_lookup import index_raw_file

# A DNG whose raw data is JPEG XL, which LibRaw can't decode without Adobe's
# DNG SDK; the preview the camera embedded is plain JPEG.
JXL_DNG = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"

_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8}


def _encode(kind: int, values) -> bytes:
    if kind == 2:
        return values.encode() + b"\x00"
    if kind == 1:
        return bytes(values)
    if kind == 3:
        return b"".join(struct.pack("<H", value) for value in values)
    if kind == 4:
        return b"".join(struct.pack("<I", value) for value in values)
    return b"".join(struct.pack("<ii" if kind == 10 else "<II", *value) for value in values)


def build_dng(width: int = 64, height: int = 48, orientation: int = 1, crop: tuple[int, int, int, int] | None = None) -> bytes:
    """A minimal uncompressed 16-bit RGGB DNG that LibRaw decodes: red in the
    top half, blue in the bottom. `crop` is DefaultCropOrigin + DefaultCropSize
    as (x, y, width, height)."""
    pixels = bytearray()
    for y in range(height):
        top = y < height // 2
        for x in range(width):
            site = (y % 2) * 2 + (x % 2)  # R, G, G, B
            pixels += struct.pack("<H", (52000 if top else 4000, 9000, 9000, 4000 if top else 52000)[site])
    tags: dict[int, tuple[int, object]] = {
        0x00FE: (4, [0]),  # NewSubfileType: the main image
        0x0100: (4, [width]),
        0x0101: (4, [height]),
        0x0102: (3, [16]),
        0x0103: (3, [1]),  # uncompressed
        0x0106: (3, [32803]),  # CFA
        0x010F: (2, "AfterFrame"),
        0x0110: (2, "Test DNG"),
        0x0111: (4, [0]),  # StripOffsets, filled in below
        0x0112: (3, [orientation]),
        0x0115: (3, [1]),
        0x0116: (4, [height]),
        0x0117: (4, [len(pixels)]),
        0x011C: (3, [1]),
        0x828D: (3, [2, 2]),  # CFARepeatPatternDim
        0x828E: (1, [0, 1, 1, 2]),  # CFAPattern: RGGB
        0xC612: (1, [1, 4, 0, 0]),  # DNGVersion
        0xC614: (2, "AfterFrame Test DNG"),
        0xC61D: (4, [65535]),  # WhiteLevel
        0xC621: (10, [(1, 1), (0, 1), (0, 1), (0, 1), (1, 1), (0, 1), (0, 1), (0, 1), (1, 1)]),  # ColorMatrix1
        0xC628: (5, [(1, 1), (1, 1), (1, 1)]),  # AsShotNeutral
    }
    if crop:
        tags[0xC61F] = (5, [(crop[0], 1), (crop[1], 1)])
        tags[0xC620] = (5, [(crop[2], 1), (crop[3], 1)])
    entries = sorted(tags.items())
    data_at = 8 + 2 + 12 * len(entries) + 4
    extra = bytearray()
    offsets = {}
    for tag, (kind, values) in entries:
        payload = _encode(kind, values)
        if len(payload) > 4:
            offsets[tag] = data_at + len(extra)
            extra += payload + b"\x00" * (len(payload) % 2)
    pixels_at = data_at + len(extra)
    out = bytearray(b"II*\x00" + struct.pack("<IH", 8, len(entries)))
    for tag, (kind, values) in entries:
        payload = struct.pack("<I", pixels_at) if tag == 0x0111 else _encode(kind, values)
        count = len(payload) if kind in (1, 2) else len(payload) // _TYPE_SIZES[kind]
        field = payload.ljust(4, b"\x00") if len(payload) <= 4 else struct.pack("<I", offsets[tag])
        out += struct.pack("<HHI", tag, kind, count) + field
    return bytes(out + struct.pack("<I", 0) + extra + pixels)


def _jpeg(size: tuple[int, int], colour: tuple[int, int, int]) -> bytes:
    out = BytesIO()
    Image.new("RGB", size, colour).save(out, "JPEG")
    return out.getvalue()


class _FakeRaw:
    """rawpy.imread's result, for previews no fixture here carries."""

    def __init__(self, thumb, width: int = 1440, height: int = 1080, flip: int = 0) -> None:
        self.sizes = SimpleNamespace(crop_width=0, crop_height=0, width=width, height=height, flip=flip)
        self._thumb = thumb

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def extract_thumb(self):
        return self._thumb()


class LibRawTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name)

    def _dng(self, name: str = "IMG_0001.dng", **options) -> Path:
        path = self.root / name
        path.write_bytes(build_dng(**options))
        return path

    def test_size_and_orientation_come_from_the_raw(self) -> None:
        info = raw_decode.raw_info(self._dng(orientation=6, crop=(2, 2, 60, 44)))
        self.assertEqual(info, raw_decode.RawInfo(60, 44, 6))
        self.assertEqual(raw_decode.raw_info(self._dng("uncropped.dng", orientation=8)), raw_decode.RawInfo(64, 48, 8))
        self.assertIsNone(raw_decode.raw_info(self.root / "missing.dng"))

    def test_a_decode_is_cropped_unrotated_and_tagged_with_the_orientation(self) -> None:
        target = self.root / "decoded.jpg"
        raw_decode.decode_in_child(self._dng(orientation=6, crop=(2, 2, 60, 44)), target, 8000)
        with Image.open(target) as image:
            self.assertEqual(image.size, (60, 44))
            self.assertEqual(image.getexif().get(0x0112), 6)
            top, bottom = image.convert("RGB").getpixel((30, 5)), image.convert("RGB").getpixel((30, 40))
        self.assertGreater(top[0], top[2])
        self.assertGreater(bottom[2], bottom[0])

    def test_a_decode_that_fails_or_hangs_costs_only_that_preview(self) -> None:
        not_raw = self.root / "notes.dng"
        not_raw.write_bytes(b"not a raw file")
        with self.assertRaises(subprocess.CalledProcessError):
            raw_decode.decode_in_child(not_raw, self.root / "out.jpg", 512)
        with self.assertRaises(subprocess.TimeoutExpired):
            raw_decode.decode_in_child(self._dng(), self.root / "out.jpg", 512, timeout=0.001)

    def test_the_embedded_preview_of_a_raw_libraw_cannot_decode(self) -> None:
        found = raw_decode.embedded_preview(JXL_DNG)
        assert found is not None
        self.assertEqual((found.width, found.height, found.orientation), (256, 144, 1))
        self.assertEqual(found.data[:2], b"\xff\xd8")

    def test_a_16_bit_rgb_preview_becomes_an_8_bit_image(self) -> None:
        bitmap = np.full((1080, 1440, 3), 50000, dtype=np.uint16)  # Hasselblad FFF
        thumb = SimpleNamespace(format=rawpy.ThumbFormat.BITMAP, data=bitmap)
        with patch.object(rawpy, "imread", return_value=_FakeRaw(lambda: thumb, flip=5)):
            found = raw_decode.embedded_preview(self.root / "B0000206.fff")
        assert found is not None
        self.assertEqual(found.orientation, 8)
        with Image.open(BytesIO(found.data)) as image:
            self.assertEqual((image.size, image.getpixel((0, 0))), ((1440, 1080), (195, 195, 195)))

    def test_no_embedded_preview_is_none(self) -> None:
        def heif_cr3():
            raise rawpy.LibRawNoThumbnailError("HEIF")

        with patch.object(rawpy, "imread", return_value=_FakeRaw(heif_cr3)):
            self.assertIsNone(raw_decode.embedded_preview(self.root / "0Y1A0001.CR3"))
        self.assertIsNone(raw_decode.embedded_preview(self.root / "missing.CR3"))

    def test_indexing_records_the_size_libraw_reads(self) -> None:
        catalog = ensure_catalog(self.root / "demo.afcatalog")
        connection = connect(catalog.db_path)
        self.addCleanup(connection.close)
        init_db(connection)
        index_raw_file(connection, self._dng("DJI_0001.dng", orientation=6, crop=(2, 2, 60, 44)))
        metadata = json.loads(connection.execute("SELECT metadata_json FROM assets").fetchone()[0])
        self.assertEqual((metadata["width"], metadata["height"]), (60, 44))


class RawPreviewOrderTest(unittest.TestCase):
    """The camera's embedded preview when it's big enough for the tier; then,
    on macOS, Image I/O; then a LibRaw decode; then the embedded preview
    whatever its size."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name)
        self.catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.raw = self.root / "IMG_0001.CR3"
        self.raw.write_bytes(b"raw")
        self.calls: list[str] = []

    def _render(
        self,
        kind: str,
        embedded_size: tuple[int, int] | None,
        sips: bool,
        image_io_errors: dict[str, Exception] | None = None,
        decode_fails: bool = False,
        metadata: dict | None = None,
    ) -> Image.Image:
        service = PreviewService(self.catalog)
        embedded = None
        if embedded_size:
            embedded = raw_decode.EmbeddedPreview(_jpeg(embedded_size, (90, 160, 90)), *embedded_size, 6)

        def image_io(tool):
            def render(source, output, size=None, validate=None):
                self.calls.append(f"{tool}:{size}" if size else tool)
                if tool in (image_io_errors or {}):
                    raise (image_io_errors or {})[tool]
                Image.new("RGB", (64, 48), (10, 120, 200)).save(output, "JPEG")
                return output

            return render

        def decode(source, target, long_edge, timeout=None):
            self.calls.append(f"libraw:{long_edge}")
            if decode_fails:
                raise subprocess.CalledProcessError(1, "decode-raw")
            Image.new("RGB", (64, 48), (200, 20, 20)).save(target, "JPEG")

        row = {
            "asset_id": "raw_abcdef123456",
            "canonical_path": str(self.raw),
            "width": 6000,
            "height": 4000,
            "metadata_json": json.dumps(metadata or {}),
        }
        with (
            patch.object(raw_decode, "embedded_preview", return_value=embedded),
            patch.object(raw_decode, "decode_in_child", side_effect=decode),
            patch.object(raw_decode, "available", return_value=True),
            patch("media_workspace.preview_service.shutil.which", return_value="/usr/bin/sips" if sips else None),
            patch.object(service, "_render_with_quicklook", side_effect=image_io("quicklook")),
            patch.object(service, "_render_raw_fullres", side_effect=image_io("sips")),
        ):
            result = service.generate_for_row(row, kind, force=True)
        with Image.open(self.catalog.root / result.relative_path) as image:
            image.load()
            return image

    def test_a_big_enough_embedded_preview_is_all_it_takes(self) -> None:
        for sips in (True, False):
            image = self._render("preview", (1620, 1080), sips=sips)
            self.assertEqual((image.size, image.getexif().get(0x0112)), ((512, 341), 6))
        image = self._render("preview-hd", (6000, 4000), sips=True)
        self.assertEqual(image.size, (6000, 4000))
        self.assertEqual(self.calls, [])

    def test_macos_tries_image_io_before_libraw(self) -> None:
        self._render("preview", (160, 120), sips=True)
        self.assertEqual(self.calls, ["quicklook:512"])
        self.calls.clear()
        image = self._render("preview", (160, 120), sips=True, image_io_errors={"quicklook": subprocess.TimeoutExpired("qlmanage", 90)})
        self.assertEqual(self.calls, ["quicklook:512", "libraw:512"])
        self.assertGreater(image.getpixel((5, 5))[0], 150)  # LibRaw's

    def test_macos_hd_tries_quick_look_only_for_what_sips_turned_black(self) -> None:
        self._render("preview-hd", (1620, 1080), sips=True)
        self.assertEqual(self.calls, ["sips"])
        self.calls.clear()
        # A Lightroom Enhanced-NR DNG: sips renders it black, Quick Look doesn't.
        self._render("preview-hd", (1620, 1080), sips=True, image_io_errors={"sips": BlackRenderError("black")})
        self.assertEqual(self.calls, ["sips", "quicklook:8000"])
        self.calls.clear()
        # An IIQ: sips can't open it and Quick Look would hang, so LibRaw.
        sips_failed = subprocess.CalledProcessError(13, "sips")
        self._render("preview-hd", (641, 480), sips=True, image_io_errors={"sips": sips_failed})
        self.assertEqual(self.calls, ["sips", "libraw:8000"])

    def test_without_image_io_libraw_decodes_then_the_small_preview_will_do(self) -> None:
        self._render("preview", (160, 120), sips=False)
        self.assertEqual(self.calls, ["libraw:512"])
        self.calls.clear()
        image = self._render("preview-hd", (1620, 1080), sips=False, decode_fails=True)
        self.assertEqual(self.calls, ["libraw:8000"])
        self.assertEqual(image.size, (1620, 1080))
        with self.assertRaises(ValueError):
            self._render("preview", None, sips=False, decode_fails=True)

    def test_colour_space_and_hd_exif_come_from_the_catalog(self) -> None:
        metadata = {
            "color_space": 65535,
            "camera_make": "Canon",
            "camera_model": "Canon EOS R6m2",
            "capture_time": "2024-07-13T09:12:53",
            "lens_model": "RF24-70mm F2.8 L IS USM",
            "iso": 100,
            "aperture": 5.6,
            "shutter_speed": 0.002,
            "focal_length": 62.0,
            "gps_latitude": 37.74,
            "gps_longitude": -119.5833,
        }
        image = self._render("preview-hd", (6000, 4000), sips=True, metadata=metadata)
        exif = image.getexif()
        details, gps = exif.get_ifd(0x8769), exif.get_ifd(0x8825)
        self.assertEqual(image.info.get("icc_profile"), adobe_rgb_icc())
        self.assertEqual((exif.get(0x010F), exif.get(0x0110), exif.get(0x0112)), ("Canon", "Canon EOS R6m2", 6))
        self.assertEqual(
            (details.get(0x9003), details.get(0xA434), details.get(0x8827)),
            ("2024:07:13 09:12:53", "RF24-70mm F2.8 L IS USM", 100),
        )
        self.assertEqual((gps.get(1), gps.get(3)), ("N", "W"))
        thumbnail = self._render("preview", (6000, 4000), sips=True, metadata=metadata)
        self.assertEqual(thumbnail.info.get("icc_profile"), adobe_rgb_icc())
        self.assertIsNone(thumbnail.getexif().get(0x010F))  # thumbnails carry only the orientation
        srgb = self._render("preview", (6000, 4000), sips=True, metadata={**metadata, "color_space": 1})
        self.assertIsNone(srgb.info.get("icc_profile"))  # untagged, like every other preview


class AdobeRgbProfileTest(unittest.TestCase):
    def test_it_converts_like_the_one_macos_ships(self) -> None:
        apple = Path("/System/Library/ColorSync/Profiles/AdobeRGB1998.icc")
        if not apple.exists():
            self.skipTest("no AdobeRGB1998.icc here")
        ours = ImageCms.ImageCmsProfile(BytesIO(adobe_rgb_icc()))
        srgb = ImageCms.createProfile("sRGB")
        colours = Image.new("RGB", (64, 1))
        colours.putdata([(r * 85, g * 85, b * 85) for r in range(4) for g in range(4) for b in range(4)])
        converted = [ImageCms.profileToProfile(colours, profile, srgb) for profile in (ours, ImageCms.ImageCmsProfile(str(apple)))]
        differences = np.abs(np.asarray(converted[0], dtype=int) - np.asarray(converted[1], dtype=int))
        self.assertLessEqual(int(differences.max()), 1)


class BlackRenderTest(unittest.TestCase):
    def test_an_all_black_render_is_a_failure_and_a_night_shot_is_not(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            black, night = Path(temp_dir) / "black.jpg", Path(temp_dir) / "night.jpg"
            Image.new("RGB", (400, 300), (0, 0, 0)).save(black)
            dark = Image.new("RGB", (400, 300), (2, 2, 3))
            dark.paste((240, 230, 200), (180, 40, 220, 60))  # a lit window
            dark.save(night)
            with self.assertRaises(BlackRenderError):
                _reject_black(black)
            _reject_black(night)


if __name__ == "__main__":
    unittest.main()
