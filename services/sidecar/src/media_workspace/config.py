from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_RAW_EXTENSIONS = {
    ".3fr",
    ".arw",
    ".cr2",
    ".cr3",
    ".dng",
    ".erf",
    ".nef",
    ".orf",
    ".pef",
    ".raf",
    ".raw",
    ".rw2",
    ".sr2",
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


@dataclass(slots=True)
class WorkspaceConfig:
    catalog_path: Path
    raw_dirs: tuple[Path, ...] = ()
    image_dirs: tuple[Path, ...] = ()
    poll_interval_seconds: float = 2.0
    thresholds: Thresholds = field(default_factory=Thresholds)

