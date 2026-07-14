"""Ordered, transactional catalog schema migrations."""
from __future__ import annotations

import sqlite3
from collections.abc import Callable


MIN_SUPPORTED_SCHEMA_VERSION = 2


class SchemaMigrationError(RuntimeError):
    """Raised when a catalog cannot be migrated without risking data loss."""


def _table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone() is not None


def ensure_column(
    connection: sqlite3.Connection,
    table_name: str,
    column_name: str,
    column_spec: str,
) -> None:
    columns = {
        row["name"]
        for row in connection.execute(f"PRAGMA table_xinfo({table_name})").fetchall()
    }
    if column_name not in columns:
        connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_spec}")


def _migrate_to_3(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            setting_key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _migrate_to_4(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS resource_sets (
            set_id TEXT PRIMARY KEY,
            primary_asset_id TEXT NOT NULL,
            raw_asset_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(primary_asset_id) REFERENCES assets(asset_id),
            FOREIGN KEY(raw_asset_id) REFERENCES assets(asset_id)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS resource_set_items (
            set_id TEXT NOT NULL,
            asset_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('primary', 'raw', 'version')),
            version_kind TEXT,
            parent_asset_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (set_id, asset_id),
            FOREIGN KEY(set_id) REFERENCES resource_sets(set_id) ON DELETE CASCADE,
            FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
            FOREIGN KEY(parent_asset_id) REFERENCES assets(asset_id)
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_resource_sets_primary ON resource_sets(primary_asset_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_resource_set_items_asset ON resource_set_items(asset_id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_resource_set_items_parent ON resource_set_items(parent_asset_id)")


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


def _migrate_to_5(connection: sqlite3.Connection) -> None:
    for name, sql_type, json_path in _FACET_COLUMNS:
        ensure_column(
            connection,
            "assets",
            name,
            f"{sql_type} GENERATED ALWAYS AS (json_extract(metadata_json, '{json_path}')) VIRTUAL",
        )
    for name, column in (
        ("idx_assets_meta_camera", "meta_camera_model"),
        ("idx_assets_meta_lens", "meta_lens_model"),
        ("idx_assets_meta_iso", "meta_iso"),
        ("idx_assets_meta_aperture", "meta_aperture"),
        ("idx_assets_meta_focal", "meta_focal"),
        ("idx_assets_meta_capture_time", "meta_capture_time"),
    ):
        connection.execute(f"CREATE INDEX IF NOT EXISTS {name} ON assets({column})")


def _migrate_to_6(connection: sqlite3.Connection) -> None:
    has_export_registry = _table_exists(connection, "export_lookup_registry")
    has_image_registry = _table_exists(connection, "image_lookup_registry")
    if not has_export_registry and not has_image_registry:
        raise SchemaMigrationError("schema v5 catalog is missing export_lookup_registry")

    if has_export_registry and not has_image_registry:
        connection.execute("ALTER TABLE export_lookup_registry RENAME TO image_lookup_registry")
        connection.execute("ALTER TABLE image_lookup_registry RENAME COLUMN export_path TO image_path")
        connection.execute("ALTER TABLE image_lookup_registry RENAME COLUMN export_asset_id TO image_asset_id")
    elif has_export_registry:
        conflict = connection.execute(
            """
            SELECT 1
            FROM export_lookup_registry AS legacy
            JOIN image_lookup_registry AS current
              ON current.image_path = legacy.export_path
            WHERE current.image_asset_id IS NOT legacy.export_asset_id
               OR current.raw_asset_id IS NOT legacy.raw_asset_id
               OR current.match_status IS NOT legacy.match_status
               OR current.score IS NOT legacy.score
               OR current.resolver_version IS NOT legacy.resolver_version
               OR current.feature_vector_json IS NOT legacy.feature_vector_json
               OR current.candidate_json IS NOT legacy.candidate_json
            LIMIT 1
            """
        ).fetchone()
        if conflict is not None:
            raise SchemaMigrationError(
                "legacy and current lookup registries contain conflicting rows"
            )
        connection.execute(
            """
            INSERT OR IGNORE INTO image_lookup_registry (
                image_path, image_asset_id, raw_asset_id, match_status, score,
                resolver_version, feature_vector_json, candidate_json,
                confirmed_at, created_at, updated_at
            )
            SELECT
                export_path, export_asset_id, raw_asset_id, match_status, score,
                resolver_version, feature_vector_json, candidate_json,
                confirmed_at, created_at, updated_at
            FROM export_lookup_registry
            """
        )
        connection.execute("DROP TABLE export_lookup_registry")

    connection.execute("UPDATE assets SET asset_type = 'image' WHERE asset_type = 'export'")
    connection.execute("UPDATE catalog_roots SET root_type = 'image' WHERE root_type = 'export'")
    connection.execute("DROP INDEX IF EXISTS idx_registry_export_asset")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_registry_image_asset ON image_lookup_registry(image_asset_id)"
    )


def _migrate_to_7(connection: sqlite3.Connection) -> None:
    for statement in (
        """
        CREATE TABLE IF NOT EXISTS face_models (
            model_id TEXT NOT NULL,
            model_version TEXT NOT NULL,
            kind TEXT NOT NULL,
            manifest_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready',
            installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (model_id, model_version)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS people_asset_index (
            asset_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            model_version TEXT NOT NULL,
            input_hash TEXT,
            status TEXT NOT NULL,
            face_count INTEGER NOT NULL DEFAULT 0,
            error_text TEXT,
            file_size INTEGER,
            file_mtime REAL,
            indexed_at TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (asset_id, model_id, model_version),
            FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
            FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS asset_faces (
            face_id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            model_version TEXT NOT NULL,
            bbox_json TEXT NOT NULL,
            landmarks_json TEXT NOT NULL,
            quality TEXT NOT NULL,
            detection_confidence REAL NOT NULL,
            embedding_blob BLOB NOT NULL,
            thumbnail_key TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
            FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS person_groups (
            group_id TEXT PRIMARY KEY,
            model_id TEXT NOT NULL,
            model_version TEXT NOT NULL,
            name TEXT,
            state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'confirmed', 'ignored')),
            cover_face_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE,
            FOREIGN KEY(cover_face_id) REFERENCES asset_faces(face_id) ON DELETE SET NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS person_group_faces (
            group_id TEXT NOT NULL,
            face_id TEXT NOT NULL UNIQUE,
            membership_state TEXT NOT NULL DEFAULT 'automatic' CHECK (membership_state IN ('automatic', 'confirmed', 'rejected')),
            source TEXT NOT NULL DEFAULT 'automatic' CHECK (source IN ('automatic', 'user_confirmed', 'user_split', 'user_merged')),
            reviewed_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_id, face_id),
            FOREIGN KEY(group_id) REFERENCES person_groups(group_id) ON DELETE CASCADE,
            FOREIGN KEY(face_id) REFERENCES asset_faces(face_id) ON DELETE CASCADE
        )
        """,
    ):
        connection.execute(statement)

    for column_name, column_spec in (
        ("priority", "INTEGER NOT NULL DEFAULT 50"),
        ("pause_requested", "INTEGER NOT NULL DEFAULT 0"),
        ("resume_cursor_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("attempt_count", "INTEGER NOT NULL DEFAULT 0"),
    ):
        ensure_column(connection, "jobs", column_name, column_spec)

    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_people_asset_index_model_status "
        "ON people_asset_index(model_id, model_version, status)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_asset_faces_asset_model "
        "ON asset_faces(asset_id, model_id, model_version)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_person_groups_model_state "
        "ON person_groups(model_id, model_version, state)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_person_group_faces_face ON person_group_faces(face_id)"
    )


MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {
    3: _migrate_to_3,
    4: _migrate_to_4,
    5: _migrate_to_5,
    6: _migrate_to_6,
    7: _migrate_to_7,
}


def migrate(connection: sqlite3.Connection, current_version: int, target_version: int) -> None:
    if current_version < MIN_SUPPORTED_SCHEMA_VERSION:
        raise SchemaMigrationError(
            f"catalog schema v{current_version} is older than the supported v{MIN_SUPPORTED_SCHEMA_VERSION}"
        )
    if current_version > target_version:
        raise SchemaMigrationError(
            f"catalog schema v{current_version} is newer than this app's v{target_version}"
        )

    for version in range(current_version + 1, target_version + 1):
        migration = MIGRATIONS.get(version)
        if migration is None:
            raise SchemaMigrationError(f"missing migration for schema v{version}")
        migration(connection)
        connection.execute(
            "UPDATE catalog_info SET schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE catalog_id = 1",
            (version,),
        )
