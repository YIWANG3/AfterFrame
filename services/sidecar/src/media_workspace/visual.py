"""What a photo looks like, from its 512 px preview: a perceptual hash and,
on a Mac, Apple Vision's feature print.

The hash (pHash: the low frequencies of a 32×32 greyscale DCT, each bit
"above the median") survives re-encoding, resizing and small crops, so two
exports of one picture are a few bits apart, and tells near-duplicates from
everything else. The feature print is a 768-value unit vector from the
image-features helper (native/image-features.swift); the Euclidean distance
between two says how alike the pictures look, so it ranks "similar" and
confirms a duplicate the hash proposed. Both come from the 512 px preview
so every photo is measured the same way: the feature print shifts with the
input's size, and only previews of one tier compare.
"""
from __future__ import annotations

import base64
import json
import math
import os
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from .processes import no_window

# Names everything a photo's asset_visual row holds (the hash, and what is
# derived with it: the look-alike and burst groups). Bump when any of that
# changes: the visual job then redoes every photo.
HASH_VERSION = "phash-32-8-1/bursts-1"
_HASH_EDGE = 32
_HASH_LOW = 8  # the 8×8 low-frequency corner: 64 bits

# Two hashes this close are the same picture (measured on previews: one
# export's re-encodes and crops land under 6, unrelated photos above 20).
DUPLICATE_MAX_HAMMING = 8
# …and, when both have a feature print, the pictures must look alike too
# (one picture's crops and flips: under 0.3; two shots of one scene: 0.8).
DUPLICATE_MAX_DISTANCE = 0.4

# A burst: frames from one camera this close in time whose pictures are of
# one scene — by feature print (two shots of a scene: 0.8; unrelated: over
# 1.1), or, with no print on one side, loosely by hash.
BURST_MAX_SECONDS = 2
BURST_MAX_DISTANCE = 0.9
BURST_MAX_HAMMING = 16


def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n)[:, None]
    i = np.arange(n)[None, :]
    matrix = np.cos(np.pi * (2 * i + 1) * k / (2 * n)) * math.sqrt(2 / n)
    matrix[0] /= math.sqrt(2)
    return matrix


_DCT = _dct_matrix(_HASH_EDGE)


def hash_pixels(pixels: np.ndarray) -> int:
    """The pHash of a greyscale image given as a 2-D array; see module doc."""
    image = Image.fromarray(pixels.astype(np.uint8), "L").resize((_HASH_EDGE, _HASH_EDGE), Image.Resampling.LANCZOS)
    grey = np.asarray(image, dtype=np.float64)
    low = (_DCT @ grey @ _DCT.T)[:_HASH_LOW, :_HASH_LOW]
    bits = (low > np.median(low)).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def perceptual_hash(path: Path) -> int | None:
    """The pHash of an image file, or None when it can't be read."""
    try:
        with Image.open(path) as image:
            grey = image.convert("L")
            grey.load()
    except Exception:
        return None
    return hash_pixels(np.asarray(grey))


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def to_signed(value: int) -> int:
    """A 64-bit hash as SQLite stores it (INTEGER is signed)."""
    return value - (1 << 64) if value >= (1 << 63) else value


def from_signed(value: int) -> int:
    return value + (1 << 64) if value < 0 else value


def hamming_to_all(hashes: np.ndarray, query: int) -> np.ndarray:
    """Hamming distance from `query` to each of `hashes` (uint64)."""
    diff = np.bitwise_xor(hashes, np.uint64(query))
    return np.unpackbits(diff.view(np.uint8).reshape(len(hashes), 8), axis=1).sum(axis=1)


def pack_embedding(vector: np.ndarray) -> bytes:
    """The vector as the catalog stores it: little-endian float16 (half the
    bytes of float32; distances move by under 0.001)."""
    return np.asarray(vector, dtype="<f2").tobytes()


def unpack_embedding(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype="<f2").astype(np.float32)


def decode_helper_vector(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float32)


def distances_to_all(matrix: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Euclidean distance from `query` to each row of `matrix` (float32)."""
    return np.linalg.norm(matrix - query[None, :], axis=1)


class FeatureHelperError(RuntimeError):
    pass


def helper_path_from_env(helper_path: Path | None = None) -> Path | None:
    """The image-features helper this machine has (an explicit path, else
    IMAGE_FEATURES_PATH from the app), or None: hashes alone then (Windows)."""
    resolved = helper_path or Path(os.environ.get("IMAGE_FEATURES_PATH", ""))
    return resolved if str(resolved) and resolved.is_file() else None


class FeatureHelper:
    """The image-features helper kept running for a job: one JSON request
    per line in, one response per line out (see native/image-features.swift).
    Spawning it per photo would cost more than the feature print."""

    def __init__(self, helper_path: Path) -> None:
        self.helper_path = Path(helper_path)
        if not self.helper_path.exists():
            raise FeatureHelperError(f"image-features helper missing at {self.helper_path}")
        # Which prints this helper makes (revision 2 on macOS 14, 1 before):
        # vectors from different models never compare.
        try:
            probe = subprocess.run([str(self.helper_path), "--model"], capture_output=True, text=True, timeout=30, **no_window())
        except (OSError, subprocess.SubprocessError) as error:
            raise FeatureHelperError(f"image-features helper failed to start: {error}") from error
        self.model = probe.stdout.strip()
        if probe.returncode != 0 or not self.model:
            raise FeatureHelperError("image-features helper did not report its model")
        self._process = subprocess.Popen(
            [str(self.helper_path), "--serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, **no_window(),
        )

    def embed(self, asset_id: str, path: Path) -> tuple[str, np.ndarray]:
        """(model name, vector) for one image, or FeatureHelperError when the
        helper can't read it or has died."""
        process = self._process
        assert process.stdin is not None and process.stdout is not None
        try:
            process.stdin.write(json.dumps({"id": asset_id, "path": str(path)}) + "\n")
            process.stdin.flush()
            line = process.stdout.readline()
        except (BrokenPipeError, OSError) as error:
            raise FeatureHelperError(f"image-features helper died: {error}") from error
        if not line:
            raise FeatureHelperError("image-features helper closed its output")
        response = json.loads(line)
        if not response.get("ok"):
            raise FeatureHelperError(str(response.get("error") or "no feature print"))
        vector = decode_helper_vector(response["b64"])
        if len(vector) != int(response.get("dim") or len(vector)):
            raise FeatureHelperError("feature print length does not match")
        return str(response["model"]), vector

    def close(self) -> None:
        process = self._process
        try:
            if process.stdin:
                process.stdin.close()
            if process.poll() is None:
                process.wait(timeout=5)
        except Exception:
            process.kill()
        finally:
            if process.stdout:
                process.stdout.close()

    def __enter__(self) -> FeatureHelper:
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
