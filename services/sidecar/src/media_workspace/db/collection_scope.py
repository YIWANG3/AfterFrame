"""Which folders a folder scope covers, as SQL.

Folders nest (collections.parent_collection_id). A view "inside a folder" is
either the folder alone or the folder with every folder under it; every query
that takes a collection_id (browse, counts, locate, facets, map points, the
annotation batch) asks here, so they all draw the same line. No imports from
the other db modules: browse.py and collections.py both import this.
"""
from __future__ import annotations

import sqlite3

Clause = tuple[str, list[object]]

# Every folder in the subtree rooted at each of the given ids, the roots
# included. UNION, not UNION ALL: a cycle in the data must end the walk, not
# the process.
_SUBTREE_CTE = """
    WITH RECURSIVE sub(collection_id) AS (
        SELECT collection_id FROM collections WHERE collection_id IN ({roots})
        UNION
        SELECT c.collection_id FROM collections c JOIN sub ON c.parent_collection_id = sub.collection_id
    )
    SELECT collection_id FROM sub
"""


def subtree_ids(connection: sqlite3.Connection, collection_id: str) -> list[str]:
    """The folder and every folder under it, the folder first."""
    rows = connection.execute(_SUBTREE_CTE.format(roots="?"), (collection_id,)).fetchall()
    ids = [row[0] for row in rows]
    return ids if ids else [collection_id]


def scope_collection_ids(connection: sqlite3.Connection, collection_id: str, include_descendants: bool = False) -> list[str]:
    """The folders a folder view reads from: the folder, or its whole subtree."""
    return subtree_ids(connection, collection_id) if include_descendants else [collection_id]


def _placeholders(ids: list[str]) -> str:
    return ", ".join("?" for _ in ids)


def members_subquery(ids: list[str]) -> Clause:
    """`assets.asset_id IN (members of these folders)`."""
    return f"assets.asset_id IN (SELECT asset_id FROM collection_items WHERE collection_id IN ({_placeholders(ids)}))", list(ids)


def members_join(ids: list[str]) -> Clause:
    """A JOIN that keeps one row per asset across the folders, as `ci`, with
    `ci.added_at` the latest time it joined any of them (the folder order
    sorts on it). With a single folder this is exactly the old
    `JOIN collection_items ci ... WHERE ci.collection_id = ?`."""
    sql = (
        "JOIN (SELECT asset_id, MAX(added_at) AS added_at FROM collection_items "
        f"WHERE collection_id IN ({_placeholders(ids)}) GROUP BY asset_id) ci ON ci.asset_id = assets.asset_id"
    )
    return sql, list(ids)


def subtree_members_subquery(roots: list[str]) -> Clause:
    """`assets.asset_id IN (members of these folders or any folder under them)`,
    resolved inside SQL — for the facet builders, which have no connection."""
    cte = _SUBTREE_CTE.format(roots=_placeholders(roots))
    return f"assets.asset_id IN (SELECT asset_id FROM collection_items WHERE collection_id IN ({cte}))", list(roots)
