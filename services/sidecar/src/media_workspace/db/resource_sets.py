"""Version stacks: attach/create/reassign + repair algorithms.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import sqlite3
from hashlib import sha1
from pathlib import Path
from uuid import uuid4

from .core import _file_id
from .core import _json

def _link_id(parent_asset_id: str, child_asset_id: str, relation_type: str) -> str:
    digest = sha1(f"{parent_asset_id}:{child_asset_id}:{relation_type}".encode("utf-8")).hexdigest()[:20]
    return f"link_{digest}"


def _resource_set_id() -> str:
    return f"set_{uuid4().hex[:20]}"


def get_resource_set(connection: sqlite3.Connection, set_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT set_id, primary_asset_id, raw_asset_id, created_at, updated_at
        FROM resource_sets
        WHERE set_id = ?
        """,
        (set_id,),
    ).fetchone()


def get_resource_set_for_asset(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT rs.set_id, rs.primary_asset_id, rs.raw_asset_id, rsi.role, rsi.version_kind, rsi.parent_asset_id, rsi.sort_order
        FROM resource_set_items AS rsi
        JOIN resource_sets AS rs ON rs.set_id = rsi.set_id
        WHERE rsi.asset_id = ?
        """,
        (asset_id,),
    ).fetchone()


def _next_resource_sort_order(connection: sqlite3.Connection, set_id: str) -> int:
    row = connection.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM resource_set_items WHERE set_id = ?",
        (set_id,),
    ).fetchone()
    return int(row["next_sort_order"]) if row is not None else 0


def add_asset_to_resource_set(
    connection: sqlite3.Connection,
    set_id: str,
    asset_id: str,
    *,
    role: str,
    version_kind: str | None = None,
    parent_asset_id: str | None = None,
    sort_order: int | None = None,
    commit: bool = True,
) -> None:
    if sort_order is None:
        sort_order = _next_resource_sort_order(connection, set_id)
    connection.execute(
        """
        INSERT INTO resource_set_items (set_id, asset_id, role, version_kind, parent_asset_id, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(set_id, asset_id) DO UPDATE SET
            role = excluded.role,
            version_kind = excluded.version_kind,
            parent_asset_id = excluded.parent_asset_id,
            sort_order = excluded.sort_order
        """,
        (set_id, asset_id, role, version_kind, parent_asset_id, sort_order),
    )
    if commit:
        connection.commit()


def create_resource_set(
    connection: sqlite3.Connection,
    primary_asset_id: str,
    *,
    commit: bool = True,
) -> str:
    existing = get_resource_set_for_asset(connection, primary_asset_id)
    if existing:
        return str(existing["set_id"])

    set_id = _resource_set_id()
    connection.execute(
        """
        INSERT INTO resource_sets (set_id, primary_asset_id)
        VALUES (?, ?)
        """,
        (set_id, primary_asset_id),
    )
    add_asset_to_resource_set(connection, set_id, primary_asset_id, role="primary", version_kind="main", parent_asset_id=None, sort_order=1, commit=False)
    if commit:
        connection.commit()
    return set_id


def attach_asset_to_resource_set(
    connection: sqlite3.Connection,
    asset_id: str,
    *,
    origin_asset_id: str | None = None,
    version_kind: str = "version",
    commit: bool = True,
) -> str:
    existing = get_resource_set_for_asset(connection, asset_id)
    if existing:
        return str(existing["set_id"])

    # Has explicit origin (e.g. AI repaint, crop) → join origin's set
    if origin_asset_id:
        origin_set = get_resource_set_for_asset(connection, origin_asset_id)
        if origin_set:
            target_set = str(origin_set["set_id"])
        else:
            # Origin has no set yet → create one with origin as primary
            target_set = create_resource_set(
                connection, origin_asset_id, commit=False,
            )
        add_asset_to_resource_set(
            connection, target_set, asset_id,
            role="version", version_kind=version_kind,
            parent_asset_id=origin_asset_id, commit=False,
        )
        if commit:
            connection.commit()
        return target_set

    # Independent import with no origin → create own set
    target_set = create_resource_set(connection, asset_id, commit=False)
    if commit:
        connection.commit()
    return target_set


def list_image_assets_missing_resource_set(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.stem,
            assets.canonical_path,
            registry.raw_asset_id
        FROM assets
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN image_lookup_registry AS registry
            ON registry.image_asset_id = assets.asset_id
        WHERE assets.asset_type = 'image'
          AND rsi.set_id IS NULL
        ORDER BY assets.created_at, assets.canonical_path
        """
    ).fetchall()


def find_image_asset_ids_by_stem(connection: sqlite3.Connection, stem: str) -> list[str]:
    rows = connection.execute(
        """
        SELECT asset_id
        FROM assets
        WHERE asset_type = 'image'
          AND stem = ?
        ORDER BY created_at, canonical_path
        """,
        (stem,),
    ).fetchall()
    return [str(row["asset_id"]) for row in rows]


def list_singleton_primary_resource_sets(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            rs.set_id,
            rs.primary_asset_id,
            a.stem,
            a.canonical_path
        FROM resource_sets AS rs
        JOIN assets AS a
            ON a.asset_id = rs.primary_asset_id
        JOIN (
            SELECT set_id, COUNT(*) AS item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS counts
            ON counts.set_id = rs.set_id
        WHERE counts.item_count = 1
        """
    ).fetchall()


def list_incorrectly_merged_resource_sets(connection: sqlite3.Connection) -> list[dict]:
    """Find resource sets containing multiple independent exports from different directories.

    Returns a list of dicts with set_id, and a list of member info.
    Sets where all members share the same parent directory are NOT returned.
    """
    # Find sets with 2+ export members
    candidate_sets = connection.execute(
        """
        SELECT rsi.set_id, COUNT(*) AS image_count
        FROM resource_set_items AS rsi
        JOIN assets ON assets.asset_id = rsi.asset_id AND assets.asset_type = 'image'
        GROUP BY rsi.set_id
        HAVING image_count > 1
        """
    ).fetchall()

    results = []
    for row in candidate_sets:
        set_id = row["set_id"]
        members = connection.execute(
            """
            SELECT rsi.asset_id, assets.canonical_path, rsi.role, rsi.version_kind, rsi.parent_asset_id
            FROM resource_set_items AS rsi
            JOIN assets ON assets.asset_id = rsi.asset_id AND assets.asset_type = 'image'
            WHERE rsi.set_id = ?
            ORDER BY rsi.sort_order
            """,
            (set_id,),
        ).fetchall()

        # Check: are there members WITHOUT a parent_asset_id (independent imports)
        # from DIFFERENT directories?
        independent_members = [m for m in members if not m["parent_asset_id"]]
        if len(independent_members) < 2:
            continue

        dirs = set()
        for m in independent_members:
            parent_dir = str(Path(m["canonical_path"]).parent)
            dirs.add(parent_dir)

        if len(dirs) < 2:
            continue

        results.append({
            "set_id": set_id,
            "members": [
                {
                    "asset_id": m["asset_id"],
                    "canonical_path": m["canonical_path"],
                    "role": m["role"],
                    "version_kind": m["version_kind"],
                    "parent_asset_id": m["parent_asset_id"],
                }
                for m in members
            ],
        })

    return results


def reassign_asset_to_resource_set(
    connection: sqlite3.Connection,
    asset_id: str,
    *,
    origin_asset_id: str,
    version_kind: str = "derived",
    commit: bool = True,
) -> str:
    current = get_resource_set_for_asset(connection, asset_id)
    if current:
        connection.execute(
            "DELETE FROM resource_set_items WHERE set_id = ? AND asset_id = ?",
            (current["set_id"], asset_id),
        )
        remaining = connection.execute(
            "SELECT COUNT(*) AS item_count FROM resource_set_items WHERE set_id = ?",
            (current["set_id"],),
        ).fetchone()
        if remaining is not None and int(remaining["item_count"]) == 0:
            connection.execute("DELETE FROM resource_sets WHERE set_id = ?", (current["set_id"],))

    target_set = attach_asset_to_resource_set(
        connection,
        asset_id,
        origin_asset_id=origin_asset_id,
        version_kind=version_kind,
        commit=False,
    )
    if commit:
        connection.commit()
    return target_set


def split_shared_asset_ids(connection: sqlite3.Connection, commit: bool = True) -> int:
    """Fix assets where multiple registry entries share one asset_id (old format without path).

    For each duplicate group, the first entry keeps the original asset record;
    additional entries get a new asset record with a path-aware stable ID.
    """
    from ..metadata import stable_asset_id

    dupes = connection.execute("""
        SELECT image_asset_id, COUNT(*) AS cnt
        FROM image_lookup_registry
        GROUP BY image_asset_id
        HAVING cnt > 1
    """).fetchall()

    split_count = 0
    for dupe in dupes:
        old_id = str(dupe["image_asset_id"])
        entries = connection.execute("""
            SELECT image_path, raw_asset_id, match_status, score,
                   resolver_version, feature_vector_json, candidate_json, confirmed_at
            FROM image_lookup_registry
            WHERE image_asset_id = ?
            ORDER BY image_path
        """, (old_id,)).fetchall()

        asset_row = connection.execute("""
            SELECT * FROM assets WHERE asset_id = ?
        """, (old_id,)).fetchone()
        if not asset_row:
            continue

        # Keep first entry on original asset, split the rest
        canonical_path = str(asset_row["canonical_path"])
        for entry in entries:
            entry_path = str(entry["image_path"])
            if entry_path == canonical_path:
                continue  # Keep original

            new_id = stable_asset_id("image", str(asset_row["fingerprint"]), entry_path)
            if new_id == old_id:
                continue  # Would collide, skip

            # Create new asset record
            connection.execute("""
                INSERT INTO assets (
                    asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
                    extension, fingerprint, file_size, modified_time, metadata_json, app_rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id) DO NOTHING
            """, (
                new_id,
                asset_row["asset_type"],
                entry_path,
                asset_row["stem"],
                asset_row["normalized_stem"],
                asset_row["stem_key"],
                asset_row["extension"],
                asset_row["fingerprint"],
                asset_row["file_size"],
                asset_row["modified_time"],
                asset_row["metadata_json"],
                asset_row["app_rating"],
            ))

            # Update registry to point to new asset
            connection.execute("""
                UPDATE image_lookup_registry
                SET image_asset_id = ?
                WHERE image_path = ? AND image_asset_id = ?
            """, (new_id, entry_path, old_id))

            # Update asset_files
            connection.execute("""
                UPDATE asset_files SET asset_id = ?, file_id = ?
                WHERE asset_id = ? AND path = ?
            """, (new_id, _file_id(new_id, entry_path), old_id, entry_path))

            # Update resource_set_items: create new membership for the split asset
            rsi = connection.execute("""
                SELECT set_id, role, version_kind, parent_asset_id, sort_order
                FROM resource_set_items WHERE asset_id = ?
            """, (old_id,)).fetchone()
            if rsi:
                parent = str(rsi["parent_asset_id"]) if rsi["parent_asset_id"] else None
                attach_asset_to_resource_set(
                    connection, new_id,
                    origin_asset_id=parent,
                    version_kind=str(rsi["version_kind"]),
                    commit=False,
                )

            # Update collection_items
            connection.execute("""
                INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at)
                SELECT collection_id, ?, added_at
                FROM collection_items WHERE asset_id = ?
            """, (new_id, old_id))

            # Share preview_entries (same preview file, different asset_id)
            connection.execute("""
                INSERT OR IGNORE INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status)
                SELECT ? || '_' || kind, ?, kind, relative_path, width, height, status
                FROM preview_entries WHERE asset_id = ?
            """, (new_id, new_id, old_id))

            split_count += 1

    if commit and split_count:
        connection.commit()
    return split_count


def remove_raw_from_resource_sets(connection: sqlite3.Connection, commit: bool = True) -> int:
    """Remove raw assets from resource sets — raw linkage is via registry, not sets."""
    removed = connection.execute("""
        DELETE FROM resource_set_items
        WHERE asset_id IN (SELECT asset_id FROM assets WHERE asset_type = 'raw')
    """).rowcount
    if removed:
        connection.execute("UPDATE resource_sets SET raw_asset_id = NULL WHERE raw_asset_id IS NOT NULL")
        # Clean up empty sets
        connection.execute("""
            DELETE FROM resource_sets WHERE set_id NOT IN (
                SELECT DISTINCT set_id FROM resource_set_items
            )
        """)
    if commit and removed:
        connection.commit()
    return removed


def link_assets(
    connection: sqlite3.Connection,
    parent_asset_id: str,
    child_asset_id: str,
    relation_type: str,
    confidence: float,
    confirmed_by: str,
    recipe_json: dict[str, object] | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO asset_links (
            link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
            confidence, confirmed_by, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(parent_asset_id, child_asset_id, relation_type) DO UPDATE SET
            recipe_json = excluded.recipe_json,
            confidence = excluded.confidence,
            confirmed_by = excluded.confirmed_by,
            confirmed_at = CURRENT_TIMESTAMP
        """,
        (
            _link_id(parent_asset_id, child_asset_id, relation_type),
            parent_asset_id,
            child_asset_id,
            relation_type,
            _json(recipe_json or {}),
            confidence,
            confirmed_by,
        ),
    )


def split_incorrectly_merged_sets(connection: sqlite3.Connection, commit: bool = True) -> int:
    """Detach independent exports wrongly merged into one set; drop emptied sets.

    Moved from the repair-resource-sets CLI handler — the algorithm belongs
    with the rest of the resource-set logic, not in the dispatcher.
    """
    split_count = 0
    for merged in list_incorrectly_merged_resource_sets(connection):
        set_id = merged["set_id"]
        independent = [m for m in merged["members"] if not m["parent_asset_id"]]
        for member in independent[1:]:
            connection.execute(
                "DELETE FROM resource_set_items WHERE set_id = ? AND asset_id = ?",
                (set_id, member["asset_id"]),
            )
            split_count += 1
        remaining = connection.execute(
            "SELECT COUNT(*) AS item_count FROM resource_set_items WHERE set_id = ?",
            (set_id,),
        ).fetchone()
        if remaining is not None and int(remaining["item_count"]) == 0:
            connection.execute("DELETE FROM resource_sets WHERE set_id = ?", (set_id,))
    if split_count and commit:
        connection.commit()
    return split_count
