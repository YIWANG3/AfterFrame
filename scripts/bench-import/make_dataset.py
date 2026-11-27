"""Build a throwaway import-benchmark folder from the repo's sample photos.

Camera-sized files: JPEGs upscaled to ~24 MP with grain added back (so the
files have real-photo entropy and size, not smooth upscales), HEICs at 12 MP.
Every file is unique (own crop, own grain, own capture time) so fingerprints
and asset ids differ, and the source EXIF (camera, lens) is kept.

usage: make_dataset.py <sample-photos dir> <out dir> <n_jpeg> <n_heic> [--sips] [--workers N]

--sips encodes the HEICs with macOS's sips (the hardware HEVC encoder, as
an iPhone does) instead of pillow-heif's x265: a minute instead of most of
the twelve, and far less heat. The first measurement (2026-11-26, §1 of
the redesign) used pillow-heif; compare before and after on one set only.
--workers caps the processes (default: one per core).
"""

import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
N_JPEG = int(sys.argv[3])
N_HEIC = int(sys.argv[4])
SIPS = "--sips" in sys.argv
WORKERS = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else None
SOURCES = sorted(SRC.glob("sample-*.jpg"))
BASE_TIME = datetime(2026, 5, 1, 9, 0, 0)


def make(job):
    index, kind = job
    rng = np.random.default_rng(index)
    source = SOURCES[index % len(SOURCES)]
    with Image.open(source) as im:
        exif = im.getexif()
        img = im.convert("RGB")
    w, h = img.size
    # A slightly different crop per copy, then up to camera size.
    dx, dy = int(rng.integers(0, 40)), int(rng.integers(0, 40))
    img = img.crop((dx, dy, w - 40 + dx, h - 40 + dy))
    long_edge = 6000 if kind == "jpeg" else 4032
    scale = long_edge / max(img.size)
    img = img.resize((round(img.size[0] * scale), round(img.size[1] * scale)), Image.Resampling.BICUBIC)
    pixels = np.asarray(img, dtype=np.int16)
    grain = rng.normal(0, 4.0, pixels.shape[:2])[..., None]
    pixels = np.clip(pixels + grain, 0, 255).astype(np.uint8)
    img = Image.fromarray(pixels, "RGB")
    shot = BASE_TIME + timedelta(seconds=index * 7)
    exif_ifd = exif.get_ifd(0x8769)
    exif_ifd[36867] = shot.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeOriginal
    exif[306] = shot.strftime("%Y:%m:%d %H:%M:%S")
    shoot = OUT / f"shoot-{index // 100:02d}"
    shoot.mkdir(parents=True, exist_ok=True)
    if kind == "jpeg":
        target = shoot / f"IMG_{index:05d}.jpg"
        img.save(target, "JPEG", quality=92, exif=exif.tobytes())
    elif SIPS:
        target = shoot / f"IMG_{index:05d}.heic"
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / "staged.jpg"
            img.save(staged, "JPEG", quality=97, exif=exif.tobytes())
            subprocess.run(["sips", "-s", "format", "heic", "-s", "formatOptions", "80", str(staged), "--out", str(target)],
                           check=True, capture_output=True)
    else:
        import pillow_heif

        target = shoot / f"IMG_{index:05d}.heic"
        heif = pillow_heif.from_pillow(img)
        heif.save(target, quality=80, exif=exif.tobytes())
    return target.stat().st_size


if __name__ == "__main__":
    jobs = [(i, "jpeg") for i in range(N_JPEG)] + [(N_JPEG + i, "heic") for i in range(N_HEIC)]
    with Pool(WORKERS) as pool:
        sizes = pool.map(make, jobs, chunksize=4)
    print(f"{len(sizes)} files, {sum(sizes) / 1e9:.2f} GB, mean {sum(sizes) / len(sizes) / 1e6:.1f} MB")
