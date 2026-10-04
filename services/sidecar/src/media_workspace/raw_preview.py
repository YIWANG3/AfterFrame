"""RAW previews without a RAW decoder: the image the camera embedded in the file.

Pillow can't demosaic, and demosaicing is the slow part anyway: seconds per
file through Image I/O, against a few hundred milliseconds to scale the JPEG
the camera already rendered. Nearly every RAW carries one: full size in
CR2/CR3, NEF, ARW, RAF and PEF, smaller in older ARW and ORF, and DNG's
preview. That JPEG is the RAW's preview on every platform; macOS falls back to
Image I/O only when it is too small (see preview_service).

Finding it must not read the whole RAW: a drive import touches tens of
thousands of them, often on a spinning disk. The file's own structure says
where its previews are: in a TIFF-based RAW (CR2, NEF, ARW, DNG, 3FR, FFF) the
directories (the IFD chain and SubIFDs) point to JPEG thumbnails and
JPEG-compressed strips, and a RAF's header to its JPEG. Only those bytes are
read. A thumbnail takes the smallest preview that is big enough. Formats
without such pointers (CR3), or where none is big enough, are scanned for JPEG
start markers, stopping at the first big enough. Each hit is walked marker by
marker, and only 8-bit Huffman frames that Pillow decodes are kept (baseline,
extended, progressive), which skips the lossless JPEG that CR2 and many DNGs
use for the raw data itself.

Hasselblad 3FR and FFF (and older TIFF-based RAWs) can carry the preview
uncompressed instead: an 8- or 16-bit RGB image in one of the directories.

The camera's metadata travels with the preview: its orientation (always), an
Adobe RGB profile when the camera was set to Adobe RGB (its JPEG is rendered
in it, untagged), and for the HD tier the EXIF itself (camera, lens,
exposure, capture time, GPS), which an edit saved from it keeps.

Embedded images are stored unrotated, like the sensor data, so the preview
carries the RAW's orientation. The exception is an RGB directory with an
Orientation tag of its own: FFF keeps a second, already rotated copy whose tag
says 1 while the RAW's says 8.
"""

from __future__ import annotations

import mmap
import struct
from collections.abc import Callable, Iterator
from functools import partial
from io import BytesIO
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image

from .color_profiles import adobe_rgb_icc
from .metadata import _iter_embedded_tiff_offsets, _parse_tiff_ifd, _read_u16, _read_u32

_SOI = b"\xff\xd8\xff"
_DECODABLE_SOF = {0xC0, 0xC1, 0xC2}
_ORIENTATION_TAG = 0x0112
_TIFF_MAGIC = (b"II*\x00", b"MM\x00*")
# Olympus ORF and Panasonic RW2 are TIFF with their own magic number: the
# same IFD0 at u32@4, the same tags.
_TIFF_LIKE = _TIFF_MAGIC + (b"IIRO", b"IIRS", b"MMOR", b"IIU\x00")
# Directory walks skip values bigger than this (a DNG's OriginalRawFileData,
# maker notes), rather than copying megabytes per preview.
_MAX_TAG_BYTES = 64 * 1024
_SUBIFDS_TAG = 0x014A
# Formats that aren't TIFF (CR3, RAF) carry a TIFF block with the
# orientation near the start; TIFF-based RAWs keep it in IFD0, which FFF
# writes at the end of the file.
_HEAD_BYTES = 512 * 1024
_RAF_MAGIC = b"FUJIFILMCCD-RAW "
# A preview at least this share of the RAW's size is its full-size rendering:
# nothing bigger is worth scanning the file for.
_FULL_SIZE = 0.9


class RawTags(NamedTuple):
    """The RAW's own TIFF/EXIF tags: IFD0, EXIF, GPS and interoperability."""

    ifd0: dict
    exif: dict
    gps: dict
    interop: dict


class EmbeddedPreview(NamedTuple):
    data: bytes  # a JPEG, or an RGB preview wrapped as TIFF; Pillow opens both
    orientation: int | None  # to show it with
    width: int
    height: int
    icc_profile: bytes | None  # the colour space it is in, when not sRGB
    tags: RawTags


class EmbeddedPreviewUnusable(ValueError):
    """The RAW's embedded preview won't do for this caller: too small, or its
    orientation can't be read. A caller with a RAW decoder falls back to it."""


