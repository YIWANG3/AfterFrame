from __future__ import annotations

import json
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from sqlite3 import Row

from .config import Thresholds
from .db import (
    get_registry,
    load_raw_cache,
    load_raw_candidates,
    load_raw_candidates_by_camera_token,
    load_raw_candidates_by_camera,
    load_raw_candidates_by_capture_window,
    upsert_catalog_root,
    upsert_export_asset,
    upsert_registry,
)
from .metadata import camera_stem_token, extract_export_candidate, stem_alnum_key
from .models import ExportCandidate, MatchDecision

RESOLVE_BATCH_COMMIT_SIZE = 200
RECALL_LIMIT = 200
EXPORT_EXTENSIONS = {".avif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def stem_similarity(export_stem: str, raw_stem: str) -> float:
    return SequenceMatcher(None, export_stem.lower(), raw_stem.lower()).ratio()


def timestamp_score(export_time: str | None, raw_time: str | None) -> float:
    export_dt = _parse_time(export_time)
    raw_dt = _parse_time(raw_time)
    if not export_dt or not raw_dt:
        return 0.0
    delta = abs((export_dt - raw_dt).total_seconds())
    if delta <= 5:
        return 1.0
    if delta <= 60:
        return 0.85
    if delta <= 5 * 60:
        return 0.6
    if delta <= 60 * 60:
        return 0.3
    return 0.0


def camera_score(export: ExportCandidate, raw: Row) -> float:
    if not export.camera_model or not raw["camera_model"]:
        return 0.0
    return 1.0 if export.camera_model.lower() == raw["camera_model"].lower() else 0.0


def lens_score(export: ExportCandidate, raw: Row) -> float:
    if not export.lens_model or not raw["lens_model"]:
        return 0.0
    return 1.0 if export.lens_model.lower() == raw["lens_model"].lower() else 0.0


def aspect_score(export: ExportCandidate, raw: Row) -> float:
    export_ratio = export.aspect_ratio
    raw_ratio = raw["aspect_ratio"]
    if export_ratio is None or raw_ratio is None:
        return 0.0
    delta = abs(export_ratio - raw_ratio)
    if delta <= 0.01:
        return 1.0
    if delta <= 0.05:
        return 0.6
    return 0.0


def exact_stem_key_score(export: ExportCandidate, raw: Row) -> float:
    return 1.0 if export.stem_key == raw["stem_key"] else 0.0


def alnum_stem_key_score(export: ExportCandidate, raw: Row) -> float:
    export_key = stem_alnum_key(export.stem)
    raw_key = stem_alnum_key(raw["stem"])
    if not export_key or not raw_key:
        return 0.0
    return 1.0 if export_key == raw_key else 0.0


def filename_family_veto(export: ExportCandidate, raw: Row) -> bool:
    if not export.stem_key or not raw["stem_key"]:
        return False
    ratio = stem_similarity(export.stem_key, raw["stem_key"])
    return ratio < 0.35 and exact_stem_key_score(export, raw) == 0 and alnum_stem_key_score(export, raw) == 0


def camera_veto(export: ExportCandidate, raw: Row) -> bool:
    if not export.camera_model or not raw["camera_model"]:
        return False
    return export.camera_model.lower() != raw["camera_model"].lower()


def capture_time_veto(export: ExportCandidate, raw: Row) -> bool:
    export_dt = _parse_time(export.capture_time)
    if not export_dt or not raw["capture_time"]:
        return False
    raw_dt = _parse_time(raw["capture_time"])
    if not raw_dt:
        return False
    return abs(export_dt - raw_dt) > timedelta(hours=6)


def veto_reasons(export: ExportCandidate, raw: Row) -> list[str]:
    reasons: list[str] = []
    if filename_family_veto(export, raw):
        reasons.append("filename_family_conflict")
    if camera_veto(export, raw):
        reasons.append("camera_model_conflict")
    if capture_time_veto(export, raw):
        reasons.append("capture_time_window_exceeded")
    return reasons


def score_candidate(export: ExportCandidate, raw: Row) -> tuple[float, dict[str, float]]:
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


def recall_candidates(connection, export: ExportCandidate) -> list[Row]:
    rows = load_raw_candidates(connection, export.stem_key, limit=RECALL_LIMIT)
    if rows:
        return rows
    export_camera_token = camera_stem_token(export.stem)
    if export_camera_token:
        rows = load_raw_candidates_by_camera_token(connection, export_camera_token, limit=RECALL_LIMIT)
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


def shortlist_candidates(connection, export: ExportCandidate) -> list[Row]:
    shortlisted: list[Row] = []
    for row in recall_candidates(connection, export):
        if veto_reasons(export, row):
            continue
        shortlisted.append(row)
    return shortlisted


def resolve_export(
    connection,
    export_path: Path,
    thresholds: Thresholds | None = None,
    refresh: bool = False,
    *,
    persist_root: bool = True,
    commit: bool = True,
) -> MatchDecision:
    thresholds = thresholds or Thresholds()
    export = extract_export_candidate(export_path)
    if persist_root:
        upsert_catalog_root(connection, "export", export.path.parent, commit=commit)
    export_asset_id = upsert_export_asset(connection, export, commit=False)

    existing = get_registry(connection, export.path)
    preexisting = existing is not None
    if existing and existing["match_status"] == "manual_confirmed":
        if commit:
            connection.commit()
        return MatchDecision(
            export_asset_id=existing["export_asset_id"],
            export_path=export.path,
            status=existing["match_status"],
            score=float(existing["score"]),
            raw_asset_id=existing["raw_asset_id"],
            feature_vector=json.loads(existing["feature_vector_json"]),
            ranked_candidates=json.loads(existing["candidate_json"]),
            preexisting=preexisting,
        )

    if existing and not refresh and existing["match_status"] == "auto_bound":
        if commit:
            connection.commit()
        return MatchDecision(
            export_asset_id=existing["export_asset_id"],
            export_path=export.path,
            status=existing["match_status"],
            score=float(existing["score"]),
            raw_asset_id=existing["raw_asset_id"],
            feature_vector=json.loads(existing["feature_vector_json"]),
            ranked_candidates=json.loads(existing["candidate_json"]),
            preexisting=preexisting,
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
        export_asset_id=export_asset_id,
        export_path=export.path,
        status=status,
        score=score,
        raw_asset_id=raw_asset_id,
        feature_vector=feature_vector,
        ranked_candidates=ranked[:5],
        preexisting=preexisting,
    )
    upsert_registry(connection, decision, commit=False)
    if commit:
        connection.commit()
    return decision


def resolve_export_batch(
    connection,
    export_dirs: list[Path],
    thresholds: Thresholds | None = None,
    refresh: bool = False,
    progress_callback=None,
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
    total = sum(count_export_files(export_dir.resolve()) for export_dir in export_dirs)
    report_progress(progress_callback, phase="resolve_exports", processed=0, total=total, status_counts=counts)

    for export_dir in export_dirs:
        upsert_catalog_root(connection, "export", export_dir.resolve(), commit=False)
        for path in iter_export_files([export_dir.resolve()]):
            decision = resolve_export(
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
            processed += 1
            if processed % RESOLVE_BATCH_COMMIT_SIZE == 0:
                connection.commit()
            report_progress(progress_callback, phase="resolve_exports", processed=processed, total=total, status_counts=counts)

    connection.commit()

    return {
        "processed": processed,
        "total": total,
        "status_counts": {key: value for key, value in counts.items() if value > 0},
        "already_in_catalog": already_in_catalog,
        "newly_added": processed - already_in_catalog,
    }


def count_export_files(export_dir: Path) -> int:
    return sum(1 for _ in iter_export_files([export_dir.resolve()]))


def iter_export_files(export_paths: list[Path]):
    for export_path in export_paths:
        export_path = export_path.resolve()
        if export_path.is_file():
            if export_path.suffix.lower() in EXPORT_EXTENSIONS:
                yield export_path
            continue
        for path in sorted(export_path.rglob("*")):
            if path.is_file() and path.suffix.lower() in EXPORT_EXTENSIONS:
                yield path


def report_progress(progress_callback, **payload) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
