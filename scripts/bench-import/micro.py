"""Per-photo costs behind a thumbnail, one at a time (no thread contention):
the current Pillow path per format, ImageIO via sips for comparison, the
colour extraction, and the look-alike measurement.

usage: micro.py <photos dir> <out dir>
"""

import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services/sidecar/src"))
os.environ["IMAGE_FEATURES_PATH"] = str(REPO / "apps/desktop/native/bin/image-features")

from media_workspace import colors, preview_service  # noqa: E402

photos = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
jpegs = sorted(photos.rglob("*.jpg"))[:20]
heics = sorted(photos.rglob("*.heic"))[:20]


def bench(label, fn, items):
    times = []
    for item in items:
        start = time.perf_counter()
        fn(item)
        times.append((time.perf_counter() - start) * 1000)
    print(f"{label:48s} median {statistics.median(times):7.1f} ms   (n={len(times)})")


def pillow(path):
    preview_service.render_pillow_preview(path, out / f"{path.stem}.pillow.jpg", 512)


def sips(path):
    subprocess.run(["sips", "-Z", "512", "-s", "format", "jpeg", str(path), "--out", str(out / f"{path.stem}.sips.jpg")],
                   check=True, capture_output=True)


def palette(path):
    colors.extract_palette(out / f"{path.stem}.pillow.jpg")


bench("Pillow thumbnail, 24 MP JPEG", pillow, jpegs)
bench("Pillow thumbnail, 12 MP HEIC", pillow, heics)
bench("sips (ImageIO) thumbnail, 24 MP JPEG (+process)", sips, jpegs)
bench("sips (ImageIO) thumbnail, 12 MP HEIC (+process)", sips, heics)
bench("colour palette from the 512 thumbnail", palette, jpegs)
