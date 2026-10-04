"""What the catalog records about a photo: the fingerprint and file name keys
that identify it, and its camera metadata, read with ExifTool (exiftool.py).

Where ExifTool can't run (a macOS without Perl), images fall back to the EXIF
Pillow reads and RAW files to the size and orientation LibRaw reads.
"""

from __future__ import annotations

import hashlib
import logging
import math
import numbers
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

from . import exiftool, raw_decode
from .models import ImageCandidate, RawMetadata

log = logging.getLogger(__name__)

IMAGE_VARIANT_WORDS = {
    "copy",
    "cover",
    "denoise",
    "denoiseai",
    "edit",
    "edited",
    "enhanced",
    "image",
    "final",
    "ig",
    "instagram",
    "light",
    "low",
    "nr",
    "small",
    "thumb",
    "thumbnail",
    "web",
}

FINGERPRINT_MODES = {"head-tail", "head-only"}
RAW_METADATA_PROFILES = {"full", "matcher"}


def quick_fingerprint(
    path: Path,
    chunk_size: int = 65536,
    *,
    stat_result: os.stat_result | None = None,
    head_bytes: bytes | None = None,
    mode: str = "head-tail",
) -> str:
    stat_result = stat_result or path.stat()
    with path.open("rb") as handle:
        return quick_fingerprint_from_handle(
            handle,
            stat_result.st_size,
            head_bytes=head_bytes,
            chunk_size=chunk_size,
            mode=mode,
        )


def quick_fingerprint_from_handle(
    handle,
    file_size: int,
    *,
    head_bytes: bytes | None = None,
    chunk_size: int = 65536,
    mode: str = "head-tail",
) -> str:
    if mode not in FINGERPRINT_MODES:
        raise ValueError(f"unsupported fingerprint mode: {mode}")
    sha1 = hashlib.sha1()
    start = head_bytes[:chunk_size] if head_bytes is not None else handle.read(chunk_size)
    sha1.update(start)
    if mode == "head-tail" and file_size > chunk_size:
        handle.seek(max(0, file_size - chunk_size))
        sha1.update(handle.read(chunk_size))
    sha1.update(mode.encode("utf-8"))
    sha1.update(str(file_size).encode("utf-8"))
    return sha1.hexdigest()


def stable_asset_id(prefix: str, fingerprint: str, path: str | None = None) -> str:
    if path:
        digest = hashlib.sha1(f"{fingerprint}:{path}".encode()).hexdigest()
        return f"{prefix}_{digest[:24]}"
    return f"{prefix}_{fingerprint[:24]}"


def normalize_stem(stem: str) -> str:
    normalized = re.sub(r"[\s._-]+", "-", stem.strip().lower())
    return normalized.strip("-")


def stem_key(stem: str) -> str:
    value = normalize_stem(stem)
    value = re.sub(r"\((\d+)\)$", "", value).strip("-")

    while True:
        if re.fullmatch(r"[a-z]{2,5}-\d{3,}", value):
            break
        next_value = re.sub(r"[-_ ]+\d+$", "", value).strip("-")
        if next_value == value:
            break
        value = next_value

    parts = [part for part in re.split(r"[-_ ]+", value) if part]
    while parts and (parts[-1] in IMAGE_VARIANT_WORDS or re.fullmatch(r"v\d+", parts[-1])):
        parts.pop()
    key = "-".join(parts).strip("-")
    return key or value


