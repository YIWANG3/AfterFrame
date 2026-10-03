"""RAW previews without a RAW decoder: the JPEG the camera embedded in the file.

macOS renders RAW through Image I/O (QuickLook and sips). Windows has
neither, and Pillow can't demosaic. Nearly every RAW format carries the
camera's own rendering as a JPEG, though: full size in CR2/CR3, NEF, RAF and
PEF, smaller in older ARW and ORF, and DNG's preview. Where there is no
Image I/O, the preview is that JPEG, scaled like any other.

The file is scanned for JPEG start markers rather than parsed per format.
Each hit is walked marker by marker. Only 8-bit Huffman frames that Pillow
decodes are kept (baseline, extended, progressive), which skips the lossless
JPEG that CR2 and many DNGs use for the raw data itself. The largest one wins.
"""

from __future__ import annotations

import mmap
from io import BytesIO
from pathlib import Path

from .metadata import _iter_embedded_tiff_offsets, _parse_tiff_ifd, _read_u32

_SOI = b"\xff\xd8\xff"
_DECODABLE_SOF = {0xC0, 0xC1, 0xC2}
_ORIENTATION_TAG = 0x0112
# The RAW's own TIFF IFD0 (orientation) sits near the start in every format.
_HEAD_BYTES = 512 * 1024


def _frame_header(buf, start: int) -> tuple[int, int, int] | None:
    """(width, height, offset of the first scan) of the JPEG at `start`, or
    None when it isn't one Pillow decodes."""
    size = len(buf)
    pos = start + 2
    width = height = 0
    while pos + 4 <= size:
        if buf[pos] != 0xFF:
            return None
        marker = buf[pos + 1]
        if marker == 0xFF:  # fill byte before a marker
            pos += 1
            continue
        if 0xD0 <= marker <= 0xD9 or marker == 0x01:  # markers without a length
            return None
        length = (buf[pos + 2] << 8) | buf[pos + 3]
        if length < 2:
            return None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):  # a start-of-frame
            if marker not in _DECODABLE_SOF or pos + 9 > size or buf[pos + 4] != 8:
                return None
            height = (buf[pos + 5] << 8) | buf[pos + 6]
            width = (buf[pos + 7] << 8) | buf[pos + 8]
        if marker == 0xDA:  # start of scan: the frame header came before it
            return (width, height, pos + 2 + length) if width and height else None
        pos += 2 + length
    return None


def _frame_end(buf, pos: int) -> int | None:
    """The offset just past the JPEG's EOI, from its first scan's data. In
    entropy-coded data 0xFF is always followed by 0x00 or a restart marker;
    any other marker starts a segment (another scan's tables, then its data)."""
    size = len(buf)
    while True:
        ff = buf.find(b"\xff", pos)
        if ff < 0 or ff + 1 >= size:
            return None
        marker = buf[ff + 1]
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            pos = ff + 2
        elif marker == 0xFF:
            pos = ff + 1
        elif marker == 0xD9:
            return ff + 2
        else:
            if ff + 4 > size:
                return None
            pos = ff + 2 + ((buf[ff + 2] << 8) | buf[ff + 3])


def _orientation(head: bytes) -> int | None:
    for base in _iter_embedded_tiff_offsets(head)[:8]:
        if base + 8 > len(head):
            continue
        little = head[base : base + 2] == b"II"
        value = _parse_tiff_ifd(head, base, _read_u32(head, base + 4, little), little).get(_ORIENTATION_TAG)
        if isinstance(value, int) and 1 <= value <= 8:
            return value
    return None


def embedded_jpeg(path: Path) -> tuple[bytes, int | None] | None:
    """The largest decodable JPEG embedded in `path` and the RAW's EXIF
    orientation (the embedded image is stored unrotated, like the sensor
    data), or None when there is none."""
    with path.open("rb") as handle:
        if path.stat().st_size == 0:
            return None
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as buf:
            frames = []
            hit = buf.find(_SOI)
            while hit >= 0:
                header = _frame_header(buf, hit)
                if header:
                    width, height, scan = header
                    frames.append((width * height, hit, scan))
                hit = buf.find(_SOI, hit + 3)
            for _area, start, scan in sorted(frames, reverse=True):
                end = _frame_end(buf, scan)
                if end:
                    return bytes(buf[start:end]), _orientation(bytes(buf[:_HEAD_BYTES]))
    return None


def render_raw_preview(source: Path, target: Path, size: int) -> None:
    """A preview of a RAW from its embedded JPEG: long edge at most `size`,
    the RAW's orientation as the EXIF tag, like every other preview."""
    from .preview_service import render_pillow_preview

    found = embedded_jpeg(source)
    if found is None:
        raise ValueError(f"no embedded JPEG preview in {source.name}")
    data, orientation = found
    render_pillow_preview(BytesIO(data), target, size, orientation=orientation)
