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
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

import urllib.request
import urllib.error

from . import video

try:
    from PIL import Image  # noqa: F401 — needed for image preprocessing
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Pillow is required for annotation. Install: pip install Pillow") from exc

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()  # lets PIL.Image.open handle HEIC/HEIF
except ImportError:  # pragma: no cover — HEIC support is optional
    pass


# ── Constants ────────────────────────────────────────────────────────────────

THUMB_MAX_EDGE = 512
JPEG_QUALITY = 85
HTTP_TIMEOUT = 60
DEFAULT_MAX_TAGS = 10
DEFAULT_MAX_CAPTION_CHARS = 200
# v2: location gained structured admin1/locality (v1 had a fuzzy "region").
# The offline geo resolver reads both shapes.
ANNOTATION_SCHEMA_VERSION = 2

# How many existing tags to inject into the prompt as "prefer these"
TAG_REUSE_HINT_LIMIT = 200


# ── Result type ──────────────────────────────────────────────────────────────

@dataclass
class AnnotationResult:
    caption: str
    tags: list[str]
    location: Optional[dict[str, Any]]  # v2: {"country", "admin1", "locality", "landmark", "confidence"}
    detected_text: Optional[str]
    raw_response: str
    provider: str
    model: str


# ── Image preprocessing ──────────────────────────────────────────────────────

def encode_image_for_llm(image_path: Path, max_edge: int = THUMB_MAX_EDGE) -> tuple[str, str]:
    """Resize, strip EXIF, JPEG-encode, base64. Returns (b64_data, mime_type)."""
    img = Image.open(image_path)
    img = img.convert("RGB")  # strips alpha + drops most EXIF
    w, h = img.size
    if max(w, h) > max_edge:
        scale = max_edge / max(w, h)
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
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
    existing_tags: list[str],
    custom_instructions: Optional[str],
) -> str:
    lang_clause = (
        "Generate tags in BOTH English and 中文 (each tag in only one language, never mixed)."
        if "en" in languages and "zh" in languages
        else "Generate tags in English." if "en" in languages
        else "Generate tags in 中文 (Simplified Chinese)."
    )

    tag_pool = ""
    if existing_tags:
        sample = filter_tags_by_language(existing_tags, languages)[:TAG_REUSE_HINT_LIMIT]
        if sample:
            tag_pool = (
                "\n\nThis library already uses these tags. PREFER reusing them when "
                "they fit; only invent a new tag if no existing one matches:\n"
                + ", ".join(sample)
            )

    extra = f"\n\nAdditional instructions from the user:\n{custom_instructions.strip()}" if custom_instructions else ""

    return f"""You are an image annotator for a photo management app. Look at the image and produce a JSON object with:

- "caption": one or two sentences describing the photo. Max {max_caption_chars} characters.
- "tags": an array of up to {max_tags} short tags. {lang_clause} Lowercase. No leading hashes.
- "location": an object {{"country": str|null, "admin1": str|null, "locality": str|null, "landmark": str|null, "confidence": 0..100}} guessing where the photo was taken. "country" is the English country name; "admin1" is the first-level division (state/province/canton, e.g. "California", "Île-de-France"); "locality" is the city/town (e.g. "San Francisco", "Grindelwald"); "landmark" is a single specific place or building if clearly identifiable (e.g. "Eiffel Tower") — one name only, no descriptions like "X skyline", no combined "A / B". Use null for any field you are not reasonably sure about. Confidence is your overall confidence in the guess.
- "detected_text": any prominent text visible in the image (signs, labels, captions), or null.

Respond with ONLY the JSON object, no commentary.{tag_pool}{extra}"""


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
    api_key: Optional[str],
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


# ── Tag fuzzy-merge ──────────────────────────────────────────────────────────

def normalize_tag(tag: str) -> str:
    """Lowercase, strip, collapse whitespace. Used as the equality key."""
    return re.sub(r"\s+", " ", tag.lower().strip())


