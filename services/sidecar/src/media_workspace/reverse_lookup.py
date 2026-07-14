from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from sqlite3 import Row

from .config import DEFAULT_RAW_EXTENSIONS, Thresholds
from .db import (
    get_registry,
    load_raw_cache,
    load_raw_candidates,
    load_raw_candidates_by_camera_token,
    load_raw_candidates_by_camera,
    load_raw_candidates_by_capture_window,
    upsert_catalog_root,
    upsert_image_asset,
    upsert_raw_asset,
    upsert_video_asset,
    upsert_registry,
)
from .metadata import (
    camera_stem_token,
    extract_image_candidate,
    extract_raw_metadata,
    iso_mtime,
    normalize_stem,
    quick_fingerprint_from_handle,
    stable_asset_id,
    stem_alnum_key,
    stem_key as compute_stem_key,
)
from .models import ImageCandidate, MatchDecision
from .source_readiness import SourceNotReadyError, validate_source_ready
from .video import VIDEO_EXTENSIONS, is_video, probe as probe_video

RESOLVE_BATCH_COMMIT_SIZE = 200
RECALL_LIMIT = 200
IMAGE_EXTENSIONS = {".avif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def _previous_asset_signature(connection, path: Path) -> tuple[str, int, str] | None:
    row = connection.execute(
        """
        SELECT assets.fingerprint, assets.file_size, assets.modified_time
        FROM asset_files
        JOIN assets ON assets.asset_id = asset_files.asset_id
        WHERE asset_files.path = ?
        LIMIT 1
        """,
        (str(path.resolve()),),
    ).fetchone()
    if row is None:
        return None
    return str(row["fingerprint"]), int(row["file_size"]), str(row["modified_time"])


def _content_changed(previous: tuple[str, int, str] | None, fingerprint: str, file_size: int, modified_time: str) -> bool:
    return previous is not None and previous != (str(fingerprint), int(file_size), str(modified_time))


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def stem_similarity(image_stem: str, raw_stem: str) -> float:
    return SequenceMatcher(None, image_stem.lower(), raw_stem.lower()).ratio()


def timestamp_score(image_time: str | None, raw_time: str | None) -> float:
    image_dt = _parse_time(image_time)
    raw_dt = _parse_time(raw_time)
    if not image_dt or not raw_dt:
        return 0.0
    delta = abs((image_dt - raw_dt).total_seconds())
    if delta <= 5:
        return 1.0
    if delta <= 60:
        return 0.85
    if delta <= 5 * 60:
        return 0.6
    if delta <= 60 * 60:
        return 0.3
    return 0.0


def camera_score(export: ImageCandidate, raw: Row) -> float:
    if not export.camera_model or not raw["camera_model"]:
        return 0.0
    return 1.0 if export.camera_model.lower() == raw["camera_model"].lower() else 0.0


def lens_score(export: ImageCandidate, raw: Row) -> float:
    if not export.lens_model or not raw["lens_model"]:
        return 0.0
    return 1.0 if export.lens_model.lower() == raw["lens_model"].lower() else 0.0


def aspect_score(export: ImageCandidate, raw: Row) -> float:
    image_ratio = export.aspect_ratio
    raw_ratio = raw["aspect_ratio"]
    if image_ratio is None or raw_ratio is None:
        return 0.0
    delta = abs(image_ratio - raw_ratio)
    if delta <= 0.01:
        return 1.0
    if delta <= 0.05:
        return 0.6
    return 0.0


def exact_stem_key_score(export: ImageCandidate, raw: Row) -> float:
    return 1.0 if export.stem_key == raw["stem_key"] else 0.0


def alnum_stem_key_score(export: ImageCandidate, raw: Row) -> float:
    image_key = stem_alnum_key(export.stem)
    raw_key = stem_alnum_key(raw["stem"])
    if not image_key or not raw_key:
        return 0.0
    return 1.0 if image_key == raw_key else 0.0


def filename_family_veto(export: ImageCandidate, raw: Row) -> bool:
    if not export.stem_key or not raw["stem_key"]:
        return False
    ratio = stem_similarity(export.stem_key, raw["stem_key"])
    return ratio < 0.35 and exact_stem_key_score(export, raw) == 0 and alnum_stem_key_score(export, raw) == 0


def camera_veto(export: ImageCandidate, raw: Row) -> bool:
    if not export.camera_model or not raw["camera_model"]:
        return False
    return export.camera_model.lower() != raw["camera_model"].lower()


def capture_time_veto(export: ImageCandidate, raw: Row) -> bool:
    image_dt = _parse_time(export.capture_time)
    if not image_dt or not raw["capture_time"]:
        return False
    raw_dt = _parse_time(raw["capture_time"])
    if not raw_dt:
        return False
    return abs(image_dt - raw_dt) > timedelta(hours=6)


def veto_reasons(export: ImageCandidate, raw: Row) -> list[str]:
    reasons: list[str] = []
    if filename_family_veto(export, raw):
        reasons.append("filename_family_conflict")
    if camera_veto(export, raw):
        reasons.append("camera_model_conflict")
    if capture_time_veto(export, raw):
        reasons.append("capture_time_window_exceeded")
    return reasons


def score_candidate(export: ImageCandidate, raw: Row) -> tuple[float, dict[str, float]]:
    features = {
        "exact_stem_key": exact_stem_key_score(export, raw),
        "alnum_stem_key": alnum_stem_key_score(export, raw),
        "stem_similarity": stem_similarity(export.stem_key, raw["stem_key"]),
        "capture_time": timestamp_score(export.capture_time, raw["capture_time"]),
        "camera_model": camera_score(export, raw),
        "lens_model": lens_score(export, raw),
        "aspect_ratio": aspect_score(export, raw),
    }
    weights = {
        "exact_stem_key": 0.62,
        "alnum_stem_key": 0.14,
        "stem_similarity": 0.12,
        "capture_time": 0.06,
        "camera_model": 0.03,
        "lens_model": 0.01,
        "aspect_ratio": 0.02,
    }
    total = sum(features[name] * weight for name, weight in weights.items())
    return round(total, 4), features


def recall_candidates(connection, export: ImageCandidate) -> list[Row]:
    rows = load_raw_candidates(connection, export.stem_key, limit=RECALL_LIMIT)
    if rows:
        return rows
    image_camera_token = camera_stem_token(export.stem)
    if image_camera_token:
        rows = load_raw_candidates_by_camera_token(connection, image_camera_token, limit=RECALL_LIMIT)
        if rows:
            return rows
        return []
    if export.capture_time:
        rows = load_raw_candidates_by_capture_window(
            connection,
            export.capture_time,
            camera_model=export.camera_model,
            limit=RECALL_LIMIT,
        )
        if rows:
            return rows
    if export.camera_model:
        rows = load_raw_candidates_by_camera(connection, export.camera_model, limit=RECALL_LIMIT)
        if rows:
            return rows
    return load_raw_cache(connection, limit=RECALL_LIMIT)


def shortlist_candidates(connection, export: ImageCandidate) -> list[Row]:
    shortlisted: list[Row] = []
    for row in recall_candidates(connection, export):
        if veto_reasons(export, row):
            continue
        shortlisted.append(row)
    return shortlisted


def resolve_image(
    connection,
    image_path: Path,
    thresholds: Thresholds | None = None,
    refresh: bool = False,
    *,
    persist_root: bool = True,
    commit: bool = True,
) -> MatchDecision:
    thresholds = thresholds or Thresholds()
    previous_signature = _previous_asset_signature(connection, image_path)
    export = extract_image_candidate(image_path)
    content_changed = _content_changed(
        previous_signature, export.fingerprint, export.file_size, export.modified_time
    )
    if persist_root:
        upsert_catalog_root(connection, "image", export.path.parent, commit=commit)
    image_asset_id = upsert_image_asset(connection, export, commit=False)

    existing = get_registry(connection, export.path)
    preexisting = existing is not None
    if existing and existing["match_status"] == "manual_confirmed":
        if commit:
            connection.commit()
        return MatchDecision(
            image_asset_id=existing["image_asset_id"],
            image_path=export.path,
            status=existing["match_status"],
            score=float(existing["score"]),
            raw_asset_id=existing["raw_asset_id"],
            feature_vector=json.loads(existing["feature_vector_json"]),
            ranked_candidates=json.loads(existing["candidate_json"]),
            preexisting=preexisting,
            content_changed=content_changed,
        )

    if existing and not refresh and existing["match_status"] == "auto_bound":
        if commit:
            connection.commit()
        return MatchDecision(
            image_asset_id=existing["image_asset_id"],
            image_path=export.path,
            status=existing["match_status"],
            score=float(existing["score"]),
            raw_asset_id=existing["raw_asset_id"],
            feature_vector=json.loads(existing["feature_vector_json"]),
            ranked_candidates=json.loads(existing["candidate_json"]),
            preexisting=preexisting,
            content_changed=content_changed,
        )

    ranked: list[dict[str, object]] = []
    for row in shortlist_candidates(connection, export):
        score, features = score_candidate(export, row)
        ranked.append(
            {
                "raw_asset_id": row["raw_asset_id"],
                "path": row["path"],
                "stem_key": row["stem_key"],
                "score": score,
                "feature_vector": features,
                "decision_stage": "scored",
            }
        )

    ranked.sort(key=lambda item: item["score"], reverse=True)
    top = ranked[0] if ranked else None
    if top and top["score"] >= thresholds.auto_bind:
        status = "auto_bound"
        raw_asset_id = str(top["raw_asset_id"])
        score = float(top["score"])
        feature_vector = dict(top["feature_vector"])
    elif top and top["score"] >= thresholds.manual_review:
        status = "pending_confirmation"
        raw_asset_id = str(top["raw_asset_id"])
        score = float(top["score"])
        feature_vector = dict(top["feature_vector"])
    else:
        status = "unmatched"
        raw_asset_id = None
        score = float(top["score"]) if top else 0.0
        feature_vector = dict(top["feature_vector"]) if top else {}

    decision = MatchDecision(
        image_asset_id=image_asset_id,
        image_path=export.path,
        status=status,
        score=score,
        raw_asset_id=raw_asset_id,
        feature_vector=feature_vector,
        ranked_candidates=ranked[:5],
        preexisting=preexisting,
        content_changed=content_changed,
    )
    upsert_registry(connection, decision, commit=False)
    if commit:
        connection.commit()
    return decision


def _load_tombstones(connection) -> dict[str, tuple[int, float]]:
    return {
        str(row["path"]): (int(row["file_size"]), float(row["mtime"]))
        for row in connection.execute("SELECT path, file_size, mtime FROM deleted_files")
    }


def _is_tombstoned(connection, tombstones: dict[str, tuple[int, float]], path: Path) -> bool:
    """True if `path` is a file the user removed from the catalog and hasn't been
    rewritten since (suppress the auto re-import). If the path has a tombstone but
    its size/mtime changed — e.g. an editor re-exported over it — the tombstone is
    stale: drop it and let the file back in."""
    key = str(path)
    record = tombstones.get(key)
    if record is None:
        return False
    size, mtime = record
    try:
        stat = path.stat()
    except OSError:
        stat = None
    if stat is not None and stat.st_size == size and abs(stat.st_mtime - mtime) < 2:
        return True
    tombstones.pop(key, None)
    connection.execute("DELETE FROM deleted_files WHERE path = ?", (key,))
    return False


def resolve_image_batch(
    connection,
    image_dirs: list[Path],
    thresholds: Thresholds | None = None,
    refresh: bool = False,
    progress_callback=None,
    respect_tombstones: bool = False,
    validate_sources: bool = False,
    persist_roots: bool = True,
) -> dict[str, object]:
    thresholds = thresholds or Thresholds()
    counts: dict[str, int] = {
        "auto_bound": 0,
        "manual_confirmed": 0,
        "pending_confirmation": 0,
        "unmatched": 0,
    }
    processed = 0
    already_in_catalog = 0
    skipped_deleted = 0
    deferred_files = 0
    changed_paths: list[str] = []
    # Auto imports (watched dirs / catch-up) respect tombstones. A manual import
    # is an explicit "bring this back" — clear any tombstone for the files it
    # touches so a later delete behaves predictably.
    tombstones = _load_tombstones(connection)
    total = sum(count_image_files(image_dir.resolve()) for image_dir in image_dirs)
    report_progress(progress_callback, phase="resolve_images", processed=0, total=total, status_counts=counts)

    for image_dir in image_dirs:
        if persist_roots:
            upsert_catalog_root(connection, "image", image_dir.resolve(), commit=False)
        for path in iter_image_files([image_dir.resolve()]):
            if respect_tombstones or validate_sources:
                if _is_tombstoned(connection, tombstones, path):
                    processed += 1
                    skipped_deleted += 1
                    report_progress(progress_callback, phase="resolve_images", processed=processed, total=total, status_counts=counts)
                    continue
            elif str(path) in tombstones:
                tombstones.pop(str(path), None)
                connection.execute("DELETE FROM deleted_files WHERE path = ?", (str(path),))
            if respect_tombstones or validate_sources:
                try:
                    validate_source_ready(path)
                except SourceNotReadyError:
                    # Do not index a first-time partial auto-export: without a
                    # preview, the gallery would otherwise render the partial
                    # original. A later watcher change retries once writing resumes.
                    processed += 1
                    deferred_files += 1
                    report_progress(progress_callback, phase="resolve_images", processed=processed, total=total, status_counts=counts)
                    continue
            if is_video(path):
                decision = index_video_file(connection, path.resolve(), commit=False)
            elif is_raw(path):
                decision = index_raw_file(connection, path.resolve(), commit=False)
            else:
                decision = resolve_image(
                    connection,
                    path.resolve(),
                    thresholds=thresholds,
                    refresh=refresh,
                    persist_root=False,
                    commit=False,
                )
            counts.setdefault(decision.status, 0)
            counts[decision.status] += 1
            if decision.preexisting:
                already_in_catalog += 1
            if decision.content_changed:
                changed_paths.append(str(path.resolve()))
            processed += 1
            if processed % RESOLVE_BATCH_COMMIT_SIZE == 0:
                connection.commit()
            report_progress(progress_callback, phase="resolve_images", processed=processed, total=total, status_counts=counts)

    connection.commit()

    return {
        "processed": processed,
        "total": total,
        "status_counts": {key: value for key, value in counts.items() if value > 0},
        "already_in_catalog": already_in_catalog,
        "newly_added": processed - already_in_catalog - skipped_deleted - deferred_files,
        "skipped_deleted": skipped_deleted,
        "deferred_files": deferred_files,
        "changed_paths": list(dict.fromkeys(changed_paths)),
    }


def is_raw(path: Path) -> bool:
    return path.suffix.lower() in DEFAULT_RAW_EXTENSIONS


def _native_raw_dimensions(path: Path) -> tuple[int, int] | None:
    """True sensor dimensions via Image I/O (sips). RAW EXIF often reports the
    embedded *preview* size — e.g. Hasselblad .3FR yields 3888×2918 instead of
    the real ~11664×8750 — so read the decoded dimensions for display."""
    try:
        result = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
            check=True, capture_output=True, text=True,
        )
    except Exception:
        return None
    width = height = None
    for line in result.stdout.splitlines():
        stripped = line.strip()
        value = stripped.split(":", 1)[1].strip() if ":" in stripped else ""
        # sips emits "pixelWidth: <nil>" for formats it can't decode dimensions
        # for; skip non-numeric values and fall back to the EXIF dims (None).
        if stripped.startswith("pixelWidth:") and value.isdigit():
            width = int(value)
        elif stripped.startswith("pixelHeight:") and value.isdigit():
            height = int(value)
    return (width, height) if width and height else None


