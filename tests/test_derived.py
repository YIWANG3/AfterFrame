from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, set_catalog_path
from media_workspace.derived import (
    _crop_box,
    create_derived_crop,
    export_assets_to_dir,
    parse_ratio,
    register_export_file,
)


class ParseRatioTest(unittest.TestCase):
    def test_common_ratios(self) -> None:
        self.assertEqual(parse_ratio("4:3"), (4.0, 3.0))
        self.assertEqual(parse_ratio("16:9"), (16.0, 9.0))
        self.assertEqual(parse_ratio("1:1"), (1.0, 1.0))
        self.assertEqual(parse_ratio("3x4"), (3.0, 4.0))  # 'x' separator tolerated

    def test_rejects_junk(self) -> None:
        for bad in ("", "4", "4:3:2", "0:3", "-1:1", "a:b"):
            with self.assertRaises(ValueError):
                parse_ratio(bad)


class CropBoxTest(unittest.TestCase):
    def test_landscape_to_16_9_center(self) -> None:
        # 800x600 → 16:9 keeps full width, crops height to 450, centered
        box = _crop_box(800, 600, 16, 9, "center")
        self.assertEqual(box, (0, 75, 800, 525))

    def test_landscape_to_16_9_top(self) -> None:
        box = _crop_box(800, 600, 16, 9, "top")
        self.assertEqual(box, (0, 0, 800, 450))

    def test_portrait_to_square_gravity_left(self) -> None:
        # 600x800 → 1:1 keeps width (narrower side), so left/right gravity
        # is a no-op on x; box is full-width 600x600
        box = _crop_box(600, 800, 1, 1, "left")
        self.assertEqual(box, (0, 100, 600, 700))

    def test_exact_ratio_is_noop(self) -> None:
        self.assertEqual(_crop_box(1600, 900, 16, 9, "center"), (0, 0, 1600, 900))

    def test_wide_to_square_right(self) -> None:
        box = _crop_box(1000, 500, 1, 1, "right")
        self.assertEqual(box, (500, 0, 1000, 500))


def _write_jpeg(path: Path, width: int = 640, height: int = 480) -> None:
    Image.new("RGB", (width, height), (120, 90, 200)).save(path, quality=90)


class RegisterAndCropTest(unittest.TestCase):
    def test_register_then_derive_crop_joins_resource_set(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            source = root / "shot.jpg"
            _write_jpeg(source, 800, 600)

            registered = register_export_file(connection, catalog, source)
            self.assertTrue(registered["asset_id"])
            self.assertEqual(registered["match_status"], "unmatched")

            derived = create_derived_crop(connection, catalog, registered["asset_id"], "1:1")
            self.assertEqual((derived["width"], derived["height"]), (600, 600))
            self.assertTrue(Path(derived["export_path"]).exists())
            self.assertEqual(derived["source_asset_id"], registered["asset_id"])

            # Both assets share one resource set; the crop is a derived version
            rows = connection.execute(
                """
                SELECT rsi.asset_id, rsi.version_kind, rsi.set_id
                FROM resource_set_items rsi
                WHERE rsi.asset_id IN (?, ?)
                ORDER BY rsi.version_kind
                """,
                (registered["asset_id"], derived["asset_id"]),
            ).fetchall()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["set_id"], rows[1]["set_id"])
            self.assertEqual(
                sorted(r["version_kind"] for r in rows), ["derived", "main"]
            )

            # Previews were generated for the derived asset
            preview = connection.execute(
                "SELECT status FROM preview_entries WHERE asset_id = ? AND kind = 'preview'",
                (derived["asset_id"],),
            ).fetchone()
            self.assertIsNotNone(preview)

    def test_register_with_version_kind_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            source = root / "base.jpg"
            _write_jpeg(source)
            base = register_export_file(connection, catalog, source)

            repaint = root / "base_ai-repaint.jpg"
            _write_jpeg(repaint)
            payload = register_export_file(
                connection, catalog, repaint, origin_path=source, version_kind="ai_repaint"
            )
            row = connection.execute(
                "SELECT version_kind FROM resource_set_items WHERE asset_id = ?",
                (payload["asset_id"],),
            ).fetchone()
            self.assertEqual(row["version_kind"], "ai_repaint")
            self.assertEqual(base["asset_id"], base["asset_id"])


class ExportAssetsTest(unittest.TestCase):
    def test_export_resize_and_transcode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)

            source = root / "big.jpg"
            _write_jpeg(source, 2000, 1000)
            registered = register_export_file(connection, catalog, source)

            dest = root / "out"
            results = export_assets_to_dir(
                connection, [registered["asset_id"]], dest, max_edge=512, fmt="webp"
            )
            self.assertEqual(len(results), 1)
            self.assertNotIn("error", results[0])
            out = Path(results[0]["path"])
            self.assertEqual(out.suffix, ".webp")
            with Image.open(out) as im:
                self.assertEqual(max(im.size), 512)

            # Unknown asset id reports a per-item error instead of raising
            bad = export_assets_to_dir(connection, ["nope"], dest)
            self.assertIn("error", bad[0])


if __name__ == "__main__":
    unittest.main()
