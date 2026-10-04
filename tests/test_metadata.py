from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace import exiftool
from media_workspace.metadata import (
    _from_exiftool,
    camera_stem_token,
    extract_image_candidate,
    extract_raw_metadata,
    quick_fingerprint,
    stem_key,
)

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        found = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in found
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0) on macOS until its parent reaps it.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _build_tiff(
    ifd0: list[tuple[int, int, object]],
    exif: list[tuple[int, int, object]] | None = None,
    gps: list[tuple[int, int, object]] | None = None,
) -> bytes:
    exif = exif or []
    gps = gps or []
    entries = list(ifd0)
    if exif:
        entries.append((0x8769, 4, 0))
    if gps:
        entries.append((0x8825, 4, 0))

    def encode_value(field_type: int, value: object) -> bytes:
        if field_type == 2:
            payload = str(value).encode("utf-8")
            return payload if payload.endswith(b"\x00") else payload + b"\x00"
        if field_type == 3:
            values = value if isinstance(value, list) else [value]
            return b"".join(struct.pack("<H", int(item)) for item in values)
        if field_type == 4:
            values = value if isinstance(value, list) else [value]
            return b"".join(struct.pack("<I", int(item)) for item in values)
        if field_type == 5:
            values = value if isinstance(value, list) else [value]
            encoded = bytearray()
            for numerator, denominator in values:
                encoded.extend(struct.pack("<I", int(numerator)))
                encoded.extend(struct.pack("<I", int(denominator)))
            return bytes(encoded)
        raise ValueError(f"unsupported field type: {field_type}")

    def write_ifd(tags: list[tuple[int, int, object]], extra_base_offset: int, next_ifd: int = 0) -> tuple[bytes, bytes]:
        extra = bytearray()
        records = bytearray()
        for tag, field_type, value in tags:
            encoded = encode_value(field_type, value)
            unit_size = {2: 1, 3: 2, 4: 4, 5: 8}[field_type]
            count = len(encoded) // unit_size
            if len(encoded) <= 4:
                value_field = encoded.ljust(4, b"\x00")
            else:
                pointer = extra_base_offset + len(extra)
                extra.extend(encoded)
                value_field = struct.pack("<I", pointer)
            records.extend(struct.pack("<HHI", tag, field_type, count))
            records.extend(value_field)
        return struct.pack("<H", len(tags)) + records + struct.pack("<I", next_ifd), bytes(extra)

    base = b"II*\x00\x08\x00\x00\x00"
    ifd0_extra_base = 8 + 2 + len(entries) * 12 + 4
    ifd0_blob, ifd0_extra = write_ifd(entries, extra_base_offset=ifd0_extra_base)
    if exif:
        exif_offset = 8 + len(ifd0_blob) + len(ifd0_extra)
        ifd0_blob = bytearray(ifd0_blob)
        pointer_position = 2 + entries.index((0x8769, 4, 0)) * 12 + 8
        ifd0_blob[pointer_position : pointer_position + 4] = struct.pack("<I", exif_offset)
        exif_extra_base = exif_offset + 2 + len(exif) * 12 + 4
        exif_blob, exif_extra = write_ifd(exif, extra_base_offset=exif_extra_base)
    else:
        exif_blob = b""
        exif_extra = b""

    if gps:
        gps_offset = 8 + len(ifd0_blob) + len(ifd0_extra) + len(exif_blob) + len(exif_extra)
        ifd0_blob = bytearray(ifd0_blob)
        pointer_position = 2 + entries.index((0x8825, 4, 0)) * 12 + 8
        ifd0_blob[pointer_position : pointer_position + 4] = struct.pack("<I", gps_offset)
        gps_extra_base = gps_offset + 2 + len(gps) * 12 + 4
        gps_blob, gps_extra = write_ifd(gps, extra_base_offset=gps_extra_base)
    else:
        gps_blob = b""
        gps_extra = b""

    return base + bytes(ifd0_blob) + ifd0_extra + exif_blob + exif_extra + gps_blob + gps_extra


def _build_jpeg_with_exif(tiff: bytes, width: int, height: int) -> bytes:
    app1_payload = b"Exif\x00\x00" + tiff
    app1 = b"\xff\xe1" + struct.pack(">H", len(app1_payload) + 2) + app1_payload
    return _build_jpeg(app1, width=width, height=height)


