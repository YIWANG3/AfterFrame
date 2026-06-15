from __future__ import annotations

import json
from pathlib import Path

from .ai_repaint import DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_JIMENG_MODEL, OPENAI_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, JIMENG_PROVIDER, run_mock_repaint, run_nanobanana_repaint, run_openai_repaint, run_jimeng_repaint
from .catalog import ensure_catalog
from .config import Thresholds
from .db import (
    attach_asset_to_resource_set,
    get_app_setting,
    is_cancel_requested,
    list_image_assets_missing_resource_set,
    update_job,
    upsert_image_asset,
    upsert_preview_entry,
    upsert_registry,
)


class JobCancelled(Exception):
    """Raised from a progress checkpoint when the job's cancel flag is set.

    Cancellation is cooperative: the UI sets jobs.cancel_requested, and every
    runner checks the flag at its progress callbacks (which already fire per
    batch). The runner then unwinds, marks the job 'cancelled', and exits —
    work committed so far is kept.
    """


def _check_cancel(connection, job_id: str) -> None:
    if is_cancel_requested(connection, job_id):
        raise JobCancelled(job_id)


def _mark_cancelled(connection, job_id: str, payload: dict, result: dict | None = None, progress: float = 0.0) -> dict[str, object]:
    final = {**(result or {}), "cancelled": True, "current_phase": None}
    update_job(
        connection,
        job_id,
        status="cancelled",
        payload={**payload, "phase": None, "phase_label": None},
        result=final,
        progress=progress,
        error_text=None,
    )
    return final
from .metadata import extract_image_candidate
from .models import MatchDecision
from .preview_service import PreviewService
from .reverse_lookup import resolve_image
from .reverse_lookup import resolve_image_batch
from .scanner import enrich_raw_assets, scan_raw_directory


def _fraction(processed: int | None, total: int | None) -> float:
    if not total:
        return 0.0
    return max(0.0, min(1.0, float(processed or 0) / float(total)))


def _scan_fraction(update: dict[str, int | str]) -> float:
    discovered = int(update.get("discovered", 0) or 0)
    processed = int(update.get("processed", 0) or 0)
    if discovered <= 0:
        return 0.0
    return max(0.0, min(0.99, float(processed) / float(discovered)))


def _phase_result(phase: dict[str, object], result: dict[str, object]) -> dict[str, object]:
    return {"key": phase["key"], "label": phase["label"], "result": result}


_HD_PHASE = {"key": "generate_previews_hd", "label": "Generate HD Previews", "progress": 1.0}


def _build_import_phases(
    mode: str, has_raw_dirs: bool, has_image_dirs: bool, generate_hd: bool = True
) -> list[dict[str, object]]:
    # HD (2000px) previews are opt-in (Settings ▸ Library). When off we skip the
    # phase entirely — the execution loop is driven by this same list, so a
    # missing phase is both unplanned and unrun.
    if mode == "source_only":
        return [{"key": "scan_sources", "label": "Index Sources", "progress": 1.0}]
    if mode == "processed_only":
        phases = [{"key": "index_processed_media", "label": "Index Images", "progress": 0.5}]
        if has_image_dirs:
            phases.append({"key": "generate_previews", "label": "Generate Previews", "progress": 0.75})
            if generate_hd:
                phases.append(dict(_HD_PHASE))
        return phases
    if mode == "processed_with_sources":
        phases = [{"key": "match_processed_media", "label": "Match with RAW", "progress": 0.5}]
        if has_image_dirs:
            phases.append({"key": "generate_previews", "label": "Generate Previews", "progress": 0.75})
            if generate_hd:
                phases.append(dict(_HD_PHASE))
        return phases
    if mode == "source_with_media":
        phases = [{"key": "scan_sources", "label": "Index Sources", "progress": 1 / 4}]
        if has_image_dirs:
            phases.append({"key": "match_processed_media", "label": "Match with RAW", "progress": 2 / 4})
            phases.append({"key": "generate_previews", "label": "Generate Previews", "progress": 3 / 4})
            if generate_hd:
                phases.append(dict(_HD_PHASE))
        return phases
    phases: list[dict[str, object]] = []
    if has_raw_dirs:
        phases.append({"key": "scan_sources", "label": "Index Sources", "progress": 1 / 4})
    if has_image_dirs:
        phases.append({"key": "match_processed_media", "label": "Match with RAW", "progress": 2 / 4 if has_raw_dirs else 0.5})
        phases.append({"key": "generate_previews", "label": "Generate Previews", "progress": 3 / 4 if has_raw_dirs else 0.75})
        if generate_hd:
            phases.append(dict(_HD_PHASE))
    return phases