class _Candidate(NamedTuple):
    width: int
    height: int
    load: Callable[[], bytes]
    orientation: int | None  # the directory's own, for an already rotated copy

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def long_edge(self) -> int:
        return max(self.width, self.height)


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
    if buf[:4] not in _TIFF_LIKE:
        return
    little = buf[:2] == b"II"
    seen: set[int] = set()
    queue = [_read_u32(buf, 4, little)]
    while queue and len(seen) < limit:
        offset = queue.pop(0)
        if not isinstance(offset, int) or offset <= 0 or offset in seen or offset + 2 > len(buf):
            continue
        seen.add(offset)
        tags = _parse_tiff_ifd(buf, 0, offset, little, _MAX_TAG_BYTES)
        end = offset + 2 + _read_u16(buf, offset, little) * 12
        if end + 4 <= len(buf):
            queue.append(_read_u32(buf, end, little))
        queue += [v for v in _as_list(tags.get(_SUBIFDS_TAG)) if isinstance(v, int)]
        yield tags


def _read(buf, start: int, end: int) -> bytes:
    return bytes(buf[start:end])


def _jpeg_at(buf, start, length) -> _Candidate | None:
    """The JPEG a directory or header points to, if Pillow decodes it. Only
    its header is read here; its bytes when it is chosen."""
    if not (isinstance(start, int) and isinstance(length, int)) or start <= 0 or length <= 0:
        return None
    if buf[start : start + 3] != _SOI or (header := _frame_header(buf, start)) is None:
        return None
    return _Candidate(header[0], header[1], partial(_read, buf, start, min(start + length, len(buf))), None)


def _pointed_previews(buf) -> list[_Candidate]:
    """The previews the file's structure points to: a TIFF directory's RGB
    image, JPEG thumbnail (JPEGInterchangeFormat) or single JPEG-compressed
    strip (CR2's full-size preview, DNG's and 3FR's), or a RAF header's JPEG."""
    found: list[_Candidate] = []
    if buf[:16] == _RAF_MAGIC and len(buf) >= 92:
        start, length = struct.unpack_from(">II", buf, 84)
        if jpeg := _jpeg_at(buf, start, length):
            found.append(jpeg)
        return found
    little = buf[:2] == b"II"
    for tags in tiff_directories(buf):
        if rgb := _rgb_directory(buf, tags):
            found.append(_Candidate(rgb.width, rgb.height, partial(_rgb_as_tiff, buf, rgb, little), rgb.orientation))
        if jpeg := _jpeg_at(buf, tags.get(0x0201), tags.get(0x0202)):
            found.append(jpeg)
        offsets, counts = _as_list(tags.get(0x0111)), _as_list(tags.get(0x0117))
        if tags.get(0x0103) in (6, 7) and len(offsets) == 1 and len(counts) == 1:
            if jpeg := _jpeg_at(buf, offsets[0], counts[0]):
                found.append(jpeg)
    return found


def _scanned_previews(buf, stop_edge: int | None) -> list[_Candidate]:
    """JPEGs found by scanning for start markers: every one Pillow decodes,
    or up to the first at least `stop_edge` on its long edge."""
    found: list[_Candidate] = []
    hit = buf.find(_SOI)
    while hit >= 0:
        header = _frame_header(buf, hit)
        if header:
            width, height, scan = header
            end = _frame_end(buf, scan)
            if end:
                found.append(_Candidate(width, height, partial(_read, buf, hit, end), None))
                if stop_edge and max(width, height) >= stop_edge:
                    break
        hit = buf.find(_SOI, hit + 3)
    return found


def _is_full_size(buf, candidate: _Candidate) -> bool:
    from .raw_dimensions import buffer_dimensions

    size = buffer_dimensions(buf)
    return size is not None and candidate.long_edge >= _FULL_SIZE * max(size)


def _choose(candidates: list[_Candidate], min_edge: int | None) -> _Candidate | None:
    """The smallest candidate at least `min_edge` on its long edge, else the
    largest. Ties go to the first found."""
    if min_edge:
        enough = [c for c in candidates if c.long_edge >= min_edge]
        if enough:
            return min(enough, key=lambda c: c.area)
    return max(candidates, key=lambda c: c.area, default=None)


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