def index_raw_file(connection, path: Path, commit: bool = True) -> MatchDecision:
    """Index a RAW as a browseable asset_type='raw' entry — EXIF + dims, no RAW
    matching. The original RAW can't be displayed by the renderer, so its preview
    (rendered by macOS) is the stand-in everywhere; see the preview pipeline.
    Mirrors index_video_file: rides the registry-based browse as 'unmatched'."""
    resolved = path.resolve()
    previous_signature = _previous_asset_signature(connection, resolved)
    existing = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?", (str(resolved),)
    ).fetchone()
    preexisting = existing is not None
    metadata = extract_raw_metadata(resolved, fingerprint_mode="head-tail", metadata_profile="full")
    # EXIF dims can be the embedded preview's size, not the sensor's — override
    # with the true decoded dimensions so the gallery shows real resolution.
    native = _native_raw_dimensions(resolved)
    if native:
        metadata.width, metadata.height = native
    upsert_raw_asset(connection, metadata, commit=False)
    # Imported RAW is a browseable photo in its own right, NOT a reverse-lookup
    # source. Keep it out of the candidate pool so a sibling JPG imported the
    # same way won't bind it as its "raw source" — only the dedicated
    # "Add RAW source" flow registers RAW as a matchable source.
    connection.execute("DELETE FROM raw_metadata_cache WHERE raw_asset_id = ?", (metadata.asset_id,))
    decision = MatchDecision(
        image_asset_id=metadata.asset_id,
        image_path=resolved,
        status="unmatched",
        score=0.0,
        raw_asset_id=None,
        feature_vector={},
        preexisting=preexisting,
        content_changed=_content_changed(
            previous_signature, metadata.fingerprint, metadata.file_size, metadata.modified_time
        ),
    )
    upsert_registry(connection, decision, commit=commit)
    return decision


