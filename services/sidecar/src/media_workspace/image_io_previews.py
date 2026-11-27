"""Previews through Image I/O on a Mac: the image-features helper's "thumb"
request (native/image-features.swift).

Image I/O decodes a JPEG or HEIF straight to the preview's size. Pillow
decodes a JPEG at a reduced scale too, but a HEIF whole: a 12 MP iPhone
photo took 601 ms through Pillow and 70 ms here, and HEIF was most of an
import's time (docs/import-pipeline-redesign.md §1).

The preview must be the one Pillow makes (preview_service.render_pillow_
preview), since old and new previews sit side by side in a catalog and the
colours, the look-alike hash and the display shape are read from them:

- a JPEG keeps its pixels as stored and the orientation tag Pillow reads;
- a HEIF comes upright and without the tag, as pillow-heif hands it over
  (libheif applies the rotation). A HEIF whose tag pillow-heif keeps is
  left to Pillow;
- the RGB colour space stays (a Display P3 photo stays P3);
- the size is Pillow's to the pixel: a 5997 × 6000 photo is a 512 × 512
  "square" preview there, 511 × 512 "portrait" by Image I/O's rounding;
- what Pillow converts (CMYK, grey, transparency, more than 8 bits a
  channel) the helper declines, and Pillow renders it as before.

The helper's resampling and JPEG encoder differ from Pillow's: measured on
the sample photos, palettes move as much as Pillow's own quality 90 → 85
does, and the hash by 0 to 2 bits.

Each render thread borrows a helper of its own; they stay with the process
for the next batch and close at exit. Anything that goes wrong here (no
helper, an old helper, a timeout, a file Image I/O can't read) sends the
photo back to Pillow, so nothing that rendered before fails.
"""
from __future__ import annotations

import atexit
import json
import math
import os
import select
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from PIL import Image

from . import formats
from .imaging import register_heif
from .processes import no_window

FAMILIES = frozenset({"jpeg", "heif"})
# Image I/O's scale, not libjpeg's: 0.8 comes closest to Pillow's 90 in
# fidelity, at about a sixth more bytes (0.75 is as big as Pillow's 90 and
# a little softer).
JPEG_QUALITY = 0.8
# A render takes tens of milliseconds; a helper that hasn't answered in this
# long is stuck on the file and is put down, and Pillow tries it.
TIMEOUT_SECONDS = 30.0
_ORIENTATION_TAG = 0x0112


class ImageIOPreviewError(RuntimeError):
    """The helper didn't render this file: Pillow renders it instead."""


def _helper_path() -> Path | None:
    if sys.platform != "darwin":
        return None
    from .visual import helper_path_from_env

    return helper_path_from_env()


