"""Pillow set-up shared by every module that opens an image."""
from __future__ import annotations

_heif_registered = False


def register_heif() -> None:
    """HEIC/HEIF (iPhone) through pillow-heif, once per process."""
    global _heif_registered
    if _heif_registered:
        return
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:  # no wheel for this platform: HEIC then fails to open
        pass
    _heif_registered = True