def run_import_job(
    connection,
    catalog_path: Path,
    job_id: str,
    raw_dirs: list[Path],
    image_dirs: list[Path],
    mode: str = "combined",
    generate_hd: bool = True,
) -> dict[str, object]:
    thresholds = Thresholds()
    phase_results: list[dict[str, object]] = []
    phases = _build_import_phases(mode, bool(raw_dirs), bool(image_dirs), generate_hd)
    if not phases:
        result = {"phase_results": [], "current_phase": None}
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={
                "raw_dirs": [str(path.resolve()) for path in raw_dirs],
                "image_dirs": [str(path.resolve()) for path in image_dirs],
                "mode": mode,
                "phase": None,
                "phase_label": None,
                "phase_index": 0,
                "phase_count": 0,
            },
            result=result,
            progress=1.0,
            error_text=None,
        )
        return result
    payload = {
        "raw_dirs": [str(path.resolve()) for path in raw_dirs],
        "image_dirs": [str(path.resolve()) for path in image_dirs],
        "mode": mode,
        "phase": phases[0]["key"],
        "phase_label": phases[0]["label"],
        "phase_index": 1,
        "phase_count": len(phases),
    }
    update_job(connection, job_id, status="running", payload=payload, progress=0.0)

    try:
        phase_cursor = 0

        if raw_dirs:
            scan_phase = phases[phase_cursor]
            if scan_phase["key"] == "scan_sources":
                scan_totals: dict[str, object] = {
                    "indexed": 0,
                    "skipped": 0,
                    "unchanged": 0,
                    "forced": 0,
                    "processed": 0,
                    "discovered": 0,
                    "total": 0,
                }

                def scan_progress(update: dict[str, int | str]) -> None:
                    _check_cancel(connection, job_id)
                    overall_processed = int(scan_totals["processed"]) + int(update.get("processed", 0) or 0)
                    overall_discovered = int(scan_totals["discovered"]) + int(update.get("discovered", 0) or 0)
                    phase_result = {
                        **scan_totals,
                        **update,
                        "processed": overall_processed,
                        "discovered": overall_discovered,
                        "total": overall_discovered,
                    }
                    update_job(
                        connection,
                        job_id,
                        payload=payload,
                        result={
                            "phase_results": phase_results,
                            "current_phase": _phase_result(scan_phase, phase_result),
                        },
                        progress=(phase_cursor + _scan_fraction(phase_result)) / len(phases),
                        commit=True,
                    )

                for raw_dir in raw_dirs:
                    result = scan_raw_directory(
                        connection,
                        raw_dir,
                        workers=8,
                        fingerprint_mode="head-only",
                        metadata_profile="matcher",
                        progress_callback=scan_progress,
                    )
                    for key in ("indexed", "skipped", "unchanged", "forced", "processed"):
                        scan_totals[key] = int(scan_totals.get(key, 0)) + int(result.get(key, 0))
                    scan_totals["discovered"] = int(scan_totals.get("discovered", 0)) + int(result.get("discovered", 0))
                    scan_totals["total"] = scan_totals["discovered"]
                    scan_totals["workers"] = result["workers"]
                    scan_totals["fingerprint_mode"] = result["fingerprint_mode"]
                    scan_totals["metadata_profile"] = result["metadata_profile"]
                phase_results.append(_phase_result(scan_phase, scan_totals))
                phase_cursor += 1

        if phase_cursor < len(phases) and phases[phase_cursor]["key"] in {"index_processed_media", "match_processed_media"}:
            resolve_phase = phases[phase_cursor]
            update_job(
                connection,
                job_id,
                payload={
                    **payload,
                    "phase": resolve_phase["key"],
                    "phase_label": resolve_phase["label"],
                    "phase_index": phase_cursor + 1,
                },
                result={"phase_results": phase_results, "current_phase": None},
                progress=(phase_cursor / len(phases)),
            )

            def resolve_progress(update: dict[str, int | str]) -> None:
                _check_cancel(connection, job_id)
                phase_fraction = _fraction(int(update.get("processed", 0)), int(update.get("total", 0)))
                update_job(
                    connection,
                    job_id,
                    payload={
                        **payload,
                        "phase": resolve_phase["key"],
                        "phase_label": resolve_phase["label"],
                        "phase_index": phase_cursor + 1,
                    },
                    result={
                        "phase_results": phase_results,
                        "current_phase": _phase_result(resolve_phase, update),
                    },
                    progress=(phase_cursor + phase_fraction) / len(phases),
                    commit=True,
                )

            resolve_result = resolve_image_batch(
                connection,
                image_dirs,
                thresholds=thresholds,
                refresh=True,
                progress_callback=resolve_progress,
            )
            # Create resource sets for any exports that don't have one yet
            for row in list_image_assets_missing_resource_set(connection):
                attach_asset_to_resource_set(
                    connection, str(row["asset_id"]),
                    version_kind="import", commit=False,
                )
            connection.commit()
            phase_results.append(_phase_result(resolve_phase, resolve_result))
            phase_cursor += 1

        if phase_cursor < len(phases) and phases[phase_cursor]["key"] == "generate_previews":
            preview_phase = phases[phase_cursor]
            update_job(
                connection,
                job_id,
                payload={
                    **payload,
                    "phase": preview_phase["key"],
                    "phase_label": preview_phase["label"],
                    "phase_index": phase_cursor + 1,
                },
                result={"phase_results": phase_results, "current_phase": None},
                progress=(phase_cursor / len(phases)),
            )

            def preview_progress(update: dict[str, int | str]) -> None:
                _check_cancel(connection, job_id)
                phase_fraction = _fraction(int(update.get("processed", 0)), int(update.get("total", 0)))
                update_job(
                    connection,
                    job_id,
                    payload={
                        **payload,
                        "phase": preview_phase["key"],
                        "phase_label": preview_phase["label"],
                        "phase_index": phase_cursor + 1,
                    },
                    result={
                        "phase_results": phase_results,
                        "current_phase": _phase_result(preview_phase, update),
                    },
                    progress=(phase_cursor + phase_fraction) / len(phases),
                    commit=True,
                )

            preview_result = PreviewService(ensure_catalog(catalog_path)).generate_batch(
                connection,
                kind="preview",
                asset_type="image",
                progress_callback=preview_progress,
                paths=image_dirs,
            )
            # Video poster frames share the standard preview tier (no HD).
            PreviewService(ensure_catalog(catalog_path)).generate_batch(
                connection,
                kind="preview",
                asset_type="video",
                progress_callback=preview_progress,
                paths=image_dirs,
            )
            phase_results.append(_phase_result(preview_phase, preview_result))
            phase_cursor += 1

        if phase_cursor < len(phases) and phases[phase_cursor]["key"] == "generate_previews_hd":
            preview_hd_phase = phases[phase_cursor]
            update_job(
                connection,
                job_id,
                payload={
                    **payload,
                    "phase": preview_hd_phase["key"],
                    "phase_label": preview_hd_phase["label"],
                    "phase_index": phase_cursor + 1,
                },
                result={"phase_results": phase_results, "current_phase": None},
                progress=(phase_cursor / len(phases)),
            )

            def preview_hd_progress(update: dict[str, int | str]) -> None:
                _check_cancel(connection, job_id)
                phase_fraction = _fraction(int(update.get("processed", 0)), int(update.get("total", 0)))
                update_job(
                    connection,
                    job_id,
                    payload={
                        **payload,
                        "phase": preview_hd_phase["key"],
                        "phase_label": preview_hd_phase["label"],
                        "phase_index": phase_cursor + 1,
                    },
                    result={
                        "phase_results": phase_results,
                        "current_phase": _phase_result(preview_hd_phase, update),
                    },
                    progress=(phase_cursor + phase_fraction) / len(phases),
                    commit=True,
                )

            preview_hd_result = PreviewService(ensure_catalog(catalog_path)).generate_batch(
                connection,
                kind="preview-hd",
                asset_type="image",
                progress_callback=preview_hd_progress,
                paths=image_dirs,
            )
            phase_results.append(_phase_result(preview_hd_phase, preview_hd_result))
        result = {"phase_results": phase_results, "current_phase": None}
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={
                **payload,
                "phase": None,
                "phase_label": None,
                "phase_index": len(phases),
            },
            result=result,
            progress=1.0,
            error_text=None,
        )
        return result
    except JobCancelled:
        return _mark_cancelled(
            connection, job_id, payload,
            result={"phase_results": phase_results},
            progress=max(0.0, len(phase_results) / len(phases)),
        )
    except Exception as error:
        update_job(
            connection,
            job_id,
            status="failed",
            payload=payload,
            result={"phase_results": phase_results},
            progress=max(0.0, len(phase_results) / len(phases)),
            error_text=str(error),
        )
        raise