class _Helper:
    """One `image-features --serve` process, used by one thread at a time."""

    def __init__(self, helper_path: Path) -> None:
        self._process = subprocess.Popen(
            [str(helper_path), "--serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **no_window(),
        )
        self._buffer = b""

    @property
    def alive(self) -> bool:
        return self._process.poll() is None

    def request(self, payload: dict) -> dict:
        process = self._process
        assert process.stdin is not None and process.stdout is not None
        try:
            process.stdin.write((json.dumps(payload) + "\n").encode())
            process.stdin.flush()
            line = self._read_line(process.stdout.fileno())
        except (BrokenPipeError, OSError) as error:
            self.kill()
            raise ImageIOPreviewError(f"image-features helper died: {error}") from error
        try:
            response = json.loads(line)
        except ValueError as error:
            # Something else wrote to its stdout (a framework's log, #215):
            # the next answer could be this one's, so it goes.
            self.kill()
            raise ImageIOPreviewError(f"image-features helper answered out of protocol: {line[:80]!r}") from error
        if not isinstance(response, dict):
            self.kill()
            raise ImageIOPreviewError("image-features helper answered out of protocol")
        return response

    def _read_line(self, fd: int) -> bytes:
        while b"\n" not in self._buffer:
            ready, _, _ = select.select([fd], [], [], TIMEOUT_SECONDS)
            if not ready:
                self.kill()
                raise ImageIOPreviewError(f"image-features helper took over {TIMEOUT_SECONDS:.0f}s")
            chunk = os.read(fd, 65536)
            if not chunk:
                self.kill()
                raise ImageIOPreviewError("image-features helper closed its output")
            self._buffer += chunk
        line, _, self._buffer = self._buffer.partition(b"\n")
        return line

    def kill(self) -> None:
        """Put down a helper that is stuck or has broken the protocol."""
        process = self._process
        try:
            process.kill()
            process.wait(timeout=5)
        except Exception:
            pass
        finally:
            for pipe in (process.stdin, process.stdout):
                try:
                    if pipe:
                        pipe.close()
                except OSError:
                    pass

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


class HelperPool:
    """The preview helpers of this process, lent to one thread at a time;
    as many run as threads render at once. Apart from the feature-print
    helpers (visual.HELPERS): a Mac too slow for prints still renders here."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._idle: dict[Path, list[_Helper]] = {}
        self._all: list[_Helper] = []
        self._renders: dict[Path, bool] = {}
        atexit.register(self.close_all)

    def renders(self, helper_path: Path) -> bool:
        """Whether this helper build takes "thumb" requests, asked once per
        process. An older build reads the flag as a file name and answers
        with an error line instead of "1"."""
        with self._lock:
            known = self._renders.get(helper_path)
        if known is not None:
            return known
        try:
            probe = subprocess.run(
                [str(helper_path), "--thumb-protocol"],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, **no_window(),
            )
            renders = probe.returncode == 0 and probe.stdout.strip() == "1"
        except (OSError, subprocess.SubprocessError):
            renders = False
        with self._lock:
            self._renders[helper_path] = renders
        return renders

    @contextmanager
    def borrow(self, helper_path: Path) -> Iterator[_Helper]:
        with self._lock:
            idle = self._idle.setdefault(helper_path, [])
            helper = idle.pop() if idle else None
        if helper is None or not helper.alive:
            try:
                helper = _Helper(helper_path)
            except OSError as error:
                raise ImageIOPreviewError(f"image-features helper failed to start: {error}") from error
            with self._lock:
                self._all.append(helper)
        try:
            yield helper
        finally:
            if helper.alive:
                with self._lock:
                    self._idle.setdefault(helper_path, []).append(helper)

    def close_all(self) -> None:
        with self._lock:
            helpers, self._all, self._idle = self._all, [], {}
        for helper in helpers:
            helper.close()


HELPERS = HelperPool()


def helper_for(source: Path) -> Path | None:
    """The helper that renders this file's preview, or None: Pillow then.
    JPEG and HEIF only, on a Mac whose helper takes "thumb" requests."""
    fmt = formats.format_for(source)
    if fmt is None or fmt.family not in FAMILIES:
        return None
    helper_path = _helper_path()
    if helper_path is None or not HELPERS.renders(helper_path):
        return None
    return helper_path


def pillow_preview_size(width: int, height: int, size: int) -> tuple[int, int]:
    """The size Image.thumbnail((size, size)) gives a width × height image:
    Pillow's rounding (Image.thumbnail's preserve_aspect_ratio, Pillow 10
    to 12), which picks whichever neighbouring whole number keeps the aspect
    closest, and never enlarges. test_image_io_previews checks it against
    Pillow itself."""
    if size >= width and size >= height:
        return width, height

    def round_aspect(number: float, key) -> int:
        return max(min(math.floor(number), math.ceil(number), key=key), 1)

    x, y = size, size
    aspect = width / height
    if x / y >= aspect:
        x = round_aspect(y * aspect, key=lambda n: abs(aspect - n / y))
    else:
        y = round_aspect(x / aspect, key=lambda n: 0 if n == 0 else abs(aspect - x / n))
    return x, y


def render(helper_path: Path, source: Path, target: Path, size: int) -> None:
    """Write the preview of `source` to `target` (see the module doc), or
    raise ImageIOPreviewError for Pillow to render it instead."""
    fmt = formats.format_for(source)
    heif = fmt is not None and fmt.family == "heif"
    if heif:
        register_heif()
    # What Pillow would make of it, from the header alone (a tenth of a
    # millisecond): the tag it carries over, and the size it decodes at (a
    # JPEG at a reduced scale, draft) and so the size it ends up with.
    try:
        with Image.open(source) as image:
            orientation = int(image.getexif().get(_ORIENTATION_TAG) or 1)
            image.draft("RGB", (size, size))
            width, height = pillow_preview_size(image.width, image.height, size)
    except Exception as error:
        raise ImageIOPreviewError(f"Pillow can't read {source.name}'s header: {error}") from error
    if heif and orientation != 1:
        raise ImageIOPreviewError("a HEIF whose orientation pillow-heif leaves to the viewer")
    request = {
        "id": source.name,
        "op": "thumb",
        "path": str(source),
        "out": str(target),
        "size": size,
        "quality": JPEG_QUALITY,
        "transform": heif,
        "orientation": orientation,
        "width": width,
        "height": height,
    }
    with HELPERS.borrow(helper_path) as helper:
        response = helper.request(request)
    if not response.get("ok"):
        raise ImageIOPreviewError(str(response.get("error") or "no preview"))