def stem_alnum_key(stem: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", stem_key(stem))


def camera_stem_token(stem: str) -> str | None:
    key = stem_key(stem)
    if not key:
        return None
    patterns = (
        r"img-\d{4,}",
        r"dscn?-\d{4,}",
        r"dji-\d{8,}",
        r"[a-z]\d{7,}",
        r"\d[a-z]\d[a-z]\d{4,}",
    )
    for pattern in patterns:
        if re.fullmatch(pattern, key):
            return key
    return None


def iso_mtime(path: Path, stat_result: os.stat_result | None = None) -> str:
    stat_result = stat_result or path.stat()
    return datetime.fromtimestamp(stat_result.st_mtime, tz=UTC).isoformat()


FIELDS = (
    "capture_time",
    "rating",
    "camera_make",
    "camera_model",
    "lens_model",
    "lens_make",
    "software",
    "iso",
    "aperture",
    "shutter_speed",
    "focal_length",
    "flash",
    "white_balance",
    "color_space",
    "lens_specification",
    "gps_latitude",
    "gps_longitude",
    "width",
    "height",
)
# What the RAW matcher needs; the rest waits for enrichment.
MATCHER_FIELDS = ("capture_time", "camera_make", "camera_model")
_MAKER_NOTES = ("Canon", "Nikon", "Sony", "FujiFilm", "Olympus", "Panasonic", "Pentax", "PhaseOne")
# What stands for no lens name: "----" (Sony), a bare lens ID, and what
# Composite:LensID's lookup says when it has none.
_NOT_A_LENS = re.compile(r"^(-+|\d+|n/a|none|unknown\b.*|.*\bno lens\b.*)$", re.IGNORECASE)


def _normalize_capture_time(value: object) -> str | None:
    """The camera's wall clock as ISO 8601 without a time zone, from EXIF's
    "2024:07:13 09:12:53", Hasselblad's "2024-07-13T09:12:53" or XMP's
    (sub-seconds and an offset are dropped). It was stored as UTC, which it
    isn't, so every viewer moved it by their own offset (shot at 18:05 in
    China, shown at 02:05 the next day) and an edit wrote that back into the
    file. Without an offset, the renderer reads it as local and shows the
    camera's clock, as photo apps do. Video creation dates are real instants
    and keep theirs."""
    if not isinstance(value, str):
        return None
    match = re.match(r"\s*(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})", value)
    if not match:
        return None
    try:
        year, month, day, hour, minute, second = (int(part) for part in match.groups())
        return datetime(year, month, day, hour, minute, second).isoformat()
    except ValueError:  # 0000:00:00 00:00:00, an unset clock
        return None


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, numbers.Real):  # Pillow's IFDRational too
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.split()[0])
        except (ValueError, IndexError):
            return None
    else:
        return None
    return number if math.isfinite(number) else None  # 0/0, "inf"


def _positive(value: object) -> float | None:
    """An exposure value; 0 is what a manual lens or an unknown leaves."""
    number = _number(value)
    return number if number else None


def _integer(value: object) -> int | None:
    number = _number(value)
    return int(number) if number is not None and number.is_integer() else None


def _text(value: object) -> str | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip() if isinstance(value, (str, int, float)) else ""
    return text or None


def _lens_name(value: object) -> str | None:
    text = _text(value)
    return text if text and not _NOT_A_LENS.match(text) else None


def _lens_specification(value: object) -> list[float] | None:
    """Focal range and apertures; an unknown one is written 0/0 (or "undef")
    and left out."""
    parts = value.split() if isinstance(value, str) else [value]
    values = [number for number in (_number(part) for part in parts) if number]
    return values or None


def _size(value: object) -> tuple[int | None, int | None]:
    parts = re.split(r"[ x]+", value.strip()) if isinstance(value, str) else []
    if len(parts) == 2 and all(_integer(part) for part in parts):
        return _integer(parts[0]), _integer(parts[1])
    return None, None


def _first(tags: dict[str, Any], keys: tuple[str, ...], convert=_text):
    """The first of `keys` ("Group:Tag", or "*:Tag" for any group) whose value
    converts; ExifTool reports a tag once per place it found it."""
    for key in keys:
        group, _, name = key.partition(":")
        if group == "*":
            values = [value for found, value in tags.items() if found.partition(":")[2] == name]
        else:
            values = [tags[key]] if key in tags else []
        for value in values:
            converted = convert(value)
            if converted is not None:
                return converted
    return None


def _color_space(tags: dict[str, Any]) -> int | None:
    """EXIF ColorSpace: 1 for sRGB, 65535 for Adobe RGB. Some cameras say
    Adobe RGB only in their maker note (Canon and Nikon: 2; a NEF has no EXIF
    ColorSpace at all) or with the interop index R03 (Fujifilm)."""
    maker = _first(tags, ("Canon:ColorSpace", "Nikon:ColorSpace"), _integer)
    interop = _text(tags.get("InteropIFD:InteropIndex")) or ""
    if maker == 2 or interop.startswith("R03"):
        return 65535
    exif = _first(tags, ("ExifIFD:ColorSpace",), _integer)
    return exif if exif is not None else (1 if maker == 1 else None)


