"""Connection, schema migration, shared helpers.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3
import zlib
from hashlib import sha1
from pathlib import Path

from ..schema import SCHEMA_STATEMENTS, SCHEMA_VERSION
from .colors import mark_colors_current
from .locations import PLACE_DATA_VERSION, refresh_place_fields
from .migrations import SchemaMigrationError, ensure_column, migrate

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"

def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


# Searchable facet columns derived from assets.metadata_json. VIRTUAL generated
# columns compute on read (no storage, auto-synced with metadata_json) and can
# be indexed — giving fast facet filters without denormalizing or backfilling.
_FACET_COLUMNS = [
    ("meta_capture_time", "TEXT", "$.capture_time"),
    ("meta_camera_model", "TEXT", "$.camera_model"),
    ("meta_lens_model", "TEXT", "$.lens_model"),
    ("meta_iso", "INTEGER", "$.iso"),
    ("meta_aperture", "REAL", "$.aperture"),
    ("meta_shutter", "REAL", "$.shutter_speed"),
    ("meta_focal", "REAL", "$.focal_length"),
    ("meta_width", "INTEGER", "$.width"),
    ("meta_height", "INTEGER", "$.height"),
]
_FACET_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_camera ON assets(meta_camera_model)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_lens ON assets(meta_lens_model)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_iso ON assets(meta_iso)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_aperture ON assets(meta_aperture)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_focal ON assets(meta_focal)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_capture_time ON assets(meta_capture_time)",
]


# Columns added to a table after its CREATE: catalogs from before them get
# them when opened.
_LATEST_COLUMNS = [
    ("catalog_info", "place_data_version", "TEXT"),
    ("catalog_info", "colors_version", "TEXT"),
    ("assets", "app_rating", "INTEGER"),
    # Pick / reject flag, Lightroom's: 1 picked, -1 rejected, NULL or 0 none.
    ("assets", "app_flag", "INTEGER"),
    # How the photo shows: portrait / landscape / square, read off its
    # thumbnail (pixels and EXIF orientation, as the browser draws it). The
    # file's own width/height are as stored, so a camera's upright shot
    # (landscape pixels, "rotate 90°" tag) reads as landscape from them.
    # '' = the thumbnail couldn't be read; NULL = not looked at yet.
    ("assets", "display_shape", "TEXT"),
    # The description the user wrote: it wins over the AI's caption
    # (asset_ai_annotations.caption), which a run never writes here. NULL:
    # they never did (the AI's shows); '' : they cleared it (nothing shows).
    ("assets", "user_description", "TEXT"),
    ("raw_metadata_cache", "metadata_level", "TEXT NOT NULL DEFAULT 'full'"),
    ("raw_metadata_cache", "fingerprint_level", "TEXT NOT NULL DEFAULT 'head-tail'"),
    ("raw_metadata_cache", "enrichment_status", "TEXT NOT NULL DEFAULT 'done'"),
    ("jobs", "result_json", "TEXT NOT NULL DEFAULT '{}'"),
    ("jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0"),
    ("jobs", "priority", "INTEGER NOT NULL DEFAULT 50"),
    ("jobs", "pause_requested", "INTEGER NOT NULL DEFAULT 0"),
    ("jobs", "resume_cursor_json", "TEXT NOT NULL DEFAULT '{}'"),
    ("jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0"),
    ("people_asset_index", "file_size", "INTEGER"),
    ("people_asset_index", "file_mtime", "REAL"),
]

# Everything init_db brings a catalog up to, as one number: the schema version
# and what _apply_latest_schema runs. A full init stores it in the database
# header (PRAGMA user_version); a catalog carrying it needs no init again.
# One-time data fixes _apply_latest_schema makes; naming a new one here brings
# every catalog through a full init once more, so it runs.
_DATA_FIXES = ("asset-files-backfill", "hand-tag-stand-ins")
INIT_STAMP = zlib.crc32(
    repr((SCHEMA_VERSION, SCHEMA_STATEMENTS, _LATEST_COLUMNS, _FACET_COLUMNS, _FACET_INDEXES, _DATA_FIXES)).encode()
) & 0x7FFFFFFF


def _is_current(connection: sqlite3.Connection) -> bool:
    """Whether init_db has nothing to do, found with plain reads. Every
    sidecar command runs init_db, and a full init takes the write lock: while
    an import held it for a preview batch, every other command (the sidebar's
    summary, browse, job polls) waited 5 s and failed "database is locked"."""
    if connection.execute("PRAGMA user_version").fetchone()[0] != INIT_STAMP:
        return False
    try:
        row = connection.execute(
            "SELECT schema_version, place_data_version, colors_version FROM catalog_info WHERE catalog_id = 1"
        ).fetchone()
    except sqlite3.OperationalError:
        return False
    if row is None or row[0] != SCHEMA_VERSION or row[1] != PLACE_DATA_VERSION:
        return False
    if connection.execute("SELECT 1 FROM asset_colors LIMIT 1").fetchone() is None:
        from ..colors import COLORS_VERSION

        return row[2] == COLORS_VERSION  # otherwise init marks the colours current
    return True


def _backup_before_migration(connection: sqlite3.Connection) -> Path | None:
    """Copy the catalog database next to itself before a schema upgrade.

    A migration is one transaction and rolls back if it fails, so this is not
    for that. It is for afterwards: migrate() refuses a catalog NEWER than the
    app, so once upgraded the catalog no longer opens in the version that was
    fine an hour ago. The copy is the way back. One per old version, never
    overwritten; in-memory and brand-new catalogs have nothing to keep.
    """
    row = connection.execute("PRAGMA database_list").fetchone()
    db_file = row[2] if row is not None else ""
    if not db_file:
        return None
    try:
        version = connection.execute("SELECT schema_version FROM catalog_info WHERE catalog_id = 1").fetchone()
    except sqlite3.OperationalError:
        return None  # no catalog_info yet: a new catalog
    if version is None or int(version[0]) >= SCHEMA_VERSION:
        return None
    source = Path(db_file)
    target = source.with_name(f"{source.name}.schema{int(version[0])}.bak")
    if target.exists():
        return target
    # The backup API copies a consistent snapshot, WAL included; a file copy would not.
    destination = sqlite3.connect(target)
    try:
        connection.backup(destination)
    finally:
        destination.close()
    return target


def init_db(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        raise SchemaMigrationError("init_db requires a connection with no active transaction")
    if _is_current(connection):
        return

    _backup_before_migration(connection)
    connection.execute("BEGIN IMMEDIATE")
    try:
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        is_new = "catalog_info" not in tables
        if is_new and tables:
            raise SchemaMigrationError("catalog has tables but no catalog_info version record")

        if is_new:
            _apply_latest_schema(connection)
            connection.execute(
                "INSERT INTO catalog_info (catalog_id, catalog_path, schema_version) VALUES (1, '', ?)",
                (SCHEMA_VERSION,),
            )
        else:
            row = connection.execute(
                "SELECT schema_version FROM catalog_info WHERE catalog_id = 1"
            ).fetchone()
            if row is None:
                raise SchemaMigrationError("catalog_info is missing its catalog row")
            migrate(connection, int(row["schema_version"]), SCHEMA_VERSION)
            _apply_latest_schema(connection)
        refresh_place_fields(connection)
        # No colours yet means nothing from an older extraction to redo: say
        # so, or the first colours written by a preview pass would look stale
        # and the catch-up job would redo them all.
        if is_new or connection.execute("SELECT 1 FROM asset_colors LIMIT 1").fetchone() is None:
            mark_colors_current(connection)
        connection.execute(f"PRAGMA user_version = {INIT_STAMP}")

        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _apply_latest_schema(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA_STATEMENTS:
        connection.execute(statement)
    for table_name, column_name, column_spec in _LATEST_COLUMNS:
        _ensure_column(connection, table_name, column_name, column_spec)
    _backfill_asset_files(connection)
    _drop_hand_tag_stand_ins(connection)
    for name, sql_type, json_path in _FACET_COLUMNS:
        _ensure_column(
            connection,
            "assets",
            name,
            f"{sql_type} GENERATED ALWAYS AS (json_extract(metadata_json, '{json_path}')) VIRTUAL",
        )
    for index_sql in _FACET_INDEXES:
        connection.execute(index_sql)


def _drop_hand_tag_stand_ins(connection: sqlite3.Connection) -> None:
    """Tags live in asset_tags alone now (annotation.py): the Inspector, search
    and the filter all read it. Two things from before are put right once:

    - a tag added by hand made a stand-in annotation row (provider 'user',
      model 'manual', nothing else in it) when the photo had none, which made
      it count as AI-annotated — "annotate missing" skipped it, the "AI
      annotated" filter counted it. The stand-ins go;
    - any tag an annotation's own list (tags_json) has that asset_tags lacks
      is copied there, so no tag the Inspector used to show goes missing."""
    rows = connection.execute(
        "SELECT asset_id, provider, model, caption, detected_text, location_json, tags_json FROM asset_ai_annotations"
    ).fetchall()
    for row in rows:
        asset_id, provider, model, caption, detected_text, location_json, tags_json = row
        stand_in = provider == "user" and model == "manual" and not caption and detected_text is None and location_json is None
        try:
            tags = json.loads(tags_json or "[]")
        except ValueError:
            tags = []
        for tag in tags if isinstance(tags, list) else []:
            if isinstance(tag, str) and tag.strip():
                connection.execute(
                    "INSERT OR IGNORE INTO asset_tags (asset_id, tag, source, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
                    (asset_id, tag.strip(), "user" if stand_in else "ai"),
                )
        if stand_in:
            connection.execute("DELETE FROM asset_ai_annotations WHERE asset_id = ?", (asset_id,))


def _backfill_asset_files(connection: sqlite3.Connection) -> None:
    """Catalogs written before asset_files existed get the table created
    empty by SCHEMA_STATEMENTS and never a row per asset — summary() then
    counts 0 and the sidebar says "No indexed assets yet" over a populated
    gallery (e2e 38-legacy-catalog, 2026-09-17). One primary file per asset,
    keyed exactly as upsert_*_asset does; a no-op once the rows exist."""
    missing = connection.execute(
        "SELECT asset_id, canonical_path FROM assets "
        "WHERE asset_id NOT IN (SELECT asset_id FROM asset_files)"
    ).fetchall()
    for asset_id, canonical_path in missing:
        connection.execute(
            "INSERT OR IGNORE INTO asset_files (file_id, asset_id, path, role) VALUES (?, ?, ?, 'primary')",
            (_file_id(asset_id, canonical_path), asset_id, canonical_path),
        )


def _ensure_column(connection: sqlite3.Connection, table_name: str, column_name: str, column_spec: str) -> None:
    ensure_column(connection, table_name, column_name, column_spec)


def set_catalog_path(connection: sqlite3.Connection, catalog_path: Path) -> None:
    connection.execute(
        """
        UPDATE catalog_info
        SET catalog_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE catalog_id = 1
        """,
        (str(catalog_path.resolve()),),
    )
    connection.commit()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _file_id(asset_id: str, path: str) -> str:
    digest = sha1(path.encode("utf-8")).hexdigest()[:16]
    return f"file_{asset_id}_{digest}"


def _preview_cache_key(asset_id: str, kind: str) -> str:
    # One row per (asset, kind): the browse query joins preview_entries once
    # per kind, so a second row shows the photo twice (four times, both kinds).
    return f"preview_{sha1(f'{asset_id}:{kind}'.encode()).hexdigest()[:20]}"
