from __future__ import annotations

import json
import time
from collections import Counter
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from sqlite3 import Row
from typing import Any

from . import exiftool, formats
from .config import Thresholds
from .db import (
    get_registry,
    load_raw_cache,
    load_raw_candidates,
    load_raw_candidates_by_camera,
    load_raw_candidates_by_camera_token,
    load_raw_candidates_by_capture_window,
    upsert_catalog_root,
    upsert_image_asset,
    upsert_raw_asset,
    upsert_registry,
    upsert_video_asset,
)
from .db.maintenance import claim_moved_original
from .db.raw_pairs import pair_asset
from .file_types import is_ignored_path
from .metadata import (
    camera_stem_token,
    extract_image_candidate,
    extract_raw_metadata,
    iso_mtime,
    normalize_stem,
    quick_fingerprint_from_handle,
    sidecar_path,
    sidecar_rating,
    stable_asset_id,
    stem_alnum_key,
)
from .metadata import (
    stem_key as compute_stem_key,
)
from .models import ImageCandidate, MatchDecision
from .progress import ProgressCallback, report_progress
from .source_readiness import SourceNotReadyError, validate_source_ready
from .video import is_video
from .video import probe as probe_video

# Files indexed per commit. One: the next file's metadata read (ExifTool,
# LibRaw — seconds for a 200 MB RAW on a drive) must not run inside an open
# write transaction, or every other process waiting on the catalog gives up
# after its busy timeout ("database is locked", 0.5.8 report).
RESOLVE_BATCH_COMMIT_SIZE = 1
# An import hands its photos on in batches this size, or whatever it has
# after this long (a slow disk still shows progress).
IMPORT_BATCH_SIZE = 100
IMPORT_BATCH_SECONDS = 8.0
RECALL_LIMIT = 200


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


def unchanged_asset_id(connection, path: Path) -> str | None:
    """The asset this file is when the catalog holds it as it is on disk:
    present, the same size and mtime, its XMP sidecar as it was (Lightroom
    re-rates a RAW by writing only the sidecar). An import has nothing to
    read in such a file; a watched folder doesn't import it at all
    (watched.changed_media). None for anything else, unreadable files too."""
    try:
        stat = path.stat()
    except OSError:
        return None
    known = connection.execute(
        """
        SELECT assets.asset_id, assets.file_size, assets.modified_time, assets.exists_on_disk,
               json_extract(assets.metadata_json, '$.sidecar_modified_time') AS sidecar_modified_time
        FROM asset_files
        JOIN assets ON assets.asset_id = asset_files.asset_id
        WHERE asset_files.path = ?
        LIMIT 1
        """,
        (str(path),),
    ).fetchone()
    if known is None or int(known["exists_on_disk"]) != 1:
        return None
    if int(stat.st_size) != int(known["file_size"] or 0) or iso_mtime(path, stat) != str(known["modified_time"] or ""):
        return None
    sidecar = sidecar_path(path)
    if (iso_mtime(sidecar) if sidecar is not None else None) != known["sidecar_modified_time"]:
        return None
    return str(known["asset_id"])


