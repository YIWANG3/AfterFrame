"""RAW files through LibRaw (rawpy): the preview the camera embedded, the
image's size and orientation, and a decode when that preview won't do.

These replace hand-written TIFF/CR3/RAF parsers that met a new corner with
every format: Hasselblad's uncompressed RGB previews, FFF's IFD0 at the end of
the file, Capture One's SubIFD type, Olympus and Panasonic magic numbers,
Canon orientation kept only in the maker note. LibRaw reads 1,200+ cameras.

Opening a file and taking its embedded preview reads the file's structure and
that preview, not the raw data (0.03-0.25 s cold on a spinning disk). A decode
reads and demosaics everything, and LibRaw still ships memory-safety fixes for
hostile files, so decodes run in a child process (`decode-raw`) with a
timeout: a crash costs one preview, not the sidecar.

One parser is still hand-written, and only for what LibRaw rejects outright:
a camera newer than the LibRaw we ship (the Sony A7 V, ILCE-7M5, under LibRaw
0.22.1). Its RAW is still a TIFF, and the JPEGs it embeds still open, so its
preview is the largest of those (`_tiff_embedded_preview`).
"""

from __future__ import annotations

import struct
import subprocess
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from .platform_tools import is_frozen
from .processes import no_window

# LibRaw's `flip` as the EXIF orientation the previews carry.
_FLIP_TO_ORIENTATION = {0: 1, 3: 3, 5: 8, 6: 6}
# A half-size decode skips demosaicing and has a quarter of the pixels. It's
# used when it still covers the size asked for, and above this long edge in
# any case: still ≥ 4000 px, and a 100 MP file peaks at 0.5 GB, not 1.4.
_HALF_SIZE_FROM = 8000
DECODE_TIMEOUT_SECONDS = 120


@dataclass(slots=True)
class RawInfo:
    width: int  # as stored, cropped to the image the camera delivers
    height: int
    orientation: int


@dataclass(slots=True)
class EmbeddedPreview:
    data: bytes  # a JPEG, or the camera's RGB preview as PNG; Pillow opens both
    width: int
    height: int
    orientation: int  # the RAW's: embedded previews are stored unrotated


def available() -> bool:
    try:
        import rawpy  # noqa: F401
    except ImportError:
        return False
    return True


def _info(sizes) -> RawInfo:
    if sizes.crop_width and sizes.crop_height:
        width, height = sizes.crop_width, sizes.crop_height
    else:
        width, height = sizes.width, sizes.height
    return RawInfo(int(width), int(height), _FLIP_TO_ORIENTATION.get(int(sizes.flip), 1))


def raw_info(path: Path) -> RawInfo | None:
    """The RAW's size and orientation, from its structure alone."""
    try:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            return _info(raw.sizes)
    except Exception:
        return None


def embedded_preview(path: Path) -> EmbeddedPreview | None:
    """The largest preview the camera embedded, and the RAW's orientation;
    None when there is none LibRaw can hand over (a stitched DNG without one,
    a CR3 shot in HEIF mode). A TIFF-based RAW LibRaw can't open at all (a
    camera newer than it) gives the largest JPEG its IFDs point at."""
    try:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            info = _info(raw.sizes)
            thumb = raw.extract_thumb()
    except Exception:
        return _tiff_embedded_preview(path)
    if thumb.format == rawpy.ThumbFormat.JPEG:
        data = bytes(thumb.data)
        try:
            with Image.open(BytesIO(data)) as image:
                width, height = image.size
        except Exception:
            return None
    else:  # an RGB bitmap (Hasselblad, Capture One DNG)
        pixels: Any = thumb.data
        if pixels.dtype != "uint8":  # 16-bit (FFF): keep the high byte
            pixels = (pixels >> 8).astype("uint8")
        bitmap = Image.fromarray(pixels)
        width, height = bitmap.size
        out = BytesIO()
        bitmap.save(out, "PNG", compress_level=1)
        data = out.getvalue()
    return EmbeddedPreview(data, width, height, info.orientation)


# The TIFF tags that locate an embedded JPEG.
_NEW_SUBFILE_TYPE = 0x00FE
_COMPRESSION = 0x0103
_STRIP_OFFSETS = 0x0111
_ORIENTATION = 0x0112
_STRIP_BYTE_COUNTS = 0x0117
_SUB_IFDS = 0x014A
_JPEG_OFFSET = 0x0201  # JPEGInterchangeFormat: Sony's and Nikon's previews
_JPEG_LENGTH = 0x0202
_JPEG_COMPRESSIONS = (6, 7)  # old-style and new-style JPEG
_MAX_IFDS = 32  # a loop or a corrupt chain stops here
_MAX_JPEG_BYTES = 64 << 20


