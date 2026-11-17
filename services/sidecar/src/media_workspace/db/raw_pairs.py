"""Same-shot RAW+JPG pairs (docs/raw-jpg-pairing-plan.md).

A camera that writes RAW+JPG leaves two files with one name side by side.
Every such pair is recorded here as it is imported; whether the library
shows it as one photo is the catalog's `raw_pairs` setting ("merge", the
default, or "separate"), so the choice can change any time without
re-importing.

While a pair is merged:
- its RAW is hidden from every view (HIDDEN_RAW_CLAUSE);
- writes to the JPG reach the RAW too (expand_ids), so both carry the same
  rating, flag, tags and description, and "separate" shows both as they were;
- folder membership belongs to the JPG alone: the RAW is in no folder, and
  goes back into the JPG's folders when the pair is shown separately again.

This is not "Add RAW Sources" (image_lookup_registry.raw_asset_id): that
finds the RAW an edited export was made from, and the two stay two photos.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from .. import formats

SETTING_KEY = "raw_pairs"
MODES = ("merge", "separate")
DEFAULT_MODE = "merge"
# The camera writes both files of a shot in the same second; two cameras that
# number alike (DSC_0001 from each) rarely shoot within it.
MAX_CAPTURE_GAP_SECONDS = 2.0
# The JPG side: what a camera writes beside its RAW.
COVER_FAMILIES = frozenset({"jpeg", "heif"})

_MERGE_ON = (
    "COALESCE((SELECT json_extract(value_json, '$.mode') FROM app_settings"
    f" WHERE setting_key = '{SETTING_KEY}'), '{DEFAULT_MODE}') = 'merge'"
)

# Leaves out the RAW of a merged pair. Needs the `assets` alias; one indexed
# lookup per row, the setting read once per query.
HIDDEN_RAW_CLAUSE = (
    "NOT EXISTS (SELECT 1 FROM raw_pairs AS rp_hidden WHERE rp_hidden.raw_asset_id = assets.asset_id"
    f" AND rp_hidden.state = 'paired' AND {_MERGE_ON})"
)

# The RAW merged into this photo, or NULL. Needs the `assets` alias.
MERGED_RAW_ID_SQL = (
    "(SELECT rp_merged.raw_asset_id FROM raw_pairs AS rp_merged WHERE rp_merged.image_asset_id = assets.asset_id"
    f" AND rp_merged.state = 'paired' AND {_MERGE_ON})"
)


# ── the setting ─────────────────────────────────────────────────────────────

def _setting(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT value_json FROM app_settings WHERE setting_key = ?", (SETTING_KEY,)).fetchone()
    if row is None:
        return {}
    try:
        value = json.loads(row[0] or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _write_setting(connection: sqlite3.Connection, value: dict) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
        """,
        (SETTING_KEY, json.dumps(value)),
    )


def get_mode(connection: sqlite3.Connection) -> str:
    mode = _setting(connection).get("mode")
    return mode if mode in MODES else DEFAULT_MODE


def is_merged(connection: sqlite3.Connection) -> bool:
    return get_mode(connection) == "merge"


def status(connection: sqlite3.Connection) -> dict:
    """What the settings and the one-time notice need: the mode, how many
    pairs the library has, and whether the user has been told about them."""
    setting = _setting(connection)
    pairs = connection.execute("SELECT COUNT(*) FROM raw_pairs WHERE state = 'paired'").fetchone()[0]
    return {"mode": get_mode(connection), "pairs": int(pairs), "noticed": bool(setting.get("noticed"))}


def mark_noticed(connection: sqlite3.Connection, *, commit: bool = True) -> None:
    _write_setting(connection, {**_setting(connection), "noticed": True})
    if commit:
        connection.commit()


def set_mode(connection: sqlite3.Connection, mode: str, *, commit: bool = True) -> dict:
    """Show the pairs as one photo ("merge") or as two ("separate"). Merging
    brings each pair's two values together first (reconcile); separating
    gives each RAW its JPG's folders back. Choosing is also noticing."""
    if mode not in MODES:
        raise ValueError(f"unknown raw pair mode: {mode}")
    previous = get_mode(connection)
    _write_setting(connection, {**_setting(connection), "mode": mode, "noticed": True})
    if mode != previous:
        for image_id, raw_id in _paired_rows(connection):
            if mode == "merge":
                reconcile(connection, image_id, raw_id)
            else:
                _copy_folders(connection, image_id, raw_id)
    if commit:
        connection.commit()
    return status(connection)


# ── finding pairs ───────────────────────────────────────────────────────────

def _side(row: sqlite3.Row) -> str | None:
    """'raw', 'cover' or None for a photo that is neither."""
    if row["asset_type"] == "raw":
        return "raw"
    fmt = formats.format_for(str(row["canonical_path"]))
    if row["asset_type"] == "image" and fmt is not None and fmt.family in COVER_FAMILIES:
        return "cover"
    return None


