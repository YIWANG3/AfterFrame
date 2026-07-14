"""Connection, schema migration, shared helpers.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3
from hashlib import sha1
from pathlib import Path

from ..schema import SCHEMA_STATEMENTS, SCHEMA_VERSION
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


def init_db(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        raise SchemaMigrationError("init_db requires a connection with no active transaction")

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

        connection.commit()
    except Exception:
        connection.rollback()
        raise


def _apply_latest_schema(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA_STATEMENTS:
        connection.execute(statement)
    _ensure_column(connection, "assets", "app_rating", "INTEGER")
    _ensure_column(connection, "raw_metadata_cache", "metadata_level", "TEXT NOT NULL DEFAULT 'full'")
    _ensure_column(connection, "raw_metadata_cache", "fingerprint_level", "TEXT NOT NULL DEFAULT 'head-tail'")
    _ensure_column(connection, "raw_metadata_cache", "enrichment_status", "TEXT NOT NULL DEFAULT 'done'")
    _ensure_column(connection, "jobs", "result_json", "TEXT NOT NULL DEFAULT '{}'")
    _ensure_column(connection, "jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(connection, "jobs", "priority", "INTEGER NOT NULL DEFAULT 50")
    _ensure_column(connection, "jobs", "pause_requested", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(connection, "jobs", "resume_cursor_json", "TEXT NOT NULL DEFAULT '{}'")
    _ensure_column(connection, "jobs", "attempt_count", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(connection, "people_asset_index", "file_size", "INTEGER")
    _ensure_column(connection, "people_asset_index", "file_mtime", "REAL")
    for name, sql_type, json_path in _FACET_COLUMNS:
        _ensure_column(
            connection,
            "assets",
            name,
            f"{sql_type} GENERATED ALWAYS AS (json_extract(metadata_json, '{json_path}')) VIRTUAL",
        )
    for index_sql in _FACET_INDEXES:
        connection.execute(index_sql)


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
