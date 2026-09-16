from __future__ import annotations

import os
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from typing import Any

from .db import load_raw_cache_index, load_raw_enrichment_candidates, upsert_catalog_root, upsert_raw_asset
from .file_types import is_source_file
from .metadata import extract_raw_metadata, iso_mtime

DEFAULT_SCAN_WORKERS = min(8, max(4, os.cpu_count() or 8))
DEFAULT_BATCH_SIZE = 250
INITIAL_COMMIT_BATCH_SIZE = 50
ProgressCallback = Callable[[dict[str, int | str]], None]


def scan_raw_directory(
    connection,
    raw_dir: Path,
    force: bool = False,
    workers: int | None = None,
    fingerprint_mode: str = "head-tail",
    metadata_profile: str = "full",
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    raw_dir = raw_dir.resolve()
    indexed = 0
    skipped = 0
    unchanged = 0
    commits = 0
    batch_size = DEFAULT_BATCH_SIZE
    processed = 0
    discovered = 0

    upsert_catalog_root(connection, "raw", raw_dir)
    cached_index = load_raw_cache_index(connection, raw_dir)

    worker_count = max(1, workers or DEFAULT_SCAN_WORKERS)
    max_in_flight = max(16, worker_count * 4)
    extract = partial(
        extract_raw_metadata,
        fingerprint_mode=fingerprint_mode,
        metadata_profile=metadata_profile,
    )
    report_progress(
        progress_callback,
        phase="scan_raw",
        processed=processed,
        total=None,
        discovered=discovered,
        indexed=indexed,
        unchanged=unchanged,
        skipped=skipped,
    )

    if worker_count == 1:
        for path in iter_candidate_paths(raw_dir):
            if not is_source_file(path):
                skipped += 1
                continue
            discovered += 1
            stat = path.stat()
            cache_key = str(path.resolve())
            cached = cached_index.get(cache_key)
            if not force and cached == (stat.st_size, iso_mtime(path, stat)):
                unchanged += 1
                processed += 1
                report_progress(
                    progress_callback,
                    phase="scan_raw",
                    processed=processed,
                    total=None,
                    discovered=discovered,
                    indexed=indexed,
                    unchanged=unchanged,
                    skipped=skipped,
                )
                continue

            metadata = extract(path)
            upsert_raw_asset(connection, metadata, commit=False)
            indexed += 1
            processed += 1
            if should_commit(indexed, batch_size):
                connection.commit()
                commits += 1
            report_progress(
                progress_callback,
                phase="scan_raw",
                processed=processed,
                total=None,
                discovered=discovered,
                indexed=indexed,
                unchanged=unchanged,
                skipped=skipped,
            )
    else:
        executor = ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="raw-scan")
        in_flight: deque = deque()
        try:
            for path in iter_candidate_paths(raw_dir):
                if not is_source_file(path):
                    skipped += 1
                    continue
                discovered += 1
                stat = path.stat()
                cache_key = str(path.resolve())
                cached = cached_index.get(cache_key)
                if not force and cached == (stat.st_size, iso_mtime(path, stat)):
                    unchanged += 1
                    processed += 1
                    report_progress(
                        progress_callback,
                        phase="scan_raw",
                        processed=processed,
                        total=None,
                        discovered=discovered,
                        indexed=indexed,
                        unchanged=unchanged,
                        skipped=skipped,
                    )
                    continue

                in_flight.append(executor.submit(extract, path))
                if len(in_flight) >= max_in_flight:
                    metadata = in_flight.popleft().result()
                    upsert_raw_asset(connection, metadata, commit=False)
                    indexed += 1
                    processed += 1
                    if should_commit(indexed, batch_size):
                        connection.commit()
                        commits += 1
                    report_progress(
                        progress_callback,
                        phase="scan_raw",
                        processed=processed,
                        total=None,
                        discovered=discovered,
                        indexed=indexed,
                        unchanged=unchanged,
                        skipped=skipped,
                    )

            while in_flight:
                metadata = in_flight.popleft().result()
                upsert_raw_asset(connection, metadata, commit=False)
                indexed += 1
                processed += 1
                if should_commit(indexed, batch_size):
                    connection.commit()
                    commits += 1
                report_progress(
                    progress_callback,
                    phase="scan_raw",
                    processed=processed,
                    total=None,
                    discovered=discovered,
                    indexed=indexed,
                    unchanged=unchanged,
                    skipped=skipped,
                )
        finally:
            executor.shutdown(wait=True)

    connection.commit()
    if indexed and not should_commit(indexed, batch_size):
        commits += 1
    return {
        "indexed": indexed,
        "skipped": skipped,
        "unchanged": unchanged,
        "forced": int(force),
        "commits": commits,
        "workers": worker_count,
        "fingerprint_mode": fingerprint_mode,
        "metadata_profile": metadata_profile,
        "processed": processed,
        "discovered": discovered,
    }