def _capture(value: object) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).replace(tzinfo=None)
    except ValueError:
        return None


_CANDIDATE_SQL = """
    SELECT assets.asset_id, assets.asset_type, assets.canonical_path, assets.stem, assets.meta_capture_time
    FROM assets
    JOIN image_lookup_registry AS registry ON registry.image_asset_id = assets.asset_id
    WHERE assets.stem_key = ? AND assets.asset_type IN ('image', 'raw')
"""


def pair_asset(connection: sqlite3.Connection, asset_id: str) -> bool:
    """Pair this photo with its other half, if it has exactly one: same
    folder, same name but for the case and the extension, one RAW and one
    JPG/HEIF, shot within MAX_CAPTURE_GAP_SECONDS when both say when. A photo
    already in a pair, or in one the user split, is left alone. True when a
    pair was made. Does not commit."""
    row = connection.execute(
        "SELECT asset_id, asset_type, canonical_path, stem, stem_key, meta_capture_time FROM assets WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if row is None or _side(row) is None:
        return False
    folder = Path(str(row["canonical_path"])).parent
    name = str(row["stem"]).casefold()
    raws: list[sqlite3.Row] = []
    covers: list[sqlite3.Row] = []
    for candidate in connection.execute(_CANDIDATE_SQL, (row["stem_key"],)):
        if str(candidate["stem"]).casefold() != name or Path(str(candidate["canonical_path"])).parent != folder:
            continue
        side = _side(candidate)
        if side == "raw":
            raws.append(candidate)
        elif side == "cover":
            covers.append(candidate)
    if len(raws) != 1 or len(covers) != 1:
        return False
    raw, cover = raws[0], covers[0]
    taken = connection.execute(
        "SELECT 1 FROM raw_pairs WHERE image_asset_id IN (?, ?) OR raw_asset_id IN (?, ?)",
        (cover["asset_id"], raw["asset_id"], cover["asset_id"], raw["asset_id"]),
    ).fetchone()
    if taken is not None:
        return False
    raw_time, cover_time = _capture(raw["meta_capture_time"]), _capture(cover["meta_capture_time"])
    if raw_time and cover_time and abs((raw_time - cover_time).total_seconds()) > MAX_CAPTURE_GAP_SECONDS:
        return False
    connection.execute(
        "INSERT INTO raw_pairs (image_asset_id, raw_asset_id) VALUES (?, ?)",
        (cover["asset_id"], raw["asset_id"]),
    )
    if is_merged(connection):
        reconcile(connection, str(cover["asset_id"]), str(raw["asset_id"]))
    return True


def pair_all(connection: sqlite3.Connection) -> int:
    """Pair every photo in the library that has an unpaired other half (the
    upgrade to schema 15, and a catch-up). Only the RAW side is walked: a
    pair always has one. Does not commit."""
    made = 0
    rows = connection.execute(
        """
        SELECT assets.asset_id FROM assets
        JOIN image_lookup_registry AS registry ON registry.image_asset_id = assets.asset_id
        WHERE assets.asset_type = 'raw'
          AND assets.asset_id NOT IN (SELECT raw_asset_id FROM raw_pairs)
        """
    ).fetchall()
    for row in rows:
        made += pair_asset(connection, str(row[0]))
    return made


# ── keeping a merged pair one photo ─────────────────────────────────────────

def _paired_rows(connection: sqlite3.Connection) -> list[tuple[str, str]]:
    return [
        (str(row[0]), str(row[1]))
        for row in connection.execute("SELECT image_asset_id, raw_asset_id FROM raw_pairs WHERE state = 'paired'")
    ]


def _copy_folders(connection: sqlite3.Connection, source_id: str, target_id: str) -> None:
    connection.execute(
        """
        INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at)
        SELECT collection_id, ?, added_at FROM collection_items WHERE asset_id = ?
        """,
        (target_id, source_id),
    )


def reconcile(connection: sqlite3.Connection, image_id: str, raw_id: str) -> None:
    """Make a pair one photo's worth of values: a rating, flag or description
    only one of the two has goes to both; where both have one, the JPG's (the
    photo the user sees) wins. Tags are pooled. The RAW's folders become the
    JPG's, and the RAW leaves them. Does not commit."""
    rows = {
        str(row["asset_id"]): row
        for row in connection.execute(
            "SELECT asset_id, app_rating, app_flag, user_description FROM assets WHERE asset_id IN (?, ?)",
            (image_id, raw_id),
        )
    }
    cover, raw = rows.get(image_id), rows.get(raw_id)
    if cover is None or raw is None:
        return
    values = {}
    for column in ("app_rating", "app_flag", "user_description"):
        chosen = cover[column] if cover[column] not in (None, 0, "") else raw[column]
        if chosen in (None, 0, "") and cover[column] is not None:
            chosen = cover[column]
        values[column] = chosen
    connection.execute(
        "UPDATE assets SET app_rating = ?, app_flag = ?, user_description = ?, updated_at = CURRENT_TIMESTAMP"
        " WHERE asset_id IN (?, ?)",
        (values["app_rating"], values["app_flag"], values["user_description"], image_id, raw_id),
    )
    for source_id, target_id in ((raw_id, image_id), (image_id, raw_id)):
        connection.execute(
            """
            INSERT OR IGNORE INTO asset_tags (asset_id, tag, source, created_at)
            SELECT ?, tag, source, created_at FROM asset_tags WHERE asset_id = ?
            """,
            (target_id, source_id),
        )
    _copy_folders(connection, raw_id, image_id)
    connection.execute("DELETE FROM collection_items WHERE asset_id = ?", (raw_id,))


def merged_raws(connection: sqlite3.Connection, asset_ids: list[str]) -> dict[str, str]:
    """{photo: the RAW merged into it} for those of these photos that have one."""
    ids = [str(asset_id) for asset_id in asset_ids if asset_id]
    if not ids or not is_merged(connection):
        return {}
    found: dict[str, str] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for row in connection.execute(
            f"SELECT image_asset_id, raw_asset_id FROM raw_pairs WHERE state = 'paired' AND image_asset_id IN ({marks})",
            chunk,
        ):
            found[str(row[0])] = str(row[1])
    return found


def expand_ids(connection: sqlite3.Connection, asset_ids: list[str]) -> list[str]:
    """These photos and, for each merged pair among them, its RAW: what a
    write to the photos the user sees has to reach."""
    raws = merged_raws(connection, asset_ids)
    expanded = list(dict.fromkeys(asset_ids))
    seen = set(expanded)
    for asset_id in asset_ids:
        raw_id = raws.get(asset_id)
        if raw_id and raw_id not in seen:
            expanded.append(raw_id)
            seen.add(raw_id)
    return expanded


def hidden_raw_ids(connection: sqlite3.Connection, asset_ids: list[str]) -> set[str]:
    """Those of these photos that are the hidden RAW of a merged pair."""
    ids = [str(asset_id) for asset_id in asset_ids if asset_id]
    if not ids or not is_merged(connection):
        return set()
    hidden: set[str] = set()
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" * len(chunk))
        hidden.update(
            str(row[0]) for row in connection.execute(
                f"SELECT raw_asset_id FROM raw_pairs WHERE state = 'paired' AND raw_asset_id IN ({marks})", chunk,
            )
        )
    return hidden


def companion_files(connection: sqlite3.Connection, asset_ids: list[str]) -> list[dict]:
    """The merged RAWs of these photos as files: what deleting or copying
    the photos has to take along."""
    raws = merged_raws(connection, asset_ids)
    if not raws:
        return []
    marks = ",".join("?" * len(raws))
    paths = {
        str(row[0]): str(row[1])
        for row in connection.execute(
            f"SELECT asset_id, canonical_path FROM assets WHERE asset_id IN ({marks})", list(raws.values()),
        )
    }
    return [
        {"asset_id": image_id, "raw_asset_id": raw_id, "raw_path": paths.get(raw_id)}
        for image_id, raw_id in raws.items()
    ]


def split_pair(connection: sqlite3.Connection, image_asset_id: str, *, commit: bool = True) -> dict:
    """Show a pair as two photos from now on, for good (a wrong pair: two
    cameras' DSC_0001). The RAW gets the JPG's folders, as when separating
    them all."""
    row = connection.execute(
        "SELECT raw_asset_id, state FROM raw_pairs WHERE image_asset_id = ?", (image_asset_id,),
    ).fetchone()
    if row is None or row["state"] != "paired":
        return {"ok": False, "asset_id": image_asset_id}
    if is_merged(connection):
        _copy_folders(connection, image_asset_id, str(row["raw_asset_id"]))
    connection.execute("UPDATE raw_pairs SET state = 'split' WHERE image_asset_id = ?", (image_asset_id,))
    if commit:
        connection.commit()
    return {"ok": True, "asset_id": image_asset_id, "raw_asset_id": str(row["raw_asset_id"])}


def forget_assets(connection: sqlite3.Connection, asset_ids: list[str]) -> None:
    """Drop the pairs these photos were in (they are leaving the catalog)."""
    for asset_id in asset_ids:
        connection.execute(
            "DELETE FROM raw_pairs WHERE image_asset_id = ? OR raw_asset_id = ?", (asset_id, asset_id),
        )
