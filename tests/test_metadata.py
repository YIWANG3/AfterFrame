from __future__ import annotations

import struct
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from media_workspace.metadata import (
    EMBEDDED_METADATA_SAMPLE_STEPS,
    EXIF_SAMPLE_BYTES,
    TIFF_IFD_WINDOW_BYTES,
    camera_stem_token,
    extract_embedded_metadata_from_handle,
    extract_image_candidate,
    extract_raw_metadata,
    quick_fingerprint,
    stem_key,
)


def _encode_value(field_type: int, value: object) -> bytes:
    if field_type in (1, 7):
        return str(value).encode("utf-8")
    if field_type == 2:
        payload = str(value).encode("utf-8")
        return payload if payload.endswith(b"\x00") else payload + b"\x00"
    if field_type == 3:
        values = value if isinstance(value, list) else [value]
        return b"".join(struct.pack("<H", int(item)) for item in values)
    if field_type in (4, 13):
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


def _write_ifd(tags: list[tuple[int, int, object]], extra_base_offset: int, next_ifd: int = 0) -> tuple[bytes, bytes]:
    extra = bytearray()
    records = bytearray()
    for tag, field_type, value in tags:
        encoded = _encode_value(field_type, value)
        unit_size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 13: 4}[field_type]
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

    base = b"II*\x00\x08\x00\x00\x00"
    ifd0_extra_base = 8 + 2 + len(entries) * 12 + 4
    ifd0_blob, ifd0_extra = _write_ifd(entries, extra_base_offset=ifd0_extra_base)
    if exif:
        exif_offset = 8 + len(ifd0_blob) + len(ifd0_extra)
        ifd0_blob = bytearray(ifd0_blob)
        pointer_position = 2 + entries.index((0x8769, 4, 0)) * 12 + 8
        ifd0_blob[pointer_position : pointer_position + 4] = struct.pack("<I", exif_offset)
        exif_extra_base = exif_offset + 2 + len(exif) * 12 + 4
        exif_blob, exif_extra = _write_ifd(exif, extra_base_offset=exif_extra_base)
    else:
        exif_blob = b""
        exif_extra = b""

    if gps:
        gps_offset = 8 + len(ifd0_blob) + len(ifd0_extra) + len(exif_blob) + len(exif_extra)
        ifd0_blob = bytearray(ifd0_blob)
        pointer_position = 2 + entries.index((0x8825, 4, 0)) * 12 + 8
        ifd0_blob[pointer_position : pointer_position + 4] = struct.pack("<I", gps_offset)
        gps_extra_base = gps_offset + 2 + len(gps) * 12 + 4
        gps_blob, gps_extra = _write_ifd(gps, extra_base_offset=gps_extra_base)
    else:
        gps_blob = b""
        gps_extra = b""

    return base + bytes(ifd0_blob) + ifd0_extra + exif_blob + exif_extra + gps_blob + gps_extra


def _build_tiff_with_ifds_at(
    ifd0_at: int,
    ifd0: list[tuple[int, int, object]],
    exif_at: int | None = None,
    exif: list[tuple[int, int, object]] | None = None,
    gps_at: int | None = None,
    gps: list[tuple[int, int, object]] | None = None,
    pointer_type: int = 4,
) -> bytes:
    """A TIFF whose IFDs sit at the given offsets, each followed by its
    values, zeros in between: Capture One writes IFD0 at the end of a DNG."""
    ifd0 = list(ifd0)
    if exif is not None:
        ifd0.append((0x8769, pointer_type, exif_at))
    if gps is not None:
        ifd0.append((0x8825, pointer_type, gps_at))
    out = bytearray(b"II*\x00" + struct.pack("<I", ifd0_at))
    for at, tags in ((ifd0_at, ifd0), (exif_at, exif), (gps_at, gps)):
        if at is None or tags is None:
            continue
        blob, extra = _write_ifd(tags, extra_base_offset=at + 2 + len(tags) * 12 + 4)
        out.extend(bytes(max(0, at + len(blob) + len(extra) - len(out))))
        out[at : at + len(blob) + len(extra)] = blob + extra
    return bytes(out)