def _head_tiffs(buf) -> Iterator[tuple[bytes, int, bool]]:
    """(data, base, little-endian) of the TIFF blocks near the start of a RAW
    that isn't a TIFF itself: CR3's CMT boxes, the EXIF of a RAF's JPEG."""
    head = bytes(buf[:_HEAD_BYTES])
    for base in _iter_embedded_tiff_offsets(head)[:8]:
        if base + 8 <= len(head):
            yield head, base, head[base : base + 2] == b"II"


def _orientation(buf) -> int | None:
    """The RAW's EXIF orientation: IFD0's when the file is a TIFF, wherever
    IFD0 is, else the first TIFF block near the start that has one."""
    if buf[:4] in _TIFF_LIKE:
        little = buf[:2] == b"II"
        found = _valid_orientation(_parse_tiff_ifd(buf, 0, _read_u32(buf, 4, little), little, _MAX_TAG_BYTES).get(_ORIENTATION_TAG))
        if found:
            return found
    for data, base, little in _head_tiffs(buf):
        ifd0 = _parse_tiff_ifd(data, base, _read_u32(data, base + 4, little), little, _MAX_TAG_BYTES)
        if found := _valid_orientation(ifd0.get(_ORIENTATION_TAG)):
            return found
    return None


_EXIF_IFD, _GPS_IFD, _INTEROP_IFD = 0x8769, 0x8825, 0xA005
_GPS_TAGS = range(0x0000, 0x0020)


def _raw_tags(buf) -> RawTags:
    """IFD0, EXIF, GPS and interoperability tags of the RAW. A TIFF-based RAW
    has them in its own IFD0; CR3 keeps them as separate TIFF blocks near the
    start (IFD0, EXIF and GPS each as a block's IFD0); a RAF in its JPEG."""
    found = RawTags({}, {}, {}, {})

    def sub(data, base, little, tags, pointer) -> dict:
        offset = tags.get(pointer)
        return _parse_tiff_ifd(data, base, offset, little, _MAX_TAG_BYTES) if isinstance(offset, int) else {}

    blocks = []
    if buf[:4] in _TIFF_LIKE:
        blocks.append((buf, 0, buf[:2] == b"II"))
    blocks += list(_head_tiffs(buf))
    for data, base, little in blocks:
        ifd = _parse_tiff_ifd(data, base, _read_u32(data, base + 4, little), little, _MAX_TAG_BYTES)
        if not found.ifd0 and 0x010F in ifd:  # Make
            found.ifd0.update(ifd)
        exif = sub(data, base, little, ifd, _EXIF_IFD) or (ifd if 0x9003 in ifd or 0x829A in ifd else {})
        if exif and not found.exif:
            found.exif.update(exif)
            found.interop.update(sub(data, base, little, exif, _INTEROP_IFD))
        gps = sub(data, base, little, ifd, _GPS_IFD) or (ifd if ifd and set(ifd) <= set(_GPS_TAGS) and 0x0002 in ifd else {})
        if gps and not found.gps:
            found.gps.update(gps)
    return found


def _colour_profile(tags: RawTags) -> bytes | None:
    """Adobe RGB when the camera says so: ColorSpace "uncalibrated" (0xFFFF)
    and, when it records one, interoperability index R03. Cameras offer
    only sRGB and Adobe RGB, so uncalibrated alone means Adobe RGB."""
    if tags.exif.get(0xA001) != 0xFFFF:
        return None
    if tags.interop.get(0x0001) not in (None, "R03"):
        return None
    return adobe_rgb_icc()


# EXIF the HD preview carries from the RAW. Not the maker note (large,
# camera-private) or the RAW's pixel dimensions, which aren't the preview's.
_IFD0_COPY = (0x010F, 0x0110, 0x0131, 0x0132, 0x013B, 0x8298)
_EXIF_SKIP = {0x927C, _INTEROP_IFD, 0xA002, 0xA003, 0xA005}