def _parse_time(value: str | None) -> datetime | None:
    """A capture time as the camera's clock showed it. Catalogs from before
    capture times dropped their (wrong) +00:00 hold both forms until
    migrated; comparing the two would raise, so the offset is dropped."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=None)
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
    export = extract_image_candidate(image_path)
    claimed = claim_moved_original(connection, "image", export.path, export.fingerprint) is not None
    previous_signature = _previous_asset_signature(connection, image_path)
    content_changed = _content_changed(
        previous_signature, export.fingerprint, export.file_size, export.modified_time
    )
    if persist_root:
        upsert_catalog_root(connection, "image", export.path.parent, commit=commit)
    image_asset_id = upsert_image_asset(connection, export, commit=False)

    existing = get_registry(connection, export.path)
    preexisting = existing is not None

    def _decision_from_registry(row: Row) -> MatchDecision:
        # The registry already holds the answer: hand it back as-is.
        if commit:
            connection.commit()
        return MatchDecision(
            image_asset_id=row["image_asset_id"],
            image_path=export.path,
            status=row["match_status"],
            score=float(row["score"]),
            raw_asset_id=row["raw_asset_id"],
            feature_vector=json.loads(row["feature_vector_json"]),
            ranked_candidates=json.loads(row["candidate_json"]),
            preexisting=preexisting,
            content_changed=content_changed,
            claimed=claimed,
        )

    if existing and existing["match_status"] == "manual_confirmed":
        return _decision_from_registry(existing)

    if existing and not refresh and existing["match_status"] == "auto_bound":
        return _decision_from_registry(existing)

    ranked: list[dict[str, Any]] = []
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
        claimed=claimed,
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
    progress_callback: ProgressCallback | None = None,
    respect_tombstones: bool = False,
    validate_sources: bool = False,
    persist_roots: bool = True,
    batch_callback=None,
    skip_unchanged: bool = False,
) -> dict[str, Any]:
    """Index every media file under `image_dirs`. With `batch_callback`, the
    files are committed and handed on in batches as they are indexed
    (`batch_callback(paths, changed_paths)`), so an import can finish each
    batch (its previews) and show it before indexing the next.

    With `skip_unchanged` (importing a folder again), a file the catalog
    holds as it is on disk (unchanged_asset_id) is not read or matched
    again: ExifTool and the fingerprint were most of a re-import, and grow
    with the folder (a large one on a network drive took minutes). It still
    counts as already in the catalog, is paired as before, and goes on with
    its batch, so a missing thumbnail is still repaired. Matching against
    RAW sources again (the "Match with RAW" imports) leaves it off."""
    thresholds = thresholds or Thresholds()
    counts: dict[str, int] = {
        "auto_bound": 0,
        "manual_confirmed": 0,
        "pending_confirmation": 0,
        "unmatched": 0,
    }
    processed = 0
    already_in_catalog = 0
    claimed_moved = 0
    skipped_deleted = 0
    deferred_files = 0
    raw_pairs_made = 0
    changed_paths: list[str] = []
    # Auto imports (watched dirs / catch-up) respect tombstones. A manual import
    # is an explicit "bring this back" — clear any tombstone for the files it
    # touches so a later delete behaves predictably.
    tombstones = _load_tombstones(connection)
    batch: list[Path] = []
    batch_changed: list[Path] = []
    last_flush = time.monotonic()

    def flush() -> None:
        nonlocal last_flush
        connection.commit()
        if batch_callback and batch:
            batch_callback(list(batch), list(batch_changed))
        batch.clear()
        batch_changed.clear()
        last_flush = time.monotonic()

    # One walk of each folder: the total is its length (counting first walked
    # it twice, a stat a file each time, which a network drive feels).
    skipped = new_skip_counts()
    walks = [(image_dir, list(iter_image_files([image_dir.resolve()], skipped))) for image_dir in image_dirs]
    total = sum(len(files) for _, files in walks)
    report_progress(progress_callback, phase="resolve_images", processed=0, total=total, status_counts=counts)

    # Whether each file is as the catalog holds it, asked once: by ExifTool's
    # read-ahead (an unchanged file isn't read) or else by the loop.
    unchanged: dict[Path, str | None] = {}

    def wanted(path: Path) -> bool:
        if is_video(path):
            return False
        if skip_unchanged:
            unchanged[path] = unchanged_asset_id(connection, path)
            return unchanged[path] is None
        return True

    for image_dir, files in walks:
        # A folder is a root whatever it holds; a lone file only when it is
        # one the catalog imports (a dropped .docx was registered as a root).
        if persist_roots and (image_dir.is_dir() or image_dir.suffix.lower() in MEDIA_EXTENSIONS):
            upsert_catalog_root(connection, "image", image_dir.resolve(), commit=False)
        # Metadata is read one file at a time below; ExifTool reads the next
        # few meanwhile.
        for path in exiftool.read_ahead(files, wanted=wanted):
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
            kind = formats.kind_of(path)
            known_asset_id = unchanged.pop(path) if path in unchanged else (
                unchanged_asset_id(connection, path) if skip_unchanged else None
            )
            if known_asset_id is not None:
                if kind != "video" and pair_asset(connection, known_asset_id):
                    raw_pairs_made += 1
                registry = get_registry(connection, path)
                if registry is not None:
                    counts.setdefault(registry["match_status"], 0)
                    counts[registry["match_status"]] += 1
                already_in_catalog += 1
                batch.append(path.resolve())
                processed += 1
                if batch_callback and (len(batch) >= IMPORT_BATCH_SIZE or time.monotonic() - last_flush >= IMPORT_BATCH_SECONDS):
                    flush()
                report_progress(progress_callback, phase="resolve_images", processed=processed, total=total, status_counts=counts)
                continue
            if kind == "video":
                decision = index_video_file(connection, path.resolve(), commit=False)
            elif kind == "raw":
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
            if kind != "video" and pair_asset(connection, decision.image_asset_id):
                raw_pairs_made += 1
            counts.setdefault(decision.status, 0)
            counts[decision.status] += 1
            # A claimed file was not in the catalog under this path, but it
            # is not new either: its record came along.
            if decision.claimed:
                claimed_moved += 1
            elif decision.preexisting:
                already_in_catalog += 1
            if decision.content_changed:
                changed_paths.append(str(path.resolve()))
                batch_changed.append(path.resolve())
            batch.append(path.resolve())
            processed += 1
            if batch_callback and (len(batch) >= IMPORT_BATCH_SIZE or time.monotonic() - last_flush >= IMPORT_BATCH_SECONDS):
                flush()
            elif processed % RESOLVE_BATCH_COMMIT_SIZE == 0:
                connection.commit()
            report_progress(progress_callback, phase="resolve_images", processed=processed, total=total, status_counts=counts)

    flush()

    return {
        "processed": processed,
        "total": total,
        "status_counts": {key: value for key, value in counts.items() if value > 0},
        "already_in_catalog": already_in_catalog,
        "newly_added": processed - already_in_catalog - claimed_moved - skipped_deleted - deferred_files,
        "claimed_moved": claimed_moved,
        "skipped_deleted": skipped_deleted,
        "deferred_files": deferred_files,
        "raw_pairs_made": raw_pairs_made,
        "skipped_unsupported": skip_summary(skipped["unsupported"]),
        "skipped_companion": skip_summary(skipped["companion"]),
        "changed_paths": list(dict.fromkeys(changed_paths)),
    }


def is_raw(path: Path) -> bool:
    return formats.kind_of(path) == "raw"


def index_raw_file(connection, path: Path, commit: bool = True) -> MatchDecision:
    """Index a RAW as a browseable asset_type='raw' entry — EXIF + dims, no RAW
    matching. The original RAW can't be displayed by the renderer, so its preview
    (rendered by macOS) is the stand-in everywhere; see the preview pipeline.
    Mirrors index_video_file: rides the registry-based browse as 'unmatched'."""
    resolved = path.resolve()
    # Its size is LibRaw's, cropped to the image the camera delivers.
    metadata = extract_raw_metadata(resolved, fingerprint_mode="head-tail", metadata_profile="full")
    claimed = claim_moved_original(connection, "raw", resolved, metadata.fingerprint) is not None
    previous_signature = _previous_asset_signature(connection, resolved)
    existing = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?", (str(resolved),)
    ).fetchone()
    preexisting = existing is not None
    # A photo is one file, so key it by path like images and videos. Keyed by
    # content alone, byte-identical copies (a re-downloaded "x (1).3FR") were
    # one asset whose size and mtime matched only one of them: the other card
    # read as changed on disk, and the gallery repaired and re-rendered both
    # in a loop. A path that already is a RAW asset keeps it (upsert_raw_asset).
    metadata.asset_id = stable_asset_id("raw", metadata.fingerprint, str(resolved))
    # Imported RAW is a browseable photo in its own right, NOT a reverse-lookup
    # source: a sibling JPG imported the same way won't bind it as its "raw
    # source". Only the dedicated "Add RAW source" flow registers RAW as a
    # matchable source, and importing the folder again leaves that alone.
    upsert_raw_asset(connection, metadata, commit=False, register_source=False)
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
        claimed=claimed,
    )
    upsert_registry(connection, decision, commit=commit)
    return decision


def index_video_file(connection, path: Path, commit: bool = True) -> MatchDecision:
    """Index a video as asset_type='video' — probe metadata, no RAW matching."""
    resolved = path.resolve()
    stat = resolved.stat()
    with resolved.open("rb") as handle:
        fingerprint = quick_fingerprint_from_handle(handle, stat.st_size, mode="head-tail")
    claimed = claim_moved_original(connection, "video", resolved, fingerprint) is not None
    previous_signature = _previous_asset_signature(connection, resolved)
    existing = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?", (str(resolved),)
    ).fetchone()
    preexisting = existing is not None
    asset_id = str(existing["asset_id"]) if existing else stable_asset_id("video", fingerprint, str(resolved))
    metadata = probe_video(resolved) or {}
    # Lightroom can't write stars into a clip, so a rated video has a sidecar.
    sidecar = sidecar_path(resolved)
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
        rating=sidecar_rating(sidecar) if sidecar is not None else None,
        sidecar_modified_time=iso_mtime(sidecar) if sidecar is not None else None,
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
        claimed=claimed,
    )
    upsert_registry(connection, decision, commit=commit)
    return decision


# Image exports, RAWs and videos share the "import an image folder" scan; the
# batch loop branches by kind (videos skip RAW matching). The registry says
# what counts.
MEDIA_EXTENSIONS = formats.IMPORTABLE_EXTENSIONS


def new_skip_counts() -> dict[str, Counter[str]]:
    """What an import walk leaves out, by extension: `unsupported` (the user
    is told) and `companion` (sidecars of photos, kept quiet about)."""
    return {"unsupported": Counter(), "companion": Counter()}


def skip_summary(counts: Counter[str]) -> dict[str, Any]:
    return {"count": sum(counts.values()), "by_extension": dict(counts.most_common())}


def iter_image_files(image_paths: list[Path], skipped: dict[str, Counter[str]] | None = None):
    """The files an import of `image_paths` (folders or files) takes, in
    order. Hidden and system files are passed over silently; every other file
    outside the registry is counted in `skipped` (new_skip_counts()) when one
    is given, so the import can say what it left out."""
    def take(path: Path) -> bool:
        if path.suffix.lower() in MEDIA_EXTENSIONS:
            return True
        if skipped is not None and not path.name.startswith("."):
            bucket = "companion" if formats.is_companion(path) else "unsupported"
            skipped[bucket][path.suffix.lower()] += 1
        return False

    for image_path in image_paths:
        image_path = image_path.resolve()
        if is_ignored_path(image_path):
            continue
        if image_path.is_file():
            if take(image_path):
                yield image_path
            continue
        for path in sorted(image_path.rglob("*")):
            if not is_ignored_path(path) and path.is_file() and take(path):
                yield path