def index_video_file(connection, path: Path, commit: bool = True) -> MatchDecision:
    """Index a video as asset_type='video' — probe metadata, no RAW matching."""
    resolved = path.resolve()
    previous_signature = _previous_asset_signature(connection, resolved)
    existing = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?", (str(resolved),)
    ).fetchone()
    preexisting = existing is not None
    stat = resolved.stat()
    with resolved.open("rb") as handle:
        fingerprint = quick_fingerprint_from_handle(handle, stat.st_size, mode="head-tail")
    asset_id = str(existing["asset_id"]) if existing else stable_asset_id("video", fingerprint, str(resolved))
    metadata = probe_video(resolved) or {}
    upsert_video_asset(
        connection,
        path=str(resolved),
        asset_id=asset_id,
        stem=resolved.stem,
        normalized_stem=normalize_stem(resolved.stem),
        stem_key=compute_stem_key(resolved.stem),
        extension=resolved.suffix.lower(),
        fingerprint=fingerprint,
        file_size=stat.st_size,
        modified_time=iso_mtime(resolved, stat),
        metadata=metadata,
        commit=commit,
    )
    # Register as 'unmatched' (no RAW) so videos ride the registry-based browse /
    # collection / detail queries exactly like un-paired exports.
    decision = MatchDecision(
        image_asset_id=asset_id,
        image_path=resolved,
        status="unmatched",
        score=0.0,
        raw_asset_id=None,
        feature_vector={},
        preexisting=preexisting,
        content_changed=_content_changed(
            previous_signature, fingerprint, stat.st_size, iso_mtime(resolved, stat)
        ),
    )
    upsert_registry(connection, decision, commit=commit)
    return decision


def count_image_files(image_dir: Path) -> int:
    return sum(1 for _ in iter_image_files([image_dir.resolve()]))


# Image exports + videos share the "import an image folder" scan; the batch
# loop branches by type (videos skip RAW matching).
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | DEFAULT_RAW_EXTENSIONS


def iter_image_files(image_paths: list[Path]):
    for image_path in image_paths:
        image_path = image_path.resolve()
        if image_path.is_file():
            if image_path.suffix.lower() in MEDIA_EXTENSIONS:
                yield image_path
            continue
        for path in sorted(image_path.rglob("*")):
            if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS:
                yield path


def report_progress(progress_callback, **payload) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