def _build_jpeg_with_xmp(exif_tiff: bytes, xmp: str, width: int, height: int) -> bytes:
    exif_payload = b"Exif\x00\x00" + exif_tiff
    exif_segment = b"\xff\xe1" + struct.pack(">H", len(exif_payload) + 2) + exif_payload
    xmp_payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp.encode("utf-8")
    xmp_segment = b"\xff\xe1" + struct.pack(">H", len(xmp_payload) + 2) + xmp_payload
    return _build_jpeg(exif_segment + xmp_segment, width=width, height=height)


def _build_jpeg(app_segments: bytes, width: int, height: int) -> bytes:
    sof0 = (
        b"\xff\xc0"
        + struct.pack(">H", 17)
        + b"\x08"
        + struct.pack(">H", height)
        + struct.pack(">H", width)
        + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    )
    return b"\xff\xd8" + app_segments + sof0 + b"\xff\xd9"


class MetadataExtractionTest(unittest.TestCase):
    def test_quick_fingerprint_supports_head_only_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "demo.CR3"
            path.write_bytes(b"prefix" + b"\x00" * 1024 + b"suffix")

            head_tail = quick_fingerprint(path, mode="head-tail")
            head_only = quick_fingerprint(path, mode="head-only")

            self.assertNotEqual(head_tail, head_only)

    def test_stem_key_keeps_camera_sequence_numbers(self) -> None:
        self.assertEqual(stem_key("IMG_3746"), "img-3746")
        self.assertEqual(stem_key("IMG_0127"), "img-0127")
        self.assertEqual(stem_key("IMG_0412-2"), "img-0412")
        self.assertEqual(stem_key("B0023524-2"), "b0023524")

    def test_camera_stem_token_recognizes_camera_style_names(self) -> None:
        self.assertEqual(camera_stem_token("IMG_3746"), "img-3746")
        self.assertEqual(camera_stem_token("B0023524-2"), "b0023524")
        self.assertEqual(camera_stem_token("0Y1A6139-Edit"), "0y1a6139")
        self.assertIsNone(camera_stem_token("cover-final"))

    def test_extract_image_candidate_reads_jpeg_exif(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[
                    (0x010F, 2, "Canon"),
                    (0x0110, 2, "Canon EOS R6m2"),
                    (0x0131, 2, "Adobe Photoshop Lightroom"),
                ],
                exif=[
                    (0x9003, 2, "2026:03:20 10:15:30"),
                    (0xA434, 2, "RF24-70mm F2.8 L IS USM"),
                    (0x8827, 3, 100),
                    (0x829D, 5, (28, 10)),
                    (0x829A, 5, (1, 250)),
                    (0x920A, 5, (70, 1)),
                    (0x9209, 3, 0),
                    (0xA403, 3, 0),
                    (0xA001, 3, 1),
                    (0xA432, 5, [(24, 1), (70, 1), (28, 10), (28, 10)]),
                ],
                gps=[
                    (0x0001, 2, "N"),
                    (0x0002, 5, [(37, 1), (54, 1), (42066, 1000)]),
                    (0x0003, 2, "W"),
                    (0x0004, 5, [(122, 1), (36, 1), (39852, 1000)]),
                ],
            )
            jpeg = _build_jpeg_with_exif(tiff, width=5926, height=3870)
            path = Path(temp_dir) / "0Y1A6380-Edit.jpg"
            path.write_bytes(jpeg)

            candidate = extract_image_candidate(path)

            self.assertEqual(candidate.camera_make, "Canon")
            self.assertEqual(candidate.camera_model, "Canon EOS R6m2")
            self.assertEqual(candidate.lens_model, "RF24-70mm F2.8 L IS USM")
            self.assertEqual(candidate.software, "Adobe Photoshop Lightroom")
            self.assertEqual(candidate.capture_time, "2026-03-20T10:15:30")
            self.assertEqual(candidate.iso, 100)
            self.assertEqual(candidate.aperture, 2.8)
            self.assertEqual(candidate.shutter_speed, 1 / 250)
            self.assertEqual(candidate.focal_length, 70.0)
            self.assertEqual(candidate.flash, 0)
            self.assertEqual(candidate.white_balance, 0)
            self.assertEqual(candidate.color_space, 1)
            self.assertEqual(candidate.lens_specification, [24.0, 70.0, 2.8, 2.8])
            self.assertAlmostEqual(candidate.gps_latitude or 0.0, 37.911685, places=5)
            self.assertAlmostEqual(candidate.gps_longitude or 0.0, -122.61107, places=5)
            self.assertEqual(candidate.width, 5926)
            self.assertEqual(candidate.height, 3870)

    def test_extract_image_candidate_reads_embedded_xmp_rating(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[(0x0110, 2, "CFV 100C/907X")],
                exif=[(0x9003, 2, "2026:03:20 10:15:30")],
            )
            xmp = """<x:xmpmeta xmlns:x='adobe:ns:meta/' xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
<rdf:RDF>
<rdf:Description xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmp:Rating='5' />
</rdf:RDF>
</x:xmpmeta>"""
            jpeg = _build_jpeg_with_xmp(tiff, xmp, width=5926, height=3870)
            path = Path(temp_dir) / "B0023524-2.jpg"
            path.write_bytes(jpeg)

            candidate = extract_image_candidate(path)

            self.assertEqual(candidate.rating, 5)

    def test_extract_raw_metadata_reads_embedded_tiff(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[
                    (0x010F, 2, "Canon"),
                    (0x0110, 2, "Canon EOS R6m2"),
                    (0x0131, 2, "Adobe Photoshop Lightroom"),
                    (0x0100, 4, 6000),
                    (0x0101, 4, 4000),
                    (0x0132, 2, "2026:01:11 15:03:52"),
                ],
                exif=[
                    (0x8827, 3, 100),
                    (0x829D, 5, (28, 10)),
                    (0x829A, 5, (1, 250)),
                    (0x920A, 5, (70, 1)),
                ],
            )
            path = Path(temp_dir) / "0Y1A6380.CR2"
            path.write_bytes(tiff)

            metadata = extract_raw_metadata(path)

            self.assertEqual(metadata.camera_make, "Canon")
            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.software, "Adobe Photoshop Lightroom")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52")
            self.assertIsNone(metadata.rating)
            self.assertEqual(metadata.iso, 100)
            self.assertEqual(metadata.aperture, 2.8)
            self.assertEqual(metadata.shutter_speed, 1 / 250)
            self.assertEqual(metadata.focal_length, 70.0)
            self.assertEqual(metadata.width, 6000)
            self.assertEqual(metadata.height, 4000)

    def test_lens_make_is_read_when_written_and_empty_when_blank(self) -> None:
        # A third-party lens: LensMake names it (Tamron on Fujifilm), or the
        # field is there but blank (Tamron on a Nikon body writes spaces).
        with tempfile.TemporaryDirectory() as temp_dir:
            for name, lens_make, expected in (("tamron", "TAMRON", "TAMRON"), ("blank", "     ", None), ("none", None, None)):
                exif = [(0xA434, 2, "E 70-180mm F2.8 A056")]
                if lens_make is not None:
                    exif.append((0xA433, 2, lens_make))
                tiff = _build_tiff(ifd0=[(0x010F, 2, "SONY"), (0x0110, 2, "ILCE-7M4")], exif=exif)
                path = Path(temp_dir) / f"{name}.jpg"
                path.write_bytes(_build_jpeg_with_exif(tiff, width=600, height=400))
                candidate = extract_image_candidate(path)
                self.assertEqual(candidate.lens_model, "E 70-180mm F2.8 A056")
                self.assertEqual(candidate.lens_make, expected, name)

            tiff = _build_tiff(
                ifd0=[(0x010F, 2, "NIKON CORPORATION"), (0x0110, 2, "NIKON Z 8"), (0x0100, 4, 6000), (0x0101, 4, 4000)],
                exif=[(0xA434, 2, "LAOWA FFII 12mm F2.8 C&D Dreamer"), (0xA433, 2, "LAOWA")],
            )
            path = Path(temp_dir) / "DSC_0001.NEF"
            path.write_bytes(tiff)
            self.assertEqual(extract_raw_metadata(path).lens_make, "LAOWA")

    def test_extract_raw_metadata_matcher_profile_skips_nonessential_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[
                    (0x0110, 2, "Canon EOS R6m2"),
                    (0x0100, 4, 6000),
                    (0x0101, 4, 4000),
                    (0x0132, 2, "2026:01:11 15:03:52"),
                ],
                exif=[(0xA434, 2, "RF24-70mm F2.8 L IS USM"), (0xA433, 2, "Canon")],
            )
            path = Path(temp_dir) / "0Y1A7001.CR2"
            path.write_bytes(tiff)

            metadata = extract_raw_metadata(path, metadata_profile="matcher")

            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52")
            self.assertIsNone(metadata.camera_make)
            self.assertIsNone(metadata.lens_model)
            self.assertIsNone(metadata.lens_make)
            self.assertIsNone(metadata.iso)
            self.assertIsNone(metadata.width)
            self.assertIsNone(metadata.height)


