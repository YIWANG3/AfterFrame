from __future__ import annotations

from pathlib import Path

from . import formats


def is_macos_metadata(path: Path) -> bool:
    """AppleDouble companions keep the original extension but contain no image."""
    return path.name.startswith("._") or "__MACOSX" in path.parts


# Folders a volume's system keeps. Importing a whole card or drive (E:\, or
# /Volumes/CARD) walks into them, and the Recycle Bin and macOS's .Trashes
# hold deleted photos that would come back as new imports.
_SYSTEM_FOLDERS = {
    "$recycle.bin", "recycler", "recycled", "system volume information",  # Windows
    ".trashes", ".spotlight-v100", ".fseventsd", ".temporaryitems", ".documentrevisions-v100",  # macOS volumes
}


def in_system_folder(path: Path) -> bool:
    return any(part.lower() in _SYSTEM_FOLDERS or part.startswith(".Trash-") for part in path.parts)


def is_ignored_path(path: Path) -> bool:
    """Not one of the user's files: an AppleDouble companion, or anything in
    a volume's system folders."""
    return is_macos_metadata(path) or in_system_folder(path)


def detect_raw_format(path: Path) -> str | None:
    """The RAW family of a user file ("cr3", "arw", "tiff-raw"…), by extension or
    by its first bytes; None for non-RAW and for files the import ignores."""
    if is_ignored_path(path):
        return None
    return formats.raw_format_of(path)


def is_raw_file(path: Path) -> bool:
    return detect_raw_format(path) is not None


def is_source_file(path: Path) -> bool:
    """What the RAW-source scan indexes: a RAW (by content too), or an image
    the catalog imports."""
    return not is_ignored_path(path) and (is_raw_file(path) or formats.kind_of(path) == "image")