def _image_size(tags: dict[str, Any]) -> tuple[int | None, int | None]:
    # A HEIF image is coded in whole tiles and cropped to its clean aperture
    # ("800 533 0 -0.5" for an 800x534 grid).
    clean = tags.get("QuickTime:CleanAperture")
    parts = clean.split() if isinstance(clean, str) else []
    if len(parts) >= 2 and all(_number(part) for part in parts[:2]):
        return round(float(parts[0])), round(float(parts[1]))
    return _size(tags.get("Composite:ImageSize"))


def _from_exiftool(tags: dict[str, Any]) -> dict[str, Any]:
    width, height = _image_size(tags)
    return {
        "capture_time": _first(
            tags,
            (
                "ExifIFD:DateTimeOriginal",
                "*:DateTimeOriginal",  # IFD0 (Nikon), PhaseOne, XMP-exif
                "ExifIFD:CreateDate",
                "XMP-photoshop:DateCreated",
                "XMP-xmp:CreateDate",
                "IFD0:ModifyDate",
            ),
            _normalize_capture_time,
        ),
        "rating": _first(tags, ("XMP-xmp:Rating", "IFD0:Rating", "ExifIFD:Rating"), _integer),
        "camera_make": _first(tags, ("IFD0:Make", "XMP-tiff:Make", "*:Make")),
        "camera_model": _first(tags, ("IFD0:Model", "XMP-tiff:Model", "*:Model")),
        "lens_model": _first(
            tags,
            (
                "ExifIFD:LensModel",
                "Composite:LensID",  # old Nikon lenses are named only by its lookup
                *(f"{group}:LensModel" for group in _MAKER_NOTES),
                "XMP-exifEX:LensModel",
                "XMP-aux:Lens",
            ),
            _lens_name,
        ),
        "lens_make": _first(tags, ("ExifIFD:LensMake", "XMP-exifEX:LensMake")),
        "software": _first(tags, ("IFD0:Software",)),
        "iso": _first(tags, ("ExifIFD:ISO", "Composite:ISO", "*:ISO"), lambda value: _integer(value) or None),
        "aperture": _first(tags, ("ExifIFD:FNumber", "*:FNumber", "ExifIFD:ApertureValue"), _positive),
        "shutter_speed": _first(tags, ("ExifIFD:ExposureTime", "*:ExposureTime"), _positive),
        "focal_length": _first(tags, ("ExifIFD:FocalLength", "*:FocalLength"), _positive),
        "flash": _first(tags, ("ExifIFD:Flash",), _integer),
        "white_balance": _first(tags, ("ExifIFD:WhiteBalance",), _integer),
        "color_space": _color_space(tags),
        "lens_specification": _first(tags, ("ExifIFD:LensInfo", "*:LensInfo"), _lens_specification),
        "gps_latitude": _first(tags, ("Composite:GPSLatitude", "*:GPSLatitude"), _number),
        "gps_longitude": _first(tags, ("Composite:GPSLongitude", "*:GPSLongitude"), _number),
        "width": width,
        "height": height,
    }


def _register_heif() -> None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        pass