class ExifToolMappingTest(unittest.TestCase):
    """How ExifTool's tags become the catalog's fields."""

    def test_adobe_rgb_from_exif_maker_notes_or_the_interop_index(self) -> None:
        def color_space(**tags):
            return _from_exiftool({key.replace("__", ":"): value for key, value in tags.items()})["color_space"]

        self.assertEqual(color_space(ExifIFD__ColorSpace=65535), 65535)
        self.assertEqual(color_space(ExifIFD__ColorSpace=1), 1)
        self.assertEqual(color_space(Nikon__ColorSpace=2), 65535)  # a NEF has no EXIF ColorSpace
        self.assertEqual(color_space(Nikon__ColorSpace=1), 1)
        self.assertEqual(color_space(ExifIFD__ColorSpace=1, Canon__ColorSpace=2), 65535)
        self.assertEqual(color_space(ExifIFD__ColorSpace=65535, InteropIFD__InteropIndex="R03 - DCF option file (Adobe RGB)"), 65535)
        self.assertIsNone(color_space())

    def test_the_capture_time_from_wherever_it_was_written(self) -> None:
        def captured(tags):
            return _from_exiftool(tags)["capture_time"]

        self.assertEqual(captured({"ExifIFD:DateTimeOriginal": "2024:07:13 09:12:53"}), "2024-07-13T09:12:53")
        self.assertEqual(captured({"ExifIFD:DateTimeOriginal": "2019-10-18T16:25:03"}), "2019-10-18T16:25:03")  # Hasselblad
        self.assertEqual(captured({"IFD0:DateTimeOriginal": "2023:05:01 08:00:00"}), "2023-05-01T08:00:00")  # Nikon
        # An export whose EXIF was stripped keeps XMP; the wall clock, not the instant.
        self.assertEqual(captured({"XMP-photoshop:DateCreated": "2025:10:04 17:34:08.120-08:00"}), "2025-10-04T17:34:08")
        # An unset camera clock is no date.
        unset = {"ExifIFD:DateTimeOriginal": "0000:00:00 00:00:00", "IFD0:ModifyDate": "2024:01:01 10:00:00"}
        self.assertEqual(captured(unset), "2024-01-01T10:00:00")
        self.assertIsNone(captured({"XMP-photoshop:DateCreated": "2024:07:13"}))

    def test_lens_names(self) -> None:
        def lens(tags):
            return _from_exiftool(tags)["lens_model"]

        named = {"ExifIFD:LensModel": "RF24-70mm F2.8 L IS USM", "Composite:LensID": "Canon RF 24-70mm F2.8L IS USM"}
        self.assertEqual(lens(named), "RF24-70mm F2.8 L IS USM")
        self.assertEqual(lens({"Composite:LensID": "AF-S Nikkor 24-70mm f/2.8G ED"}), "AF-S Nikkor 24-70mm f/2.8G ED")
        self.assertEqual(lens({"Composite:LensID": "Unknown (00 0 0)", "PhaseOne:LensModel": "Schneider 80mm LS"}), "Schneider 80mm LS")
        self.assertIsNone(lens({"Composite:LensID": "65535", "ExifIFD:LensModel": "   "}))
        self.assertIsNone(lens({"ExifIFD:LensModel": "----", "Composite:LensID": "E-Mount, T-Mount, Other Lens or no lens"}))
        self.assertEqual(lens({"ExifIFD:LensModel": "28 - 70mm F2.8 DG DN | Contemporary 021"}), "28 - 70mm F2.8 DG DN | Contemporary 021")

    def test_numbers(self) -> None:
        found = _from_exiftool({
            "ExifIFD:ISO": "100 0",
            "ExifIFD:LensInfo": "70 200 0 0",
            "Composite:ImageSize": "6000x4000",
            "Composite:GPSLatitude": -33.8568,
            "Composite:GPSLongitude": "151.2153",
            "XMP-xmp:Rating": 0,
        })
        self.assertEqual((found["iso"], found["lens_specification"]), (100, [70.0, 200.0]))
        self.assertEqual((found["width"], found["height"]), (6000, 4000))
        self.assertEqual((found["gps_latitude"], found["gps_longitude"]), (-33.8568, 151.2153))
        self.assertEqual(found["rating"], 0)
        # A manual lens on a Sony: no aperture or focal length, written as 0.
        manual = _from_exiftool({"ExifIFD:FNumber": 0, "ExifIFD:FocalLength": 0, "Sony:FocalLength": 0, "ExifIFD:ISO": 0})
        self.assertEqual((manual["aperture"], manual["focal_length"], manual["iso"]), (None, None, None))
        heif = _from_exiftool({"Composite:ImageSize": "800 534", "QuickTime:CleanAperture": "800 533 0 -0.5"})
        self.assertEqual((heif["width"], heif["height"]), (800, 533))


