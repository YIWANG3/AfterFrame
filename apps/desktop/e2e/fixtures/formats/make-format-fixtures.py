#!/usr/bin/env python3
"""The fixtures for e2e/79-more-formats.spec.js, made once on a Mac:

    python3 make-format-fixtures.py

- layered.psd: the HEIC fixture (../heic/iphone-style.heic) rewritten as a
  Photoshop file by sips at 320 px — a flattened composite, which is what
  Pillow and Image I/O read. Chromium can't decode PSD, so the lightbox gets
  it through the same JPEG transcode as HEIC (electron/media/protocol.js).
- pixel.gif / pixel.bmp: a 64×48 gradient from Pillow (the GIF palettised).
- clip.mts / clip.3gp: three seconds of ffmpeg's test pattern as H.264 with a
  keyframe every 12 frames and B-frames, as a camcorder writes it, in an
  MPEG-TS container (AVCHD) and a 3GP one. AVFoundation reads both
  (`video-tool probe` and `poster` succeed), as does the FFmpeg the Windows
  build bundles. Not a one-second clip: MPEG-TS has no index, so FFmpeg seeks
  it by position and lands on the keyframe at or after the target — in a clip
  with a single keyframe, the poster's seek to 0.5 s found no frame at all.

The HEIF-family files the spec imports (.HIF, .heif) are the HEIC fixture
copied under those names at test time: the bytes are the same format.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
HEIC = HERE.parent / "heic" / "iphone-style.heic"


def main() -> int:
    subprocess.run(["sips", "-s", "format", "psd", "-Z", "320", str(HEIC), "--out", str(HERE / "layered.psd")], check=True, capture_output=True)
    width, height = 64, 48
    gradient = Image.new("RGB", (width, height))
    gradient.putdata([(x * 255 // width, y * 255 // height, 80) for y in range(height) for x in range(width)])
    gradient.save(HERE / "pixel.bmp")
    gradient.convert("P", palette=Image.Palette.ADAPTIVE).save(HERE / "pixel.gif")
    pattern = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25"]
    h264 = ["-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-bf", "2"]
    subprocess.run(["ffmpeg", "-v", "error", "-y", *pattern, "-f", "lavfi", "-i", "sine=frequency=440", *h264, "-c:a", "aac", "-f", "mpegts", str(HERE / "clip.mts")], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *pattern, *h264, "-an", "-f", "3gp", str(HERE / "clip.3gp")], check=True)
    for name in ("layered.psd", "pixel.gif", "pixel.bmp", "clip.mts", "clip.3gp"):
        print(f"{name}: {(HERE / name).stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
