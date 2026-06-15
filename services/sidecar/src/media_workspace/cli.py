from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
from uuid import uuid4

from .benchmark import benchmark_dataset
from .catalog import ensure_catalog
from .config import Thresholds
from .analysis import analyze_metadata_coverage
from .ai_repaint import DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, OPENAI_PROVIDER, list_provider_models, run_mock_repaint, run_nanobanana_repaint, run_openai_repaint
from .db import (
    attach_asset_to_resource_set,
    cleanup_orphan_image_assets,
    confirm_match,
    connect,
    verify_assets,
    relink_asset,
    create_job,
    delete_app_setting,
    delete_image_asset_from_catalog,
    find_image_asset_ids_by_stem,
    get_duplicate_assets,
    get_image_asset_detail,
    remove_raw_from_resource_sets,
    split_shared_asset_ids,
    get_image_asset_detail_by_path,
    get_app_setting,
    get_job,
    get_latest_job,
    init_db,
    list_singleton_primary_resource_sets,
    list_image_assets_missing_resource_set,
    list_jobs,
    list_catalog_roots,
    list_image_assets,
    list_pending,
    set_catalog_path,
    summary,
    upsert_catalog_root,
    list_collections,
    create_collection,
    update_collection,
    delete_collection,
    add_collection_items,
    attach_asset_to_resource_set,
    remove_collection_items,
    reassign_asset_to_resource_set,
    browse_collection,
    set_asset_rating,
    set_app_setting,
    upsert_image_asset,
    upsert_registry,
)
from .evaluation import evaluate_ground_truth
from .ground_truth import export_ground_truth
from .job_runner import run_ai_repaint_job, run_annotation_job, run_enrichment_job, run_import_job, run_preview_job
from .preview_service import PreviewService
from .metadata import extract_image_candidate
from .models import MatchDecision
from .reverse_lookup import resolve_image, resolve_image_batch
from .scanner import enrich_raw_assets, scan_raw_directory
from .watcher import ImageWatcher


def _provider_token_key(provider: str) -> str:
    return f"ai_provider_token:{provider}"


DERIVED_STEM_MARKERS = [
    "_ai-repaint",
    "_edited",
    "_crop",
]


def _infer_origin_stem(stem: str) -> tuple[str | None, str]:
    inferred_kind = "import"
    current = stem
    changed = False
    while True:
        next_value = current
        if "_ai-repaint" in current:
            next_value = current.split("_ai-repaint", 1)[0]
            inferred_kind = "ai_repaint"
        elif "_edited" in current:
            next_value = current.split("_edited", 1)[0]
            if inferred_kind == "import":
                inferred_kind = "crop"
        elif "_crop" in current:
            next_value = current.split("_crop", 1)[0]
            if inferred_kind == "import":
                inferred_kind = "crop"
        if next_value == current:
            break
        current = next_value
        changed = True
    return (current if changed and current else None, inferred_kind)


