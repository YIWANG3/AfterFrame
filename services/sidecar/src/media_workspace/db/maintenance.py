"""Cleanup/delete/summary — mutating maintenance passes.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import os
import sqlite3
from hashlib import sha1
from pathlib import Path
from uuid import uuid4

from ..models import ExportCandidate, MatchDecision, RawMetadata

# Sentinel: distinguishes "don't touch error_text" from "clear it" in update_job.
_UNSET = object()
from ..schema import SCHEMA_STATEMENTS

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"
SCHEMA_VERSION = 5

from .assets import upsert_preview_entry
from .resource_sets import _link_id, get_resource_set_for_asset

def cleanup_orphan_export_assets(connection: sqlite3.Connection, commit: bool = True) -> dict[str, int]:
    orphan_rows = connection.execute(
        """
        SELECT orphan.asset_id AS orphan_asset_id, active.asset_id AS active_asset_id
        FROM assets AS orphan
        JOIN assets AS active
            ON active.asset_type = 'export'
           AND active.canonical_path = orphan.canonical_path
        JOIN asset_files AS active_files
            ON active_files.asset_id = active.asset_id
           AND active_files.path = active.canonical_path
        LEFT JOIN asset_files AS orphan_files
            ON orphan_files.asset_id = orphan.asset_id
        WHERE orphan.asset_type = 'export'
          AND orphan.asset_id != active.asset_id
          AND orphan_files.asset_id IS NULL
        ORDER BY orphan.canonical_path, orphan.asset_id
        """
    ).fetchall()
    metrics = {
        "found": len(orphan_rows),
        "deleted": 0,
        "previews_migrated": 0,
        "registry_relinked": 0,
        "links_relinked": 0,
    }

    for row in orphan_rows:
        orphan_asset_id = str(row["orphan_asset_id"])
        active_asset_id = str(row["active_asset_id"])

        preview_rows = connection.execute(
            """
            SELECT kind, relative_path, width, height, status
            FROM preview_entries
            WHERE asset_id = ?
            """,
            (orphan_asset_id,),
        ).fetchall()
        for preview in preview_rows:
            upsert_preview_entry(
                connection,
                active_asset_id,
                kind=str(preview["kind"]),
                relative_path=str(preview["relative_path"]),
                width=preview["width"],
                height=preview["height"],
                status=str(preview["status"]),
                commit=False,
            )
            metrics["previews_migrated"] += 1
        connection.execute("DELETE FROM preview_entries WHERE asset_id = ?", (orphan_asset_id,))

        metrics["registry_relinked"] += connection.execute(
            """
            UPDATE export_lookup_registry
            SET export_asset_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE export_asset_id = ?
            """,
            (active_asset_id, orphan_asset_id),
        ).rowcount

        link_rows = connection.execute(
            """
            SELECT link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
                   confidence, confirmed_by, confirmed_at
            FROM asset_links
            WHERE parent_asset_id = ? OR child_asset_id = ?
            """,
            (orphan_asset_id, orphan_asset_id),
        ).fetchall()
        for link in link_rows:
            parent_asset_id = active_asset_id if link["parent_asset_id"] == orphan_asset_id else str(link["parent_asset_id"])
            child_asset_id = active_asset_id if link["child_asset_id"] == orphan_asset_id else str(link["child_asset_id"])
            if parent_asset_id == child_asset_id:
                continue
            connection.execute(
                """
                INSERT INTO asset_links (
                    link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
                    confidence, confirmed_by, confirmed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(parent_asset_id, child_asset_id, relation_type) DO UPDATE SET
                    recipe_json = excluded.recipe_json,
                    confidence = excluded.confidence,
                    confirmed_by = excluded.confirmed_by,
                    confirmed_at = COALESCE(asset_links.confirmed_at, excluded.confirmed_at)
                """,
                (
                    _link_id(parent_asset_id, child_asset_id, str(link["relation_type"])),
                    parent_asset_id,
                    child_asset_id,
                    str(link["relation_type"]),
                    str(link["recipe_json"]),
                    float(link["confidence"]),
                    link["confirmed_by"],
                    link["confirmed_at"],
                ),
            )
            metrics["links_relinked"] += 1
        connection.execute(
            "DELETE FROM asset_links WHERE parent_asset_id = ? OR child_asset_id = ?",
            (orphan_asset_id, orphan_asset_id),
        )

        connection.execute("DELETE FROM assets WHERE asset_id = ?", (orphan_asset_id,))
        metrics["deleted"] += 1

    if commit:
        connection.commit()
    return metrics


def delete_export_asset_from_catalog(
    connection: sqlite3.Connection,
    catalog_root: Path,
    asset_id: str,
    *,
    commit: bool = True,
) -> dict[str, object]:
    asset_row = connection.execute(
        """
        SELECT asset_id, asset_type, canonical_path
        FROM assets
        WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchone()
    if asset_row is None or str(asset_row["asset_type"]) != "export":
        raise ValueError(f"unknown export asset: {asset_id}")

    deleted_preview_paths: list[str] = []
    preview_rows = connection.execute(
        "SELECT relative_path FROM preview_entries WHERE asset_id = ?",
        (asset_id,),
    ).fetchall()
    for row in preview_rows:
        relative_path = str(row["relative_path"] or "")
        if not relative_path:
            continue
        preview_path = (catalog_root / relative_path).resolve()
        try:
            preview_path.unlink(missing_ok=True)
        except Exception:
            pass
        deleted_preview_paths.append(str(preview_path))
    connection.execute("DELETE FROM preview_entries WHERE asset_id = ?", (asset_id,))

    set_row = get_resource_set_for_asset(connection, asset_id)
    if set_row is not None:
        set_id = str(set_row["set_id"])
        connection.execute(
            "DELETE FROM resource_set_items WHERE set_id = ? AND asset_id = ?",
            (set_id, asset_id),
        )
        next_primary_row = connection.execute(
            """
            SELECT asset_id
            FROM resource_set_items
            WHERE set_id = ?
            ORDER BY sort_order, created_at, asset_id
            LIMIT 1
            """,
            (set_id,),
        ).fetchone()
        if next_primary_row is not None:
            next_primary_asset_id = str(next_primary_row["asset_id"])
            connection.execute(
                "UPDATE resource_sets SET primary_asset_id = ?, updated_at = CURRENT_TIMESTAMP WHERE set_id = ?",
                (next_primary_asset_id, set_id),
            )
            connection.execute(
                "UPDATE resource_set_items SET role = 'version' WHERE set_id = ? AND role = 'primary'",
                (set_id,),
            )
            connection.execute(
                "UPDATE resource_set_items SET role = 'primary' WHERE set_id = ? AND asset_id = ?",
                (set_id, next_primary_asset_id),
            )
        else:
            connection.execute("DELETE FROM resource_sets WHERE set_id = ?", (set_id,))

    # Any remaining resource_set_items rows that point at this asset as their
    # version parent would otherwise leave a dangling FK once the asset row is
    # gone, so detach them before the final delete.
    connection.execute(
        "UPDATE resource_set_items SET parent_asset_id = NULL WHERE parent_asset_id = ?",
        (asset_id,),
    )
    connection.execute("DELETE FROM collection_items WHERE asset_id = ?", (asset_id,))
    connection.execute(
        "DELETE FROM export_lookup_registry WHERE export_asset_id = ? OR raw_asset_id = ?",
        (asset_id, asset_id),
    )
    connection.execute(
        "DELETE FROM asset_links WHERE parent_asset_id = ? OR child_asset_id = ?",
        (asset_id, asset_id),
    )
    # Defensive: clear any other tables keyed by this asset_id (raw cache should
    # not hold an export asset, but stale rows must not block deletion).
    connection.execute("DELETE FROM raw_metadata_cache WHERE raw_asset_id = ?", (asset_id,))
    connection.execute("DELETE FROM asset_files WHERE asset_id = ?", (asset_id,))
    connection.execute("DELETE FROM assets WHERE asset_id = ?", (asset_id,))

    if commit:
        connection.commit()

    return {
        "asset_id": asset_id,
        "export_path": str(asset_row["canonical_path"]),
        "preview_files_deleted": deleted_preview_paths,
    }


def summary(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        "assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "raw_assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.asset_type = 'raw' AND assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "export_assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.asset_type = 'export' AND assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "roots": connection.execute("SELECT COUNT(*) FROM catalog_roots WHERE is_active = 1").fetchone()[0],
        "preview_ready": connection.execute(
            "SELECT COUNT(*) FROM preview_entries WHERE kind = 'preview' AND status = 'ready'"
        ).fetchone()[0],
        "preview_hd_ready": connection.execute(
            "SELECT COUNT(*) FROM preview_entries WHERE kind = 'preview-hd' AND status = 'ready'"
        ).fetchone()[0],
        "pending_matches": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status = 'pending_confirmation'"
        ).fetchone()[0],
        "confirmed_matches": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status IN ('auto_bound', 'manual_confirmed')"
        ).fetchone()[0],
        "unmatched_exports": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status = 'unmatched'"
        ).fetchone()[0],
        "raw_fast_only": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level != 'full' OR enrichment_status != 'done'"
        ).fetchone()[0],
        "raw_enriched": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level = 'full' AND enrichment_status = 'done'"
        ).fetchone()[0],
        "rated_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.export_asset_id)
            FROM export_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.export_asset_id
            WHERE assets.app_rating > 0
            """
        ).fetchone()[0],
        "recently_added_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.export_asset_id)
            FROM export_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.export_asset_id
            WHERE assets.created_at >= datetime('now', '-7 days')
            """
        ).fetchone()[0],
    }


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------
