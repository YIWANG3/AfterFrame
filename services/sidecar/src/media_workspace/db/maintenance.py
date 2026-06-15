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

from ..models import ImageCandidate, MatchDecision, RawMetadata

# Sentinel: distinguishes "don't touch error_text" from "clear it" in update_job.
_UNSET = object()
from ..schema import SCHEMA_STATEMENTS

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"
SCHEMA_VERSION = 5

from .assets import upsert_preview_entry
from .resource_sets import _link_id, get_resource_set_for_asset


def verify_assets(
    connection: sqlite3.Connection,
    *,
    scope: str = "all",
    commit: bool = True,
) -> dict[str, int]:
    """Stat every asset's original file and reconcile assets.exists_on_disk.

    This is the explicit, full-library sweep behind the File ▸ Verify Files
    menu action. Browsing reconciles the visible page lazily; this catches the
    rest. Stat is cheap (microseconds/file), so we run it synchronously.

    scope: 'all' | 'image' | 'raw'.
    Returns {checked, present, missing, newly_missing, recovered}.
    """
    where = ""
    params: list[object] = []
    if scope in ("image", "raw"):
        where = "WHERE asset_type = ?"
        params = [scope]
    elif scope != "all":
        raise ValueError(f"unsupported scope: {scope}")

    rows = connection.execute(
        f"SELECT asset_id, canonical_path, exists_on_disk FROM assets {where}",
        params,
    ).fetchall()

    metrics = {"checked": 0, "present": 0, "missing": 0, "newly_missing": 0, "recovered": 0}
    for row in rows:
        metrics["checked"] += 1
        present = os.path.exists(str(row["canonical_path"]))
        flag = 1 if present else 0
        metrics["present" if present else "missing"] += 1
        if flag != int(row["exists_on_disk"]):
            connection.execute(
                "UPDATE assets SET exists_on_disk = ?, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?",
                (flag, str(row["asset_id"])),
            )
            metrics["recovered" if present else "newly_missing"] += 1

    if commit:
        connection.commit()
    return metrics


def relink_asset(
    connection: sqlite3.Connection,
    asset_id: str,
    new_path: Path,
    *,
    force: bool = False,
    commit: bool = True,
) -> dict[str, object]:
    """Point a missing asset at a new on-disk location, in place.

    Keeps the original asset_id (and therefore its rating, crops, version
    stack) — we only rewrite the path columns. The new file's content
    fingerprint must match the stored one unless force=True; on mismatch we
    return early WITHOUT mutating so the UI can confirm and retry with force.

    Returns one of:
      {"status": "relinked", asset_id, old_path, new_path, forced}
      {"status": "fingerprint_mismatch", asset_id, old_path, candidate_path,
       expected_fingerprint, actual_fingerprint}
    """
    from ..metadata import quick_fingerprint

    row = connection.execute(
        "SELECT asset_id, asset_type, fingerprint, canonical_path FROM assets WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown asset: {asset_id}")

    target = Path(new_path)
    if not target.exists():
        raise ValueError(f"new file does not exist: {target}")
    new_str = str(target.resolve())
    old_path = str(row["canonical_path"])

    actual_fp = quick_fingerprint(target, mode="head-tail")
    expected_fp = str(row["fingerprint"])
    if actual_fp != expected_fp and not force:
        return {
            "status": "fingerprint_mismatch",
            "asset_id": asset_id,
            "old_path": old_path,
            "candidate_path": new_str,
            "expected_fingerprint": expected_fp,
            "actual_fingerprint": actual_fp,
        }

    connection.execute(
        "UPDATE assets SET canonical_path = ?, exists_on_disk = 1, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?",
        (new_str, asset_id),
    )
    # asset_files.path is UNIQUE; rewrite the row that pointed at the old path.
    connection.execute(
        "UPDATE asset_files SET path = ? WHERE asset_id = ? AND path = ?",
        (new_str, asset_id, old_path),
    )
    # The gallery reads image_path from the registry, not assets.canonical_path,
    # so the registry's path (its PRIMARY KEY) has to move too.
    if str(row["asset_type"]) == "image":
        connection.execute(
            "UPDATE image_lookup_registry SET image_path = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE image_asset_id = ? AND image_path = ?",
            (new_str, asset_id, old_path),
        )

    if commit:
        connection.commit()
    return {
        "status": "relinked",
        "asset_id": asset_id,
        "old_path": old_path,
        "new_path": new_str,
        "forced": actual_fp != expected_fp,
    }

def cleanup_orphan_image_assets(connection: sqlite3.Connection, commit: bool = True) -> dict[str, int]:
    orphan_rows = connection.execute(
        """
        SELECT orphan.asset_id AS orphan_asset_id, active.asset_id AS active_asset_id
        FROM assets AS orphan
        JOIN assets AS active
            ON active.asset_type = 'image'
           AND active.canonical_path = orphan.canonical_path
        JOIN asset_files AS active_files
            ON active_files.asset_id = active.asset_id
           AND active_files.path = active.canonical_path
        LEFT JOIN asset_files AS orphan_files
            ON orphan_files.asset_id = orphan.asset_id
        WHERE orphan.asset_type = 'image'
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
            UPDATE image_lookup_registry
            SET image_asset_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE image_asset_id = ?
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


def delete_image_asset_from_catalog(
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
    if asset_row is None or str(asset_row["asset_type"]) not in ("image", "video"):
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
        "DELETE FROM image_lookup_registry WHERE image_asset_id = ? OR raw_asset_id = ?",
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
        "image_path": str(asset_row["canonical_path"]),
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
        "image_assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.asset_type = 'image' AND assets.exists_on_disk = 1
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
            "SELECT COUNT(*) FROM image_lookup_registry WHERE match_status = 'pending_confirmation'"
        ).fetchone()[0],
        "confirmed_matches": connection.execute(
            "SELECT COUNT(*) FROM image_lookup_registry WHERE match_status IN ('auto_bound', 'manual_confirmed')"
        ).fetchone()[0],
        "unmatched_images": connection.execute(
            "SELECT COUNT(*) FROM image_lookup_registry WHERE match_status = 'unmatched'"
        ).fetchone()[0],
        "raw_fast_only": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level != 'full' OR enrichment_status != 'done'"
        ).fetchone()[0],
        "raw_enriched": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level = 'full' AND enrichment_status = 'done'"
        ).fetchone()[0],
        "rated_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.image_asset_id)
            FROM image_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.image_asset_id
            WHERE assets.app_rating > 0
            """
        ).fetchone()[0],
        "recently_added_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.image_asset_id)
            FROM image_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.image_asset_id
            WHERE assets.created_at >= datetime('now', '-7 days')
            """
        ).fetchone()[0],
    }


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------