def merge_with_existing_tags(connection: sqlite3.Connection, raw_tags: list[str]) -> list[str]:
    """Map LLM tags to existing-library tags where possible.

    Strategy: case-insensitive exact match first. If no hit, return as-is.
    Levenshtein/stem-based fuzzy is intentionally NOT implemented in v1 — exact
    match plus the "prefer these" prompt hint covers the common cases without
    surprise rewrites.
    """
    rows = connection.execute("SELECT tag FROM asset_tags GROUP BY tag").fetchall()
    by_norm = {normalize_tag(r["tag"]): r["tag"] for r in rows}
    out: list[str] = []
    seen: set[str] = set()
    for raw in raw_tags:
        norm = normalize_tag(raw)
        if not norm:
            continue
        canonical = by_norm.get(norm, raw.strip())
        if canonical in seen:
            continue
        seen.add(canonical)
        out.append(canonical)
    return out


# ── Top-level annotate entry point ───────────────────────────────────────────

def annotate(
    *,
    image_paths: list[Path],
    provider: str,
    api_key: Optional[str],
    model: str,
    base_url: Optional[str] = None,
    languages: Optional[list[str]] = None,
    max_tags: int = DEFAULT_MAX_TAGS,
    max_caption_chars: int = DEFAULT_MAX_CAPTION_CHARS,
    custom_instructions: Optional[str] = None,
    existing_tags: Optional[list[str]] = None,
    is_video: bool = False,
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
        custom_instructions=custom_instructions,
    )
    prompt_text = (
        f"These {len(images)} images are frames sampled in order from a single short video clip. "
        "Describe the clip as a whole and annotate it as instructed."
        if is_video and len(images) > 1
        else "Annotate this image as instructed."
    )

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
    raw_tags = parsed.get("tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = [str(t).strip() for t in raw_tags if str(t).strip()][:max_tags]

    location = parsed.get("location")
    if not isinstance(location, dict):
        location = None

    detected_text = parsed.get("detected_text")
    if not isinstance(detected_text, str):
        detected_text = None

    return AnnotationResult(
        caption=caption,
        tags=tags,
        location=location,
        detected_text=detected_text,
        raw_response=text,
        provider=provider,
        model=model,
    )


# ── Persistence ──────────────────────────────────────────────────────────────

def save_annotation(connection: sqlite3.Connection, asset_id: str, result: AnnotationResult) -> dict[str, Any]:
    """Write annotation + tags. Replaces any existing annotation for the asset."""
    now = datetime.now(timezone.utc).isoformat()
    merged_tags = merge_with_existing_tags(connection, result.tags)

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
            json.dumps(result.location, ensure_ascii=False) if result.location else None,
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
        _sync_ai_location(connection, asset_id, result.location)
    except Exception:  # noqa: BLE001 — best-effort by design
        pass
    connection.commit()

    return get_annotation(connection, asset_id) or {}


def _sync_ai_location(connection: sqlite3.Connection, asset_id: str, location: Optional[dict]) -> None:
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
    api_key: Optional[str],
    model: str,
    base_url: Optional[str] = None,
    languages: Optional[list[str]] = None,
    max_tags: int = DEFAULT_MAX_TAGS,
    max_caption_chars: int = DEFAULT_MAX_CAPTION_CHARS,
    custom_instructions: Optional[str] = None,
    video_frame_interval: float = 0.0,
    progress_callback: Optional[Callable[[dict[str, int]], None]] = None,
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
    # Fetch the tag-reuse hint once and share it across all workers.
    existing_tags = list_top_tags(connection)

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
                existing_tags=existing_tags,
                is_video=is_video,
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


def get_annotation(connection: sqlite3.Connection, asset_id: str) -> Optional[dict[str, Any]]:
    row = connection.execute(
        """
        SELECT asset_id, provider, model, schema_version, caption, tags_json,
               location_json, detected_text, created_at, updated_at
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
        "tags": json.loads(row["tags_json"] or "[]"),
        "location": json.loads(row["location_json"]) if row["location_json"] else None,
        "detected_text": row["detected_text"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def add_asset_tag(connection: sqlite3.Connection, asset_id: str, tag: str, *, source: str = "user", commit: bool = True) -> Optional[dict[str, Any]]:
    """Manually add a tag to an asset. Keeps tags_json (display) and asset_tags
    (search/filter) in sync. Creates a minimal annotation row if none exists."""
    tag = (tag or "").strip()
    if not tag:
        return get_annotation(connection, asset_id)
    now = datetime.now(timezone.utc).isoformat()
    norm = normalize_tag(tag)
    connection.execute(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag, source, created_at) VALUES (?, ?, ?, ?)",
        (asset_id, tag, source, now),
    )
    row = connection.execute("SELECT tags_json FROM asset_ai_annotations WHERE asset_id = ?", (asset_id,)).fetchone()
    if row is not None:
        tags = json.loads(row["tags_json"] or "[]")
        if norm not in {normalize_tag(t) for t in tags}:
            tags.append(tag)
            connection.execute(
                "UPDATE asset_ai_annotations SET tags_json = ?, updated_at = ? WHERE asset_id = ?",
                (json.dumps(tags, ensure_ascii=False), now, asset_id),
            )
    else:
        connection.execute(
            """
            INSERT INTO asset_ai_annotations
                (asset_id, provider, model, schema_version, caption, tags_json,
                 location_json, detected_text, raw_response, created_at, updated_at)
            VALUES (?, 'user', 'manual', ?, '', ?, NULL, NULL, NULL, ?, ?)
            """,
            (asset_id, ANNOTATION_SCHEMA_VERSION, json.dumps([tag], ensure_ascii=False), now, now),
        )
    if commit:
        connection.commit()
    return get_annotation(connection, asset_id)


def remove_asset_tag(connection: sqlite3.Connection, asset_id: str, tag: str, *, commit: bool = True) -> Optional[dict[str, Any]]:
    """Remove a tag from an asset (both tags_json and asset_tags)."""
    tag = (tag or "").strip()
    if not tag:
        return get_annotation(connection, asset_id)
    norm = normalize_tag(tag)
    connection.execute(
        "DELETE FROM asset_tags WHERE asset_id = ? AND LOWER(TRIM(tag)) = ?",
        (asset_id, norm),
    )
    row = connection.execute("SELECT tags_json FROM asset_ai_annotations WHERE asset_id = ?", (asset_id,)).fetchone()
    if row is not None:
        tags = [t for t in json.loads(row["tags_json"] or "[]") if normalize_tag(t) != norm]
        connection.execute(
            "UPDATE asset_ai_annotations SET tags_json = ?, updated_at = ? WHERE asset_id = ?",
            (json.dumps(tags, ensure_ascii=False), datetime.now(timezone.utc).isoformat(), asset_id),
        )
    if commit:
        connection.commit()
    return get_annotation(connection, asset_id)


def list_top_tags(connection: sqlite3.Connection, limit: int = TAG_REUSE_HINT_LIMIT) -> list[str]:
    """Most-used tags first, for prompt reuse hints."""
    rows = connection.execute(
        "SELECT tag, COUNT(*) AS uses FROM asset_tags GROUP BY tag ORDER BY uses DESC, tag ASC LIMIT ?",
        (limit,),
    ).fetchall()
    return [r["tag"] for r in rows]


# ── Provider health checks + model listing ───────────────────────────────────

ANTHROPIC_MODELS = ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"]


def test_connection(*, provider: str, api_key: Optional[str], base_url: Optional[str] = None) -> dict[str, Any]:
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
            url = (base_url or "https://api.openai.com/v1").rstrip("/") + "/models"
            headers = {}
            if api_key:
                headers["authorization"] = f"Bearer {api_key}"
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            count = len(payload.get("data") or [])
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


def list_models(*, provider: str, api_key: Optional[str], base_url: Optional[str] = None) -> list[dict[str, str]]:
    """Return [{id, label}] for the provider. Local providers proxy /v1/models."""
    if provider == "anthropic":
        # Anthropic has no public list-models endpoint — use a curated set.
        return [{"id": m, "label": m} for m in ANTHROPIC_MODELS]

    if provider in ("openai", "openai_compatible"):
        url = (base_url or "https://api.openai.com/v1").rstrip("/") + "/models"
        headers = {}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        out: list[dict[str, str]] = []
        for entry in payload.get("data") or []:
            mid = entry.get("id")
            if not mid:
                continue
            out.append({"id": mid, "label": mid})
        out.sort(key=lambda m: m["id"])
        return out

    raise RuntimeError(f"Unsupported provider for list_models: {provider}")
