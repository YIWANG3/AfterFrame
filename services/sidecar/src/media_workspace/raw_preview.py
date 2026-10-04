"""RAW previews without a RAW decoder: the image the camera embedded in the file.

macOS renders RAW through Image I/O (QuickLook and sips). Windows has
neither, and Pillow can't demosaic. Nearly every RAW format carries the
camera's own rendering as a JPEG, though: full size in CR2/CR3, NEF, RAF and
PEF, smaller in older ARW and ORF, and DNG's preview. Where there is no
Image I/O, the preview is that JPEG, scaled like any other.

The file is scanned for JPEG start markers rather than parsed per format.
Each hit is walked marker by marker. Only 8-bit Huffman frames that Pillow
decodes are kept (baseline, extended, progressive), which skips the lossless
JPEG that CR2 and many DNGs use for the raw data itself.

Hasselblad 3FR and FFF (and older TIFF-based RAWs) can carry the preview
uncompressed instead: an RGB image in one of the file's TIFF directories. Those
are found by walking the directories (the IFD chain and SubIFDs) for
uncompressed 8- or 16-bit RGB. The largest preview of either kind wins.

Embedded images are stored unrotated, like the sensor data, so the preview
carries the RAW's orientation. The exception is an RGB directory with an
Orientation tag of its own: FFF keeps a second, already rotated copy whose tag
says 1 while the RAW's says 8.
"""

from __future__ import annotations

import mmap
from collections.abc import Iterator
from io import BytesIO
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image

from .metadata import _iter_embedded_tiff_offsets, _parse_tiff_ifd, _read_u16, _read_u32

_SOI = b"\xff\xd8\xff"
_DECODABLE_SOF = {0xC0, 0xC1, 0xC2}
_ORIENTATION_TAG = 0x0112
_TIFF_MAGIC = (b"II*\x00", b"MM\x00*")
_SUBIFDS_TAG = 0x014A
# Formats that aren't TIFF (CR3, RAF) carry a TIFF block with the
# orientation near the start; TIFF-based RAWs keep it in IFD0, which FFF
# writes at the end of the file.
_HEAD_BYTES = 512 * 1024


class _RgbImage(NamedTuple):
    """An uncompressed RGB image in one of the RAW's TIFF directories."""

    width: int
    height: int
    depth: int  # bytes per sample
    offsets: list
    counts: list
    orientation: int | None  # the directory's own Orientation tag

    @property
    def area(self) -> int:
        return self.width * self.height


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


def _as_list(value) -> list:
    return value if isinstance(value, list) else [value]


def _valid_orientation(value) -> int | None:
    return value if isinstance(value, int) and 1 <= value <= 8 else None


def _rgb_directory(buf, tags: dict) -> _RgbImage | None:
    """The uncompressed 8- or 16-bit RGB image a TIFF directory holds, the
    form Hasselblad's previews take; None for anything else (the raw CFA data,
    a JPEG-compressed or planar image)."""
    width, height = tags.get(0x0100), tags.get(0x0101)
    bits = _as_list(tags.get(0x0102))
    offsets, counts = _as_list(tags.get(0x0111)), _as_list(tags.get(0x0117))
    if not (isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0):
        return None
    if tags.get(0x0103) != 1 or tags.get(0x0106) != 2 or tags.get(0x011C, 1) != 1:
        return None
    if len(bits) != 3 or len(set(bits)) != 1 or bits[0] not in (8, 16) or tags.get(0x0115, 3) != 3:
        return None
    if not offsets or len(offsets) != len(counts) or not all(isinstance(v, int) for v in offsets + counts):
        return None
    depth = bits[0] // 8
    if sum(counts) < width * height * 3 * depth or any(o + c > len(buf) for o, c in zip(offsets, counts, strict=True)):
        return None
    return _RgbImage(width, height, depth, offsets, counts, _valid_orientation(tags.get(_ORIENTATION_TAG)))


