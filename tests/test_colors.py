"""Dominant colours: extraction, the colour filter, and how the rows get there."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from media_workspace.catalog import ensure_catalog
from media_workspace.colors import extract_palette, palette_from_pixels, parse_hex
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import get_facet_values
from media_workspace.db.colors import color_status, get_asset_colors
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.job_runner import run_colors_job
from media_workspace.models import ImageCandidate, MatchDecision
from media_workspace.preview_service import PreviewService


def paint(path: Path, *bands: tuple[str, float]) -> None:
    """A 120×80 JPEG of vertical bands: (hex, width share)."""
    image = Image.new("RGB", (120, 80))
    x = 0
    for hex_color, share in bands:
        width = round(120 * share)
        image.paste(parse_hex(hex_color), (x, 0, x + width, 80))
        x += width
    image.save(path, quality=95)


class PaletteTest(unittest.TestCase):
    def test_bands_come_back_in_order_of_cover_with_their_share(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bands.jpg"
            paint(path, ("#3060c0", 0.6), ("#e04020", 0.3), ("#f0f0f0", 0.1))
            palette = extract_palette(path)
        self.assertEqual(len(palette), 3)
        self.assertAlmostEqual(palette[0]["share"], 0.6, delta=0.05)
        self.assertAlmostEqual(palette[1]["share"], 0.3, delta=0.05)
        # JPEG nudges the values; the hue is what matters.
        r, g, b = parse_hex(palette[0]["hex"])
        self.assertTrue(b > r and b > g)
        r, g, b = parse_hex(palette[1]["hex"])
        self.assertTrue(r > g and r > b)

    def test_near_shades_of_one_area_are_merged_and_noise_is_dropped(self):
        palette = palette_from_pixels(
            [(100, 150, 200), (104, 152, 198), (250, 10, 10), (20, 20, 20)],
            [500, 400, 90, 5],
        )
        self.assertEqual([round(s["share"], 2) for s in palette], [0.9, 0.09])

    def test_unreadable_file_gives_no_palette(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "x.jpg"
            path.write_bytes(b"not an image")
            self.assertEqual(extract_palette(path), [])

    def test_hex_forms(self):
        self.assertEqual(parse_hex("#3A7"), (51, 170, 119))
        self.assertEqual(parse_hex("ff0000"), (255, 0, 0))
        self.assertIsNone(parse_hex("#12345"))
        self.assertIsNone(parse_hex(None))


PHOTOS = {  # stem: bands
    "sea": (("#2060c0", 0.7), ("#f8f8f8", 0.3)),
    "sunset": (("#e06020", 0.5), ("#f0c040", 0.3), ("#402030", 0.2)),
    "night": (("#101018", 0.99), ("#ffffff", 0.01)),
}


class ColorFilterTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.catalog = ensure_catalog(root / "demo.afcatalog")
        self.connection = connect(self.catalog.root / "catalog.sqlite3")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, bands in PHOTOS.items():
            path = root / f"{stem}.jpg"
            paint(path, *bands)
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=120, height=80,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def render_previews(self):
        """Previews through the service; sips is replaced by a plain resize."""
        service = PreviewService(self.catalog)

        def fake_sips(source, output, size, validate=None):
            with Image.open(source) as image:
                image.thumbnail((size, size))
                image.save(output)
            return output

        with patch.object(PreviewService, "_render_with_sips", side_effect=fake_sips):
            return service.generate_batch(self.connection, kind="preview", asset_type="image")

    def test_previews_bring_their_colours_and_the_filter_finds_by_shade(self):
        self.assertEqual(get_facet_values(self.connection)["colors_analyzed"], 0)
        result = self.render_previews()
        self.assertEqual(result["generated"], 3)
        self.assertEqual(color_status(self.connection), {"analyzed": 3, "missing": 0, "stale": False})
        self.assertEqual(get_facet_values(self.connection)["colors_analyzed"], 3)
        sea = get_asset_colors(self.connection, "image_sea")
        self.assertEqual(len(sea), 2)
        self.assertGreater(sea[0]["share"], sea[1]["share"])

        # Any colour, not a fixed list: a nearby blue finds the sea.
        self.assertEqual(self.stems({"color": "#3070d0"}), ["sea"])
        self.assertEqual(self.stems({"color": "#3070d0", "color_tolerance": "strict"}), ["sea"])
        self.assertEqual(self.stems({"color": "#e07030"}), ["sunset"])
        # White covers 30% of the sea photo; the sliver in the night photo
        # is not enough to call it a white photo.
        self.assertEqual(self.stems({"color": "#ffffff", "color_tolerance": "strict"}), ["sea"])
        self.assertEqual(self.stems({"color": ["#3070d0", "#e07030"]}), ["sea", "sunset"])
        self.assertEqual(self.stems({"color": "#00ff00"}), [])
        self.assertEqual(self.stems({"color": "#00ff00", "color_tolerance": "loose"}), [])
        self.assertEqual(self.stems({"color": "not-a-colour"}), ["night", "sea", "sunset"])  # ignored, not empty

    def test_the_colours_job_fills_photos_whose_preview_predates_them(self):
        self.render_previews()
        self.connection.execute("DELETE FROM asset_colors")
        self.connection.commit()
        self.assertEqual(color_status(self.connection)["missing"], 3)
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('job-1', 'colors', 'queued', '{}', '{}')"
        )
        self.connection.commit()

        result = run_colors_job(self.connection, self.catalog.root, "job-1")

        self.assertEqual(result, {"analyzed": 3, "failed": 0, "total": 3})
        self.assertEqual(color_status(self.connection), {"analyzed": 3, "missing": 0, "stale": False})
        self.assertEqual(self.connection.execute("SELECT status FROM jobs WHERE job_id = 'job-1'").fetchone()[0], "succeeded")

    def test_colours_from_an_older_extraction_are_redone_on_the_next_run(self):
        self.render_previews()
        self.connection.execute("UPDATE catalog_info SET colors_version = 'older'")
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('job-3', 'colors', 'queued', '{}', '{}')"
        )
        self.connection.commit()
        self.assertTrue(color_status(self.connection)["stale"])
        self.assertEqual(run_colors_job(self.connection, self.catalog.root, "job-3")["total"], 3)
        self.assertFalse(color_status(self.connection)["stale"])

    def test_force_redoes_photos_that_already_have_colours(self):
        self.render_previews()
        self.connection.execute("UPDATE asset_colors SET hex = '#000000'")
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('job-2', 'colors', 'queued', '{}', '{}')"
        )
        self.connection.commit()
        self.assertEqual(run_colors_job(self.connection, self.catalog.root, "job-2")["total"], 0)
        self.assertEqual(run_colors_job(self.connection, self.catalog.root, "job-2", force=True)["total"], 3)
        self.assertNotEqual(get_asset_colors(self.connection, "image_sea")[0]["hex"], "#000000")

    def test_a_second_preview_pass_fills_colours_without_rerendering(self):
        self.render_previews()
        self.connection.execute("DELETE FROM asset_colors WHERE asset_id = 'image_sea'")
        self.connection.commit()
        result = self.render_previews()
        self.assertEqual((result["generated"], result["skipped"]), (0, 3))
        self.assertEqual(color_status(self.connection)["missing"], 0)

    def test_colour_rules_save_with_their_tolerance(self):
        rules = normalize_rules({"filters": {"color": ["#3070d0"], "color_tolerance": "loose"}})
        self.assertEqual(rules["filters"], {"color": "#3070d0", "color_tolerance": "loose"})
        with self.assertRaises(ValueError):
            normalize_rules({"filters": {"color_tolerance": "loose"}})  # a modifier alone is no condition