def run_enrichment_job(
    connection,
    job_id: str,
    raw_dirs: list[Path] | None = None,
) -> dict[str, object]:
    payload = {
        "raw_dirs": [str(path.resolve()) for path in raw_dirs] if raw_dirs else [],
        "phase": "enrich_raw",
        "phase_label": "Enrich RAW Metadata",
        "phase_index": 1,
        "phase_count": 1,
    }
    update_job(connection, job_id, status="running", payload=payload, progress=0.0)
    try:
        def enrich_progress(update: dict[str, int | str]) -> None:
            _check_cancel(connection, job_id)
            update_job(
                connection,
                job_id,
                payload=payload,
                result={"current_phase": _phase_result({"key": "enrich_raw", "label": "Enrich RAW Metadata"}, update)},
                progress=_fraction(int(update.get("processed", 0)), int(update.get("total", 0))),
                commit=True,
            )

        result = enrich_raw_assets(
            connection,
            raw_dirs=raw_dirs or [],
            workers=8,
            fingerprint_mode="head-only",
            progress_callback=enrich_progress,
        )
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={**payload, "phase": None, "phase_label": None},
            result={**result, "current_phase": None},
            progress=1.0,
            error_text=None,
        )
        return result
    except JobCancelled:
        return _mark_cancelled(connection, job_id, payload)
    except Exception as error:
        update_job(
            connection,
            job_id,
            status="failed",
            payload=payload,
            result={},
            progress=0.0,
            error_text=str(error),
        )
        raise


