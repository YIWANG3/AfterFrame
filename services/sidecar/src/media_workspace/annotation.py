"""LLM auto-annotation: caption, tags, and location guess for an image.

Single-asset path (no job system) — keeps it simple for the MVP. Batch can
build on top by looping with a job for progress.

Providers:
    - anthropic            (Claude 4.5 family, vision via messages API)
    - openai               (GPT-4o family)
    - google               (Gemini vision)
    - openai_compatible    (Ollama or any OpenAI-compatible /v1 endpoint)

Schema written:
    asset_ai_annotations   one row per asset, latest only
    asset_tags             flat tag table, one row per (asset, tag)
"""

from __future__ import annotations

import base64
import io
import json
import re
import shutil
import sqlite3
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import video
from .ai_repaint import fetch_openai_model_ids
from .annotation_location import asset_gps_location, effective_location
from .db.tags import (  # noqa: F401 — the tag writes live in db/tags.py; re-exported for callers and tests
    TagResolver,
    add_asset_tag,
    add_asset_tags,
    ensure_tag,
    get_asset_tags,
    list_top_tags,
    normalize_tag,
    remove_asset_tag,
    reuse_hints,
)

try:
    from PIL import Image, ImageOps  # noqa: F401 — needed for image preprocessing
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Pillow is required for annotation. Install: pip install Pillow") from exc

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()  # lets PIL.Image.open handle HEIC/HEIF
except ImportError:  # pragma: no cover — HEIC support is optional
    pass

# Panoramas and stitched exports routinely exceed PIL's 89-megapixel
# decompression-bomb default (a ~98 MP pano warns today and would hard-fail at
# 2× the limit). These are the user's own local files and we downscale to
# THUMB_MAX_EDGE immediately, so the DoS guard doesn't apply here.
Image.MAX_IMAGE_PIXELS = None


# ── Constants ────────────────────────────────────────────────────────────────

THUMB_MAX_EDGE = 512
JPEG_QUALITY = 85
HTTP_TIMEOUT = 60
DEFAULT_MAX_TAGS = 10
DEFAULT_MAX_CAPTION_CHARS = 200
# v2: location gained structured admin1/locality (v1 had a fuzzy "region").
# The offline geo resolver reads both shapes.
ANNOTATION_SCHEMA_VERSION = 2

# The system prompt's text is data, shared with the web build (which has no
# sidecar): apps/desktop/src/api/browser/llm.js reads the same file through a
# Vite alias, so a wording change lands on both sides at once.
_PROMPT_PATH = Path(__file__).parent / "data" / "annotation_prompt.json"
_PROMPT: dict[str, Any] = json.loads(_PROMPT_PATH.read_text(encoding="utf-8"))
# How many existing tags to inject into the prompt as "prefer these"
TAG_REUSE_HINT_LIMIT = int(_PROMPT["tag_reuse_hint_limit"])


# ── Result type ──────────────────────────────────────────────────────────────

@dataclass
class AnnotationResult:
    caption: str
    tags: list[str]
    # The group the model put each tag under (a tag_groups id), when it
    # answered in groups; a tag it filed under "other" is absent here.
    tag_groups: dict[str, str] = field(default_factory=dict)
    location: dict[str, Any] | None = None  # v2: {"country", "admin1", "locality", "landmark", "confidence"}
    detected_text: str | None = None
    raw_response: str = ""
    provider: str = ""
    model: str = ""


# ── Image preprocessing ──────────────────────────────────────────────────────

def encode_image_for_llm(image_path: Path, max_edge: int = THUMB_MAX_EDGE) -> tuple[str, str]:
    """Resize, strip EXIF, JPEG-encode, base64. Returns (b64_data, mime_type)."""
    # Bake in EXIF orientation BEFORE stripping metadata — otherwise a portrait
    # phone shot (orientation 6) reaches the model lying on its side, which
    # wrecks OCR in particular. Generated previews (sips/QuickLook) are already
    # upright, but `_batch_image_path` falls back to the untouched original when
    # no preview exists yet, and `annotate-asset --image` always passes one.
    with Image.open(image_path) as source:
        img = ImageOps.exif_transpose(source).convert("RGB")  # strips alpha + drops most EXIF
    w, h = img.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        img = img.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"


# ── Prompt construction ──────────────────────────────────────────────────────

