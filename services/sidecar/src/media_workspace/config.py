from __future__ import annotations

from dataclasses import dataclass

# RAW extensions vary by manufacturer; cover the full common set so files are
# recognized on import regardless of camera brand. (Whether a given format also
# *renders* depends on macOS Image I/O support — unsupported ones still import
# but may lack a preview. Video-RAW like .braw/.r3d is intentionally excluded.)
DEFAULT_RAW_EXTENSIONS = {
    ".3fr",                                  # Hasselblad
    ".ari",                                  # Arri
    ".arw", ".srf", ".sr2",                  # Sony
    ".bay",                                  # Casio
    ".cap", ".iiq", ".eip",                  # Phase One
    ".cr2", ".cr3", ".crw",                  # Canon
    ".dcs", ".dcr", ".drf", ".k25", ".kdc",  # Kodak
    ".dng",                                  # Adobe / Leica / Pentax / Ricoh / …
    ".erf",                                  # Epson
    ".fff",                                  # Imacon / Hasselblad
    ".gpr",                                  # GoPro
    ".mef",                                  # Mamiya
    ".mdc",                                  # Minolta / Agfa
    ".mos",                                  # Leaf
    ".mrw",                                  # Minolta
    ".nef", ".nrw",                          # Nikon
    ".orf",                                  # Olympus / OM System
    ".pef", ".ptx",                          # Pentax
    ".pxn",                                  # Logitech
    ".raf",                                  # Fujifilm
    ".raw", ".rw2", ".rwl", ".rwz",          # Panasonic / Leica / generic
    ".srw",                                  # Samsung
    ".x3f",                                  # Sigma (Foveon)
}

DEFAULT_IMAGE_EXTENSIONS = {
    ".avif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}


@dataclass(slots=True)
class Thresholds:
    auto_bind: float = 0.90
    manual_review: float = 0.7
