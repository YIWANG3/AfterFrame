from __future__ import annotations

from pathlib import Path

from .config import DEFAULT_IMAGE_EXTENSIONS, DEFAULT_RAW_EXTENSIONS

RAW_SIGNATURE_SAMPLE_BYTES = 4096

RAW_EXTENSION_FORMATS = {
    ".3fr": "3fr",
    ".arw": "arw",
    ".cr2": "cr2",
    ".cr3": "cr3",
    ".dng": "dng",
    ".erf": "erf",
    ".nef": "nef",
    ".orf": "orf",
    ".pef": "pef",
    ".raf": "raf",
    ".raw": "raw",
    ".rw2": "rw2",
    ".sr2": "sr2",
}


def _read_signature(path: Path, limit: int = RAW_SIGNATURE_SAMPLE_BYTES) -> bytes:
    with path.open("rb") as handle:
        return handle.read(limit)


def _is_iso_bmff_raw(data: bytes) -> str | None:
    if len(data) < 16 or data[4:8] != b"ftyp":
        return None
    brands = {data[8:12], data[16:20], data[20:24], data[24:28]}
    if {b"crx ", b"cr3 ", b"crx\x00"} & brands:
        return "cr3"
    return None


def _is_tiff_header(data: bytes) -> bool:
    return data.startswith(b"II*\x00") or data.startswith(b"MM\x00*")


def _detect_tiff_raw_format(data: bytes) -> str | None:
    if not _is_tiff_header(data):
        return None

    marker_map = (
        (b"DNGVersion", "dng"),
        (b"FUJIFILM", "raf"),
        (b"NIKON", "nef"),
        (b"Nikon", "nef"),
        (b"SONY", "arw"),
        (b"Panasonic", "rw2"),
        (b"OLYMPUS", "orf"),
        (b"Hasselblad", "3fr"),
        (b"Canon", "cr2"),
        (b"PENTAX", "pef"),
        (b"EPSON", "erf"),
    )
    for marker, detected in marker_map:
        if marker in data:
            return detected

    # Generic TIFF-like RAW fallback. For no-extension files we prefer a weak
    # positive over dropping a real RAW, but we still reject obviously unrelated
    # non-TIFF files elsewhere.
    return "tiff-raw"


def detect_raw_format(path: Path) -> str | None:
    extension = path.suffix.lower()
    if extension in DEFAULT_RAW_EXTENSIONS:
        return RAW_EXTENSION_FORMATS.get(extension, extension.lstrip("."))

    data = _read_signature(path)
    return _is_iso_bmff_raw(data) or _detect_tiff_raw_format(data)


def is_raw_file(path: Path) -> bool:
    return detect_raw_format(path) is not None


def is_source_file(path: Path) -> bool:
    return is_raw_file(path) or path.suffix.lower() in DEFAULT_IMAGE_EXTENSIONS
