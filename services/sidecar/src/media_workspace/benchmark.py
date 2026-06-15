from __future__ import annotations

import time
from collections import Counter
from pathlib import Path
from sqlite3 import Connection

from .analysis import analyze_metadata_coverage
from .catalog import ensure_catalog
from .config import DEFAULT_IMAGE_EXTENSIONS, Thresholds
from .db import connect, init_db, set_catalog_path, summary
from .evaluation import evaluate_ground_truth
from .preview_service import PreviewService
from .reverse_lookup import resolve_image
from .scanner import scan_raw_directory


def _iter_image_files(image_dirs: list[Path]):
    for directory in image_dirs:
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() not in DEFAULT_IMAGE_EXTENSIONS:
                continue
            yield path.resolve()


def _count_image_files(image_dirs: list[Path]) -> int:
    return sum(1 for _ in _iter_image_files(image_dirs))


def _round_elapsed(start: float) -> float:
    return round(time.perf_counter() - start, 4)


def benchmark_dataset(
    *,
    catalog_path: Path,
    raw_dirs: list[Path],
    image_dirs: list[Path],
    truth_csv: Path | None = None,
    thresholds: Thresholds | None = None,
    include_previews: bool = True,
    force_scan: bool = False,
    force_previews: bool = False,
    scan_workers: int | None = None,
    fingerprint_mode: str = "head-tail",
    metadata_profile: str = "full",
) -> dict[str, object]:
    thresholds = thresholds or Thresholds()
    raw_dirs = [path.resolve() for path in raw_dirs]
    image_dirs = [path.resolve() for path in image_dirs]
    catalog = ensure_catalog(catalog_path)

    init_start = time.perf_counter()
    connection = _init_catalog_connection(catalog.root)
    init_elapsed = _round_elapsed(init_start)
    try:
        metadata_start = time.perf_counter()
        metadata_report = analyze_metadata_coverage(raw_dirs=raw_dirs, image_dirs=image_dirs)
        metadata_elapsed = _round_elapsed(metadata_start)

        scan_start = time.perf_counter()
        scan_results = [
            scan_raw_directory(
                connection,
                raw_dir,
                force=force_scan,
                workers=scan_workers,
                fingerprint_mode=fingerprint_mode,
                metadata_profile=metadata_profile,
            )
            for raw_dir in raw_dirs
        ]
        scan_elapsed = _round_elapsed(scan_start)
        raw_indexed = sum(int(result["indexed"]) for result in scan_results)
        raw_unchanged = sum(int(result["unchanged"]) for result in scan_results)

        resolve_start = time.perf_counter()
        resolve_report = _resolve_images(connection, image_dirs, thresholds)
        resolve_elapsed = _round_elapsed(resolve_start)

        preview_report: dict[str, object] | None = None
        if include_previews:
            preview_start = time.perf_counter()
            service = PreviewService(catalog=catalog)
            raw_preview = service.generate_batch(
                connection,
                kind="preview",
                asset_type="raw",
                force=force_previews,
            )
            image_preview = service.generate_batch(
                connection,
                kind="preview",
                asset_type="image",
                force=force_previews,
            )
            preview_elapsed = _round_elapsed(preview_start)
            preview_total = (
                int(raw_preview["generated"])
                + int(raw_preview["skipped"])
                + int(raw_preview["failed"])
                + int(image_preview["generated"])
                + int(image_preview["skipped"])
                + int(image_preview["failed"])
            )
            preview_report = {
                "elapsed_seconds": preview_elapsed,
                "assets_processed": preview_total,
                "assets_per_second": round(preview_total / preview_elapsed, 2) if preview_elapsed > 0 else 0.0,
                "raw": raw_preview,
                "image": image_preview,
            }

        evaluation_summary = None
        if truth_csv is not None:
            evaluation_summary = evaluate_ground_truth(connection, truth_csv.resolve(), refresh=False)["summary"]

        dataset_summary = {
            "raw_dirs": [str(path) for path in raw_dirs],
            "image_dirs": [str(path) for path in image_dirs],
            "raw_file_count": sum(report["total_files"] for report in metadata_report["raw_reports"]),
            "image_file_count": _count_image_files(image_dirs),
        }

        scan_total = raw_indexed + raw_unchanged
        stages: dict[str, object] = {
            "init_catalog": {
                "elapsed_seconds": init_elapsed,
                "catalog_path": str(catalog.root),
            },
            "metadata_analysis": {
                "elapsed_seconds": metadata_elapsed,
                **metadata_report,
            },
            "scan_raw": {
                "elapsed_seconds": scan_elapsed,
                "files_processed": scan_total,
                "files_per_second": round(scan_total / scan_elapsed, 2) if scan_elapsed > 0 else 0.0,
                "results": scan_results,
            },
            "resolve_images": {
                "elapsed_seconds": resolve_elapsed,
                "images_per_second": round(resolve_report["images_processed"] / resolve_elapsed, 2)
                if resolve_elapsed > 0
                else 0.0,
                **resolve_report,
            },
        }
        if preview_report is not None:
            stages["generate_previews"] = preview_report

        result: dict[str, object] = {
            "dataset": dataset_summary,
            "thresholds": {
                "auto_bind": thresholds.auto_bind,
            "manual_review": thresholds.manual_review,
        },
        "fingerprint_mode": fingerprint_mode,
        "metadata_profile": metadata_profile,
        "stages": stages,
        "summary": summary(connection),
    }
        if evaluation_summary is not None:
            result["evaluation"] = evaluation_summary
        return result
    finally:
        connection.close()


def _resolve_images(connection: Connection, image_dirs: list[Path], thresholds: Thresholds) -> dict[str, object]:
    counts: Counter[str] = Counter()
    processed = 0
    for image_path in _iter_image_files(image_dirs):
        decision = resolve_image(connection, image_path, thresholds=thresholds)
        counts[decision.status] += 1
        processed += 1
    return {
        "images_processed": processed,
        "status_counts": dict(sorted(counts.items())),
    }


def _init_catalog_connection(catalog_path: Path) -> Connection:
    catalog = ensure_catalog(catalog_path)
    connection = connect(catalog.db_path)
    init_db(connection)
    set_catalog_path(connection, catalog.root)
    return connection
