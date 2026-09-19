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
    for collection in collections:
        if collection["kind"] != "smart":
            continue
        rules = parse_rules(collection["rules_json"])
        collection["rules"] = rules
        collection["item_count"] = (
            count_image_assets(connection, rules["status"], rules["search"], rules["filters"]) if rules else 0
        )
    return collections


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
    connection.execute(
        """
        INSERT INTO collections (collection_id, name, kind, rules_json, sort_order)
        VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections))
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
