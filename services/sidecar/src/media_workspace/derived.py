"""Derived-version operations callable without the UI.

- register_export_file: file on disk → catalog asset, RAW binding inherited
  from its origin, attached to the origin's resource set as a derived version,
  previews generated. Shared by quick-register (editor exports) and
  create-derived (agent/CLI crops).
- create_derived_crop: crop an existing export to an aspect ratio, write the
  result into the catalog's derived/ dir and register it.
- export_assets_to_dir: copy/resize/transcode assets into a destination folder
  (no catalog writes).
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Optional
from uuid import uuid4

from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps

from .catalog import CatalogPaths
from .config import Thresholds
from .db import (
    attach_asset_to_resource_set,
    upsert_export_asset,
    upsert_preview_entry,
    upsert_registry,
)
from .metadata import extract_export_candidate
from .models import MatchDecision
from .preview_service import PreviewService
from .reverse_lookup import resolve_export

# Formats Pillow reads + writes losslessly enough for crop/export. HEIC and
# RAW are out of scope here — exports in those formats are rare.
SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}

PIL_FORMAT_BY_NAME = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}
EXT_BY_FORMAT = {"jpeg": ".jpg", "png": ".png", "webp": ".webp"}


def parse_ratio(value: str) -> tuple[float, float]:
    """'4:3' / '16:9' / '1:1' → (w, h). Raises ValueError on junk."""
    parts = str(value).replace("x", ":").split(":")
    if len(parts) != 2:
        raise ValueError(f"invalid ratio {value!r}; expected like '4:3'")
    w, h = float(parts[0]), float(parts[1])
    if w <= 0 or h <= 0:
        raise ValueError(f"invalid ratio {value!r}; sides must be positive")
    return w, h


def _crop_box(width: int, height: int, ratio_w: float, ratio_h: float, gravity: str) -> tuple[int, int, int, int]:
    target = ratio_w / ratio_h
    current = width / height
    if abs(current - target) < 1e-6:
        return (0, 0, width, height)
    if current > target:
        crop_w, crop_h = round(height * target), height
    else:
        crop_w, crop_h = width, round(width / target)
    x0 = (width - crop_w) // 2
    y0 = (height - crop_h) // 2
    if gravity == "top":
        y0 = 0
    elif gravity == "bottom":
        y0 = height - crop_h
    elif gravity == "left":
        x0 = 0
    elif gravity == "right":
        x0 = width - crop_w
    return (x0, y0, x0 + crop_w, y0 + crop_h)


def _save_image(image: Image.Image, dest: Path, *, exif_bytes: Optional[bytes], quality: int) -> None:
    suffix = dest.suffix.lower()
    kwargs: dict = {}
    if exif_bytes:
        kwargs["exif"] = exif_bytes
    if suffix in (".jpg", ".jpeg"):
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        kwargs.update(quality=quality, subsampling=1, optimize=True)
    elif suffix == ".webp":
        kwargs.update(quality=quality)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, **kwargs)


def crop_image_to_ratio(src: Path, dest: Path, ratio: str, gravity: str = "center", quality: int = 95) -> dict:
    ratio_w, ratio_h = parse_ratio(ratio)
    with Image.open(src) as im:
        # Normalize pixel orientation; exif_transpose strips the Orientation
        # tag from the copy's EXIF so re-embedding it is safe.
        im = ImageOps.exif_transpose(im)
        exif_bytes = im.info.get("exif")
        box = _crop_box(im.width, im.height, ratio_w, ratio_h, gravity)
        cropped = im.crop(box)
        _save_image(cropped, dest, exif_bytes=exif_bytes, quality=quality)
        return {"width": cropped.width, "height": cropped.height, "box": list(box)}


def register_export_file(
    connection,
    catalog: CatalogPaths,
    export_path: Path,
    origin_path: Optional[Path] = None,
    collage_source_ids: Optional[list[str]] = None,
) -> dict:
    """Register a finished file as an export asset (ported from quick-register).

    Inherits the RAW binding from origin_path when given (skipping the
    matcher), attaches the asset to the origin's resource set as a derived
    version, and generates both preview sizes.
    """
    export_path = export_path.resolve()
    candidate = extract_export_candidate(export_path, fingerprint_mode="head-only")
    asset_id = upsert_export_asset(connection, candidate, commit=True)
    origin_asset_id = None

    match_status = "unmatched"
    match_score = 0.0
    raw_asset_id = None
    if origin_path:
        origin = str(origin_path.resolve())
        origin_asset_row = connection.execute(
            "SELECT asset_id FROM asset_files WHERE path = ?",
            (origin,),
        ).fetchone()
        origin_asset_id = str(origin_asset_row["asset_id"]) if origin_asset_row else None
        origin_row = connection.execute(
            """
            SELECT registry.raw_asset_id, registry.score
            FROM asset_files
            JOIN export_lookup_registry AS registry ON registry.export_asset_id = asset_files.asset_id
            WHERE asset_files.path = ?
              AND registry.raw_asset_id IS NOT NULL
            """,
            (origin,),
        ).fetchone()
        if origin_row:
            raw_asset_id = origin_row[0]
            match_score = origin_row[1] or 1.0
            match_status = "auto_bound"

    if not raw_asset_id:
        thresholds = Thresholds()
        decision = resolve_export(connection, export_path, thresholds=thresholds, refresh=True)
        match_status = decision.status
        match_score = decision.score
        raw_asset_id = decision.raw_asset_id
    else:
        reg_decision = MatchDecision(
            export_asset_id=asset_id,
            export_path=export_path,
            status=match_status,
            score=match_score,
            raw_asset_id=raw_asset_id,
            feature_vector={},
        )
        upsert_registry(connection, reg_decision, commit=True)

    collage_source_ids = collage_source_ids or []
    if collage_source_ids:
        # Collage gets its own resource set, not joined to any source's set
        attach_asset_to_resource_set(
            connection,
            asset_id,
            origin_asset_id=None,
            version_kind="import",
            commit=True,
        )
    else:
        attach_asset_to_resource_set(
            connection,
            asset_id,
            origin_asset_id=origin_asset_id,
            version_kind="derived" if origin_asset_id else "import",
            commit=True,
        )

    preview_service = PreviewService(catalog)
    row = connection.execute(
        """
        SELECT asset_id, asset_type, canonical_path, extension,
               json_extract(metadata_json, '$.width') AS width,
               json_extract(metadata_json, '$.height') AS height
        FROM assets WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchone()
    if row:
        try:
            preview_result = preview_service.generate_for_row(row, kind="preview", force=False)
            upsert_preview_entry(connection, asset_id, "preview", preview_result.relative_path, preview_result.width, preview_result.height, preview_result.status)
            preview_hd_result = preview_service.generate_for_row(row, kind="preview-hd", force=False)
            upsert_preview_entry(connection, asset_id, "preview-hd", preview_hd_result.relative_path, preview_hd_result.width, preview_hd_result.height, preview_hd_result.status)
            connection.commit()
        except Exception as e:
            print(f"Warning: preview generation failed: {e}", file=sys.stderr)

    if collage_source_ids:
        for idx, source_id in enumerate(collage_source_ids):
            connection.execute(
                """
                INSERT INTO asset_links (link_id, parent_asset_id, child_asset_id, relation_type, recipe_json, confidence)
                VALUES (?, ?, ?, 'collage_source', ?, 1.0)
                ON CONFLICT(parent_asset_id, child_asset_id, relation_type) DO NOTHING
                """,
                (str(uuid4()), asset_id, source_id, json.dumps({"sort_order": idx})),
            )
        connection.commit()

    return {
        "asset_id": asset_id,
        "export_path": str(export_path),
        "match_status": match_status,
        "score": match_score,
        "raw_asset_id": raw_asset_id,
    }


