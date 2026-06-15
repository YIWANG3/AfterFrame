from __future__ import annotations

import time
from collections import Counter
from pathlib import Path

from .config import DEFAULT_IMAGE_EXTENSIONS, DEFAULT_RAW_EXTENSIONS
from .metadata import extract_image_candidate, extract_raw_metadata

RAW_FIELDS = ("capture_time", "camera_model", "lens_model", "width", "height")
IMAGE_FIELDS = ("capture_time", "camera_model", "lens_model", "width", "height")


def _field_value(metadata, field: str):
    return getattr(metadata, field, None)


def _non_empty(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True


def _iter_files(directory: Path, extensions: set[str]):
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in extensions:
            continue
        yield path


def _analyze_group(directory: Path, kind: str) -> dict[str, object]:
    if kind == "raw":
        extractor = extract_raw_metadata
        extensions = DEFAULT_RAW_EXTENSIONS
        fields = RAW_FIELDS
    elif kind == "image":
        extractor = extract_image_candidate
        extensions = DEFAULT_IMAGE_EXTENSIONS
        fields = IMAGE_FIELDS
    else:
        raise ValueError(f"unsupported group kind: {kind}")

    start = time.perf_counter()
    total = 0
    errors = 0
    extension_counts: Counter[str] = Counter()
    coverage_counts = {field: 0 for field in fields}
    coverage_samples = {field: [] for field in fields}
    camera_models: Counter[str] = Counter()
    lens_models: Counter[str] = Counter()

    for path in _iter_files(directory, extensions):
        total += 1
        extension_counts[path.suffix.lower()] += 1
        try:
            metadata = extractor(path)
        except Exception:
            errors += 1
            continue

        for field in fields:
            value = _field_value(metadata, field)
            if _non_empty(value):
                coverage_counts[field] += 1
                samples = coverage_samples[field]
                if len(samples) < 5 and value not in samples:
                    samples.append(value)

        if _non_empty(getattr(metadata, "camera_model", None)):
            camera_models[str(metadata.camera_model)] += 1
        if _non_empty(getattr(metadata, "lens_model", None)):
            lens_models[str(metadata.lens_model)] += 1

    elapsed = time.perf_counter() - start
    coverage = {
        field: {
            "count": coverage_counts[field],
            "ratio": round((coverage_counts[field] / total), 4) if total else 0.0,
            "samples": coverage_samples[field],
        }
        for field in fields
    }
    return {
        "kind": kind,
        "directory": str(directory.resolve()),
        "total_files": total,
        "errors": errors,
        "elapsed_seconds": round(elapsed, 4),
        "files_per_second": round((total / elapsed), 2) if elapsed > 0 else 0.0,
        "extensions": dict(extension_counts.most_common()),
        "coverage": coverage,
        "top_camera_models": dict(camera_models.most_common(10)),
        "top_lens_models": dict(lens_models.most_common(10)),
    }


def analyze_metadata_coverage(raw_dirs: list[Path], image_dirs: list[Path]) -> dict[str, object]:
    raw_reports = [_analyze_group(directory.resolve(), "raw") for directory in raw_dirs]
    image_reports = [_analyze_group(directory.resolve(), "image") for directory in image_dirs]
    return {
        "raw_reports": raw_reports,
        "image_reports": image_reports,
    }
