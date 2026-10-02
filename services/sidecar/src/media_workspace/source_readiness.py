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


def _main_image_ends(handle, size: int) -> bool:
    """Whether the JPEG's main image is complete: its EOI follows its scan.

    Some cameras append data after the image: DJI writes an embedded preview
    and padding, so the file does not end with EOI though nothing is missing.
    Walk the segments to the first SOS, then look for EOI after it (scan data
    cannot hold FF D9: an FF there is stuffed as FF 00).
    """
    offset = 2  # after SOI
    while offset + 4 <= size:
        handle.seek(offset)
        head = handle.read(4)
        if len(head) < 4 or head[0] != 0xFF:
            return False
        marker = head[1]
        if marker == 0xFF:  # fill byte
            offset += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # standalone markers
            offset += 2
            continue
        if marker == 0xD9:
            return False  # EOI before any scan: nothing was drawn
        length = int.from_bytes(head[2:4], "big")
        if length < 2:
            return False
        offset += 2 + length
        if marker == 0xDA:  # SOS: the scan starts here
            break
    else:
        return False
    chunk = 1 << 20
    previous = b""
    handle.seek(offset)
    while True:
        block = handle.read(chunk)
        if not block:
            return False
        if b"\xff\xd9" in previous[-1:] + block:
            return True
        previous = block


def validate_source_ready(source_path: Path) -> tuple[int, int]:
    marker = source_marker(source_path)
    # JPEG decoders can return a superficially valid image from only the first
    # scanlines and fill the unwritten bottom with gray. Require the main
    # image's EOI: at the end of the file, or after its scan when the camera
    # appended data behind it.
    if source_path.suffix.lower() in {".jpg", ".jpeg"}:
        try:
            with source_path.open("rb") as handle:
                handle.seek(max(0, marker[0] - 16))
                tail = handle.read()
                complete = tail.rstrip(b"\x00\r\n\t ").endswith(b"\xff\xd9") or _main_image_ends(handle, marker[0])
        except OSError as error:
            raise SourceNotReadyError(f"source unreadable: {source_path}") from error
        if not complete:
            raise SourceNotReadyError(f"JPEG export is not complete: {source_path}")
    return marker


def validate_source_unchanged(source_path: Path, before: tuple[int, int]) -> None:
    if validate_source_ready(source_path) != before:
        raise SourceNotReadyError(f"source changed while processing: {source_path}")
