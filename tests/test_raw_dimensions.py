from __future__ import annotations

import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.raw_dimensions import raw_dimensions
from media_workspace.reverse_lookup import resolve_image_batch

DNG_FIXTURE = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures" / "raw" / "luna-morning.dng"

SHORT, LONG, RATIONAL = 3, 4, 5


def _tiff(ifd0: dict, subifds: tuple[dict, ...] = (), exif: dict | None = None) -> bytes:
    """A little-endian TIFF: IFD0, the SubIFDs and EXIF IFD it points to.
    Tags map to (type, values); a RATIONAL value is (numerator, denominator)."""
    dirs = [dict(ifd0), *(dict(d) for d in subifds), *([dict(exif)] if exif else [])]
    if subifds:
        dirs[0][0x014A] = (LONG, [0] * len(subifds))
    if exif:
        dirs[0][0x8769] = (LONG, [0])
    sizes = [2 + 12 * len(d) + 4 for d in dirs]
    offsets = [8]
    for size in sizes[:-1]:
        offsets.append(offsets[-1] + size)
    if subifds:
        dirs[0][0x014A] = (LONG, offsets[1 : 1 + len(subifds)])
    if exif:
        dirs[0][0x8769] = (LONG, [offsets[-1]])
    data_at = offsets[-1] + sizes[-1]
    out, extra = bytearray(b"II*\x00" + struct.pack("<I", 8)), bytearray()
    for directory in dirs:
        out += struct.pack("<H", len(directory))
        for tag in sorted(directory):
            kind, values = directory[tag]
            if kind == RATIONAL:
                payload = b"".join(struct.pack("<II", *v) for v in values)
            else:
                payload = struct.pack("<" + {SHORT: "H", LONG: "I"}[kind] * len(values), *values)
            if len(payload) <= 4:
                field = payload.ljust(4, b"\x00")
            else:
                field = struct.pack("<I", data_at + len(extra))
                extra += payload
            out += struct.pack("<HHI", tag, kind, len(values)) + field
        out += struct.pack("<I", 0)
    return bytes(out + extra)


def _thumbnail(width: int = 160, height: int = 120) -> dict:
    return {0x00FE: (LONG, [1]), 0x0100: (LONG, [width]), 0x0101: (LONG, [height]), 0x0106: (SHORT, [2])}


def _raw_directory(width: int, height: int, crop: tuple[int, int] | None = None, photometric: int = 32803) -> dict:
    tags = {0x00FE: (LONG, [0]), 0x0100: (LONG, [width]), 0x0101: (LONG, [height]), 0x0106: (SHORT, [photometric])}
    if crop:
        tags[0xC620] = (RATIONAL, [(crop[0], 1), (crop[1], 1)])
    return tags


def _raf(entries: list[tuple[int, tuple[int, int]]]) -> bytes:
    """A Fujifilm RAF header: magic, offsets at 84, then the directory of
    (tag, size, data) entries, big-endian."""
    directory = struct.pack(">I", len(entries)) + b"".join(
        struct.pack(">HHHH", tag, 4, *value) for tag, value in entries
    )
    head = b"FUJIFILMCCD-RAW 0201FF383501" + bytes(84 - 28)
    at = 200
    offsets = struct.pack(">6I", 148, 0, at, len(directory), at + len(directory), 0)
    return (head + offsets).ljust(at, b"\x00") + directory + bytes(64)


class RawDimensionsTest(unittest.TestCase):
    def _write(self, name: str, data: bytes) -> Path:
        path = Path(self.temp_dir.name) / name
        path.write_bytes(data)
        return path

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_the_raw_directorys_default_crop_size(self) -> None:
        # DNG, 3FR, FFF: IFD0 is a thumbnail, the raw data is a SubIFD.
        dng = self._write("DJI_0079.DNG", _tiff(_thumbnail(), subifds=(_raw_directory(4032, 3024, crop=(4000, 3000)),)))
        mono = self._write("L1010305.DNG", _tiff(_thumbnail(), subifds=(_raw_directory(8424, 5632, crop=(8368, 5584), photometric=34892),)))
        self.assertEqual(raw_dimensions(dng), (4000, 3000))
        self.assertEqual(raw_dimensions(mono), (8368, 5584))

    def test_the_crop_size_wins_over_the_exif_size(self) -> None:
        # Leica's EXIF size includes the margins DefaultCropSize cuts.
        leica = _tiff(
            _thumbnail(720, 480),
            subifds=(_raw_directory(9536, 6344, crop=(9520, 6336)),),
            exif={0xA002: (LONG, [9536]), 0xA003: (LONG, [6344])},
        )
        self.assertEqual(raw_dimensions(self._write("L1000083.DNG", leica)), (9520, 6336))

    def test_the_exif_size_when_there_is_no_crop(self) -> None:
        # CR2: IFD0 is the full-size preview; an M-RAW is smaller, as EXIF says.
        cr2 = _tiff(
            {0x0100: (LONG, [6720]), 0x0101: (LONG, [4480])},
            exif={0xA002: (SHORT, [5040]), 0xA003: (SHORT, [3360])},
        )
        self.assertEqual(raw_dimensions(self._write("_MG_1836.CR2", cr2)), (5040, 3360))

    def test_the_raw_directorys_own_size_last(self) -> None:
        # NEF: neither a crop nor an EXIF size, only the raw data's.
        nef = _tiff(_thumbnail(), subifds=(_thumbnail(), _raw_directory(8288, 5520)))
        self.assertEqual(raw_dimensions(self._write("DSC_0017.NEF", nef)), (8288, 5520))

    def test_a_raf_follows_its_crop_mode(self) -> None:
        # A GFX 50S II in 35mm mode: the full sensor is 4530×6912 (height,
        # width); the cropped size is what was shot.
        raf = _raf([(0x0100, (4530, 6912)), (0x0110, (8, 12)), (0x0111, (4512, 6768))])
        self.assertEqual(raw_dimensions(self._write("_DSF0277.RAF", raf)), (6768, 4512))

    def test_nothing_to_go_on(self) -> None:
        self.assertIsNone(raw_dimensions(self._write("thumb.DNG", _tiff(_thumbnail()))))
        self.assertIsNone(raw_dimensions(self._write("0Y1A1387.CR3", b"\x00\x00\x00\x18ftypcrx " + bytes(64))))
        self.assertIsNone(raw_dimensions(self._write("no-size.RAF", _raf([(0x0100, (4530, 6912))]))))
        self.assertIsNone(raw_dimensions(self._write("cut.RAF", _raf([(0x0111, (4512, 6768))])[:120])))
        self.assertIsNone(raw_dimensions(self._write("empty.ARW", b"")))

    def test_a_real_dng(self) -> None:
        # Its IFD0 says 256×144; sips says 1024×576.
        self.assertEqual(raw_dimensions(DNG_FIXTURE), (1024, 576))

    def test_an_import_without_sips_records_the_real_size(self) -> None:
        root = Path(self.temp_dir.name)
        raw = root / "luna-morning.dng"
        shutil.copyfile(DNG_FIXTURE, raw)
        catalog = ensure_catalog(root / "demo.afcatalog")
        connection = connect(catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, catalog.root)
        with patch("media_workspace.reverse_lookup.subprocess.run", side_effect=FileNotFoundError("sips")):
            resolve_image_batch(connection, [raw], refresh=True)
        metadata = json.loads(connection.execute("SELECT metadata_json FROM assets WHERE asset_type = 'raw'").fetchone()[0])
        connection.close()
        self.assertEqual((metadata["width"], metadata["height"]), (1024, 576))


if __name__ == "__main__":
    unittest.main()
