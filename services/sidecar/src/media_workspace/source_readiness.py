from __future__ import annotations

from pathlib import Path


class SourceNotReadyError(RuntimeError):
    """The source is incomplete or changed while it is being processed."""


def source_marker(source_path: Path) -> tuple[int, int]:
    try:
        stat = source_path.stat()
    except OSError as error:
        raise SourceNotReadyError(f"source unavailable: {source_path}") from error
    if stat.st_size <= 0:
        raise SourceNotReadyError(f"source is empty: {source_path}")
    return stat.st_size, stat.st_mtime_ns


def validate_source_ready(source_path: Path) -> tuple[int, int]:
    marker = source_marker(source_path)
    # JPEG decoders can return a superficially valid image from only the first
    # scanlines and fill the unwritten bottom with gray. Require the final EOI.
    if source_path.suffix.lower() in {".jpg", ".jpeg"}:
        try:
            with source_path.open("rb") as handle:
                handle.seek(max(0, marker[0] - 16))
                tail = handle.read()
        except OSError as error:
            raise SourceNotReadyError(f"source unreadable: {source_path}") from error
        if not tail.rstrip(b"\x00\r\n\t ").endswith(b"\xff\xd9"):
            raise SourceNotReadyError(f"JPEG export is not complete: {source_path}")
    return marker


def validate_source_unchanged(source_path: Path, before: tuple[int, int]) -> None:
    if validate_source_ready(source_path) != before:
        raise SourceNotReadyError(f"source changed while processing: {source_path}")
