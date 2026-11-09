"""Albums CRUD + membership: manual folders, and smart collections whose
contents are a saved filter (see smart_rules.py).

Folders nest: parent_collection_id names the folder a folder sits in (NULL at
the top level), any depth. Only manual folders take part — a smart collection
is neither a parent nor a child. Deleting a folder deletes the folders under
it; a folder's view may read its whole subtree (collection_scope.py).

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3
from uuid import uuid4

from .browse import count_image_assets
from .collection_scope import subtree_ids
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
    subtree_counts = _subtree_counts(connection)
    for collection in collections:
        collection.update(stats.get(collection["collection_id"]) or empty_stats())
        if collection["kind"] != "smart":
            collection["subtree_count"] = subtree_counts.get(collection["collection_id"], collection["item_count"])
            continue
        collection["parent_collection_id"] = None
        rules = parse_rules(collection["rules_json"])
        collection["rules"] = rules
        collection["item_count"] = (
            count_image_assets(connection, "all", base=rules) if rules else 0
        )
        collection["subtree_count"] = collection["item_count"]
    _add_tree_fields(collections)
    return collections


# ── Nesting ────────────────────────────────────────────────────────────────

def _add_tree_fields(collections: list[dict]) -> None:
    """`depth` (0 at the top level) and `path` (ancestor names then the
    folder's own, " / " between) on every row, in place. A parent that is not
    in the list, or a cycle in the data, ends the walk: the folder then reads
    as top-level rather than crashing the sidebar."""
    by_id = {c["collection_id"]: c for c in collections if c["kind"] == "manual"}
    for collection in collections:
        names = [collection["name"]]
        seen = {collection["collection_id"]}
        parent_id = collection.get("parent_collection_id") if collection["kind"] == "manual" else None
        while parent_id and parent_id in by_id and parent_id not in seen:
            seen.add(parent_id)
            names.append(by_id[parent_id]["name"])
            parent_id = by_id[parent_id].get("parent_collection_id")
        collection["depth"] = len(names) - 1
        collection["path"] = " / ".join(reversed(names))


def _subtree_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Per folder, how many distinct photos sit in it or in any folder under
    it — the count a collapsed folder shows. One recursive query; folders
    whose subtree holds nothing are absent."""
    return {
        row[0]: int(row[1])
        for row in connection.execute(
            """
            WITH RECURSIVE tree(root_id, collection_id) AS (
                SELECT collection_id, collection_id FROM collections WHERE kind = 'manual'
                UNION
                SELECT tree.root_id, c.collection_id
                FROM collections c JOIN tree ON c.parent_collection_id = tree.collection_id
            )
            SELECT tree.root_id, COUNT(DISTINCT ci.asset_id)
            FROM tree JOIN collection_items ci ON ci.collection_id = tree.collection_id
            GROUP BY tree.root_id
            """
        )
    }


def _manual_folder(connection: sqlite3.Connection, collection_id: str) -> sqlite3.Row:
    row = connection.execute(
        "SELECT collection_id, kind, parent_collection_id FROM collections WHERE collection_id = ?", (collection_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"Unknown folder: {collection_id}")
    return row


def _check_parent(connection: sqlite3.Connection, parent_id: str | None) -> None:
    if parent_id is None:
        return
    parent = _manual_folder(connection, parent_id)
    if parent["kind"] != "manual":
        raise ValueError("A smart collection cannot hold folders")


def _top_of_siblings(connection: sqlite3.Connection, parent_id: str | None) -> int:
    """The sort_order above every folder at this level: new and moved
    folders land on top, where the sidebar opens the name field."""
    row = connection.execute(
        "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM collections WHERE kind = 'manual' AND parent_collection_id IS ?",
        (parent_id,),
    ).fetchone()
    return int(row[0])


def move_collection(connection: sqlite3.Connection, collection_id: str, parent_id: str | None) -> dict:
    """Put a folder inside another (or at the top level with parent_id None),
    on top of its new siblings. Refused for smart collections, for a parent
    that is the folder itself or sits under it, and for a smart collection as
    parent. Returns the folder's new place."""
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _manual_folder(connection, collection_id)
        if row["kind"] != "manual":
            raise ValueError("A smart collection cannot be moved into a folder")
        parent_id = parent_id or None
        _check_parent(connection, parent_id)
        if parent_id is not None and parent_id in subtree_ids(connection, collection_id):
            raise ValueError("A folder cannot be moved into itself or into one of its own folders")
        if row["parent_collection_id"] == parent_id:
            return {"collection_id": collection_id, "parent_collection_id": parent_id, "moved": False}
        connection.execute(
            "UPDATE collections SET parent_collection_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE collection_id = ?",
            (parent_id, _top_of_siblings(connection, parent_id), collection_id),
        )
    return {"collection_id": collection_id, "parent_collection_id": parent_id, "moved": True}


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
    parent_id: str | None = None,
) -> dict:
    """`parent_id` puts a new folder inside that folder; smart collections
    never nest and refuse one."""
    parent_id = parent_id or None
    if kind == "smart":
        rules_json = _checked_rules_json(rules_json)
        if parent_id is not None:
            raise ValueError("A smart collection cannot sit inside a folder")
    else:
        _check_parent(connection, parent_id)
    collection_id = _collection_id()
    # A new folder goes on top of its siblings' custom order, where the sidebar
    # opens its name field; smart collections keep going to the end of theirs.
    if kind == "manual":
        position = _top_of_siblings(connection, parent_id)
    else:
        position = int(connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections").fetchone()[0])
    connection.execute(
        """
        INSERT INTO collections (collection_id, name, kind, rules_json, sort_order, parent_collection_id)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (collection_id, name, kind, rules_json, position, parent_id),
    )
    if commit:
        connection.commit()
    return {"collection_id": collection_id, "name": name, "kind": kind, "parent_collection_id": parent_id}


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


def reorder_collections(connection: sqlite3.Connection, collection_ids: list[str], parent_id: str | None = None) -> None:
    """Save the complete order of one level — the folders directly under
    `parent_id` (the top level with None) — atomically; reject stale lists."""
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        current = {r[0] for r in connection.execute(
            "SELECT collection_id FROM collections WHERE kind = 'manual' AND parent_collection_id IS ?",
            (parent_id or None,),
        )}
        if len(collection_ids) != len(current) or set(collection_ids) != current:
            raise ValueError("Folder list changed; reload and try again")
        connection.executemany(
            "UPDATE collections SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE collection_id = ?",
            [(index, collection_id) for index, collection_id in enumerate(collection_ids)],
        )


def delete_collection(connection: sqlite3.Connection, collection_id: str, commit: bool = True) -> list[str]:
    """Delete a collection and, for a folder, every folder under it (their
    memberships go with them; the photos stay). Returns the ids deleted,
    the folder asked for first."""
    ids = subtree_ids(connection, collection_id)
    connection.execute(
        f"DELETE FROM collections WHERE collection_id IN ({', '.join('?' for _ in ids)})",
        ids,
    )
    if commit:
        connection.commit()
    return ids


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