def _from_pillow(path: Path) -> dict[str, Any]:
    """The EXIF Pillow reads, for when ExifTool can't run: an image's camera,
    exposure, capture time and GPS (no maker notes, no XMP)."""
    _register_heif()
    try:
        with Image.open(path) as image:
            width, height = image.size
            exif = image.getexif()
    except Exception:
        return {}
    details, gps = exif.get_ifd(0x8769), exif.get_ifd(0x8825)

    def coordinate(values, reference) -> float | None:
        try:
            degrees, minutes, seconds = (float(value) for value in values)
        except (TypeError, ValueError):
            return None
        sign = -1 if str(reference).upper() in ("S", "W") else 1
        return sign * (degrees + minutes / 60 + seconds / 3600)

    lens = details.get(0xA432)
    return {
        "capture_time": _normalize_capture_time(details.get(0x9003)) or _normalize_capture_time(exif.get(0x0132)),
        "camera_make": _text(exif.get(0x010F)),
        "camera_model": _text(exif.get(0x0110)),
        "lens_model": _lens_name(details.get(0xA434)),
        "lens_make": _text(details.get(0xA433)),
        "software": _text(exif.get(0x0131)),
        "iso": _integer(details.get(0x8827)) or None,
        "aperture": _positive(details.get(0x829D)),
        "shutter_speed": _positive(details.get(0x829A)),
        "focal_length": _positive(details.get(0x920A)),
        "flash": _integer(details.get(0x9209)),
        "white_balance": _integer(details.get(0xA403)),
        "color_space": _integer(details.get(0xA001)),
        "lens_specification": _lens_specification(" ".join(str(float(value)) for value in lens)) if isinstance(lens, tuple) else None,
        "gps_latitude": coordinate(gps.get(2), gps.get(1)),
        "gps_longitude": coordinate(gps.get(4), gps.get(3)),
        "width": width,
        "height": height,
    }


def read_metadata(path: Path, profile: str = "full", raw: bool = False) -> dict[str, Any]:
    """The catalog's metadata fields for `path`, None where unknown. A RAW's
    size is LibRaw's, cropped to the image the camera delivers: ExifTool's
    includes the sensor's margins for some formats (ARW, NEF, DNG)."""
    if profile not in RAW_METADATA_PROFILES:
        raise ValueError(f"unsupported metadata profile: {profile}")
    found: dict[str, Any] = {}
    try:
        tags = exiftool.read(path)
    except exiftool.ExifToolError as error:
        log.warning("metadata: %s", error)
        tags = None
    if tags is not None:
        found = _from_exiftool(tags)
    elif not raw:
        found = _from_pillow(path)
    if raw and profile == "full":
        info = raw_decode.raw_info(path)
        if info:
            found["width"], found["height"] = info.width, info.height
    fields = MATCHER_FIELDS if profile == "matcher" else FIELDS
    return {field: found.get(field) if field in fields else None for field in FIELDS}


def extract_raw_metadata(
    path: Path,
    fingerprint_mode: str = "head-tail",
    metadata_profile: str = "full",
) -> RawMetadata:
    stat = path.stat()
    resolved_path = path.resolve()
    metadata = read_metadata(path, profile=metadata_profile, raw=True)
    fingerprint = quick_fingerprint(path, stat_result=stat, mode=fingerprint_mode)
    return RawMetadata(
        asset_id=stable_asset_id("raw", fingerprint),
        path=resolved_path,
        stem=path.stem,
        normalized_stem=normalize_stem(path.stem),
        stem_key=stem_key(path.stem),
        extension=path.suffix.lower(),
        fingerprint=fingerprint,
        file_size=stat.st_size,
        modified_time=iso_mtime(path, stat),
        metadata_level=metadata_profile,
        fingerprint_level=fingerprint_mode,
        enrichment_status="done" if metadata_profile == "full" else "pending",
        **metadata,
    )


def extract_image_candidate(path: Path, fingerprint_mode: str = "head-tail") -> ImageCandidate:
    stat = path.stat()
    resolved_path = path.resolve()
    metadata = read_metadata(path)
    if metadata["width"] is None or metadata["height"] is None:
        metadata["width"], metadata["height"] = _pillow_size(path)
    fingerprint = quick_fingerprint(path, stat_result=stat, mode=fingerprint_mode)
    return ImageCandidate(
        asset_id=stable_asset_id("image", fingerprint, str(resolved_path)),
        path=resolved_path,
        stem=path.stem,
        normalized_stem=normalize_stem(path.stem),
        stem_key=stem_key(path.stem),
        extension=path.suffix.lower(),
        fingerprint=fingerprint,
        file_size=stat.st_size,
        modified_time=iso_mtime(path, stat),
        **metadata,
    )


def _pillow_size(path: Path) -> tuple[int | None, int | None]:
    _register_heif()
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None, None
