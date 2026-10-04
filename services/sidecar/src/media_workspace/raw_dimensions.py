"""A RAW's real pixel dimensions, without a RAW decoder.

The size in a RAW's IFD0 is often its preview's: Hasselblad 3FR and FFF, DNG,
NEF and IIQ all put a thumbnail there (a DJI DNG or a D850 NEF says 160×120).
macOS asks Image I/O (sips). Where sips isn't there, or can't read the file,
the size comes from where the format records it, the first of:

- the raw image directory's DefaultCropSize: the area a converter keeps once
  the sensor's margins are cut (DNG, 3FR, FFF, ARW);
- EXIF PixelXDimension/PixelYDimension: the size the photo was taken at (CR2,
  including M-RAW and S-RAW, and IIQ);
- the raw image directory's own size, margins included (NEF: within 1% of the
  size Nikon reports);
- in a Fujifilm RAF, the cropped size in the RAF header, which follows the
  crop mode (6768×4512 for a GFX shot in 35mm mode).

All are the size as stored, before the EXIF orientation, like sips reports.
None when the file has none of them; the EXIF size then stands.
"""

from __future__ import annotations

import mmap
import struct
from pathlib import Path

from .metadata import _parse_tiff_ifd, _read_u32
from .raw_preview import tiff_directories

_NEW_SUBFILE_TYPE = 0x00FE
_PHOTOMETRIC = 0x0106
_RAW_PHOTOMETRIC = {32803, 34892}  # CFA, LinearRaw
_DEFAULT_CROP_SIZE = 0xC620
_EXIF_IFD = 0x8769
_PIXEL_X, _PIXEL_Y = 0xA002, 0xA003

_RAF_MAGIC = b"FUJIFILMCCD-RAW "
_RAF_CROPPED_SIZE = 0x0111  # height, width


def _size(width, height) -> tuple[int, int] | None:
    if isinstance(width, (int, float)) and isinstance(height, (int, float)) and width >= 1 and height >= 1:
        return round(width), round(height)
    return None


def _tiff_dimensions(buf) -> tuple[int, int] | None:
    raw = [
        tags for tags in tiff_directories(buf)
        if tags.get(_NEW_SUBFILE_TYPE) == 0 and tags.get(_PHOTOMETRIC) in _RAW_PHOTOMETRIC
    ]
    for tags in raw:
        crop = tags.get(_DEFAULT_CROP_SIZE)
        if isinstance(crop, list) and len(crop) == 2 and (size := _size(*crop)):
            return size
    little = buf[:2] == b"II"
    exif_at = _parse_tiff_ifd(buf, 0, _read_u32(buf, 4, little), little).get(_EXIF_IFD)
    if isinstance(exif_at, int):
        exif = _parse_tiff_ifd(buf, 0, exif_at, little)
        if size := _size(exif.get(_PIXEL_X), exif.get(_PIXEL_Y)):
            return size
    sizes = [size for tags in raw if (size := _size(tags.get(0x0100), tags.get(0x0101)))]
    return max(sizes, key=lambda s: s[0] * s[1], default=None)


def _raf_dimensions(buf) -> tuple[int, int] | None:
    """From the RAF header's directory: a count, then (tag, size, data)
    entries, big-endian."""
    if len(buf) < 100:
        return None
    start, length = struct.unpack_from(">II", buf, 92)
    end = min(start + length, len(buf))
    if start + 4 > end:
        return None
    count = struct.unpack_from(">I", buf, start)[0]
    pos = start + 4
    for _ in range(min(count, 1024)):
        if pos + 4 > end:
            break
        tag, size = struct.unpack_from(">HH", buf, pos)
        if tag == _RAF_CROPPED_SIZE and size == 4 and pos + 8 <= end:
            height, width = struct.unpack_from(">HH", buf, pos + 4)
            return _size(width, height)
        pos += 4 + size
    return None


def raw_dimensions(path: Path) -> tuple[int, int] | None:
    """(width, height) of the RAW's image as stored; None when the file
    doesn't say (see the module docstring for where it looks)."""
    with path.open("rb") as handle:
        if path.stat().st_size < 8:
            return None
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as buf:
            if buf[:16] == _RAF_MAGIC:
                return _raf_dimensions(buf)
            return _tiff_dimensions(buf)
