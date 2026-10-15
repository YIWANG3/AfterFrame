"""Albums CRUD + membership: manual folders, and smart collections whose
contents are a saved filter (see smart_rules.py).

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3
from uuid import uuid4

from .browse import count_image_assets
from .smart_rules import normalize_rules, parse_rules


def _collection_id() -> str:
    return f"col_{uuid4().hex[:16]}"


def list_collections(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """
        SELECT c.*, COALESCE(counts.cnt, 0) AS item_count
        FROM collections c
        LEFT JOIN (
            SELECT collection_id, COUNT(*) AS cnt FROM collection_items GROUP BY collection_id
        ) counts ON counts.collection_id = c.collection_id
        ORDER BY c.sort_order, c.name
        """
    ).fetchall()
    collections = [dict(r) for r in rows]
    stats = collection_stats(connection)
    for collection in collections:
        collection.update(stats.get(collection["collection_id"]) or empty_stats())
        if collection["kind"] != "smart":
            continue
        rules = parse_rules(collection["rules_json"])
        collection["rules"] = rules
        collection["item_count"] = (
            count_image_assets(connection, "all", base=rules) if rules else 0
        )
    return collections


# ── Folder statistics (docs/folders-page-plan.md §4.1) ─────────────────────

# How many of a folder's newest photos make its cover mosaic.
COVER_COUNT = 4


def empty_stats() -> dict:
    """The stats shape of a folder with nothing in it (and of smart collections)."""
    return {"last_added_at": None, "captured_from": None, "captured_to": None, "cover_relative_paths": []}


def collection_stats(connection: sqlite3.Connection) -> dict[str, dict]:
    """Per folder, what the folder page shows besides the count: when a photo
    last joined, the capture-time span of its photos, and the previews of its
    newest `COVER_COUNT` photos (the first is the single cover). Two passes
    over collection_items, no per-folder queries. Folders without items are
    absent; callers fill in `empty_stats()`."""
    stats: dict[str, dict] = {}
    for row in connection.execute(
        """
        SELECT ci.collection_id,
               MAX(ci.added_at) AS last_added_at,
               MIN(NULLIF(json_extract(a.metadata_json, '$.capture_time'), '')) AS captured_from,
               MAX(NULLIF(json_extract(a.metadata_json, '$.capture_time'), '')) AS captured_to
        FROM collection_items ci
        JOIN assets a ON a.asset_id = ci.asset_id
        GROUP BY ci.collection_id
        """
    ):
        stats[row["collection_id"]] = {
            "last_added_at": row["last_added_at"],
            "captured_from": row["captured_from"],
            "captured_to": row["captured_to"],
            "cover_relative_paths": [],
        }
    # Newest added first; a photo without a ready preview is skipped, so the
    # mosaic never shows a hole for it.
    for row in connection.execute(
        """
        SELECT collection_id, relative_path FROM (
            SELECT ci.collection_id, pe.relative_path,
                   ROW_NUMBER() OVER (
                       PARTITION BY ci.collection_id ORDER BY ci.added_at DESC, ci.asset_id
                   ) AS rn
            FROM collection_items ci
            JOIN preview_entries pe
              ON pe.asset_id = ci.asset_id AND pe.kind = 'preview' AND pe.status = 'ready'
        )
        WHERE rn <= ?
        ORDER BY collection_id, rn
        """,
        (COVER_COUNT,),
    ):
        entry = stats.get(row["collection_id"])
        if entry is not None:
            entry["cover_relative_paths"].append(row["relative_path"])
    return stats


def _checked_rules_json(rules_json: str) -> str:
    try:
        rules = json.loads(rules_json)
    except json.JSONDecodeError as error:
        raise ValueError(f"Smart collection rules are not valid JSON: {error}") from error
    return json.dumps(normalize_rules(rules), ensure_ascii=False)


def create_collection(
    connection: sqlite3.Connection,
    name: str,
    kind: str = "manual",
    rules_json: str = "[]",
    commit: bool = True,
) -> dict:
    if kind == "smart":
        rules_json = _checked_rules_json(rules_json)
    collection_id = _collection_id()
    # A new folder goes on top of the folders' custom order, where the sidebar
    # opens its name field; smart collections keep going to the end of theirs.
    position = (
        "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM collections WHERE kind = 'manual'"
        if kind == "manual"
        else "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections"
    )
    connection.execute(
        f"""
        INSERT INTO collections (collection_id, name, kind, rules_json, sort_order)
        VALUES (?, ?, ?, ?, ({position}))
        """,
        (collection_id, name, kind, rules_json),
    )
    if commit:
        connection.commit()
    return {"collection_id": collection_id, "name": name, "kind": kind}


def update_collection(
    connection: sqlite3.Connection,
    collection_id: str,
    name: str | None = None,
    rules_json: str | None = None,
    sort_order: int | None = None,
    commit: bool = True,
) -> None:
    parts: list[str] = []
    params: list[object] = []
    if name is not None:
        parts.append("name = ?")
        params.append(name)
    if rules_json is not None:
        kind = connection.execute("SELECT kind FROM collections WHERE collection_id = ?", (collection_id,)).fetchone()
        parts.append("rules_json = ?")
        params.append(_checked_rules_json(rules_json) if kind is not None and kind[0] == "smart" else rules_json)
    if sort_order is not None:
        parts.append("sort_order = ?")
        params.append(sort_order)
    if not parts:
        return
    parts.append("updated_at = CURRENT_TIMESTAMP")
    params.append(collection_id)
    connection.execute(
        f"UPDATE collections SET {', '.join(parts)} WHERE collection_id = ?",
        params,
    )
    if commit:
        connection.commit()


def reorder_collections(connection: sqlite3.Connection, collection_ids: list[str]) -> None:
    """Save the complete manual-folder order atomically; reject stale lists."""
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        current = {r[0] for r in connection.execute(
            "SELECT collection_id FROM collections WHERE kind = 'manual'"
        )}
        if len(collection_ids) != len(current) or set(collection_ids) != current:
            raise ValueError("Folder list changed; reload and try again")
        connection.executemany(
            "UPDATE collections SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE collection_id = ?",
            [(index, collection_id) for index, collection_id in enumerate(collection_ids)],
        )


def delete_collection(connection: sqlite3.Connection, collection_id: str, commit: bool = True) -> None:
    connection.execute("DELETE FROM collections WHERE collection_id = ?", (collection_id,))
    if commit:
        connection.commit()


def add_collection_items(
    connection: sqlite3.Connection,
    collection_id: str,
    asset_ids: list[str],
    commit: bool = True,
) -> int:
    kind = connection.execute("SELECT kind FROM collections WHERE collection_id = ?", (collection_id,)).fetchone()
    if kind is not None and kind[0] == "smart":
        raise ValueError("A smart collection fills itself from its rules; photos cannot be added to it")
    added = 0
    for asset_id in asset_ids:
        added += connection.execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, asset_id) VALUES (?, ?)",
            (collection_id, asset_id),
        ).rowcount
    if commit:
        connection.commit()
    return added


def remove_collection_items(
    connection: sqlite3.Connection,
    collection_id: str,
    asset_ids: list[str],
    commit: bool = True,
) -> int:
    removed = 0
    for asset_id in asset_ids:
        removed += connection.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?",
            (collection_id, asset_id),
        ).rowcount
    if commit:
        connection.commit()
    return removed