def enrich_raw_assets(
    connection,
    raw_dirs: list[Path] | None = None,
    limit: int | None = None,
    workers: int | None = None,
    fingerprint_mode: str = "head-only",
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    if fingerprint_mode != "head-only":
        raise ValueError("enrich-raw currently supports only fingerprint-mode=head-only to avoid raw asset id churn")

    roots = [path.resolve() for path in raw_dirs] if raw_dirs else None
    candidates = load_raw_enrichment_candidates(connection, roots=roots, limit=limit)
    enriched = 0
    failed = 0
    commits = 0
    batch_size = DEFAULT_BATCH_SIZE
    total = len(candidates)
    processed = 0

    worker_count = max(1, workers or DEFAULT_SCAN_WORKERS)
    extract = partial(
        extract_raw_metadata,
        fingerprint_mode=fingerprint_mode,
        metadata_profile="full",
    )
    report_progress(
        progress_callback,
        phase="enrich_raw",
        processed=processed,
        total=total,
        enriched=enriched,
        failed=failed,
    )

    if worker_count == 1:
        for row in candidates:
            try:
                metadata = extract(Path(str(row["path"])))
            except OSError:
                failed += 1
                processed += 1
                report_progress(
                    progress_callback,
                    phase="enrich_raw",
                    processed=processed,
                    total=total,
                    enriched=enriched,
                    failed=failed,
                )
                continue
            upsert_raw_asset(connection, metadata, commit=False)
            enriched += 1
            processed += 1
            if should_commit(enriched, batch_size):
                connection.commit()
                commits += 1
            report_progress(
                progress_callback,
                phase="enrich_raw",
                processed=processed,
                total=total,
                enriched=enriched,
                failed=failed,
            )
    else:
        executor = ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="raw-enrich")
        in_flight: deque = deque()
        max_in_flight = max(16, worker_count * 4)
        try:
            for row in candidates:
                in_flight.append(executor.submit(extract, Path(str(row["path"]))))
                if len(in_flight) >= max_in_flight:
                    try:
                        metadata = in_flight.popleft().result()
                    except OSError:
                        failed += 1
                        processed += 1
                        report_progress(
                            progress_callback,
                            phase="enrich_raw",
                            processed=processed,
                            total=total,
                            enriched=enriched,
                            failed=failed,
                        )
                        continue
                    upsert_raw_asset(connection, metadata, commit=False)
                    enriched += 1
                    processed += 1
                    if should_commit(enriched, batch_size):
                        connection.commit()
                        commits += 1
                    report_progress(
                        progress_callback,
                        phase="enrich_raw",
                        processed=processed,
                        total=total,
                        enriched=enriched,
                        failed=failed,
                    )
            while in_flight:
                try:
                    metadata = in_flight.popleft().result()
                except OSError:
                    failed += 1
                    processed += 1
                    report_progress(
                        progress_callback,
                        phase="enrich_raw",
                        processed=processed,
                        total=total,
                        enriched=enriched,
                        failed=failed,
                    )
                    continue
                upsert_raw_asset(connection, metadata, commit=False)
                enriched += 1
                processed += 1
                if should_commit(enriched, batch_size):
                    connection.commit()
                    commits += 1
                report_progress(
                    progress_callback,
                    phase="enrich_raw",
                    processed=processed,
                    total=total,
                    enriched=enriched,
                    failed=failed,
                )
        finally:
            executor.shutdown(wait=True)

    connection.commit()
    if enriched and not should_commit(enriched, batch_size):
        commits += 1
    return {
        "queued": len(candidates),
        "enriched": enriched,
        "failed": failed,
        "workers": worker_count,
        "fingerprint_mode": fingerprint_mode,
    }


def worker_count_hint(workers: int | None) -> int:
    return max(1, workers or DEFAULT_SCAN_WORKERS)


def iter_candidate_paths(raw_dir: Path):
    raw_dir = raw_dir.resolve()
    if raw_dir.is_file():
        yield raw_dir
        return
    for current_root, dir_names, file_names in os.walk(raw_dir):
        dir_names.sort()
        file_names.sort()
        current_dir = Path(current_root)
        for name in file_names:
            yield current_dir / name


def should_commit(indexed: int, batch_size: int) -> bool:
    if indexed <= 0:
        return False
    if indexed <= batch_size:
        return indexed % min(INITIAL_COMMIT_BATCH_SIZE, batch_size) == 0
    return indexed % batch_size == 0


def report_progress(progress_callback: ProgressCallback | None, **payload: Any) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