def _read_ifd(file, at: int, order: str) -> tuple[dict[int, list[int]], int]:
    """The integer tags of the IFD at `at` (SHORT, LONG and IFD values, up to
    64 of each), and where the next IFD is."""
    file.seek(at)
    (count,) = struct.unpack(order + "H", file.read(2))
    if count > 1000:
        raise ValueError("not an IFD")
    entries = file.read(count * 12 + 4)
    tags: dict[int, list[int]] = {}
    for index in range(count):
        entry = entries[index * 12 : index * 12 + 12]
        tag, kind, n = struct.unpack(order + "HHI", entry[:8])
        if kind not in (3, 4, 13) or not 0 < n <= 64:
            continue
        width = 2 if kind == 3 else 4
        if width * n <= 4:
            blob = entry[8 : 8 + width * n]
        else:
            (offset,) = struct.unpack(order + "I", entry[8:])
            file.seek(offset)
            blob = file.read(width * n)
        tags[tag] = list(struct.unpack(order + ("H" if kind == 3 else "I") * n, blob))
    (next_at,) = struct.unpack(order + "I", entries[count * 12 : count * 12 + 4])
    return tags, next_at


def _tiff_embedded_preview(path: Path) -> EmbeddedPreview | None:
    """The largest JPEG a TIFF-based RAW embeds (ARW, NEF, DNG…), with IFD0's
    orientation: what macOS shows for a camera its RAW decoder doesn't know
    yet. Walks IFD0's chain and the SubIFDs; the full-resolution image (new
    subfile type 0) is the raw data, never a candidate."""
    try:
        with path.open("rb") as file:
            head = file.read(8)
            if head[:4] not in (b"II*\x00", b"MM\x00*"):
                return None
            order = "<" if head[:2] == b"II" else ">"
            pending = [struct.unpack(order + "I", head[4:])[0]]
            seen: set[int] = set()
            orientation = 1
            candidates: set[tuple[int, int]] = set()  # (length, offset)
            while pending and len(seen) < _MAX_IFDS:
                at = pending.pop(0)
                if not at or at in seen:
                    continue
                seen.add(at)
                tags, next_at = _read_ifd(file, at, order)
                if len(seen) == 1 and tags.get(_ORIENTATION, [1])[0] in range(1, 9):
                    orientation = tags.get(_ORIENTATION, [1])[0]
                pending += [next_at, *tags.get(_SUB_IFDS, [])]
                if _JPEG_OFFSET in tags and _JPEG_LENGTH in tags:
                    candidates.add((tags[_JPEG_LENGTH][0], tags[_JPEG_OFFSET][0]))
                strips, counts = tags.get(_STRIP_OFFSETS, []), tags.get(_STRIP_BYTE_COUNTS, [])
                is_preview = tags.get(_NEW_SUBFILE_TYPE, [0])[0] & 1
                if is_preview and tags.get(_COMPRESSION, [0])[0] in _JPEG_COMPRESSIONS and len(strips) == len(counts) == 1:
                    candidates.add((counts[0], strips[0]))
            for length, offset in sorted(candidates, reverse=True):
                if not 0 < length <= _MAX_JPEG_BYTES:
                    continue
                file.seek(offset)
                data = file.read(length)
                if not data.startswith(b"\xff\xd8"):
                    continue
                try:
                    with Image.open(BytesIO(data)) as image:
                        width, height = image.size
                except Exception:
                    continue
                return EmbeddedPreview(data, width, height, orientation)
    except (OSError, ValueError, struct.error):
        return None
    return None


def decode(path: Path, target: Path, long_edge: int, full: bool = False) -> None:
    """Decode the RAW to an sRGB JPEG at most `long_edge` px, cropped to the
    camera's image, unrotated with the orientation as the EXIF tag like every
    other preview. `full`: never at half size, whatever the cost — the
    editor's full-size picture of the RAW, not a preview. In-process: call it
    through decode_in_child."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        sizes = raw.sizes
        info = _info(sizes)
        half = not full and max(info.width, info.height) >= min(_HALF_SIZE_FROM, 2 * long_edge)
        rgb = raw.postprocess(
            half_size=half,
            use_camera_wb=True,  # rawpy defaults to daylight
            no_auto_bright=True,
            gamma=(2.4, 12.92),  # sRGB's curve, not BT.709's
            output_bps=8,
            user_flip=0,  # pixels as stored; the orientation goes in the EXIF tag
        )
    image = Image.fromarray(rgb)
    if sizes.crop_width and sizes.crop_height:
        scale = 2 if half else 1
        left = max(0, sizes.crop_left_margin - sizes.left_margin) // scale
        top = max(0, sizes.crop_top_margin - sizes.top_margin) // scale
        image = image.crop((left, top, left + sizes.crop_width // scale, top + sizes.crop_height // scale))
    image.thumbnail((long_edge, long_edge), Image.Resampling.LANCZOS)
    exif = Image.Exif()
    if info.orientation != 1:
        exif[0x0112] = info.orientation
    image.save(target, "JPEG", quality=95 if full else 90, exif=exif.tobytes())


def _sidecar_command() -> list[str]:
    # The frozen sidecar is its own executable; in development it's a module.
    return [sys.executable] if is_frozen() else [sys.executable, "-m", "media_workspace"]


def decode_in_child(path: Path, target: Path, long_edge: int, timeout: float = DECODE_TIMEOUT_SECONDS, full: bool = False) -> None:
    """decode() in a child process: a crash or a hang in LibRaw fails this
    one preview (CalledProcessError / TimeoutExpired) instead of the sidecar."""
    subprocess.run(
        [*_sidecar_command(), "decode-raw", "--source", str(path), "--target", str(target), "--size", str(long_edge),
         *(["--full"] if full else [])],
        check=True,
        capture_output=True,
        timeout=timeout,
        **no_window(),
    )