def run_preview_job(
    connection,
    catalog_path: Path,
    job_id: str,
    *,
    kind: str = "preview",
    asset_type: str | None = "image",
    limit: int | None = None,
    force: bool = False,
) -> dict[str, object]:
    payload = {
        "kind": kind,
        "asset_type": asset_type,
        "limit": limit,
        "force": force,
        "phase": "generate_previews",
        "phase_label": "Generate Previews",
        "phase_index": 1,
        "phase_count": 1,
    }
    update_job(connection, job_id, status="running", payload=payload, progress=0.0)
    try:
        def preview_progress(update: dict[str, int | str]) -> None:
            _check_cancel(connection, job_id)
            update_job(
                connection,
                job_id,
                payload=payload,
                result={"current_phase": _phase_result({"key": "generate_previews", "label": "Generate Previews"}, update)},
                progress=_fraction(int(update.get("processed", 0)), int(update.get("total", 0))),
                commit=True,
            )

        result = PreviewService(ensure_catalog(catalog_path)).generate_batch(
            connection,
            kind=kind,
            asset_type=asset_type,
            limit=limit,
            force=force,
            progress_callback=preview_progress,
        )
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={**payload, "phase": None, "phase_label": None},
            result={**result, "current_phase": None},
            progress=1.0,
            error_text=None,
        )
        return result
    except JobCancelled:
        return _mark_cancelled(connection, job_id, payload)
    except Exception as error:
        update_job(
            connection,
            job_id,
            status="failed",
            payload=payload,
            result={},
            progress=0.0,
            error_text=str(error),
        )
        raise


def run_annotation_job(
    connection,
    catalog_path: Path,
    job_id: str,
    *,
    provider: str,
    api_key: str | None,
    model: str,
    base_url: str | None = None,
    asset_type: str | None = "image",
    only_missing: bool = True,
    asset_ids: list[str] | None = None,
    collection_id: str | None = None,
    languages: list[str] | None = None,
    max_tags: int = 10,
    max_caption_chars: int = 200,
    custom_instructions: str | None = None,
    video_frame_interval: float = 0.0,
    limit: int | None = None,
) -> dict[str, object]:
    from . import annotation as _annotation
    from .db import list_assets_for_annotation

    catalog = ensure_catalog(catalog_path)
    payload = {
        "kind": "annotation",
        "provider": provider,
        "model": model,
        "only_missing": only_missing,
        "phase": "annotate",
        "phase_label": "Annotate with AI",
        "phase_index": 0,
        "phase_count": 1,
    }
    update_job(connection, job_id, status="running", payload=payload, progress=0.0)
    try:
        assets = list_assets_for_annotation(
            connection,
            asset_type=asset_type,
            only_missing=only_missing,
            asset_ids=asset_ids,
            collection_id=collection_id,
            limit=limit,
        )

        def annotation_progress(update: dict[str, int]) -> None:
            _check_cancel(connection, job_id)
            update_job(
                connection,
                job_id,
                payload=payload,
                result={"current_phase": _phase_result({"key": "annotate", "label": "Annotate with AI"}, update)},
                progress=_fraction(int(update.get("processed", 0)), int(update.get("total", 0))),
                commit=True,
            )

        result = _annotation.annotate_batch(
            connection,
            catalog.root,
            assets,
            provider=provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
            languages=languages,
            max_tags=max_tags,
            max_caption_chars=max_caption_chars,
            custom_instructions=custom_instructions,
            video_frame_interval=video_frame_interval,
            progress_callback=annotation_progress,
        )
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={**payload, "phase": None, "phase_label": None},
            result={**result, "current_phase": None},
            progress=1.0,
            error_text=None,
        )
        return result
    except JobCancelled:
        return _mark_cancelled(connection, job_id, payload)
    except Exception as error:
        update_job(
            connection,
            job_id,
            status="failed",
            payload=payload,
            result={},
            progress=0.0,
            error_text=str(error),
        )
        raise