def _has_cjk(text: str) -> bool:
    """True if the string contains any CJK ideograph — our heuristic for a
    Chinese tag vs an English one."""
    return any("一" <= ch <= "鿿" for ch in text)


def filter_tags_by_language(tags: list[str], languages: list[str]) -> list[str]:
    """Keep only tags whose language is among the selected ones.

    The tag-reuse pool would otherwise leak Chinese tags from earlier
    bilingual runs into an English-only request (and vice versa), since the
    model is told to PREFER reusing them.
    """
    want_en = "en" in languages
    want_zh = "zh" in languages
    if want_en and want_zh:
        return tags
    out: list[str] = []
    for tag in tags:
        is_zh = _has_cjk(tag)
        if is_zh and want_zh:
            out.append(tag)
        elif not is_zh and want_en:
            out.append(tag)
    return out


def build_system_prompt(
    *,
    languages: list[str],
    max_tags: int,
    max_caption_chars: int,
    existing_tags: list[str] | None = None,
    custom_instructions: str | None,
    tag_groups: list[dict[str, Any]] | None = None,
) -> str:
    """The annotation system prompt: data/annotation_prompt.json filled in.

    With `tag_groups` (db.tags.reuse_hints: [{id, name, examples}]) the model
    answers tags by group and the groups are listed with the library's own
    tags in each; without, it answers a flat list and `existing_tags` is the
    flat reuse hint. Mirrored line for line by buildAnnotationSystemPrompt in
    the web build's llm.js — keep the two in step when the interpolation
    changes.
    """
    want_en = "en" in languages
    want_zh = "zh" in languages
    lang_clause = _PROMPT["lang_clause"]["en+zh" if want_en and want_zh else "en" if want_en else "zh"]
    shape = str(_PROMPT["tags_grouped" if tag_groups is not None else "tags_flat"]).replace("{max_tags}", str(max_tags))

    prompt = (
        str(_PROMPT["template"])
        .replace("{max_caption_chars}", str(max_caption_chars))
        .replace("{tags_shape}", shape)
        .replace("{lang_clause}", lang_clause)
    )

    if tag_groups is not None:
        lines = []
        for group in tag_groups:
            if str(group.get("id")) == "other":
                continue
            examples = filter_tags_by_language([str(t) for t in group.get("examples") or []], languages)
            line = str(_PROMPT["group_line" if examples else "group_line_bare"])
            lines.append(
                line.replace("{id}", str(group["id"])).replace("{name}", str(group.get("name") or group["id"]))
                .replace("{examples}", ", ".join(examples))
            )
        if lines:
            prompt += _PROMPT["groups_intro"] + "\n".join(lines)
    elif existing_tags:
        sample = filter_tags_by_language(existing_tags, languages)[:TAG_REUSE_HINT_LIMIT]
        if sample:
            prompt += _PROMPT["tag_pool_intro"] + ", ".join(sample)

    if custom_instructions:
        prompt += _PROMPT["custom_instructions_intro"] + custom_instructions.strip()

    return prompt


# ── Anthropic adapter ────────────────────────────────────────────────────────

def call_anthropic(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    images: list[tuple[str, str]],
    prompt_text: str = "Annotate this image as instructed.",
) -> str:
    """Call Anthropic Messages API with vision (one or more images)."""
    content: list[dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}}
        for (b64, mime) in images
    ]
    content.append({"type": "text", "text": prompt_text})
    body = {
        "model": model,
        "max_tokens": 1024,
        "system": system_prompt,
        "messages": [{"role": "user", "content": content}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Anthropic API HTTP {e.code}: {detail}") from e

    blocks = payload.get("content", [])
    for b in blocks:
        if b.get("type") == "text":
            return b.get("text", "")
    raise RuntimeError(f"Anthropic returned no text block: {payload!r}")


# ── OpenAI-compatible adapter (covers OpenAI + Ollama + custom) ──────────────

def call_openai_compatible(
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    system_prompt: str,
    images: list[tuple[str, str]],
    prompt_text: str = "Annotate this image as instructed.",
) -> str:
    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
        for (b64, mime) in images
    ]
    content.append({"type": "text", "text": prompt_text})
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "max_tokens": 1024,
    }
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    base_url = base_url.rstrip("/")
    url = f"{base_url}/chat/completions"
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI-compatible API HTTP {e.code} at {url}: {detail}") from e
    choices = payload.get("choices", [])
    if not choices:
        raise RuntimeError(f"No choices returned: {payload!r}")
    return choices[0].get("message", {}).get("content", "")


