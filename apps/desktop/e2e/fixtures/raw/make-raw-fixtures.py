#!/usr/bin/env python3
"""Shrink real camera DNGs into e2e fixtures.

    python3 make-raw-fixtures.py <name>=<source.dng> [...]
    e.g.  python3 make-raw-fixtures.py luna-morning=~/Downloads/IMG_20260818_091943_779.dng

A phone/camera DNG is 30–70 MB; committing that is out of the question, and a
hand-written minimal DNG is rejected by Image I/O (sips reports no size,
qlmanage hangs), which the sidecar relies on for RAW previews and native
dimensions. Adobe DNG Converter (free, macOS) re-encodes a real DNG lossy at a
reduced long side — ~220 KB at 1024 px — while keeping the camera EXIF
(make/model, capture time, ISO, aperture, shutter) the pairing scorer reads.

The converter also writes a GPS IFD of all zeros even when the source had no
GPS, which would drop the fixture on the map at 0°N 0°E. We retag the GPSInfo
pointer in IFD0 as an unknown private tag so every reader skips it; the file
stays a valid DNG (verified with sips + the sidecar's extract_raw_metadata).
"""
from __future__ import annotations

import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

CONVERTER = Path("/Applications/Adobe DNG Converter.app/Contents/MacOS/Adobe DNG Converter")
LONG_SIDE = 1024
GPS_INFO_TAG = 34853


def strip_gps(data: bytearray) -> bool:
    little = data[:2] == b"II"
    fmt = "<" if little else ">"
    ifd0 = struct.unpack(fmt + "I", data[4:8])[0]
    count = struct.unpack(fmt + "H", data[ifd0:ifd0 + 2])[0]
    for i in range(count):
        off = ifd0 + 2 + i * 12
        if struct.unpack(fmt + "H", data[off:off + 2])[0] == GPS_INFO_TAG:
            data[off:off + 2] = struct.pack(fmt + "H", 0xFFFE)
            return True
    return False


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if not CONVERTER.exists():
        print(f"Adobe DNG Converter not found at {CONVERTER}", file=sys.stderr)
        return 1
    out_dir = Path(__file__).resolve().parent
    for spec in argv:
        name, _, source = spec.partition("=")
        src = Path(os.path.expanduser(source)).resolve()
        if not name or not src.exists():
            print(f"bad argument {spec!r}", file=sys.stderr)
            return 1
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                [str(CONVERTER), "-lossy", "-side", str(LONG_SIDE), "-p1", "-fl", "-d", tmp, "-o", f"{name}.dng", str(src)],
                check=True, capture_output=True,
            )
            data = bytearray((Path(tmp) / f"{name}.dng").read_bytes())
        stripped = strip_gps(data)
        dest = out_dir / f"{name}.dng"
        dest.write_bytes(data)
        print(f"{dest.name}: {len(data) // 1024} KB from {src.name} ({src.stat().st_size // 1024 // 1024} MB){' (GPS stripped)' if stripped else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
