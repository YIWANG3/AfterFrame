from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(slots=True)
class _FileMetadata:
    """What a RAW and a photo share: identity, file stats and the EXIF read
    off the file. Both are built with `**metadata` keyword arguments."""

    asset_id: str
    path: Path
    stem: str
    normalized_stem: str
    stem_key: str
    extension: str
    fingerprint: str
    file_size: int
    modified_time: str
    capture_time: str | None
    rating: int | None
    camera_make: str | None
    camera_model: str | None
    lens_model: str | None
    software: str | None
    iso: int | None
    aperture: float | None
    shutter_speed: float | None
    focal_length: float | None
    flash: int | None
    white_balance: int | None
    color_space: str | int | None
    lens_specification: list[float] | None
    gps_latitude: float | None
    gps_longitude: float | None
    width: int | None
    height: int | None
    # Keyword-only with a default: older constructors do not pass it, and a
    # subclass can still add required fields after it.
    lens_make: str | None = field(default=None, kw_only=True)
    # The XMP sidecar's mtime when the file had one: what changed-media
    # compares to notice a Lightroom re-rating of an otherwise untouched RAW.
    sidecar_modified_time: str | None = field(default=None, kw_only=True)

    @property
    def aspect_ratio(self) -> float | None:
        if not self.width or not self.height:
            return None
        return self.width / self.height


@dataclass(slots=True)
class RawMetadata(_FileMetadata):
    metadata_level: str
    fingerprint_level: str
    enrichment_status: str


@dataclass(slots=True)
class ImageCandidate(_FileMetadata):
    pass


@dataclass(slots=True)
class MatchDecision:
    image_asset_id: str
    image_path: Path
    status: str
    score: float
    raw_asset_id: str | None
    feature_vector: dict[str, float]
    ranked_candidates: list[dict[str, object]] = field(default_factory=list)
    # True when this export was already in the catalog before this import pass —
    # used to report "already imported" counts (re-importing the same folder).
    preexisting: bool = False
    # Same canonical path, but the bytes/mtime changed since the previous pass.
    # Preview generation uses this to bypass a stale ready cache after an editor
    # (notably Lightroom) exports with overwrite enabled.
    content_changed: bool = False