def tiff_directories(buf, limit: int = 32) -> Iterator[dict]:
    """The tags of each directory in a TIFF-based RAW, the IFD chain and the
    SubIFDs under it; at most `limit`, since a corrupt file can point in
    circles. Nothing for a file that isn't a TIFF."""
    if buf[:4] not in _TIFF_MAGIC:
        return
    little = buf[:2] == b"II"
    seen: set[int] = set()
    queue = [_read_u32(buf, 4, little)]
    while queue and len(seen) < limit:
        offset = queue.pop(0)
        if not isinstance(offset, int) or offset <= 0 or offset in seen or offset + 2 > len(buf):
            continue
        seen.add(offset)
        tags = _parse_tiff_ifd(buf, 0, offset, little)
        end = offset + 2 + _read_u16(buf, offset, little) * 12
        if end + 4 <= len(buf):
            queue.append(_read_u32(buf, end, little))
        queue += [v for v in _as_list(tags.get(_SUBIFDS_TAG)) if isinstance(v, int)]
        yield tags


def _tiff_rgb_previews(buf) -> list[_RgbImage]:
    """Every uncompressed RGB image in the file's TIFF directories."""
    return [rgb for tags in tiff_directories(buf) if (rgb := _rgb_directory(buf, tags))]


def _rgb_as_tiff(buf, rgb: _RgbImage, little: bool) -> bytes:
    """The RGB image as an in-memory TIFF Pillow opens (16-bit scaled to 8)."""
    width, height, depth = rgb.width, rgb.height, rgb.depth
    data = b"".join(buf[o : o + c] for o, c in zip(rgb.offsets, rgb.counts, strict=True))[: width * height * 3 * depth]
    if depth == 1:
        image = Image.frombytes("RGB", (width, height), data)
    else:
        samples = np.frombuffer(data, dtype="<u2" if little else ">u2").reshape(height, width, 3)
        image = Image.fromarray((samples >> 8).astype(np.uint8), "RGB")
    out = BytesIO()
    image.save(out, "TIFF")
    return out.getvalue()


def _orientation(buf) -> int | None:
    """The RAW's EXIF orientation: IFD0's when the file is a TIFF, wherever
    IFD0 is, else the first TIFF block near the start that has one."""
    if buf[:4] in _TIFF_MAGIC:
        little = buf[:2] == b"II"
        found = _valid_orientation(_parse_tiff_ifd(buf, 0, _read_u32(buf, 4, little), little).get(_ORIENTATION_TAG))
        if found:
            return found
    head = bytes(buf[:_HEAD_BYTES])
    for base in _iter_embedded_tiff_offsets(head)[:8]:
        if base + 8 > len(head):
            continue
        little = head[base : base + 2] == b"II"
        found = _valid_orientation(_parse_tiff_ifd(head, base, _read_u32(head, base + 4, little), little).get(_ORIENTATION_TAG))
        if found:
            return found
    return None


def embedded_preview(path: Path) -> tuple[bytes, int | None] | None:
    """The largest preview embedded in `path`, as image bytes Pillow opens (a
    JPEG, or an uncompressed RGB image wrapped as TIFF), and the orientation
    to show it with; None when there is none."""
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
            jpeg = None
            for area, start, scan in sorted(frames, reverse=True):
                end = _frame_end(buf, scan)
                if end:
                    jpeg = (area, start, end)
                    break
            rgb = max(_tiff_rgb_previews(buf), key=lambda r: r.area, default=None)
            orientation = _orientation(buf)
            if rgb and (jpeg is None or rgb.area > jpeg[0]):
                return _rgb_as_tiff(buf, rgb, buf[:2] == b"II"), rgb.orientation or orientation
            if jpeg:
                return bytes(buf[jpeg[1] : jpeg[2]]), orientation
    return None


def render_raw_preview(source: Path, target: Path, size: int) -> None:
    """A preview of a RAW from its embedded image: long edge at most `size`,
    the RAW's orientation as the EXIF tag, like every other preview."""
    from .preview_service import render_pillow_preview

    found = embedded_preview(source)
    if found is None:
        raise ValueError(f"no embedded preview in {source.name}")
    data, orientation = found
    render_pillow_preview(BytesIO(data), target, size, orientation=orientation)