def exif_bytes(tags: RawTags, orientation: int | None) -> bytes:
    """An EXIF block with the RAW's camera, lens, exposure, capture time and
    GPS, and `orientation`. Whatever Pillow can't write is left out."""
    def build(include_raw: bool) -> bytes:
        exif = Image.Exif()
        if include_raw:
            for tag in _IFD0_COPY:
                if tag in tags.ifd0:
                    exif[tag] = tags.ifd0[tag]
            if tags.exif:
                ifd = exif.get_ifd(_EXIF_IFD)
                for tag, value in tags.exif.items():
                    if tag not in _EXIF_SKIP and not (isinstance(value, bytes) and len(value) > 256):
                        ifd[tag] = value
            if tags.gps:
                gps = exif.get_ifd(_GPS_IFD)
                for tag, value in tags.gps.items():
                    gps[tag] = value
        if orientation and orientation != 1:
            exif[_ORIENTATION_TAG] = orientation
        return exif.tobytes()

    try:
        return build(include_raw=True)
    except Exception:
        return build(include_raw=False)


def embedded_preview(
    path: Path, min_edge: int | None = None, stop_edge: int | None = None, scan_past_pointers: bool = True
) -> EmbeddedPreview | None:
    """The preview embedded in `path`: with `min_edge`, the smallest one at
    least that long on its long edge (a thumbnail needn't decode a 24 MP
    JPEG); without, or when none is, the largest. None when there is none.

    The file is scanned only when what its structure points to won't do,
    and never past the first JPEG at least `stop_edge` (or `min_edge`) long.
    A RAF holds no JPEG besides its header's, so it is never scanned; nor,
    with `scan_past_pointers` off, a RAW that points to any preview (a
    caller with a RAW decoder would rather use it than read the file)."""
    with path.open("rb") as handle:
        if path.stat().st_size == 0:
            return None
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as buf:
            candidates = _pointed_previews(buf)
            best = _choose(candidates, min_edge)
            satisfied = best is not None and (
                (bool(min_edge) and best.long_edge >= (min_edge or 0)) or _is_full_size(buf, best)
            )
            may_scan = buf[:16] != _RAF_MAGIC and (scan_past_pointers or not candidates)
            if not satisfied and may_scan:
                candidates += _scanned_previews(buf, min_edge or stop_edge)
                best = _choose(candidates, min_edge)
            if best is None:
                return None
            tags = _raw_tags(buf)
            orientation = best.orientation or _orientation(buf)
            return EmbeddedPreview(best.load(), orientation, best.width, best.height, _colour_profile(tags), tags)


# Above this, a requested size means the HD tier: the embedded image at full size.
_THUMBNAIL_LIMIT = 4096
_HD_STOP_EDGE = 2000


def _own_orientation(data: bytes) -> int | None:
    try:
        with Image.open(BytesIO(data)) as image:
            return _valid_orientation(image.getexif().get(_ORIENTATION_TAG))
    except Exception:
        return None


def render_raw_preview(source: Path, target: Path, size: int, require: int = 0) -> None:
    """A preview of a RAW from its embedded image: long edge at most `size`,
    the RAW's orientation as the EXIF tag and its colour profile, like every
    other preview; the HD tier (`size` above a thumbnail's) also keeps the
    RAW's EXIF. A thumbnail uses the smallest embedded image at least `size`,
    the HD tier the largest.

    `require` is for a caller that has a RAW decoder to fall back to: an
    embedded image shorter than that, or one whose orientation can't be read,
    raises EmbeddedPreviewUnusable rather than giving a lesser preview, and
    the file isn't scanned past what its structure points to."""
    from .preview_service import render_pillow_preview

    hd = size > _THUMBNAIL_LIMIT
    found = embedded_preview(
        source,
        min_edge=None if hd else size,
        stop_edge=max(require, _HD_STOP_EDGE) if hd else None,
        scan_past_pointers=not require,
    )
    if found is None:
        raise ValueError(f"no embedded preview in {source.name}")
    if max(found.width, found.height) < require:
        raise EmbeddedPreviewUnusable(
            f"{source.name}: the embedded preview is {found.width}×{found.height}, under {require} px"
        )
    if require and found.orientation is None and _own_orientation(found.data) is None:
        raise EmbeddedPreviewUnusable(f"{source.name}: the RAW's orientation can't be read")
    render_pillow_preview(
        BytesIO(found.data), target, size,
        orientation=found.orientation,
        icc_profile=found.icc_profile,
        exif=exif_bytes(found.tags, found.orientation) if hd else None,
    )