def _asset_canonical_path(connection, asset_id: str) -> tuple[str, Path]:
    row = connection.execute(
        "SELECT stem, canonical_path FROM assets WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"unknown asset: {asset_id}")
    path = Path(row["canonical_path"])
    if not path.exists():
        raise ValueError(f"source file missing on disk: {path}")
    return row["stem"], path


def create_derived_crop(connection, catalog: CatalogPaths, asset_id: str, ratio: str, gravity: str = "center") -> dict:
    stem, src = _asset_canonical_path(connection, asset_id)
    if src.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
        raise ValueError(f"unsupported source format for crop: {src.suffix}")
    ratio_label = ratio.replace(":", "x")
    dest = catalog.derived_dir / f"{stem}_crop{ratio_label}_{uuid4().hex[:8]}{src.suffix.lower()}"
    crop_info = crop_image_to_ratio(src, dest, ratio, gravity=gravity)
    payload = register_export_file(connection, catalog, dest, origin_path=src)
    payload.update(
        source_asset_id=asset_id,
        crop_ratio=ratio,
        gravity=gravity,
        width=crop_info["width"],
        height=crop_info["height"],
    )
    return payload


# Default font chain: CJK-capable faces first so Chinese captions just work.
FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _resolve_font(font_path: Optional[str], size: int) -> ImageFont.FreeTypeFont:
    candidates = [font_path] if font_path else FONT_CANDIDATES
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    raise ValueError("no usable font found; pass --font-path")


def _rgba(color: str, opacity: float) -> tuple[int, int, int, int]:
    rgb = ImageColor.getrgb(color)
    alpha = round(255 * max(0.0, min(1.0, opacity)))
    if len(rgb) == 4:
        alpha = round(rgb[3] * max(0.0, min(1.0, opacity)))
        rgb = rgb[:3]
    return (*rgb, alpha)


def render_text_overlay(
    src: Path,
    dest: Path,
    *,
    text: str,
    x: float = 0.5,
    y: float = 0.9,
    size: float = 0.05,
    color: str = "#FFFFFF",
    stroke_color: Optional[str] = "#000000",
    stroke_width: Optional[int] = None,
    opacity: float = 1.0,
    align: str = "center",
    font_path: Optional[str] = None,
    quality: int = 95,
) -> dict:
    """Draw text onto a copy of the image. (x, y) are normalized 0-1 coords of
    the text block CENTER; size is the font height as a fraction of image
    height. Returns the drawn geometry so callers can reason about placement.
    """
    if not text or not text.strip():
        raise ValueError("text is empty")
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        exif_bytes = im.info.get("exif")
        base = im.convert("RGBA")
        overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        font_size = max(8, round(size * base.height))
        font = _resolve_font(font_path, font_size)
        stroke = stroke_width if stroke_width is not None else max(1, round(font_size * 0.05))
        if not stroke_color:
            stroke = 0
        # Anchor manually via bbox — multiline anchor support varies by Pillow.
        bbox = draw.multiline_textbbox((0, 0), text, font=font, stroke_width=stroke, align=align)
        text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        px = round(x * base.width - text_w / 2 - bbox[0])
        py = round(y * base.height - text_h / 2 - bbox[1])
        draw.multiline_text(
            (px, py),
            text,
            font=font,
            fill=_rgba(color, opacity),
            align=align,
            stroke_width=stroke,
            stroke_fill=_rgba(stroke_color, opacity) if stroke else None,
        )
        out = Image.alpha_composite(base, overlay)
        if dest.suffix.lower() in (".jpg", ".jpeg"):
            out = out.convert("RGB")
        _save_image(out, dest, exif_bytes=exif_bytes, quality=quality)
        return {
            "width": out.width,
            "height": out.height,
            "font_size": font_size,
            "text_box": [px + bbox[0], py + bbox[1], px + bbox[0] + text_w, py + bbox[1] + text_h],
        }


def create_derived_text(connection, catalog: CatalogPaths, asset_id: str, output: Optional[Path] = None, **opts) -> dict:
    """Render text onto an asset. With output: render only (preview, no catalog
    writes). Without: write into derived/ and register as a derived version.
    """
    stem, src = _asset_canonical_path(connection, asset_id)
    if src.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
        raise ValueError(f"unsupported source format for text overlay: {src.suffix}")
    if output is not None:
        info = render_text_overlay(src, output, **opts)
        return {"path": str(output), "registered": False, **info}
    dest = catalog.derived_dir / f"{stem}_text_{uuid4().hex[:8]}{src.suffix.lower()}"
    info = render_text_overlay(src, dest, **opts)
    payload = register_export_file(connection, catalog, dest, origin_path=src)
    payload.update(source_asset_id=asset_id, registered=True, **info)
    return payload


def _unique_dest(dest_dir: Path, stem: str, suffix: str) -> Path:
    candidate = dest_dir / f"{stem}{suffix}"
    counter = 1
    while candidate.exists():
        candidate = dest_dir / f"{stem}-{counter}{suffix}"
        counter += 1
    return candidate


def export_assets_to_dir(
    connection,
    asset_ids: list[str],
    dest_dir: Path,
    max_edge: Optional[int] = None,
    fmt: Optional[str] = None,
    quality: int = 90,
) -> list[dict]:
    """Copy assets out of the library, optionally resizing/transcoding.

    Pure file operation — writes nothing to the catalog.
    """
    dest_dir = dest_dir.expanduser().resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)
    if fmt and fmt not in PIL_FORMAT_BY_NAME:
        raise ValueError(f"unsupported format: {fmt}")
    results = []
    for asset_id in asset_ids:
        try:
            stem, src = _asset_canonical_path(connection, asset_id)
            needs_pixels = bool(max_edge) or bool(fmt and EXT_BY_FORMAT[fmt] != src.suffix.lower())
            if not needs_pixels:
                dest = _unique_dest(dest_dir, stem, src.suffix.lower())
                shutil.copy2(src, dest)
                results.append({"asset_id": asset_id, "path": str(dest), "resized": False})
                continue
            if src.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
                raise ValueError(f"unsupported source format: {src.suffix}")
            suffix = EXT_BY_FORMAT[fmt] if fmt else src.suffix.lower()
            dest = _unique_dest(dest_dir, stem, suffix)
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im)
                exif_bytes = im.info.get("exif")
                if max_edge and max(im.size) > max_edge:
                    im.thumbnail((max_edge, max_edge), Image.LANCZOS)
                _save_image(im, dest, exif_bytes=exif_bytes, quality=quality)
                results.append({
                    "asset_id": asset_id,
                    "path": str(dest),
                    "resized": True,
                    "width": im.width,
                    "height": im.height,
                })
        except Exception as e:
            results.append({"asset_id": asset_id, "error": str(e)})
    return results
