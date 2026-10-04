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
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

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
    a CR3 shot in HEIF mode)."""
    try:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            info = _info(raw.sizes)
            thumb = raw.extract_thumb()
    except Exception:
        return None
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


def decode(path: Path, target: Path, long_edge: int) -> None:
    """Decode the RAW to an sRGB JPEG at most `long_edge` px, cropped to the
    camera's image, unrotated with the orientation as the EXIF tag like every
    other preview. In-process: call it through decode_in_child."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        sizes = raw.sizes
        info = _info(sizes)
        half = max(info.width, info.height) >= min(_HALF_SIZE_FROM, 2 * long_edge)
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
    image.save(target, "JPEG", quality=90, exif=exif.tobytes())


def _sidecar_command() -> list[str]:
    # The frozen sidecar is its own executable; in development it's a module.
    return [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "media_workspace"]


def decode_in_child(path: Path, target: Path, long_edge: int, timeout: float = DECODE_TIMEOUT_SECONDS) -> None:
    """decode() in a child process: a crash or a hang in LibRaw fails this
    one preview (CalledProcessError / TimeoutExpired) instead of the sidecar."""
    subprocess.run(
        [*_sidecar_command(), "decode-raw", "--source", str(path), "--target", str(target), "--size", str(long_edge)],
        check=True,
        capture_output=True,
        timeout=timeout,
    )
