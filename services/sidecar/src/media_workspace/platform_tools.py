"""Where the sidecar runs, asked once.

The platform decides a few things across the package: whether a program
gets a console window, which decoders exist, how the sidecar itself is
started. They are read from here rather than compared against sys.platform
in each place. processes.py, the Windows switch itself, keeps its literal
checks: mypy skips its Windows-only ctypes block on the literal, and its
tests patch sys.platform at runtime.
"""
from __future__ import annotations

import shutil
import sys
from functools import lru_cache

IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"


def is_frozen() -> bool:
    """Running as the packaged (PyInstaller) sidecar, not from a checkout."""
    return bool(getattr(sys, "frozen", False))


@lru_cache(maxsize=1)
def has_image_io() -> bool:
    """macOS's Image I/O renderers (sips, Quick Look) are here. Probed once
    per process: the previews asked this on every file."""
    return shutil.which("sips") is not None
