"""Dominant colours per asset (asset_colors), written when a preview is
rendered and by the colours job for photos whose preview predates them."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def replace_asset_colors(connection: sqlite3.Connection, asset_id: str, swatches: list[dict], *, commit: bool = False) -> None:
    connection.execute("DELETE FROM asset_colors WHERE asset_id = ?", (asset_id,))
    connection.executemany(
        "INSERT INTO asset_colors (asset_id, rank, hex, share, l, a, b) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(asset_id, rank, s["hex"], s["share"], s["l"], s["a"], s["b"]) for rank, s in enumerate(swatches)],
    )
    if commit:
        connection.commit()


def get_asset_colors(connection: sqlite3.Connection, asset_id: str) -> list[dict]:
    rows = connection.execute(
        "SELECT hex, share FROM asset_colors WHERE asset_id = ? ORDER BY rank", (asset_id,)
    ).fetchall()
    return [{"hex": row[0], "share": row[1]} for row in rows]


def analyze_asset_colors(connection: sqlite3.Connection, asset_id: str, preview_path: Path, *, commit: bool = False) -> bool:
    """Extract and store the palette of one preview. False when the preview
    could not be read; the asset is then left without colours, and the
    next colours pass tries again."""
    from ..colors import extract_palette

    swatches = extract_palette(preview_path)
    if not swatches:
        return False
    replace_asset_colors(connection, asset_id, swatches, commit=commit)
    return True


_MISSING = """
    FROM assets
    JOIN preview_entries ON preview_entries.asset_id = assets.asset_id
        AND preview_entries.kind = 'preview' AND preview_entries.status = 'ready'
    WHERE assets.exists_on_disk = 1 AND assets.asset_type = 'image'
      AND NOT EXISTS (SELECT 1 FROM asset_colors c WHERE c.asset_id = assets.asset_id)
"""


def list_assets_missing_colors(connection: sqlite3.Connection, limit: int | None = None, *, force: bool = False) -> list[sqlite3.Row]:
    """Photos with a preview on record but no colours yet; with `force`,
    every photo with a preview (a re-analysis after the extraction changed)."""
    scope = _MISSING.split("AND NOT EXISTS")[0] if force else _MISSING
    sql = f"SELECT assets.asset_id, preview_entries.relative_path {scope} ORDER BY assets.created_at DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return connection.execute(sql).fetchall()


def color_status(connection: sqlite3.Connection) -> dict[str, int]:
    analyzed = connection.execute("SELECT COUNT(DISTINCT asset_id) FROM asset_colors").fetchone()[0]
    missing = connection.execute(f"SELECT COUNT(*) {_MISSING}").fetchone()[0]
    return {"analyzed": int(analyzed), "missing": int(missing)}