# ── Response parsing ─────────────────────────────────────────────────────────

JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_llm_json(text: str) -> dict[str, Any]:
    """Extract the first {...} JSON object from the model's response."""
    text = text.strip()
    # Strip markdown code fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n", "", text)
        text = re.sub(r"\n```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = JSON_OBJ_RE.search(text)
        if not match:
            raise
        return json.loads(match.group(0))


# ── Tag spellings ────────────────────────────────────────────────────────────

def merge_with_existing_tags(connection: sqlite3.Connection, raw_tags: list[str]) -> list[str]:
    """The library's spelling for each tag (db.tags.TagResolver: alias, the
    library's own case, the vocabulary's other language), duplicates folded.
    Writes nothing."""
    resolver = TagResolver(connection)
    out: list[str] = []
    for raw in raw_tags:
        resolved = resolver.resolve(raw)
        if resolved is not None and resolved.tag not in out:
            out.append(resolved.tag)
    return out


def parse_tags(raw: Any, max_tags: int) -> tuple[list[str], dict[str, str]]:
    """The model's tags as (tags in order, tag → group id). Grouped output
    is an object keyed by group id; a flat array (an older prompt, a model
    that ignored the shape) has no groups. "other" is no group. Capped at
    max_tags over everything."""
    tags: list[str] = []
    groups_of: dict[str, str] = {}

    def take(value: Any, group: str | None) -> None:
        text = str(value).strip() if value is not None else ""
        if not text or text in tags or len(tags) >= max_tags:
            return
        tags.append(text)
        if group and group != "other":
            groups_of[text] = group

    if isinstance(raw, dict):
        for group, values in raw.items():
            if isinstance(values, list):
                for value in values:
                    take(value, str(group))
            elif isinstance(values, str):
                take(values, str(group))
    elif isinstance(raw, list):
        for value in raw:
            take(value, None)
    return tags, groups_of


# ── Top-level annotate entry point ───────────────────────────────────────────

def annotate(
    *,
    image_paths: list[Path],
    provider: str,
    api_key: str | None,
    model: str,
    base_url: str | None = None,
    languages: list[str] | None = None,
    max_tags: int = DEFAULT_MAX_TAGS,
    max_caption_chars: int = DEFAULT_MAX_CAPTION_CHARS,
    custom_instructions: str | None = None,
    existing_tags: list[str] | None = None,
    tag_groups: list[dict[str, Any]] | None = None,
    is_video: bool = False,
    location_hint: str | None = None,
    location_context: dict[str, Any] | None = None,
) -> AnnotationResult:
    """Annotate one asset from one or more frames. Pure: no DB writes.

    Images pass a single frame; videos pass several sampled frames in one
    multi-image call so the caption/tags describe the whole clip.
    """
    languages = languages or ["en", "zh"]
    existing_tags = existing_tags or []
    if not image_paths:
        raise RuntimeError("no frames to annotate")

    images = [encode_image_for_llm(p) for p in image_paths]
    system = build_system_prompt(
        languages=languages,
        max_tags=max_tags,
        max_caption_chars=max_caption_chars,
        existing_tags=existing_tags,
        tag_groups=tag_groups,
        custom_instructions=custom_instructions,
    )
    prompt_text = (
        f"These {len(images)} images are frames sampled in order from a single short video clip. "
        "Describe the clip as a whole and annotate it as instructed."
        if is_video and len(images) > 1
        else "Annotate this image as instructed."
    )
    if location_hint and location_hint.strip():
        # User correction flow ("wrong location? tell the AI"): the hint
        # outranks visual inference for the location fields.
        prompt_text += (
            "\n\nUser correction: this photo was taken at/in: "
            f"{location_hint.strip()}. "
            "Trust this over visual inference when filling the location fields, "
            "and reconsider the caption and tags accordingly."
        )

    if location_context:
        system += (
            "\n\nThis asset has EXIF GPS. The supplied coordinates take priority over visual "
            "guesses and conflicting location hints. Nearby gazetteer names are approximate, "
            "not verified boundaries or landmarks. Keep caption and tags consistent with GPS; "
            "do not invent a specific landmark. Return location: null (the app supplies GPS location)."
        )
        prompt_text += "\n\nEXIF GPS context:\n" + json.dumps(location_context, ensure_ascii=False)

    if provider == "anthropic":
        if not api_key:
            raise RuntimeError("Anthropic provider requires an API key")
        text = call_anthropic(api_key=api_key, model=model, system_prompt=system, images=images, prompt_text=prompt_text)
    elif provider in ("openai", "openai_compatible"):
        url = base_url or "https://api.openai.com/v1"
        text = call_openai_compatible(base_url=url, api_key=api_key, model=model, system_prompt=system, images=images, prompt_text=prompt_text)
    else:
        raise RuntimeError(f"Unsupported provider for annotation: {provider}")

    parsed = parse_llm_json(text)

    caption = str(parsed.get("caption") or "").strip()[:max_caption_chars]
    tags, groups_of = parse_tags(parsed.get("tags"), max_tags)

    location = parsed.get("location")
    if not isinstance(location, dict):
        location = None
    else:
        # Provenance and coordinates are application-owned, never model output.
        location = {key: value for key, value in location.items()
                    if key in {"country", "admin1", "locality", "region", "landmark", "confidence"}}
    if location_context:
        location = dict(location_context)  # Never trust model compliance for location fields.

    detected_text = parsed.get("detected_text")
    if not isinstance(detected_text, str):
        detected_text = None

    return AnnotationResult(
        caption=caption,
        tags=tags,
        tag_groups=groups_of,
        location=location,
        detected_text=detected_text,
        raw_response=text,
        provider=provider,
        model=model,
    )


# ── Persistence ──────────────────────────────────────────────────────────────

def save_annotation(connection: sqlite3.Connection, asset_id: str, result: AnnotationResult) -> dict[str, Any]:
    """Write annotation + tags. Replaces any existing annotation for the asset."""
    now = datetime.now(UTC).isoformat()
    # Each tag in the library's spelling, with a `tags` row. The model's
    # group only places a tag that has none yet, and only into a group the
    # model may fill (ai_fill); a vocabulary tag takes the vocabulary's group.
    fillable = {row[0] for row in connection.execute("SELECT group_id FROM tag_groups WHERE ai_fill = 1")}
    resolver = TagResolver(connection)
    merged_tags: list[str] = []
    for raw in result.tags:
        resolved = resolver.resolve(raw)
        if resolved is None or resolved.tag in merged_tags:
            continue
        suggested = result.tag_groups.get(raw)
        if resolved.is_new and resolved.group_id not in fillable:
            resolved.group_id = None  # a vocabulary concept of a group the model may not fill lands ungrouped
        ensure_tag(connection, resolved, group_id=suggested if suggested in fillable else None, resolver=resolver)
        merged_tags.append(resolved.tag)
    location = asset_gps_location(connection, asset_id) or result.location

    connection.execute(
        """
        INSERT INTO asset_ai_annotations
            (asset_id, provider, model, schema_version, caption, tags_json,
             location_json, detected_text, raw_response, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            schema_version = excluded.schema_version,
            caption = excluded.caption,
            tags_json = excluded.tags_json,
            location_json = excluded.location_json,
            detected_text = excluded.detected_text,
            raw_response = excluded.raw_response,
            updated_at = excluded.updated_at
        """,
        (
            asset_id,
            result.provider,
            result.model,
            ANNOTATION_SCHEMA_VERSION,
            result.caption,
            json.dumps(merged_tags, ensure_ascii=False),
            json.dumps(location, ensure_ascii=False) if location else None,
            result.detected_text,
            result.raw_response,
            now,
            now,
        ),
    )

    # Replace AI-sourced tag rows for this asset (preserve user-source tags).
    connection.execute("DELETE FROM asset_tags WHERE asset_id = ? AND source = 'ai'", (asset_id,))
    for tag in merged_tags:
        connection.execute(
            "INSERT OR IGNORE INTO asset_tags (asset_id, tag, source, created_at) VALUES (?, ?, 'ai', ?)",
            (asset_id, tag, now),
        )

    # Resolve the location guess to map coordinates (offline gazetteer) so the
    # asset appears on the map right after annotation — no separate backfill
    # needed for new annotations. Resolver problems must never break the
    # annotation write itself.
    try:
        if not location or location.get("source") != "exif":
            _sync_ai_location(connection, asset_id, location)
    except Exception:  # noqa: BLE001 — best-effort by design
        pass
    connection.commit()

    return get_annotation(connection, asset_id) or {}


def _sync_ai_location(connection: sqlite3.Connection, asset_id: str, location: dict | None) -> None:
    """Keep asset_locations in step with this annotation's location guess.

    Resolvable → upsert an ai row (never touching manual/exif). Unresolvable →
    drop a stale ai row from a previous annotation run, if any."""
    from .db.locations import delete_asset_location, upsert_ai_asset_location
    from .geo_resolver import RESOLVER_VERSION, resolve_location

    resolved = resolve_location(location)
    if resolved is not None:
        upsert_ai_asset_location(
            connection, asset_id, resolved,
            location=location, resolver_version=RESOLVER_VERSION,
        )
        return
    existing = connection.execute(
        "SELECT source FROM asset_locations WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    if existing is not None and str(existing["source"]) == "ai":
        delete_asset_location(connection, asset_id)


# ── Batch annotation ─────────────────────────────────────────────────────────

def _batch_image_path(catalog_root: Path, row: sqlite3.Row) -> Path:
    """Pick the best on-disk image to send to the LLM for a batch row.

    Prefer a generated preview JPEG (already downsized + sidesteps HEIC/RAW
    decode), falling back to the original canonical file. The LLM encoder
    downsizes again to THUMB_MAX_EDGE either way.
    """
    keys = row.keys() if hasattr(row, "keys") else []
    for rel_key in ("preview_hd_relative_path", "preview_relative_path"):
        rel = row[rel_key] if rel_key in keys else None
        if rel:
            candidate = catalog_root / rel
            if candidate.exists():
                return candidate
    return Path(row["canonical_path"])


def annotate_batch(
    connection: sqlite3.Connection,
    catalog_root: Path,
    assets: Sequence[sqlite3.Row],
    *,
    provider: str,
    api_key: str | None,
    model: str,
    base_url: str | None = None,
    languages: list[str] | None = None,
    max_tags: int = DEFAULT_MAX_TAGS,
    max_caption_chars: int = DEFAULT_MAX_CAPTION_CHARS,
    custom_instructions: str | None = None,
    video_frame_interval: float = 0.0,
    progress_callback: Callable[[dict[str, int]], None] | None = None,
    max_workers: int = 3,
) -> dict[str, Any]:
    """Annotate many assets concurrently.

    Mirrors PreviewService.generate_batch: the network-bound annotate() runs in
    worker threads (no DB access), while every DB write (save_annotation) happens
    on the calling thread as futures complete — keeps the sqlite connection
    single-threaded. Per-asset failures are collected, not fatal.
    """
    total = len(assets)
    succeeded = 0
    failed = 0
    processed = 0
    errors: list[dict[str, str]] = []
    # The tag groups and their reuse hints, fetched once and shared by all workers.
    tag_groups = reuse_hints(connection)
    # Resolve before worker threads start: SQLite stays on the caller thread.
    gps_contexts = {str(row["asset_id"]): asset_gps_location(connection, str(row["asset_id"])) for row in assets}

    def report() -> None:
        if progress_callback:
            progress_callback({
                "processed": processed,
                "total": total,
                "succeeded": succeeded,
                "failed": failed,
            })

    report()
    if total == 0:
        return {"total": 0, "succeeded": 0, "failed": 0, "errors": []}

    def work(row: sqlite3.Row) -> AnnotationResult:
        keys = row.keys() if hasattr(row, "keys") else []
        is_video = "asset_type" in keys and str(row["asset_type"]) == "video"
        tmp_dir: str | None = None
        try:
            if is_video:
                # Sample frames from the original clip (default: first/middle/last)
                # and send them as one multi-image call describing the whole video.
                tmp_dir = tempfile.mkdtemp(prefix="afvframes-")
                interval = video_frame_interval if video_frame_interval and video_frame_interval > 0 else None
                frames = video.frames(Path(row["canonical_path"]), Path(tmp_dir), interval=interval)
                image_paths = [Path(tmp_dir) / f["filename"] for f in frames]
                if not image_paths:  # tool missing / failed → fall back to poster
                    image_paths = [_batch_image_path(catalog_root, row)]
                    is_video = False
            else:
                image_paths = [_batch_image_path(catalog_root, row)]
            return annotate(
                image_paths=image_paths,
                provider=provider,
                api_key=api_key,
                model=model,
                base_url=base_url,
                languages=languages,
                max_tags=max_tags,
                max_caption_chars=max_caption_chars,
                custom_instructions=custom_instructions,
                tag_groups=tag_groups,
                is_video=is_video,
                location_context=gps_contexts[str(row["asset_id"])],
            )
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    # All futures are submitted upfront; if the progress callback raises
    # (cooperative job cancellation) cancel the queued API calls before
    # unwinding so the executor's exit handler doesn't run the whole batch.
    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = {pool.submit(work, row): row for row in assets}
        try:
            for future in as_completed(futures):
                row = futures[future]
                try:
                    result = future.result()
                    save_annotation(connection, str(row["asset_id"]), result)
                    succeeded += 1
                except Exception as exc:  # noqa: BLE001 — one bad asset must not kill the batch
                    failed += 1
                    if len(errors) < 50:
                        errors.append({"asset_id": str(row["asset_id"]), "error": f"{type(exc).__name__}: {exc}"})
                processed += 1
                report()
        except BaseException:
            pool.shutdown(wait=False, cancel_futures=True)
            raise

    return {"total": total, "succeeded": succeeded, "failed": failed, "errors": errors}


def get_annotation(connection: sqlite3.Connection, asset_id: str) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT asset_id, provider, model, schema_version, caption, tags_json,
               location_json, detected_text, created_at, updated_at,
               (SELECT metadata_json FROM assets WHERE assets.asset_id = asset_ai_annotations.asset_id) AS metadata_json
        FROM asset_ai_annotations
        WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "asset_id": row["asset_id"],
        "provider": row["provider"],
        "model": row["model"],
        "schema_version": row["schema_version"],
        "caption": row["caption"],
        # The photo's tags, hand-added and AI alike (asset_tags); ai_tags is
        # what the last annotation run proposed.
        "tags": get_asset_tags(connection, asset_id),
        "ai_tags": json.loads(row["tags_json"] or "[]"),
        "location": effective_location(row["metadata_json"], json.loads(row["location_json"]) if row["location_json"] else None),
        "detected_text": row["detected_text"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def clear_ai_location(connection: sqlite3.Connection, asset_id: str) -> dict[str, Any] | None:
    """User veto of a wrong AI location guess.

    Nulls the annotation's location_json AND drops the resolved AI point —
    both must go, because resolve-ai-locations (the backfill that runs on
    map open) would otherwise re-create the point from location_json.
    Manual/EXIF locations are never touched. Re-annotating the asset can
    produce a fresh guess afterwards.
    """
    from .db.locations import delete_asset_location

    row = connection.execute(
        "SELECT source FROM asset_locations WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    if row is not None and str(row["source"]) == "ai":
        delete_asset_location(connection, asset_id)
    connection.execute(
        "UPDATE asset_ai_annotations SET location_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?",
        (asset_id,),
    )
    connection.commit()
    return get_annotation(connection, asset_id)


# ── Provider health checks + model listing ───────────────────────────────────

ANTHROPIC_MODELS = ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"]


def test_connection(*, provider: str, api_key: str | None, base_url: str | None = None) -> dict[str, Any]:
    """Send a minimal request to verify reachability + auth. Returns {ok, error?, info?}."""
    try:
        if provider == "anthropic":
            if not api_key:
                return {"ok": False, "error": "API key required for Anthropic."}
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=json.dumps({
                    "model": "claude-haiku-4-5",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "hi"}],
                }).encode("utf-8"),
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
            return {"ok": True, "info": "Reachable, key accepted."}
        elif provider in ("openai", "openai_compatible"):
            count = len(fetch_openai_model_ids(api_key, base_url))
            return {"ok": True, "info": f"Reachable. Endpoint exposes {count} models."}
        else:
            return {"ok": False, "error": f"Unsupported provider: {provider}"}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return {"ok": False, "error": f"HTTP {e.code}: {detail[:200] or e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"Cannot reach endpoint: {e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def list_models(*, provider: str, api_key: str | None, base_url: str | None = None) -> list[dict[str, str]]:
    """Return [{id, label}] for the provider. Local providers proxy /v1/models."""
    if provider == "anthropic":
        # Anthropic has no public list-models endpoint — use a curated set.
        return [{"id": m, "label": m} for m in ANTHROPIC_MODELS]

    if provider in ("openai", "openai_compatible"):
        return [{"id": mid, "label": mid} for mid in sorted(fetch_openai_model_ids(api_key, base_url, timeout=20))]

    raise RuntimeError(f"Unsupported provider for list_models: {provider}")