def run_ai_repaint_job(
    connection,
    catalog_path: Path,
    job_id: str,
    *,
    provider: str,
    input_path: Path,
    output_path: Path,
    prompt: str,
    api_key: str | None = None,
    origin_path: Path | None = None,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
    temperature: float | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> dict[str, object]:
    payload = {
        "provider": provider,
        "input_path": str(input_path.resolve()),
        "output_path": str(output_path.resolve()),
        "origin_path": str(origin_path.resolve()) if origin_path else None,
        "prompt": prompt,
        "api_key_supplied": bool(api_key),
        "aspect_ratio": aspect_ratio,
        "image_size": image_size,
        "temperature": temperature,
        "phase": "generate_ai_repaint",
        "phase_label": "Generate AI Repaint",
        "phase_index": 1,
        "phase_count": 1,
    }
    update_job(connection, job_id, status="running", payload=payload, progress=0.1, result={"current_phase": {"status": "running"}}, error_text=None)
    try:
        if provider == "mock":
            result = run_mock_repaint(
                input_path=input_path,
                output_path=output_path,
                prompt=prompt,
            )
        else:
            effective_api_key = api_key
            if not effective_api_key:
                provider_key = f"ai_provider_token:{provider}"
                config = get_app_setting(connection, provider_key)
                effective_api_key = config.get("token") if isinstance(config, dict) else None
            if not effective_api_key:
                raise ValueError(f"No API token configured for provider '{provider}'.")
            if provider == JIMENG_PROVIDER:
                # Jimeng uses ak/sk pair stored as JSON in the token field
                ak, sk = None, None
                if effective_api_key:
                    try:
                        creds = json.loads(effective_api_key)
                        ak, sk = creds.get("access_key_id"), creds.get("secret_access_key")
                    except (json.JSONDecodeError, TypeError):
                        pass
                result = run_jimeng_repaint(
                    input_path=input_path,
                    output_path=output_path,
                    prompt=prompt,
                    access_key_id=ak,
                    secret_access_key=sk,
                    model=model or DEFAULT_JIMENG_MODEL,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    scale=temperature,
                )
            elif provider == OPENAI_PROVIDER:
                result = run_openai_repaint(
                    input_path=input_path,
                    output_path=output_path,
                    prompt=prompt,
                    api_key=effective_api_key,
                    model=model or DEFAULT_OPENAI_MODEL,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                )
            elif provider == OPENAI_COMPATIBLE_PROVIDER:
                result = run_openai_repaint(
                    input_path=input_path,
                    output_path=output_path,
                    prompt=prompt,
                    api_key=effective_api_key,
                    model=model or DEFAULT_OPENAI_MODEL,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    base_url=base_url or "https://api.openai.com/v1",
                )
            else:
                result = run_nanobanana_repaint(
                    input_path=input_path,
                    output_path=output_path,
                    prompt=prompt,
                    api_key=effective_api_key,
                    model=model or DEFAULT_GEMINI_MODEL,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                )

        # Shared register pipeline (asset upsert → raw-binding inheritance →
        # resource-set attach → previews). Replaces a hand-copied version that
        # had drifted: preview failures here used to fail the whole job even
        # though the asset was already committed.
        from .derived import register_image_file

        register_payload = register_image_file(
            connection,
            ensure_catalog(catalog_path),
            Path(result.output_path),
            origin_path=origin_path,
            version_kind="ai_repaint",
        )
        asset_id = register_payload["asset_id"]
        match_status = register_payload["match_status"]
        match_score = register_payload["score"]

        final_result = {
            "provider": result.provider,
            "model": result.model,
            "output_path": result.output_path,
            "mime_type": result.mime_type,
            "prompt": result.prompt,
            "notes": result.notes,
            "asset_id": asset_id,
            "match_status": match_status,
            "score": match_score,
            "current_phase": None,
        }
        update_job(
            connection,
            job_id,
            status="succeeded",
            payload={**payload, "phase": None, "phase_label": None},
            result=final_result,
            progress=1.0,
            error_text=None,
        )
        return final_result
    except Exception as error:
        update_job(
            connection,
            job_id,
            status="failed",
            payload=payload,
            result={},
            progress=0.0,
            error_text=str(error),
        )
        raise
