"""One photo in full: the payload behind `asset-detail`, what the lightbox
and the Inspector show. The row comes from browse.py; this adds what hangs
off it (colours, people, duplicates, the version stack, collages) and turns
relative preview paths into absolute ones.

Its own module because it reads from assets, browse, colors and people at
once; browse.py cannot import assets.py (locations.py sits between them).
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from .assets import get_duplicate_assets, list_collage_sources, list_collages_using_asset
from .browse import (
    description_fields,
    get_image_asset_detail,
    get_image_asset_detail_by_path,
    list_version_siblings,
    row_tags,
)
from .colors import get_asset_colors
from .people import get_asset_people


def _preview_path(catalog_root: Path, relative: str | None) -> str | None:
    return str((catalog_root / relative).resolve()) if relative else None


def _related(catalog_root: Path, row: sqlite3.Row, asset_id_key: str) -> dict[str, Any]:
    return {
        "asset_id": row[asset_id_key],
        "stem": row["stem"],
        "image_path": row["image_path"],
        "preview_path": _preview_path(catalog_root, row["preview_relative_path"]),
    }


def asset_detail(
    connection: sqlite3.Connection,
    catalog_root: Path,
    *,
    asset_id: str | None = None,
    image_path: str | None = None,
) -> dict[str, Any] | None:
    """The detail payload for the asset with `asset_id`, or the one registered
    under `image_path`; None when there is no such photo."""
    if image_path:
        row = get_image_asset_detail_by_path(connection, image_path)
    else:
        row = get_image_asset_detail(connection, str(asset_id))
    if row is None:
        return None
    asset_id = str(row["asset_id"])
    set_id = row["resource_set_id"]
    # Read-only live stat (as browse does) — no write-back on this path.
    present = os.path.exists(row["image_path"]) if row["image_path"] else True
    return {
        "asset_id": asset_id,
        "asset_type": row["asset_type"],
        "stem": row["stem"],
        "image_path": row["image_path"],
        "image_metadata": json.loads(row["image_metadata_json"] or "{}"),
        "app_rating": row["app_rating"],
        "app_flag": row["app_flag"],
        "display_shape": row["display_shape"] or None,
        "tags": row_tags(row),
        **description_fields(row),
        "exists_on_disk": present,
        "imported_at": row["imported_at"],
        "match_status": row["match_status"],
        "score": row["score"],
        "raw_asset_id": row["raw_asset_id"],
        "raw_path": row["raw_path"],
        "raw_metadata": json.loads(row["raw_metadata_json"] or "{}") if row["raw_metadata_json"] else {},
        "feature_vector": json.loads(row["feature_vector_json"] or "{}"),
        "candidates": json.loads(row["candidate_json"] or "[]"),
        "colors": get_asset_colors(connection, asset_id),
        "image_preview_path": _preview_path(catalog_root, row["image_preview_relative_path"]),
        "raw_preview_path": _preview_path(catalog_root, row["raw_preview_relative_path"]),
        "image_preview_hd_path": _preview_path(catalog_root, row["image_preview_hd_relative_path"]),
        "resource_set_id": set_id,
        "resource_role": row["resource_role"],
        "version_kind": row["version_kind"],
        "resource_sort_order": row["resource_sort_order"],
        "set_primary_asset_id": row["set_primary_asset_id"],
        "set_raw_asset_id": row["set_raw_asset_id"],
        "primary_stem": row["primary_stem"],
        "set_item_count": row["set_item_count"],
        "duplicates": [
            {"asset_id": d["asset_id"], "image_path": d["image_path"], "stem": d["stem"]}
            for d in get_duplicate_assets(connection, asset_id)
        ],
        "people": get_asset_people(connection, asset_id=asset_id),
        # A RAW imported as a photo is in the gallery; a RAW source folder's
        # RAWs are not. Only the first can be opened from its export's Inspector.
        "raw_in_library": bool(row["raw_asset_id"]) and connection.execute(
            "SELECT 1 FROM image_lookup_registry WHERE image_asset_id = ? LIMIT 1",
            (row["raw_asset_id"],),
        ).fetchone() is not None,
        "version_siblings": [
            {
                "asset_id": s["asset_id"],
                "role": s["role"],
                "version_kind": s["version_kind"],
                "stem": s["stem"],
                "image_path": s["image_path"],
                "preview_path": _preview_path(catalog_root, s["preview_relative_path"]),
            }
            for s in (list_version_siblings(connection, set_id, asset_id) if set_id else [])
        ],
        "collage_sources": [_related(catalog_root, s, "source_asset_id") for s in list_collage_sources(connection, asset_id)],
        "used_in_collages": [_related(catalog_root, s, "collage_asset_id") for s in list_collages_using_asset(connection, asset_id)],
    }
