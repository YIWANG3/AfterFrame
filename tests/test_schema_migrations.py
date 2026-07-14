from __future__ import annotations

import sqlite3
import unittest
from unittest.mock import patch

from media_workspace.db import SCHEMA_VERSION, init_db
from media_workspace.db.migrations import MIGRATIONS, SchemaMigrationError


def create_v5_catalog() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE catalog_info (
            catalog_id INTEGER PRIMARY KEY CHECK (catalog_id = 1),
            catalog_path TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO catalog_info (catalog_id, catalog_path, schema_version)
        VALUES (1, '/legacy/demo.afcatalog', 5);

        CREATE TABLE catalog_roots (
            root_id TEXT PRIMARY KEY,
            root_type TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO catalog_roots (root_id, root_type, path)
        VALUES ('root_legacy', 'export', '/legacy/images');

        CREATE TABLE assets (
            asset_id TEXT PRIMARY KEY,
            asset_type TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            stem TEXT NOT NULL,
            normalized_stem TEXT NOT NULL,
            stem_key TEXT NOT NULL,
            extension TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            modified_time TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            exists_on_disk INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            app_rating INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO assets (
            asset_id, asset_type, canonical_path, stem, normalized_stem,
            stem_key, extension, fingerprint, file_size, modified_time,
            metadata_json, app_rating
        ) VALUES (
            'export_legacy', 'export', '/legacy/images/sample.jpg', 'sample',
            'sample', 'sample', '.jpg', 'fingerprint', 123, '2026-01-01',
            '{"camera_model":"Legacy Cam"}', 4
        );

        CREATE TABLE export_lookup_registry (
            export_path TEXT PRIMARY KEY,
            export_asset_id TEXT NOT NULL,
            raw_asset_id TEXT,
            match_status TEXT NOT NULL,
            score REAL NOT NULL DEFAULT 0,
            resolver_version TEXT NOT NULL,
            feature_vector_json TEXT NOT NULL DEFAULT '{}',
            candidate_json TEXT NOT NULL DEFAULT '[]',
            confirmed_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(export_asset_id) REFERENCES assets(asset_id),
            FOREIGN KEY(raw_asset_id) REFERENCES assets(asset_id)
        );
        INSERT INTO export_lookup_registry (
            export_path, export_asset_id, match_status, score,
            resolver_version, feature_vector_json, candidate_json
        ) VALUES (
            '/legacy/images/sample.jpg', 'export_legacy', 'unmatched', 0.25,
            'legacy_resolver', '{"source":"fixture"}', '["raw_candidate"]'
        );

        CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            job_type TEXT NOT NULL,
            status TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            progress REAL NOT NULL DEFAULT 0,
            error_text TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    connection.commit()
    return connection


class SchemaMigrationTest(unittest.TestCase):
    def test_all_supported_pre_rename_versions_follow_the_ordered_chain(self) -> None:
        for version in range(2, 6):
            with self.subTest(version=version):
                connection = create_v5_catalog()
                connection.execute("UPDATE catalog_info SET schema_version = ?", (version,))
                connection.commit()
                try:
                    init_db(connection)
                    self.assertEqual(
                        connection.execute("SELECT schema_version FROM catalog_info").fetchone()[0],
                        SCHEMA_VERSION,
                    )
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM image_lookup_registry").fetchone()[0],
                        1,
                    )
                finally:
                    connection.close()

    def test_v5_catalog_upgrades_without_losing_registry_data(self) -> None:
        connection = create_v5_catalog()
        self.addCleanup(connection.close)

        init_db(connection)

        info = connection.execute(
            "SELECT catalog_path, schema_version FROM catalog_info WHERE catalog_id = 1"
        ).fetchone()
        self.assertEqual(info["schema_version"], SCHEMA_VERSION)
        self.assertEqual(info["catalog_path"], "/legacy/demo.afcatalog")
        asset = connection.execute(
            "SELECT asset_id, asset_type, app_rating, meta_camera_model FROM assets"
        ).fetchone()
        self.assertEqual(dict(asset), {
            "asset_id": "export_legacy",
            "asset_type": "image",
            "app_rating": 4,
            "meta_camera_model": "Legacy Cam",
        })
        registry = connection.execute(
            "SELECT image_path, image_asset_id, candidate_json FROM image_lookup_registry"
        ).fetchone()
        self.assertEqual(registry["image_path"], "/legacy/images/sample.jpg")
        self.assertEqual(registry["image_asset_id"], "export_legacy")
        self.assertEqual(registry["candidate_json"], '["raw_candidate"]')
        self.assertIsNone(connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='export_lookup_registry'"
        ).fetchone())
        root_type = connection.execute("SELECT root_type FROM catalog_roots").fetchone()[0]
        self.assertEqual(root_type, "image")
        self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_repeated_init_is_idempotent(self) -> None:
        connection = create_v5_catalog()
        self.addCleanup(connection.close)

        init_db(connection)
        first_tables = connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        init_db(connection)
        second_tables = connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()

        self.assertEqual([tuple(row) for row in second_tables], [tuple(row) for row in first_tables])
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM image_lookup_registry").fetchone()[0], 1)
        self.assertEqual(connection.execute("SELECT schema_version FROM catalog_info").fetchone()[0], SCHEMA_VERSION)

    def test_failed_migration_rolls_back_schema_and_version(self) -> None:
        connection = create_v5_catalog()
        self.addCleanup(connection.close)

        def fail_after_schema_change(target: sqlite3.Connection) -> None:
            target.execute("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)")
            raise RuntimeError("simulated interruption")

        with patch.dict(MIGRATIONS, {6: fail_after_schema_change}):
            with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                init_db(connection)

        self.assertEqual(connection.execute("SELECT schema_version FROM catalog_info").fetchone()[0], 5)
        self.assertIsNotNone(connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='export_lookup_registry'"
        ).fetchone())
        self.assertIsNone(connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_probe'"
        ).fetchone())

    def test_newer_catalog_is_rejected_without_downgrading(self) -> None:
        connection = create_v5_catalog()
        self.addCleanup(connection.close)
        connection.execute("UPDATE catalog_info SET schema_version = 99")
        connection.commit()

        with self.assertRaisesRegex(SchemaMigrationError, "newer than this app"):
            init_db(connection)

        self.assertEqual(connection.execute("SELECT schema_version FROM catalog_info").fetchone()[0], 99)


if __name__ == "__main__":
    unittest.main()
