from __future__ import annotations

import json
from hashlib import sha1
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    cleanup_orphan_export_assets,
    connect,
    get_registry,
    init_db,
    load_raw_candidates_by_camera_token,
    set_catalog_path,
    summary,
    upsert_export_asset,
    upsert_preview_entry,
)
from media_workspace.metadata import extract_export_candidate
from media_workspace.reverse_lookup import resolve_export, resolve_export_batch
from media_workspace.scanner import scan_raw_directory


class ReverseLookupTest(unittest.TestCase):
    def test_plain_files_resolve_by_stem_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            raw_file = raw_dir / "B0023524.CR3"
            raw_file.write_bytes(b"raw-binary-placeholder")

            export_file = export_dir / "B0023524-2.jpg"
            export_file.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            scan_result = scan_raw_directory(connection, raw_dir)
            self.assertEqual(scan_result["indexed"], 1)

            decision = resolve_export(connection, export_file)
            self.assertEqual(decision.status, "auto_bound")
            self.assertIsNotNone(decision.raw_asset_id)

            registry = get_registry(connection, export_file)
            self.assertIsNotNone(registry)
            self.assertGreaterEqual(float(registry["score"]), 0.85)

            candidates = json.loads(registry["candidate_json"])
            self.assertEqual(candidates[0]["stem_key"], "b0023524")

    def test_plain_files_without_stem_match_stay_unmatched(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            (raw_dir / "IMG_1001.CR3").write_bytes(b"raw-binary-placeholder")
            export_file = export_dir / "cover-final.jpg"
            export_file.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            scan_raw_directory(connection, raw_dir)
            decision = resolve_export(connection, export_file)

            self.assertEqual(decision.status, "unmatched")
            self.assertIsNone(decision.raw_asset_id)

    def test_batch_resolve_reports_status_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            (raw_dir / "B0023524.CR3").write_bytes(b"raw-binary-placeholder")

            matched_export = export_dir / "B0023524-2.jpg"
            matched_export.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )
            unmatched_export = export_dir / "cover-final.jpg"
            unmatched_export.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            scan_raw_directory(connection, raw_dir)
            result = resolve_export_batch(connection, [export_dir])

            self.assertEqual(result["processed"], 2)
            self.assertEqual(result["status_counts"]["auto_bound"], 1)
            self.assertEqual(result["status_counts"]["unmatched"], 1)

    def test_img_sequence_without_matching_number_stays_unmatched(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            raw_dir = root / "raw"
            export_dir = root / "exports"
            raw_dir.mkdir()
            export_dir.mkdir()

            (raw_dir / "IMG_3746.CR2").write_bytes(b"raw-binary-placeholder")
            export_file = export_dir / "IMG_4274.png"
            export_file.write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + b"\x00\x00\x00\rIHDR"
                + b"\x00\x00\x0f\x00"
                + b"\x00\x00\x0a\x00"
                + b"\x08\x02\x00\x00\x00"
                + b"\x00\x00\x00\x00"
            )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            scan_raw_directory(connection, raw_dir)
            decision = resolve_export(connection, export_file)

            self.assertEqual(decision.status, "unmatched")
            self.assertIsNone(decision.raw_asset_id)
            self.assertEqual(load_raw_candidates_by_camera_token(connection, "img-4274"), [])

    def test_export_path_reuses_existing_asset_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            export_dir = root / "exports"
            export_dir.mkdir()

            export_file = export_dir / "B0023524-2.jpg"
            export_file.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            export = extract_export_candidate(export_file)
            asset_id = upsert_export_asset(connection, export)

            replacement = extract_export_candidate(export_file)
            replacement.asset_id = f"export_{sha1(b'alt').hexdigest()[:24]}"
            reused_asset_id = upsert_export_asset(connection, replacement)

            self.assertEqual(reused_asset_id, asset_id)
            self.assertEqual(summary(connection)["export_assets"], 1)

    def test_cleanup_orphan_export_assets_migrates_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            export_dir = root / "exports"
            export_dir.mkdir()

            export_file = export_dir / "B0023524-2.jpg"
            export_file.write_bytes(
                b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
                b"\xff\xc0\x00\x11\x08\x03\x00\x04\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
            )

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            export = extract_export_candidate(export_file)
            active_asset_id = upsert_export_asset(connection, export)

            orphan_asset_id = f"export_{sha1(b'orphan').hexdigest()[:24]}"
            connection.execute(
                """
                INSERT INTO assets (
                    asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, extension,
                    fingerprint, file_size, modified_time, metadata_json
                ) VALUES (?, 'export', ?, ?, ?, ?, ?, ?, ?, ?, '{}')
                """,
                (
                    orphan_asset_id,
                    str(export.path),
                    export.stem,
                    export.normalized_stem,
                    export.stem_key,
                    export.extension,
                    export.fingerprint,
                    export.file_size,
                    export.modified_time,
                ),
            )
            upsert_preview_entry(
                connection,
                orphan_asset_id,
                kind="preview",
                relative_path="previews/orphan.jpg",
                width=120,
                height=80,
                status="ready",
            )

            payload = cleanup_orphan_export_assets(connection)

            self.assertEqual(payload["found"], 1)
            self.assertEqual(payload["deleted"], 1)
            self.assertEqual(payload["previews_migrated"], 1)
            self.assertEqual(summary(connection)["export_assets"], 1)
            self.assertIsNone(
                connection.execute("SELECT 1 FROM assets WHERE asset_id = ?", (orphan_asset_id,)).fetchone()
            )
            preview_row = connection.execute(
                "SELECT relative_path FROM preview_entries WHERE asset_id = ? AND kind = 'preview'",
                (active_asset_id,),
            ).fetchone()
            self.assertIsNotNone(preview_row)
            self.assertEqual(preview_row["relative_path"], "previews/orphan.jpg")


if __name__ == "__main__":
    unittest.main()