class ExifToolTest(unittest.TestCase):
    def setUp(self) -> None:
        if exiftool.find_command() is None:
            self.fail("ExifTool is missing: run `npm --prefix apps/desktop run fetch:exiftool`")
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.root = Path(temp_dir.name)

    def test_a_camera_dng_and_an_iphone_style_heic(self) -> None:
        raw = extract_raw_metadata(FIXTURES / "raw" / "luna-morning.dng")
        self.assertEqual((raw.camera_make, raw.camera_model, raw.iso), ("Insta360", "Luna Ultra", 275))
        self.assertEqual(raw.capture_time, "2026-08-18T09:19:43")
        self.assertEqual((raw.width, raw.height), (1024, 576))
        heic = extract_image_candidate(FIXTURES / "heic" / "iphone-style.heic")
        self.assertEqual((heic.camera_model, heic.lens_model, heic.rating), ("Canon EOS R6m2", "EF70-200mm f/2.8L IS II USM", 5))
        self.assertEqual((heic.capture_time, heic.width, heic.height), ("2025-10-04T17:34:08", 800, 533))

    def test_an_ifd0_far_into_the_file(self) -> None:
        # Capture One writes IFD0 and the EXIF IFD at the end of its DNGs, tens
        # of MB in (#141): here, past 5 MB of zeros.
        gap = 5 * 1024 * 1024
        ifd0_at = 8 + gap
        make, model, when = b"SONY\x00", b"ILCE-7M4\x00", b"2022:07:31 15:32:58\x00"
        values_at = ifd0_at + 2 + 3 * 12 + 4
        make_at, model_at = values_at, values_at + len(make)
        exif_at = model_at + len(model) + (model_at + len(model)) % 2
        when_at = exif_at + 2 + 2 * 12 + 4
        ifd0 = struct.pack("<H", 3) + b"".join([
            struct.pack("<HHII", 0x010F, 2, len(make), make_at),
            struct.pack("<HHII", 0x0110, 2, len(model), model_at),
            struct.pack("<HHII", 0x8769, 4, 1, exif_at),
        ]) + struct.pack("<I", 0)
        exif = struct.pack("<H", 2) + b"".join([
            struct.pack("<HHIHH", 0x8827, 3, 1, 100, 0),
            struct.pack("<HHII", 0x9003, 2, len(when), when_at),
        ]) + struct.pack("<I", 0)
        body = ifd0 + make + model + b"\x00" * ((model_at + len(model)) % 2) + exif + when
        path = self.root / "DSC07281.dng"
        path.write_bytes(b"II*\x00" + struct.pack("<I", ifd0_at) + b"\x00" * gap + body)
        metadata = extract_raw_metadata(path)
        self.assertEqual((metadata.camera_make, metadata.camera_model, metadata.iso), ("SONY", "ILCE-7M4", 100))
        self.assertEqual(metadata.capture_time, "2022-07-31T15:32:58+00:00")

    def test_a_name_in_any_script(self) -> None:
        path = self.root / "飞飞花鸟岛 沙滩 #2.heic"
        shutil.copyfile(FIXTURES / "heic" / "iphone-style.heic", path)
        self.assertEqual(extract_image_candidate(path).camera_model, "Canon EOS R6m2")

    def test_a_file_it_cant_read_has_no_metadata(self) -> None:
        path = self.root / "IMG_0001.CR3"
        path.write_bytes(b"not a photo")
        metadata = extract_raw_metadata(path)
        self.assertIsNone(metadata.camera_model)
        self.assertIsNone(metadata.capture_time)

    def test_threads_share_the_processes(self) -> None:
        heic = FIXTURES / "heic" / "iphone-style.heic"
        results: list[str | None] = []
        threads = [threading.Thread(target=lambda: results.append(extract_image_candidate(heic).camera_model)) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results, ["Canon EOS R6m2"] * 8)

    def test_a_hung_or_dead_process_is_replaced(self) -> None:
        command = exiftool.find_command()
        assert command is not None
        pool = exiftool.ExifTool(command, size=1)
        self.addCleanup(pool.close)
        heic = FIXTURES / "heic" / "iphone-style.heic"
        with self.assertRaises(exiftool.ExifToolError):
            pool.read(heic, timeout=0)
        self.assertEqual(pool.read(heic)["IFD0:Model"], "Canon EOS R6m2")
        # A process that isn't ExifTool at all: it exits at once, or can't start.
        for command in ([sys.executable, "-c", "pass"], [str(self.root / "no-such-perl")]):
            with self.assertRaises(exiftool.ExifToolError):
                exiftool.ExifTool(command, size=1).read(heic)
        # A name with a line break can't be passed to it (one argument per line).
        self.assertEqual(pool.read(self.root / "two\nlines.jpg"), {})

    def test_a_killed_sidecar_leaves_no_exiftool_behind(self) -> None:
        # At the end of its input a -stay_open ExifTool polls for good; it
        # watches for its parent instead.
        script = (
            "import sys, time\n"
            "from pathlib import Path\n"
            "from media_workspace import exiftool\n"
            "exiftool.read(Path(sys.argv[1]))\n"
            "print(exiftool.shared()._idle.queue[-1]._process.pid, flush=True)\n"
            "time.sleep(60)\n"
        )
        sidecar = subprocess.Popen(
            [sys.executable, "-c", script, str(FIXTURES / "heic" / "iphone-style.heic")],
            stdout=subprocess.PIPE, text=True, env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
        )
        child = int(sidecar.stdout.readline())
        sidecar.kill()
        sidecar.wait()
        sidecar.stdout.close()
        deadline = time.monotonic() + 10
        while _alive(child) and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertFalse(_alive(child), "ExifTool outlived the sidecar")

    def test_a_process_is_renewed_after_a_few_hundred_files(self) -> None:
        command = exiftool.find_command()
        assert command is not None
        started = []
        real = exiftool._Process

        def counting(*args):
            started.append(1)
            return real(*args)

        pool = exiftool.ExifTool(command, size=1)
        self.addCleanup(pool.close)
        with patch.object(exiftool, "_Process", counting), patch.object(exiftool, "_FILES_PER_PROCESS", 2):
            for _ in range(5):
                pool.read(FIXTURES / "heic" / "iphone-style.heic")
        self.assertEqual(len(started), 3)

    def test_an_import_reads_the_next_files_ahead(self) -> None:
        paths = []
        for index in range(10):
            path = self.root / f"IMG_{index:04d}.heic"
            shutil.copyfile(FIXTURES / "heic" / "iphone-style.heic", path)
            paths.append(path)
        pool = exiftool.shared()
        assert pool is not None
        threads: list[str] = []
        real = pool.read

        def recording(path, *args, **kwargs):
            threads.append(threading.current_thread().name)
            return real(path, *args, **kwargs)

        with patch.object(pool, "read", recording):
            seen = []
            for path in exiftool.read_ahead(iter(paths), depth=3, wanted=lambda path: path.name != "IMG_0005.heic"):
                seen.append(path)
                if path.name not in ("IMG_0005.heic", "IMG_0007.heic"):  # skipped, like a deleted file
                    self.assertEqual(extract_image_candidate(path).camera_model, "Canon EOS R6m2")
            self.assertEqual(seen, paths)
            self.assertIn(len(threads), (8, 9))  # each wanted file read once (a skipped one maybe not)
            self.assertTrue(all(name.startswith("exiftool-ahead") for name in threads))
            self.assertEqual(exiftool._ahead, {})
            # A loop that stops early leaves nothing behind either.
            for _ in exiftool.read_ahead(iter(paths), depth=3):
                break
            self.assertEqual(exiftool._ahead, {})

    def test_without_exiftool_an_image_still_has_its_exif(self) -> None:
        with patch.object(exiftool, "read", return_value=None):
            heic = extract_image_candidate(FIXTURES / "heic" / "iphone-style.heic")
            raw = extract_raw_metadata(FIXTURES / "raw" / "luna-morning.dng")
        self.assertEqual((heic.camera_model, heic.iso, heic.capture_time), ("Canon EOS R6m2", 100, "2025-10-04T17:34:08"))
        self.assertEqual((heic.aperture, heic.shutter_speed, heic.focal_length), (4.5, 0.0025, 70.0))
        self.assertEqual((heic.width, heic.height), (800, 533))
        # A RAW: only what LibRaw reads.
        self.assertEqual((raw.camera_model, raw.width, raw.height), (None, 1024, 576))


if __name__ == "__main__":
    unittest.main()
