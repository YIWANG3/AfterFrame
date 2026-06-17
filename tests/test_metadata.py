from __future__ import annotations

import struct
import tempfile
import unittest
from pathlib import Path

from media_workspace.metadata import camera_stem_token, extract_image_candidate, extract_raw_metadata, quick_fingerprint, stem_key


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
            self.assertEqual(candidate.capture_time, "2026-03-20T10:15:30+00:00")
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
            path = Path(temp_dir) / "0Y1A6380.CR3"
            path.write_bytes(b"\x00" * 344 + tiff + b"\x00" * 256)

            metadata = extract_raw_metadata(path)

            self.assertEqual(metadata.camera_make, "Canon")
            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.software, "Adobe Photoshop Lightroom")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52+00:00")
            self.assertIsNone(metadata.rating)
            self.assertEqual(metadata.iso, 100)
            self.assertEqual(metadata.aperture, 2.8)
            self.assertEqual(metadata.shutter_speed, 1 / 250)
            self.assertEqual(metadata.focal_length, 70.0)
            self.assertEqual(metadata.width, 6000)
            self.assertEqual(metadata.height, 4000)

    def test_extract_raw_metadata_falls_back_to_larger_sample(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[
                    (0x0110, 2, "Canon EOS R6m2"),
                    (0x0132, 2, "2026:01:11 15:03:52"),
                ]
            )
            path = Path(temp_dir) / "0Y1A7000.CR3"
            path.write_bytes(b"\x00" * (700 * 1024) + tiff + b"\x00" * 256)

            metadata = extract_raw_metadata(path)

            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52+00:00")

    def test_extract_raw_metadata_matcher_profile_skips_nonessential_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tiff = _build_tiff(
                ifd0=[
                    (0x0110, 2, "Canon EOS R6m2"),
                    (0x0100, 4, 6000),
                    (0x0101, 4, 4000),
                    (0x0132, 2, "2026:01:11 15:03:52"),
                ],
                exif=[(0xA434, 2, "RF24-70mm F2.8 L IS USM")],
            )
            path = Path(temp_dir) / "0Y1A7001.CR3"
            path.write_bytes(b"\x00" * 1024 + tiff)

            metadata = extract_raw_metadata(path, metadata_profile="matcher")

            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52+00:00")
            self.assertIsNone(metadata.camera_make)
            self.assertIsNone(metadata.lens_model)
            self.assertIsNone(metadata.iso)
            self.assertIsNone(metadata.width)
            self.assertIsNone(metadata.height)


if __name__ == "__main__":
    unittest.main()