def _serve_loop(args) -> int:
    """Resident mode: amortize interpreter startup across many commands.

    Protocol (line-delimited JSON on stdio):
      request  {"id": <any>, "argv": ["browse-images", "--status", "all", ...]}
      response {"id": <any>, "code": <int>, "stdout": <str>, "error": <str|null>}

    Each request re-enters main() with a fresh parse and DB connection — the
    savings come from skipping process spawn + module imports (~150ms), not
    from caching state, so per-command semantics are identical to one-shot.
    """
    import contextlib
    import io
    import sys
    import traceback

    catalog_arg = str(args.catalog)
    sys.stdout.write(json.dumps({"ready": True, "catalog": catalog_arg}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        buf = io.StringIO()
        errbuf = io.StringIO()
        code = 0
        error = None
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(errbuf):
                code = main(["--catalog", catalog_arg, *[str(a) for a in request.get("argv", [])]])
        except SystemExit as exc:  # argparse errors etc.
            code = int(exc.code) if isinstance(exc.code, int) else 1
            error = str(exc) if exc.code and not isinstance(exc.code, int) else None
        except Exception:  # noqa: BLE001
            code = 1
            error = traceback.format_exc(limit=8)
        if code != 0 and not error and errbuf.getvalue():
            error = errbuf.getvalue()[-2000:]
        response = {"id": request.get("id"), "code": code, "stdout": buf.getvalue(), "error": error}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


def _annotation_from_row(row) -> dict | None:
    """Inline annotation payload for browse rows (same shape as get-annotation).

    Lets the UI hydrate its annotation cache from browse results so switching
    assets renders synchronously — no per-asset fetch, no placeholder flash.
    """
    if row["anno_provider"] is None:
        return None
    return {
        "asset_id": row["asset_id"],
        "provider": row["anno_provider"],
        "model": row["anno_model"],
        "schema_version": row["anno_schema_version"],
        "caption": row["anno_caption"],
        "tags": json.loads(row["anno_tags_json"] or "[]"),
        "location": json.loads(row["anno_location_json"]) if row["anno_location_json"] else None,
        "detected_text": row["anno_detected_text"],
        "created_at": row["anno_created_at"],
        "updated_at": row["anno_updated_at"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="media_workspace")
    parser.add_argument("--catalog", type=Path, default=Path("data/default.afcatalog"))
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--catalog", type=Path, default=argparse.SUPPRESS)

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init-catalog", parents=[common])

    scan_raw = subparsers.add_parser("scan-raw", parents=[common])
    scan_raw.add_argument("--raw-dir", type=Path, action="append", required=True)
    scan_raw.add_argument("--force", action="store_true")
    scan_raw.add_argument("--workers", type=int)
    scan_raw.add_argument("--fingerprint-mode", choices=["head-tail", "head-only"], default="head-only")
    scan_raw.add_argument("--metadata-profile", choices=["full", "matcher"], default="matcher")

    enrich_raw = subparsers.add_parser("enrich-raw", parents=[common])
    enrich_raw.add_argument("--raw-dir", type=Path, action="append", default=[])
    enrich_raw.add_argument("--limit", type=int)
    enrich_raw.add_argument("--workers", type=int)
    enrich_raw.add_argument("--fingerprint-mode", choices=["head-only"], default="head-only")

    analyze = subparsers.add_parser("analyze-metadata", parents=[common])
    analyze.add_argument("--raw-dir", type=Path, action="append", default=[])
    analyze.add_argument("--image-dir", type=Path, action="append", default=[])

    evaluate = subparsers.add_parser("evaluate-ground-truth", parents=[common])
    evaluate.add_argument("--truth-csv", type=Path, required=True)
    evaluate.add_argument("--refresh", action="store_true")

    export_truth = subparsers.add_parser("export-ground-truth", parents=[common])
    export_truth.add_argument("--output-csv", type=Path, required=True)
    export_truth.add_argument(
        "--status",
        choices=["matched", "unmatched", "pending"],
        action="append",
        required=True,
    )

    benchmark = subparsers.add_parser("benchmark-dataset", parents=[common])
    benchmark.add_argument("--raw-dir", type=Path, action="append", required=True)
    benchmark.add_argument("--image-dir", type=Path, action="append", required=True)
    benchmark.add_argument("--truth-csv", type=Path)
    benchmark.add_argument("--auto-threshold", type=float, default=0.85)
    benchmark.add_argument("--manual-threshold", type=float, default=0.7)
    benchmark.add_argument("--skip-previews", action="store_true")
    benchmark.add_argument("--force-scan", action="store_true")
    benchmark.add_argument("--force-previews", action="store_true")
    benchmark.add_argument("--scan-workers", type=int)
    benchmark.add_argument("--fingerprint-mode", choices=["head-tail", "head-only"], default="head-tail")
    benchmark.add_argument("--metadata-profile", choices=["full", "matcher"], default="full")
    benchmark.add_argument("--report-json", type=Path)

    resolve = subparsers.add_parser("resolve-image", parents=[common])
    resolve.add_argument("--path", type=Path, required=True)
    resolve.add_argument("--auto-threshold", type=float, default=0.85)
    resolve.add_argument("--manual-threshold", type=float, default=0.7)
    resolve.add_argument("--refresh", action="store_true")

    resolve_batch = subparsers.add_parser("resolve-export-batch", parents=[common])
    resolve_batch.add_argument("--image-dir", type=Path, action="append", required=True)
    resolve_batch.add_argument("--auto-threshold", type=float, default=0.85)
    resolve_batch.add_argument("--manual-threshold", type=float, default=0.7)
    resolve_batch.add_argument("--refresh", action="store_true")

    watch = subparsers.add_parser("watch-images", parents=[common])
    watch.add_argument("--image-dir", type=Path, action="append", required=True)
    watch.add_argument("--interval", type=float, default=2.0)
    watch.add_argument("--auto-threshold", type=float, default=0.85)
    watch.add_argument("--manual-threshold", type=float, default=0.7)

    previews = subparsers.add_parser("generate-previews", parents=[common])
    previews.add_argument("--kind", choices=["preview", "preview-hd"], default="preview")
    previews.add_argument("--asset-type", choices=["raw", "image"])
    previews.add_argument("--limit", type=int)
    previews.add_argument("--force", action="store_true")

    browse = subparsers.add_parser("browse-images", parents=[common])
    browse.add_argument("--status", choices=["all", "matched", "unmatched", "rated", "recent"], required=True)
    browse.add_argument("--limit", type=int, default=120)
    browse.add_argument("--offset", type=int, default=0)
    browse.add_argument("--search", default=None)
    browse.add_argument("--sort", default=None)
    # Structured facet filters (all optional, AND-combined). Passed as a single
    # JSON object to keep the surface small and forward-compatible.
    browse.add_argument("--filters", default=None, help="JSON object of facet filters")

    subparsers.add_parser("facet-values", parents=[common])

    search_facet_p = subparsers.add_parser("search-facet", parents=[common])
    search_facet_p.add_argument("--field", choices=["tag", "camera", "lens"], required=True)
    search_facet_p.add_argument("--q", default="")
    search_facet_p.add_argument("--limit", type=int, default=50)

    detail = subparsers.add_parser("asset-detail", parents=[common])
    detail_group = detail.add_mutually_exclusive_group(required=True)
    detail_group.add_argument("--asset-id")
    detail_group.add_argument("--image-path", type=Path)

    subparsers.add_parser("list-pending", parents=[common])

    confirm = subparsers.add_parser("confirm-match", parents=[common])
    confirm.add_argument("--image-path", type=Path, required=True)
    confirm.add_argument("--raw-asset-id", required=True)

    # Collections
    subparsers.add_parser("list-collections", parents=[common])

    create_col = subparsers.add_parser("create-collection", parents=[common])
    create_col.add_argument("--name", required=True)
    create_col.add_argument("--kind", choices=["manual", "smart"], default="manual")
    create_col.add_argument("--rules-json", default="[]")

    update_col = subparsers.add_parser("update-collection", parents=[common])
    update_col.add_argument("--collection-id", required=True)
    update_col.add_argument("--name")
    update_col.add_argument("--rules-json")
    update_col.add_argument("--sort-order", type=int)

    delete_col = subparsers.add_parser("delete-collection", parents=[common])
    delete_col.add_argument("--collection-id", required=True)

    col_add = subparsers.add_parser("collection-add-items", parents=[common])
    col_add.add_argument("--collection-id", required=True)
    col_add.add_argument("--asset-id", action="append", required=True)

    col_remove = subparsers.add_parser("collection-remove-items", parents=[common])
    col_remove.add_argument("--collection-id", required=True)
    col_remove.add_argument("--asset-id", action="append", required=True)

    set_rating = subparsers.add_parser("set-asset-rating", parents=[common])
    set_rating.add_argument("--asset-id", action="append", required=True)
    set_rating.add_argument("--rating", type=int, choices=[0, 1, 2, 3, 4, 5], required=True)

    browse_col = subparsers.add_parser("browse-collection", parents=[common])
    browse_col.add_argument("--collection-id", required=True)
    browse_col.add_argument("--limit", type=int, default=120)
    browse_col.add_argument("--offset", type=int, default=0)

    quick_reg = subparsers.add_parser("quick-register", parents=[common])
    quick_reg.add_argument("--image-path", type=Path, required=True)
    quick_reg.add_argument("--origin-path", type=Path, default=None)
    quick_reg.add_argument("--collage-source-ids", nargs="*", default=None)

    create_derived = subparsers.add_parser("create-derived", parents=[common])
    create_derived.add_argument("--asset-id", required=True)
    create_derived.add_argument("--crop-ratio", required=True, help="Target aspect ratio, e.g. '4:3', '1:1', '16:9'")
    create_derived.add_argument("--gravity", choices=["center", "top", "bottom", "left", "right"], default="center")

    add_text_p = subparsers.add_parser("add-text", parents=[common])
    add_text_p.add_argument("--asset-id", required=True)
    add_text_p.add_argument("--text", required=True)
    add_text_p.add_argument("--x", type=float, default=0.5, help="Normalized center x of the text block (0-1)")
    add_text_p.add_argument("--y", type=float, default=0.9, help="Normalized center y of the text block (0-1)")
    add_text_p.add_argument("--size", type=float, default=0.05, help="Font height as a fraction of image height")
    add_text_p.add_argument("--color", default="#FFFFFF")
    add_text_p.add_argument("--stroke-color", default="#000000")
    add_text_p.add_argument("--stroke-width", type=int, default=None)
    add_text_p.add_argument("--opacity", type=float, default=1.0)
    add_text_p.add_argument("--align", choices=["left", "center", "right"], default="center")
    add_text_p.add_argument("--font-path", default=None)
    add_text_p.add_argument("--output", type=Path, default=None, help="Render to this path only — no catalog registration (preview mode)")

    subparsers.add_parser("serve", parents=[common], help="Resident mode: line-delimited JSON requests on stdin")

    export_assets_p = subparsers.add_parser("export-assets", parents=[common])
    export_assets_p.add_argument("--asset-id", action="append", required=True)
    export_assets_p.add_argument("--dest", type=Path, required=True)
    export_assets_p.add_argument("--max-edge", type=int, help="Resize so the longest edge fits this many pixels")
    export_assets_p.add_argument("--format", choices=["jpeg", "png", "webp"], help="Transcode to this format")
    export_assets_p.add_argument("--quality", type=int, default=90)

    collage_src = subparsers.add_parser("collage-sources", parents=[common])
    collage_src.add_argument("--asset-id", required=True)

    repaint_history = subparsers.add_parser("list-repaint-history", parents=[common])
    repaint_history.add_argument("--asset-path", type=Path, required=True)

    delete_image = subparsers.add_parser("delete-image-assets", parents=[common])
    delete_image.add_argument("--asset-id", action="append", required=True)

    subparsers.add_parser("cleanup-orphan-images", parents=[common])

    verify_assets_p = subparsers.add_parser("verify-assets", parents=[common])
    verify_assets_p.add_argument("--scope", choices=["all", "image", "raw"], default="all")

    relink_asset_p = subparsers.add_parser("relink-asset", parents=[common])
    relink_asset_p.add_argument("--asset-id", required=True)
    relink_asset_p.add_argument("--new-path", type=Path, required=True)
    relink_asset_p.add_argument("--force", action="store_true",
                                help="Relink even if the new file's fingerprint differs from the original")

    subparsers.add_parser("catalog-roots", parents=[common])
    register_roots_parser = subparsers.add_parser("register-roots", parents=[common])
    register_roots_parser.add_argument("--root-type", choices=["raw", "image"], required=True)
    register_roots_parser.add_argument("--path", type=Path, action="append", required=True)

    create_job_parser = subparsers.add_parser("create-job", parents=[common])
    create_job_parser.add_argument("--job-type", choices=["import", "enrichment", "preview", "ai_repaint", "annotation"], required=True)
    create_job_parser.add_argument("--payload-json", default="{}")

    get_job_parser = subparsers.add_parser("get-job", parents=[common])
    get_job_parser.add_argument("--job-id", required=True)

    latest_job_parser = subparsers.add_parser("latest-job", parents=[common])
    latest_job_parser.add_argument("--job-type", choices=["import", "enrichment", "preview", "ai_repaint", "annotation"])

    cancel_job_parser = subparsers.add_parser("cancel-job", parents=[common])
    cancel_job_parser.add_argument("--job-id", required=True)

    subparsers.add_parser("list-active-jobs", parents=[common])

    list_jobs_parser = subparsers.add_parser("list-jobs", parents=[common])
    list_jobs_parser.add_argument("--job-type", choices=["import", "enrichment", "preview", "ai_repaint", "annotation"])
    list_jobs_parser.add_argument("--limit", type=int, default=20)

    run_import_job_parser = subparsers.add_parser("run-import-job", parents=[common])
    run_import_job_parser.add_argument("--job-id", required=True)
    run_import_job_parser.add_argument(
        "--mode",
        choices=["source_only", "processed_only", "source_with_media", "processed_with_sources", "combined"],
        default="combined",
    )
    run_import_job_parser.add_argument("--raw-dir", type=Path, action="append", default=[])
    run_import_job_parser.add_argument("--image-dir", type=Path, action="append", default=[])
    run_import_job_parser.add_argument("--generate-hd", action="store_true", help="also generate 2000px HD previews")

    run_enrichment_job_parser = subparsers.add_parser("run-enrichment-job", parents=[common])
    run_enrichment_job_parser.add_argument("--job-id", required=True)
    run_enrichment_job_parser.add_argument("--raw-dir", type=Path, action="append", default=[])

    run_preview_job_parser = subparsers.add_parser("run-preview-job", parents=[common])
    run_preview_job_parser.add_argument("--job-id", required=True)
    run_preview_job_parser.add_argument("--kind", choices=["preview", "preview-hd"], default="preview")
    run_preview_job_parser.add_argument("--asset-type", choices=["raw", "image"])
    run_preview_job_parser.add_argument("--limit", type=int)
    run_preview_job_parser.add_argument("--force", action="store_true")

    get_provider_token = subparsers.add_parser("get-provider-token", parents=[common])
    get_provider_token.add_argument("--provider", required=True)

    set_provider_token = subparsers.add_parser("set-provider-token", parents=[common])
    set_provider_token.add_argument("--provider", required=True)
    set_provider_token.add_argument("--token", required=True)

    delete_provider_token = subparsers.add_parser("delete-provider-token", parents=[common])
    delete_provider_token.add_argument("--provider", required=True)

    subparsers.add_parser("repair-resource-sets", parents=[common])
    subparsers.add_parser("split-shared-assets", parents=[common])

    run_ai_repaint_job_parser = subparsers.add_parser("run-ai-repaint-job", parents=[common])
    run_ai_repaint_job_parser.add_argument("--job-id", required=True)
    run_ai_repaint_job_parser.add_argument("--provider", choices=["nanobanana", "openai", "openai_compatible", "jimeng", "mock"], default="nanobanana")
    run_ai_repaint_job_parser.add_argument("--base-url")
    run_ai_repaint_job_parser.add_argument("--model")
    run_ai_repaint_job_parser.add_argument("--input", type=Path, required=True)
    run_ai_repaint_job_parser.add_argument("--output", type=Path, required=True)
    run_ai_repaint_job_parser.add_argument("--prompt", required=True)
    run_ai_repaint_job_parser.add_argument("--origin-path", type=Path)
    run_ai_repaint_job_parser.add_argument("--aspect-ratio")
    run_ai_repaint_job_parser.add_argument("--image-size", choices=["1K", "2K", "4K"])
    run_ai_repaint_job_parser.add_argument("--temperature", type=float)
    run_ai_repaint_job_parser.add_argument("--api-key")

    summary_parser = subparsers.add_parser("summary", parents=[common])
    summary_parser.add_argument("--json", action="store_true")

    list_models_parser = subparsers.add_parser("list-ai-models", parents=[common])
    list_models_parser.add_argument("--provider", choices=["nanobanana", "openai", "openai_compatible", "jimeng"], default="nanobanana")
    list_models_parser.add_argument("--api-key")
    list_models_parser.add_argument("--base-url")

    repaint = subparsers.add_parser("ai-repaint", parents=[common])
    repaint.add_argument("--provider", choices=["nanobanana", "openai", "jimeng", "mock"], default="nanobanana")
    repaint.add_argument("--input", type=Path, required=True)
    repaint.add_argument("--output", type=Path, required=True)
    repaint.add_argument("--prompt", required=True)
    repaint.add_argument("--api-key")
    repaint.add_argument("--model", default=DEFAULT_GEMINI_MODEL)
    repaint.add_argument("--aspect-ratio")
    repaint.add_argument("--image-size", choices=["1K", "2K", "4K"])

    annotate_p = subparsers.add_parser("annotate-asset", parents=[common])
    annotate_p.add_argument("--asset-id", required=True)
    annotate_p.add_argument("--image", type=Path, required=True)
    annotate_p.add_argument("--provider", choices=["anthropic", "openai", "openai_compatible"], required=True)
    annotate_p.add_argument("--model", required=True)
    annotate_p.add_argument("--api-key")
    annotate_p.add_argument("--base-url")
    annotate_p.add_argument("--languages", default="en,zh", help="Comma-separated tag languages, e.g. 'en' or 'en,zh'")
    annotate_p.add_argument("--max-tags", type=int, default=10)
    annotate_p.add_argument("--max-caption-chars", type=int, default=200)
    annotate_p.add_argument("--custom-instructions")

    run_annotation_job_parser = subparsers.add_parser("run-annotation-job", parents=[common])
    run_annotation_job_parser.add_argument("--job-id", required=True)
    run_annotation_job_parser.add_argument("--provider", choices=["anthropic", "openai", "openai_compatible"], required=True)
    run_annotation_job_parser.add_argument("--model", required=True)
    run_annotation_job_parser.add_argument("--api-key")
    run_annotation_job_parser.add_argument("--base-url")
    run_annotation_job_parser.add_argument("--asset-type", choices=["raw", "image"], default="image")
    # only-missing defaults ON ("annotate all" skips already-annotated); pass
    # --reannotate to overwrite existing annotations.
    run_annotation_job_parser.add_argument("--reannotate", action="store_true")
    run_annotation_job_parser.add_argument("--asset-ids", help="Comma-separated asset_ids to scope the batch (multi-select).")
    run_annotation_job_parser.add_argument("--collection-id", help="Scope the batch to a collection/folder.")
    run_annotation_job_parser.add_argument("--languages", default="en,zh")
    run_annotation_job_parser.add_argument("--max-tags", type=int, default=10)
    run_annotation_job_parser.add_argument("--max-caption-chars", type=int, default=200)
    run_annotation_job_parser.add_argument("--custom-instructions")
    run_annotation_job_parser.add_argument("--video-frame-interval", type=float, default=0.0,
                                           help="Seconds between sampled video frames (0 = first/middle/last).")
    run_annotation_job_parser.add_argument("--limit", type=int)

    annotation_count_p = subparsers.add_parser("annotation-count", parents=[common])
    annotation_count_p.add_argument("--asset-type", choices=["raw", "image"], default="image")
    annotation_count_p.add_argument("--reannotate", action="store_true")
    annotation_count_p.add_argument("--asset-ids")
    annotation_count_p.add_argument("--collection-id")

    get_annotation_p = subparsers.add_parser("get-annotation", parents=[common])
    get_annotation_p.add_argument("--asset-id", required=True)

    add_tag_p = subparsers.add_parser("add-asset-tag", parents=[common])
    add_tag_p.add_argument("--asset-id", required=True)
    add_tag_p.add_argument("--tag", required=True)

    remove_tag_p = subparsers.add_parser("remove-asset-tag", parents=[common])
    remove_tag_p.add_argument("--asset-id", required=True)
    remove_tag_p.add_argument("--tag", required=True)

    list_tags_p = subparsers.add_parser("list-tags", parents=[common])
    list_tags_p.add_argument("--limit", type=int, default=200)

    test_conn_p = subparsers.add_parser("annotation-test-connection", parents=[common])
    test_conn_p.add_argument("--provider", choices=["anthropic", "openai", "openai_compatible"], required=True)
    test_conn_p.add_argument("--api-key")
    test_conn_p.add_argument("--base-url")

    list_anno_models_p = subparsers.add_parser("annotation-list-models", parents=[common])
    list_anno_models_p.add_argument("--provider", choices=["anthropic", "openai", "openai_compatible"], required=True)
    list_anno_models_p.add_argument("--api-key")
    list_anno_models_p.add_argument("--base-url")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Secrets come via env, not argv (argv is visible to every local process
    # through `ps`). The Electron transport strips --api-key into this var;
    # an explicitly passed flag still wins for direct CLI use.
    if getattr(args, "api_key", None) in (None, ""):
        env_key = os.environ.get("MEDIA_WORKSPACE_API_KEY")
        if env_key and hasattr(args, "api_key"):
            args.api_key = env_key

    if args.command == "serve":
        return _serve_loop(args)

    if args.command == "benchmark-dataset":
        thresholds = Thresholds(auto_bind=args.auto_threshold, manual_review=args.manual_threshold)
        payload = benchmark_dataset(
            catalog_path=args.catalog,
            raw_dirs=args.raw_dir,
            image_dirs=args.image_dir,
            truth_csv=args.truth_csv,
            thresholds=thresholds,
            include_previews=not args.skip_previews,
            force_scan=args.force_scan,
            force_previews=args.force_previews,
            scan_workers=args.scan_workers,
            fingerprint_mode=args.fingerprint_mode,
            metadata_profile=args.metadata_profile,
        )
        rendered = json.dumps(payload, indent=2)
        if args.report_json:
            args.report_json.parent.mkdir(parents=True, exist_ok=True)
            args.report_json.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 0

    # Catalog-free commands (no DB connection required) — must run before
    # ensure_catalog() so users can configure providers without a catalog open.
    if args.command == "annotation-test-connection":
        from . import annotation as _annotation
        result = _annotation.test_connection(
            provider=args.provider,
            api_key=args.api_key,
            base_url=args.base_url,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0

    if args.command == "annotation-list-models":
        from . import annotation as _annotation
        try:
            models = _annotation.list_models(
                provider=args.provider,
                api_key=args.api_key,
                base_url=args.base_url,
            )
            print(json.dumps({"ok": True, "models": models}, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 0

    catalog = ensure_catalog(args.catalog)
    fresh_db = not catalog.db_path.exists()
    connection = connect(catalog.db_path)
    init_db(connection)
    if fresh_db:
        set_catalog_path(connection, catalog.root)
    try:
        return _dispatch(parser, args, catalog, connection)
    finally:
        # Serve mode re-enters main() per request — without an explicit close
        # each request would leak a WAL/SHM file handle until GC.
        connection.close()


def _cmd_get_provider_token(args, connection, catalog, parser):
    payload = get_app_setting(connection, _provider_token_key(args.provider))
    print(json.dumps(payload or {}, indent=2))
    return 0


def _cmd_set_provider_token(args, connection, catalog, parser):
    set_app_setting(connection, _provider_token_key(args.provider), {"token": args.token})
    print(json.dumps({"provider": args.provider, "configured": True}, indent=2))
    return 0


def _cmd_delete_provider_token(args, connection, catalog, parser):
    delete_app_setting(connection, _provider_token_key(args.provider))
    print(json.dumps({"provider": args.provider, "configured": False}, indent=2))
    return 0


def _cmd_repair_resource_sets(args, connection, catalog, parser):
    from .db import list_incorrectly_merged_resource_sets

    # Phase 0: Split assets sharing the same asset_id (old format without path)
    shared_split_count = split_shared_asset_ids(connection)
    raw_removed = remove_raw_from_resource_sets(connection)

    # Phase 1: Split incorrectly merged sets (different-directory independent exports)
    from .db import split_incorrectly_merged_sets
    split_count = split_incorrectly_merged_sets(connection)

    # Phase 2: Attach assets missing a resource set
    repaired = 0
    primaries_created = 0
    versions_attached = 0
    missing = list_image_assets_missing_resource_set(connection)
    for row in missing:
        asset_id = str(row["asset_id"])
        stem = str(row["stem"])
        origin_stem, version_kind = _infer_origin_stem(stem)
        origin_asset_id = None
        if origin_stem:
            candidate_ids = [candidate for candidate in find_image_asset_ids_by_stem(connection, origin_stem) if candidate != asset_id]
            if candidate_ids:
                origin_asset_id = candidate_ids[0]
        if origin_asset_id:
            attach_asset_to_resource_set(
                connection,
                asset_id,
                origin_asset_id=origin_asset_id,
                version_kind=version_kind,
                commit=False,
            )
            versions_attached += 1
        else:
            attach_asset_to_resource_set(
                connection,
                asset_id,
                origin_asset_id=None,
                version_kind="import",
                commit=False,
            )
            primaries_created += 1
        repaired += 1

    # Phase 3: Reassign singleton derived sets
    repaired_singletons = 0
    suspect_sets = list_singleton_primary_resource_sets(connection)
    for row in suspect_sets:
        stem = str(row["stem"])
        origin_stem, version_kind = _infer_origin_stem(stem)
        if not origin_stem:
            continue
        candidate_ids = [candidate for candidate in find_image_asset_ids_by_stem(connection, origin_stem) if candidate != row["primary_asset_id"]]
        if not candidate_ids:
            continue
        origin_asset_id = candidate_ids[0]
        reassign_asset_to_resource_set(
            connection,
            str(row["primary_asset_id"]),
            origin_asset_id=origin_asset_id,
            version_kind=version_kind,
            commit=False,
        )
        repaired_singletons += 1
        versions_attached += 1
        repaired += 1
    connection.commit()
    print(json.dumps({
        "ok": True,
        "shared_assets_split": shared_split_count,
        "raw_removed_from_sets": raw_removed,
        "split_merged_sets": split_count,
        "repaired": repaired,
        "primaries_created": primaries_created,
        "versions_attached": versions_attached,
        "singleton_versions_reassigned": repaired_singletons,
    }, indent=2))
    return 0


def _cmd_split_shared_assets(args, connection, catalog, parser):
    count = split_shared_asset_ids(connection)
    raw_removed = remove_raw_from_resource_sets(connection)
    print(json.dumps({"ok": True, "split_count": count, "raw_removed": raw_removed}, indent=2))
    return 0


def _cmd_list_ai_models(args, connection, catalog, parser):
    effective_key = args.api_key
    if not effective_key:
        provider_key = f"ai_provider_token:{args.provider}"
        config = get_app_setting(connection, provider_key)
        effective_key = config.get("token") if isinstance(config, dict) else None
    if not effective_key:
        print(json.dumps({"error": f"No API key for {args.provider}"}))
        return 1
    models = list_provider_models(args.provider, effective_key, base_url=getattr(args, "base_url", None))
    print(json.dumps(models, indent=2))
    return 0


def _cmd_run_ai_repaint_job(args, connection, catalog, parser):
    payload = run_ai_repaint_job(
        connection,
        catalog_path=args.catalog,
        job_id=args.job_id,
        provider=args.provider,
        input_path=args.input,
        output_path=args.output,
        prompt=args.prompt,
        api_key=args.api_key,
        origin_path=args.origin_path,
        aspect_ratio=args.aspect_ratio,
        image_size=args.image_size,
        temperature=args.temperature,
        model=getattr(args, "model", None),
        base_url=getattr(args, "base_url", None),
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_ai_repaint(args, connection, catalog, parser):
    if args.provider == "mock":
        payload = run_mock_repaint(
            input_path=args.input,
            output_path=args.output,
            prompt=args.prompt,
        )
    elif args.provider == OPENAI_PROVIDER:
        payload = run_openai_repaint(
            input_path=args.input,
            output_path=args.output,
            prompt=args.prompt,
            api_key=args.api_key,
            model=args.model or DEFAULT_OPENAI_MODEL,
            aspect_ratio=args.aspect_ratio,
            image_size=args.image_size,
        )
    else:
        payload = run_nanobanana_repaint(
            input_path=args.input,
            output_path=args.output,
            prompt=args.prompt,
            api_key=args.api_key,
            model=args.model,
            aspect_ratio=args.aspect_ratio,
            image_size=args.image_size,
        )
    print(json.dumps(asdict(payload), indent=2))
    return 0


def _cmd_annotate_asset(args, connection, catalog, parser):
    import shutil
    import tempfile
    from pathlib import Path as _Path
    from . import annotation as _annotation
    from . import video as _video

    langs = [s.strip() for s in (args.languages or "").split(",") if s.strip()]
    existing = _annotation.list_top_tags(connection)

    src = _Path(args.image)
    tmp_dir = None
    try:
        # Video: PIL can't open it — sample frames and send them as one
        # multi-image call (same as the batch path).
        if _video.is_video(src):
            tmp_dir = tempfile.mkdtemp(prefix="afvframes-")
            frames = _video.frames(src, _Path(tmp_dir))
            image_paths = [_Path(tmp_dir) / f["filename"] for f in frames]
            is_video = bool(image_paths)
            if not image_paths:
                image_paths, is_video = [src], False
        else:
            image_paths, is_video = [src], False
        result = _annotation.annotate(
            image_paths=image_paths,
            provider=args.provider,
            api_key=args.api_key,
            model=args.model,
            base_url=args.base_url,
            languages=langs,
            max_tags=args.max_tags,
            max_caption_chars=args.max_caption_chars,
            custom_instructions=args.custom_instructions,
            existing_tags=existing,
            is_video=is_video,
        )
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    saved = _annotation.save_annotation(connection, args.asset_id, result)
    print(json.dumps(saved, ensure_ascii=False, indent=2))
    return 0


def _cmd_run_annotation_job(args, connection, catalog, parser):
    langs = [s.strip() for s in (args.languages or "").split(",") if s.strip()]
    asset_ids = [s.strip() for s in (args.asset_ids or "").split(",") if s.strip()] or None
    payload = run_annotation_job(
        connection,
        catalog_path=args.catalog,
        job_id=args.job_id,
        provider=args.provider,
        api_key=args.api_key,
        model=args.model,
        base_url=args.base_url,
        asset_type=args.asset_type,
        only_missing=not args.reannotate,
        asset_ids=asset_ids,
        collection_id=args.collection_id or None,
        languages=langs,
        max_tags=args.max_tags,
        max_caption_chars=args.max_caption_chars,
        custom_instructions=args.custom_instructions,
        video_frame_interval=args.video_frame_interval,
        limit=args.limit,
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _cmd_annotation_count(args, connection, catalog, parser):
    from .db import count_assets_for_annotation
    asset_ids = [s.strip() for s in (args.asset_ids or "").split(",") if s.strip()] or None
    count = count_assets_for_annotation(
        connection,
        asset_type=args.asset_type,
        only_missing=not args.reannotate,
        asset_ids=asset_ids,
        collection_id=args.collection_id or None,
    )
    print(json.dumps({"count": count}, ensure_ascii=False))
    return 0


def _cmd_get_annotation(args, connection, catalog, parser):
    from . import annotation as _annotation
    payload = _annotation.get_annotation(connection, args.asset_id)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _cmd_add_asset_tag(args, connection, catalog, parser):
    from . import annotation as _annotation
    payload = _annotation.add_asset_tag(connection, args.asset_id, args.tag)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _cmd_remove_asset_tag(args, connection, catalog, parser):
    from . import annotation as _annotation
    payload = _annotation.remove_asset_tag(connection, args.asset_id, args.tag)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _cmd_list_tags(args, connection, catalog, parser):
    from . import annotation as _annotation
    tags = _annotation.list_top_tags(connection, limit=args.limit)
    print(json.dumps(tags, ensure_ascii=False))
    return 0


def _cmd_init_catalog(args, connection, catalog, parser):
    set_catalog_path(connection, catalog.root)
    print(f"initialized {catalog.root}")
    return 0


def _cmd_scan_raw(args, connection, catalog, parser):
    aggregate = {"indexed": 0, "skipped": 0, "unchanged": 0, "forced": int(args.force)}
    for raw_dir in args.raw_dir:
        result = scan_raw_directory(
            connection,
            raw_dir,
            force=args.force,
            workers=args.workers,
            fingerprint_mode=args.fingerprint_mode,
            metadata_profile=args.metadata_profile,
        )
        aggregate["indexed"] += result["indexed"]
        aggregate["skipped"] += result["skipped"]
        aggregate["unchanged"] += result["unchanged"]
        aggregate["workers"] = result["workers"]
        aggregate["fingerprint_mode"] = result["fingerprint_mode"]
        aggregate["metadata_profile"] = result["metadata_profile"]
    print(json.dumps(aggregate, indent=2))
    return 0


def _cmd_enrich_raw(args, connection, catalog, parser):
    payload = enrich_raw_assets(
        connection,
        raw_dirs=args.raw_dir,
        limit=args.limit,
        workers=args.workers,
        fingerprint_mode=args.fingerprint_mode,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_analyze_metadata(args, connection, catalog, parser):
    payload = analyze_metadata_coverage(
        raw_dirs=[path.resolve() for path in args.raw_dir],
        image_dirs=[path.resolve() for path in args.image_dir],
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_create_job(args, connection, catalog, parser):
    payload = json.loads(args.payload_json or "{}")
    print(json.dumps(create_job(connection, args.job_type, payload=payload), indent=2))
    return 0


def _cmd_get_job(args, connection, catalog, parser):
    print(json.dumps(get_job(connection, args.job_id), indent=2))
    return 0


def _cmd_latest_job(args, connection, catalog, parser):
    print(json.dumps(get_latest_job(connection, args.job_type), indent=2))
    return 0


def _cmd_list_jobs(args, connection, catalog, parser):
    print(json.dumps(list_jobs(connection, job_type=args.job_type, limit=args.limit), indent=2))
    return 0


def _cmd_cancel_job(args, connection, catalog, parser):
    from .db import request_job_cancel
    print(json.dumps(request_job_cancel(connection, args.job_id), indent=2))
    return 0


def _cmd_list_active_jobs(args, connection, catalog, parser):
    from .db import list_active_jobs
    print(json.dumps(list_active_jobs(connection), indent=2))
    return 0


def _cmd_run_import_job(args, connection, catalog, parser):
    payload = run_import_job(
        connection,
        catalog.root,
        args.job_id,
        raw_dirs=args.raw_dir,
        image_dirs=args.image_dir,
        mode=args.mode,
        generate_hd=args.generate_hd,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_run_enrichment_job(args, connection, catalog, parser):
    payload = run_enrichment_job(connection, args.job_id, raw_dirs=args.raw_dir)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_run_preview_job(args, connection, catalog, parser):
    payload = run_preview_job(
        connection,
        catalog.root,
        args.job_id,
        kind=args.kind,
        asset_type=args.asset_type,
        limit=args.limit,
        force=args.force,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_evaluate_ground_truth(args, connection, catalog, parser):
    payload = evaluate_ground_truth(connection, args.truth_csv.resolve(), refresh=args.refresh)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_export_ground_truth(args, connection, catalog, parser):
    payload = export_ground_truth(connection, args.output_csv, statuses=args.status)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_resolve_image(args, connection, catalog, parser):
    thresholds = Thresholds(auto_bind=args.auto_threshold, manual_review=args.manual_threshold)
    decision = resolve_image(connection, args.path, thresholds=thresholds, refresh=args.refresh)
    print(
        json.dumps(
            {
                "status": decision.status,
                "score": decision.score,
                "raw_asset_id": decision.raw_asset_id,
                "top_candidates": decision.ranked_candidates,
            },
            indent=2,
        )
    )
    return 0


def _cmd_resolve_image_batch(args, connection, catalog, parser):
    thresholds = Thresholds(auto_bind=args.auto_threshold, manual_review=args.manual_threshold)
    payload = resolve_image_batch(connection, args.image_dir, thresholds=thresholds, refresh=args.refresh)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_watch_images(args, connection, catalog, parser):
    thresholds = Thresholds(auto_bind=args.auto_threshold, manual_review=args.manual_threshold)
    watcher = ImageWatcher(
        connection,
        image_dirs=tuple(args.image_dir),
        thresholds=thresholds,
        poll_interval_seconds=args.interval,
    )
    watcher.run()
    return 0


def _cmd_generate_previews(args, connection, catalog, parser):
    service = PreviewService(catalog)
    payload = service.generate_batch(
        connection,
        kind=args.kind,
        asset_type=args.asset_type,
        limit=args.limit,
        force=args.force,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_facet_values(args, connection, catalog, parser):
    from .db import get_facet_values
    print(json.dumps(get_facet_values(connection), ensure_ascii=False))
    return 0


def _cmd_search_facet(args, connection, catalog, parser):
    from .db import search_facet_values
    print(json.dumps(search_facet_values(connection, args.field, args.q, args.limit), ensure_ascii=False))
    return 0


def _cmd_browse_images(args, connection, catalog, parser):
    facet_filters = json.loads(args.filters) if args.filters else None
    payload = []
    # Lazy detection (layer 1): stat the visible page so missing badges appear
    # just by scrolling. This is the read path (re-run on every page/scroll), so
    # it must stay read-only — reconciling assets.exists_on_disk is left to the
    # explicit verify-assets sweep. The live `present` value below is what the
    # UI badges/blocks read; the DB flag only gates preview/export batches.
    for row in list_image_assets(connection, status=args.status, limit=args.limit, offset=args.offset, search=args.search, sort=args.sort, filters=facet_filters):
        preview_path = None
        if row["preview_relative_path"]:
            preview_path = str((catalog.root / row["preview_relative_path"]).resolve())
        preview_hd_path = None
        if row["preview_hd_relative_path"]:
            preview_hd_path = str((catalog.root / row["preview_hd_relative_path"]).resolve())
        present = os.path.exists(row["image_path"]) if row["image_path"] else True
        payload.append(
            {
                "asset_id": row["asset_id"],
                "asset_type": row["asset_type"],
                "stem": row["stem"],
                "image_path": row["image_path"],
                "image_metadata": json.loads(row["image_metadata_json"] or "{}"),
                "app_rating": row["app_rating"],
                "exists_on_disk": present,
                "imported_at": row["imported_at"],
                "match_status": row["match_status"],
                "score": row["score"],
                "raw_asset_id": row["raw_asset_id"],
                "raw_path": row["raw_path"],
                "raw_metadata": json.loads(row["raw_metadata_json"] or "{}") if row["raw_metadata_json"] else {},
                "preview_path": preview_path,
                "preview_hd_path": preview_hd_path,
                "resource_set_id": row["resource_set_id"],
                "resource_role": row["resource_role"],
                "version_kind": row["version_kind"],
                "resource_sort_order": row["resource_sort_order"],
                "set_primary_asset_id": row["set_primary_asset_id"],
                "set_raw_asset_id": row["set_raw_asset_id"],
                "primary_stem": row["primary_stem"],
                "set_item_count": row["set_item_count"],
                "annotation": _annotation_from_row(row),
            }
        )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_asset_detail(args, connection, catalog, parser):
    if args.image_path:
        row = get_image_asset_detail_by_path(connection, str(args.image_path.resolve()))
        identifier = str(args.image_path)
    else:
        row = get_image_asset_detail(connection, args.asset_id)
        identifier = args.asset_id
    if row is None:
        raise SystemExit(f"unknown export asset: {identifier}")
    duplicates = get_duplicate_assets(connection, row["asset_id"])
    # Read-only live stat (see _cmd_browse_images) — no write-back on this path.
    present = os.path.exists(row["image_path"]) if row["image_path"] else True
    payload = {
        "asset_id": row["asset_id"],
        "asset_type": row["asset_type"],
        "stem": row["stem"],
        "image_path": row["image_path"],
        "image_metadata": json.loads(row["image_metadata_json"] or "{}"),
        "app_rating": row["app_rating"],
        "exists_on_disk": present,
        "imported_at": row["imported_at"],
        "match_status": row["match_status"],
        "score": row["score"],
        "raw_asset_id": row["raw_asset_id"],
        "raw_path": row["raw_path"],
        "raw_metadata": json.loads(row["raw_metadata_json"] or "{}") if row["raw_metadata_json"] else {},
        "feature_vector": json.loads(row["feature_vector_json"] or "{}"),
        "candidates": json.loads(row["candidate_json"] or "[]"),
        "image_preview_path": str((catalog.root / row["image_preview_relative_path"]).resolve())
        if row["image_preview_relative_path"]
        else None,
        "raw_preview_path": str((catalog.root / row["raw_preview_relative_path"]).resolve())
        if row["raw_preview_relative_path"]
        else None,
        "image_preview_hd_path": str((catalog.root / row["image_preview_hd_relative_path"]).resolve())
        if row["image_preview_hd_relative_path"]
        else None,
        "resource_set_id": row["resource_set_id"],
        "resource_role": row["resource_role"],
        "version_kind": row["version_kind"],
        "resource_sort_order": row["resource_sort_order"],
        "set_primary_asset_id": row["set_primary_asset_id"],
        "set_raw_asset_id": row["set_raw_asset_id"],
        "primary_stem": row["primary_stem"],
        "set_item_count": row["set_item_count"],
        "duplicates": [
            {"asset_id": d["asset_id"], "image_path": d["image_path"], "stem": d["stem"]}
            for d in duplicates
        ],
    }

    # Add version siblings from resource set
    asset_id = row["asset_id"]
    set_id = row["resource_set_id"]
    if set_id:
        from .db import list_version_siblings
        siblings = list_version_siblings(connection, set_id, asset_id)
        payload["version_siblings"] = [
            {
                "asset_id": s["asset_id"],
                "role": s["role"],
                "version_kind": s["version_kind"],
                "stem": s["stem"],
                "image_path": s["image_path"],
                "preview_path": str((catalog.root / s["preview_relative_path"]).resolve())
                if s["preview_relative_path"] else None,
            }
            for s in siblings
        ]
    else:
        payload["version_siblings"] = []

    # Add collage relationships
    from .db import list_collage_sources, list_collages_using_asset
    collage_sources = list_collage_sources(connection, asset_id)
    payload["collage_sources"] = [
        {
            "asset_id": s["source_asset_id"],
            "stem": s["stem"],
            "image_path": s["image_path"],
            "preview_path": str((catalog.root / s["preview_relative_path"]).resolve())
            if s["preview_relative_path"] else None,
        }
        for s in collage_sources
    ]

    used_in_collages = list_collages_using_asset(connection, asset_id)
    payload["used_in_collages"] = [
        {
            "asset_id": s["collage_asset_id"],
            "stem": s["stem"],
            "image_path": s["image_path"],
            "preview_path": str((catalog.root / s["preview_relative_path"]).resolve())
            if s["preview_relative_path"] else None,
        }
        for s in used_in_collages
    ]
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_list_pending(args, connection, catalog, parser):
    payload = []
    for row in list_pending(connection):
        payload.append(
            {
                "image_path": row["image_path"],
                "image_asset_id": row["image_asset_id"],
                "score": row["score"],
                "candidates": json.loads(row["candidate_json"]),
            }
        )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_confirm_match(args, connection, catalog, parser):
    confirm_match(connection, args.image_path, args.raw_asset_id)
    print(f"confirmed {args.image_path} -> {args.raw_asset_id}")
    return 0


def _cmd_list_repaint_history(args, connection, catalog, parser):
    from .db import list_repaint_history
    history = list_repaint_history(connection, str(args.asset_path.resolve()))
    print(json.dumps(history, ensure_ascii=False))
    return 0


def _cmd_collage_sources(args, connection, catalog, parser):
    # Get sources if this asset is a collage
    from .db import list_collage_sources, list_collages_using_asset
    sources = list_collage_sources(connection, args.asset_id)
    # Get collages that use this asset as a source
    used_in = list_collages_using_asset(connection, args.asset_id)
    print(json.dumps({
        "sources": [dict(r) for r in sources],
        "used_in_collages": [dict(r) for r in used_in],
    }, ensure_ascii=False))
    return 0


def _cmd_quick_register(args, connection, catalog, parser):
    from .derived import register_image_file
    payload = register_image_file(
        connection,
        catalog,
        args.image_path.resolve(),
        origin_path=args.origin_path.resolve() if args.origin_path else None,
        collage_source_ids=getattr(args, "collage_source_ids", None) or [],
    )
    print(json.dumps(payload))
    return 0


def _cmd_create_derived(args, connection, catalog, parser):
    from .derived import create_derived_crop
    payload = create_derived_crop(
        connection,
        catalog,
        args.asset_id,
        args.crop_ratio,
        gravity=args.gravity,
    )
    print(json.dumps(payload))
    return 0


def _cmd_add_text(args, connection, catalog, parser):
    from .derived import create_derived_text
    payload = create_derived_text(
        connection,
        catalog,
        args.asset_id,
        output=args.output,
        text=args.text,
        x=args.x,
        y=args.y,
        size=args.size,
        color=args.color,
        stroke_color=args.stroke_color,
        stroke_width=args.stroke_width,
        opacity=args.opacity,
        align=args.align,
        font_path=args.font_path,
    )
    print(json.dumps(payload))
    return 0


def _cmd_export_assets(args, connection, catalog, parser):
    from .derived import export_assets_to_dir
    payload = export_assets_to_dir(
        connection,
        args.asset_id,
        args.dest,
        max_edge=args.max_edge,
        fmt=args.format,
        quality=args.quality,
    )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_cleanup_orphan_images(args, connection, catalog, parser):
    payload = cleanup_orphan_image_assets(connection)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_verify_assets(args, connection, catalog, parser):
    payload = verify_assets(connection, scope=args.scope)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_relink_asset(args, connection, catalog, parser):
    payload = relink_asset(connection, args.asset_id, args.new_path, force=args.force)
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_delete_image_assets(args, connection, catalog, parser):
    payload = [
        delete_image_asset_from_catalog(connection, catalog.root, asset_id, commit=False)
        for asset_id in args.asset_id
    ]
    connection.commit()
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_catalog_roots(args, connection, catalog, parser):
    payload = [
        {
            "root_id": row["root_id"],
            "root_type": row["root_type"],
            "path": row["path"],
            "is_active": bool(row["is_active"]),
        }
        for row in list_catalog_roots(connection)
    ]
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_register_roots(args, connection, catalog, parser):
    for root_path in args.path:
        upsert_catalog_root(connection, args.root_type, root_path.resolve(), commit=False)
    connection.commit()
    payload = [
        {
            "root_id": row["root_id"],
            "root_type": row["root_type"],
            "path": row["path"],
            "is_active": bool(row["is_active"]),
        }
        for row in list_catalog_roots(connection)
    ]
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_summary(args, connection, catalog, parser):
    payload = summary(connection)
    if args.json:
        print(json.dumps(payload))
    else:
        print(json.dumps(payload, indent=2))
    return 0


def _cmd_list_collections(args, connection, catalog, parser):
    payload = []
    for row in list_collections(connection):
        payload.append(
            {
                "collection_id": row["collection_id"],
                "name": row["name"],
                "kind": row["kind"],
                "parent_collection_id": row["parent_collection_id"],
                "rules_json": row["rules_json"],
                "sort_order": row["sort_order"],
                "item_count": row["item_count"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_create_collection(args, connection, catalog, parser):
    col = create_collection(connection, args.name, args.kind, args.rules_json)
    print(json.dumps(col, indent=2))
    return 0


def _cmd_update_collection(args, connection, catalog, parser):
    update_collection(
        connection,
        args.collection_id,
        name=args.name,
        rules_json=args.rules_json,
        sort_order=args.sort_order,
    )
    print(json.dumps({"ok": True, "collection_id": args.collection_id}))
    return 0


def _cmd_delete_collection(args, connection, catalog, parser):
    delete_collection(connection, args.collection_id)
    print(json.dumps({"ok": True, "collection_id": args.collection_id}))
    return 0


def _cmd_collection_add_items(args, connection, catalog, parser):
    add_collection_items(connection, args.collection_id, args.asset_id)
    print(json.dumps({"ok": True, "collection_id": args.collection_id, "added": args.asset_id}))
    return 0


def _cmd_collection_remove_items(args, connection, catalog, parser):
    remove_collection_items(connection, args.collection_id, args.asset_id)
    print(json.dumps({"ok": True, "collection_id": args.collection_id, "removed": args.asset_id}))
    return 0


def _cmd_set_asset_rating(args, connection, catalog, parser):
    updated = set_asset_rating(connection, args.asset_id, None if args.rating == 0 else args.rating)
    print(json.dumps({"ok": True, "asset_ids": args.asset_id, "rating": args.rating, "updated": updated}))
    return 0


def _cmd_browse_collection(args, connection, catalog, parser):
    payload = []
    for row in browse_collection(connection, args.collection_id, limit=args.limit, offset=args.offset):
        preview_path = None
        if row["preview_relative_path"]:
            preview_path = str((catalog.root / row["preview_relative_path"]).resolve())
        preview_hd_path = None
        if row["preview_hd_relative_path"]:
            preview_hd_path = str((catalog.root / row["preview_hd_relative_path"]).resolve())
        payload.append(
            {
                "asset_id": row["asset_id"],
                "asset_type": row["asset_type"],
                "stem": row["stem"],
                "image_path": row["image_path"],
                "image_metadata": json.loads(row["image_metadata_json"] or "{}"),
                "app_rating": row["app_rating"],
                "imported_at": row["imported_at"],
                "match_status": row["match_status"],
                "score": row["score"],
                "raw_asset_id": row["raw_asset_id"],
                "raw_path": row["raw_path"],
                "raw_metadata": json.loads(row["raw_metadata_json"] or "{}") if row["raw_metadata_json"] else {},
                "preview_path": preview_path,
                "preview_hd_path": preview_hd_path,
                "resource_set_id": row["resource_set_id"],
                "resource_role": row["resource_role"],
                "version_kind": row["version_kind"],
                "resource_sort_order": row["resource_sort_order"],
                "set_primary_asset_id": row["set_primary_asset_id"],
                "set_raw_asset_id": row["set_raw_asset_id"],
                "primary_stem": row["primary_stem"],
                "set_item_count": row["set_item_count"],
                "annotation": _annotation_from_row(row),
            }
        )
    print(json.dumps(payload, indent=2))
    return 0

# Command registry — adding a CLI verb is one function + one entry here.
COMMAND_HANDLERS = {
    "get-provider-token": _cmd_get_provider_token,
    "set-provider-token": _cmd_set_provider_token,
    "delete-provider-token": _cmd_delete_provider_token,
    "repair-resource-sets": _cmd_repair_resource_sets,
    "split-shared-assets": _cmd_split_shared_assets,
    "list-ai-models": _cmd_list_ai_models,
    "run-ai-repaint-job": _cmd_run_ai_repaint_job,
    "ai-repaint": _cmd_ai_repaint,
    "annotate-asset": _cmd_annotate_asset,
    "run-annotation-job": _cmd_run_annotation_job,
    "annotation-count": _cmd_annotation_count,
    "get-annotation": _cmd_get_annotation,
    "add-asset-tag": _cmd_add_asset_tag,
    "remove-asset-tag": _cmd_remove_asset_tag,
    "list-tags": _cmd_list_tags,
    "init-catalog": _cmd_init_catalog,
    "scan-raw": _cmd_scan_raw,
    "enrich-raw": _cmd_enrich_raw,
    "analyze-metadata": _cmd_analyze_metadata,
    "create-job": _cmd_create_job,
    "get-job": _cmd_get_job,
    "latest-job": _cmd_latest_job,
    "list-jobs": _cmd_list_jobs,
    "cancel-job": _cmd_cancel_job,
    "list-active-jobs": _cmd_list_active_jobs,
    "run-import-job": _cmd_run_import_job,
    "run-enrichment-job": _cmd_run_enrichment_job,
    "run-preview-job": _cmd_run_preview_job,
    "evaluate-ground-truth": _cmd_evaluate_ground_truth,
    "export-ground-truth": _cmd_export_ground_truth,
    "resolve-image": _cmd_resolve_image,
    "resolve-export-batch": _cmd_resolve_image_batch,
    "watch-images": _cmd_watch_images,
    "generate-previews": _cmd_generate_previews,
    "facet-values": _cmd_facet_values,
    "search-facet": _cmd_search_facet,
    "browse-images": _cmd_browse_images,
    "asset-detail": _cmd_asset_detail,
    "list-pending": _cmd_list_pending,
    "confirm-match": _cmd_confirm_match,
    "list-repaint-history": _cmd_list_repaint_history,
    "collage-sources": _cmd_collage_sources,
    "quick-register": _cmd_quick_register,
    "create-derived": _cmd_create_derived,
    "add-text": _cmd_add_text,
    "export-assets": _cmd_export_assets,
    "cleanup-orphan-images": _cmd_cleanup_orphan_images,
    "verify-assets": _cmd_verify_assets,
    "relink-asset": _cmd_relink_asset,
    "delete-image-assets": _cmd_delete_image_assets,
    "catalog-roots": _cmd_catalog_roots,
    "register-roots": _cmd_register_roots,
    "summary": _cmd_summary,
    "list-collections": _cmd_list_collections,
    "create-collection": _cmd_create_collection,
    "update-collection": _cmd_update_collection,
    "delete-collection": _cmd_delete_collection,
    "collection-add-items": _cmd_collection_add_items,
    "collection-remove-items": _cmd_collection_remove_items,
    "set-asset-rating": _cmd_set_asset_rating,
    "browse-collection": _cmd_browse_collection,
}


def _dispatch(parser, args, catalog, connection) -> int:
    handler = COMMAND_HANDLERS.get(args.command)
    if handler is None:
        parser.error(f"unsupported command: {args.command}")
        return 2
    return handler(args, connection, catalog, parser)