class _CountingReader(BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.bytes_read = 0

    def read(self, size: int | None = -1) -> bytes:
        chunk = super().read(size)
        self.bytes_read += len(chunk)
        return chunk


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

    def test_extract_raw_metadata_reads_ifds_past_the_sample(self) -> None:
        # Capture One writes IFD0 and the EXIF IFD at the end of its DNGs, 60
        # MB in; they're read from there, not by reading the file up to them.
        far = EXIF_SAMPLE_BYTES + 1024 * 1024
        xmp = (
            "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
            "<rdf:Description xmlns:xmp='http://ns.adobe.com/xap/1.0/' xmp:Rating='4' /></rdf:RDF></x:xmpmeta>"
        )
        dng = _build_tiff_with_ifds_at(
            far,
            [(0x010F, 2, "SONY"), (0x0110, 2, "ILCE-7M4"), (0x0100, 4, 160), (0x0101, 4, 107), (0x02BC, 1, xmp)],
            exif_at=far + 4096,
            exif=[(0x9003, 2, "2022:07:31 15:32:58"), (0x8827, 3, 100), (0xA434, 2, "Sony FE 16-35mm f2.8 GM (SEL1635GM)")],
            gps_at=far + 8192,
            gps=[(0x0001, 2, "N"), (0x0002, 5, [(47, 1), (36, 1), (36, 1)]), (0x0003, 2, "W"), (0x0004, 5, [(122, 1), (19, 1), (48, 1)])],
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "DSC07744.dng"
            path.write_bytes(dng)

            metadata = extract_raw_metadata(path)
            matcher = extract_raw_metadata(path, metadata_profile="matcher")

        self.assertEqual((metadata.camera_make, metadata.camera_model), ("SONY", "ILCE-7M4"))
        self.assertEqual(metadata.capture_time, "2022-07-31T15:32:58+00:00")
        self.assertEqual(metadata.iso, 100)
        self.assertEqual(metadata.lens_model, "Sony FE 16-35mm f2.8 GM (SEL1635GM)")
        self.assertEqual(metadata.rating, 4)
        self.assertEqual((metadata.width, metadata.height), (160, 107))
        self.assertAlmostEqual(metadata.gps_latitude or 0.0, 47.61, places=5)
        self.assertAlmostEqual(metadata.gps_longitude or 0.0, -122.33, places=5)
        self.assertEqual((matcher.camera_model, matcher.capture_time), ("ILCE-7M4", "2022-07-31T15:32:58+00:00"))

        reader = _CountingReader(dng)
        self.assertEqual(extract_embedded_metadata_from_handle(reader, ".dng")["camera_model"], "ILCE-7M4")
        self.assertLessEqual(reader.bytes_read, EMBEDDED_METADATA_SAMPLE_STEPS[0] + 3 * TIFF_IFD_WINDOW_BYTES)

    def test_extract_raw_metadata_reads_an_exif_ifd_past_the_sample(self) -> None:
        # IFD0 in the sample, its EXIF IFD past it, pointed to as a LONG or as
        # TIFF type 13 (IFD).
        far = EXIF_SAMPLE_BYTES + 1024 * 1024
        with tempfile.TemporaryDirectory() as temp_dir:
            for pointer_type in (4, 13):
                path = Path(temp_dir) / f"pointer-type-{pointer_type}.dng"
                path.write_bytes(
                    _build_tiff_with_ifds_at(
                        8, [(0x0110, 2, "ILCE-7M4")], exif_at=far, exif=[(0x9003, 2, "2022:07:31 15:32:58")], pointer_type=pointer_type
                    )
                )
                self.assertEqual(extract_raw_metadata(path).capture_time, "2022-07-31T15:32:58+00:00", pointer_type)

    def test_an_ifd0_rewritten_at_the_end_keeps_its_values_where_they_were(self) -> None:
        # A tool that rewrites IFD0 at the end of a NEF or a DJI DNG leaves
        # Make, Model and DateTime where the camera wrote them, near the start.
        far = EXIF_SAMPLE_BYTES + 1024 * 1024
        ifd0, values = _write_ifd(
            [(0x010F, 2, "NIKON CORPORATION"), (0x0110, 2, "NIKON D850"), (0x0132, 2, "2017:11:27 10:45:55")], extra_base_offset=1024
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "DSC_8861.NEF"
            path.write_bytes(b"II*\x00" + struct.pack("<I", far) + bytes(1016) + values + bytes(far - 1024 - len(values)) + ifd0)

            metadata = extract_raw_metadata(path)

            self.assertEqual((metadata.camera_make, metadata.camera_model), ("NIKON CORPORATION", "NIKON D850"))
            self.assertEqual(metadata.capture_time, "2017-11-27T10:45:55+00:00")

    def test_a_read_past_the_sample_leaves_the_sample_growing_where_it_was(self) -> None:
        # IFD0 points past the end of a cut-off file; the sample still grows
        # and finds the TIFF embedded 700 KB in.
        with tempfile.TemporaryDirectory() as temp_dir:
            embedded = _build_tiff(ifd0=[(0x0110, 2, "Canon EOS R6m2"), (0x0132, 2, "2026:01:11 15:03:52")])
            path = Path(temp_dir) / "cut-off.dng"
            path.write_bytes(b"II*\x00" + struct.pack("<I", 2 * EXIF_SAMPLE_BYTES) + b"\x00" * (700 * 1024) + embedded + b"\x00" * 256)

            metadata = extract_raw_metadata(path)

            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52+00:00")

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
            path.write_bytes(b"\x00" * 344 + tiff + b"\x00" * 256)
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
            path = Path(temp_dir) / "0Y1A7001.CR3"
            path.write_bytes(b"\x00" * 1024 + tiff)

            metadata = extract_raw_metadata(path, metadata_profile="matcher")

            self.assertEqual(metadata.camera_model, "Canon EOS R6m2")
            self.assertEqual(metadata.capture_time, "2026-01-11T15:03:52+00:00")
            self.assertIsNone(metadata.camera_make)
            self.assertIsNone(metadata.lens_model)
            self.assertIsNone(metadata.lens_make)
            self.assertIsNone(metadata.iso)
            self.assertIsNone(metadata.width)
            self.assertIsNone(metadata.height)


if __name__ == "__main__":
    unittest.main()
