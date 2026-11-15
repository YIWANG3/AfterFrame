"""The statistics page (db/stats.py catalog_stats) and the camera names it
shows (camera_names.py)."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.camera_names import camera_label, crop_factor
from media_workspace.db import connect, init_db, upsert_image_asset, upsert_registry
from media_workspace.db.stats import TIMELINE_MONTHS, catalog_stats
from media_workspace.models import ImageCandidate, MatchDecision


class CameraNamesTests(unittest.TestCase):
    def test_labels_read_as_people_say_them(self):
        self.assertEqual(camera_label("SONY", "ILCE-7CM2"), "Sony A7C II")
        self.assertEqual(camera_label("SONY", "ILCE-6700"), "Sony A6700")
        self.assertEqual(camera_label("FUJIFILM", "X-T5"), "Fujifilm X-T5")
        self.assertEqual(camera_label("RICOH IMAGING COMPANY, LTD.", "RICOH GR IIIx"), "Ricoh GR IIIx")
        self.assertEqual(camera_label("RICOH IMAGING COMPANY, LTD.", "PENTAX K-1 Mark II"), "Pentax K-1 Mark II")
        self.assertEqual(camera_label("Canon", "Canon EOS R5"), "Canon EOS R5")
        self.assertEqual(camera_label("NIKON CORPORATION", "NIKON Z 6_2"), "Nikon Z 6 II")
        self.assertEqual(camera_label("Apple", "iPhone 16 Pro"), "iPhone 16 Pro")
        self.assertIsNone(camera_label("Canon", "  "))

    def test_crop_factors_of_known_bodies_only(self):
        self.assertEqual(crop_factor("Sony A7C II"), 1.0)
        self.assertEqual(crop_factor("Sony A6700"), 1.5)
        self.assertEqual(crop_factor("Fujifilm X-T5"), 1.5)
        self.assertEqual(crop_factor("Fujifilm GFX100S"), 0.79)
        self.assertEqual(crop_factor("Canon EOS R7"), 1.6)
        self.assertEqual(crop_factor("Canon EOS R5"), 1.0)
        self.assertEqual(crop_factor("Nikon Z fc"), 1.5)
        self.assertEqual(crop_factor("Ricoh GR IIIx"), 1.53)
        self.assertIsNone(crop_factor("iPhone 16 Pro"))
        self.assertIsNone(crop_factor(None))


class CatalogStatsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)

    def add(self, stem, *, make="FUJIFILM", model="X-T5", lens="XF33mmF1.4 R LM WR", captured="2026-03-14T17:05:00",
            iso=400, aperture=1.4, shutter=1 / 250, focal=33.0, size=10, flag=None, rating=None,
            extension=".jpg", asset_type="image", raw_id=None):
        path = Path(self.directory.name) / f"{stem}{extension}"
        path.write_bytes(b"x")
        candidate = ImageCandidate(
            asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
            extension=extension, fingerprint=f"fp-{stem}", file_size=size, modified_time="2026-01-01T00:00:00",
            capture_time=captured, rating=None, camera_make=make, camera_model=model,
            lens_model=lens, software=None, iso=iso, aperture=aperture, shutter_speed=shutter, focal_length=focal,
            flash=None, white_balance=None, color_space=None, lens_specification=None,
            gps_latitude=None, gps_longitude=None, width=6000, height=4000,
        )
        asset_id = upsert_image_asset(self.connection, candidate)
        if asset_type != "image":
            self.connection.execute("UPDATE assets SET asset_type = ? WHERE asset_id = ?", (asset_type, asset_id))
        self.connection.execute("UPDATE assets SET app_flag = ?, app_rating = ? WHERE asset_id = ?", (flag, rating, asset_id))
        upsert_registry(self.connection, MatchDecision(
            image_asset_id=asset_id, image_path=path, status="auto_bound" if raw_id else "unmatched",
            score=1.0 if raw_id else 0.0, raw_asset_id=raw_id, feature_vector={},
        ))
        return asset_id

    def add_raw(self, stem, size):
        self.connection.execute(
            """
            INSERT INTO assets (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
                                extension, fingerprint, file_size, modified_time, metadata_json)
            VALUES (?, 'raw', ?, ?, ?, ?, '.raf', ?, ?, '2026-01-01T00:00:00', '{"capture_time": "2026-03-14T17:05:00"}')
            """,
            (f"raw_{stem}", f"/raw/{stem}.raf", stem, stem, stem, f"fp-raw-{stem}", size),
        )
        return f"raw_{stem}"

    def test_cameras_lenses_and_combos(self):
        self.add("a", flag=1)
        self.add("b", flag=-1)
        self.add("c", lens="XF56mmF1.2 R WR")
        self.add("d", make="SONY", model="ILCE-7CM2", lens="FE 85mm F1.8")
        self.add("e", make=None, model=None, lens=None)
        gear = catalog_stats(self.connection)["gear"]

        fuji, sony = gear["cameras"]
        self.assertEqual((fuji["model"], fuji["label"], fuji["count"]), ("X-T5", "Fujifilm X-T5", 3))
        self.assertEqual((fuji["picks"], fuji["rejects"]), (1, 1))
        self.assertEqual(fuji["top_lens"], "XF33mmF1.4 R LM WR")
        self.assertEqual(sony["label"], "Sony A7C II")
        self.assertEqual(len(fuji["monthly"]), TIMELINE_MONTHS)
        self.assertEqual(gear["months"][-1], "2026-03")
        self.assertEqual(fuji["monthly"][-1], 3)
        self.assertEqual(gear["without_camera"], 1)

        self.assertEqual([(lens["lens"], lens["count"], lens["camera"]) for lens in gear["lenses"]], [
            ("XF33mmF1.4 R LM WR", 2, "Fujifilm X-T5"),
            ("FE 85mm F1.8", 1, "Sony A7C II"),
            ("XF56mmF1.2 R WR", 1, "Fujifilm X-T5"),
        ])
        self.assertEqual(gear["without_lens"], 1)
        self.assertEqual(gear["combos"][0], {"model": "X-T5", "camera": "Fujifilm X-T5", "lens": "XF33mmF1.4 R LM WR", "count": 2})

    def test_exposure_bins_fill_the_gaps_and_keep_the_range(self):
        self.add("a", aperture=1.7, shutter=1 / 250, iso=100)
        self.add("b", aperture=1.8, shutter=1 / 60, iso=400, flag=-1)
        self.add("c", aperture=4.0, shutter=1 / 64, iso=6400)
        exposure = catalog_stats(self.connection)["exposure"]

        aperture = {b["label"]: b for b in exposure["aperture"]}
        self.assertEqual(list(aperture), ["1.8", "2", "2.8", "4"])
        self.assertEqual((aperture["1.8"]["count"], aperture["1.8"]["min"], aperture["1.8"]["max"]), (2, 1.7, 1.8))
        self.assertEqual(aperture["2"]["count"], 0)

        shutter = [(b["label"], b["count"], b["rejects"]) for b in exposure["shutter"]]
        self.assertEqual(shutter, [("1/250", 1, 0), ("1/125", 0, 0), ("1/60", 2, 1)])

        self.assertEqual([b["label"] for b in exposure["iso"]], ["100", "200", "400", "800", "1600", "3200", "6400"])

    def test_focal_lengths_are_35mm_equivalent_and_unknown_bodies_apart(self):
        self.add("a", focal=33.0)  # X-T5: 49.5 → 50
        self.add("b", make="SONY", model="ILCE-7CM2", focal=85.0)
        self.add("c", make="Apple", model="iPhone 16 Pro", focal=6.86)
        focal = catalog_stats(self.connection)["exposure"]["focal"]
        counts = {b["label"]: b["count"] for b in focal["bins"]}
        self.assertEqual(counts["50"], 1)
        self.assertEqual(counts["85"], 1)
        self.assertEqual(counts["60"], 0)
        self.assertEqual(focal["unknown"], 1)

    def test_culling_counts_photos_not_videos(self):
        self.add("a", flag=1, rating=5)
        self.add("b", flag=-1)
        self.add("c", rating=3)
        self.add("d")
        self.add("v", asset_type="video", extension=".mov", flag=1)
        stats = catalog_stats(self.connection)
        culling = stats["culling"]
        self.assertEqual(culling["total"], 4)
        self.assertEqual((culling["reviewed"], culling["unreviewed"]), (3, 1))
        self.assertEqual((culling["picks"], culling["rejects"], culling["rated4"]), (1, 1, 1))
        self.assertEqual(culling["ratings"], [0, 0, 1, 0, 1])
        self.assertEqual((stats["overview"]["photos"], stats["overview"]["videos"]), (4, 1))
        self.assertEqual(stats["formats"]["video"], 1)

    def test_storage_counts_a_shared_raw_once(self):
        raw = self.add_raw("r", size=1000)
        self.add("a", size=10, raw_id=raw)
        self.add("b", size=20, raw_id=raw)  # a second version of the same RAW
        self.add("c", size=5, flag=-1)
        storage = catalog_stats(self.connection)["storage"]
        self.assertEqual(storage["by_kind"], {"raw": 1000, "jpeg": 35})
        self.assertEqual(storage["total_bytes"], 1035)
        self.assertEqual(storage["rejected"], {"count": 1, "bytes": 5})
        self.assertEqual(storage["by_year"], [{"year": "2026", "bytes": 1035}])
        formats = catalog_stats(self.connection)["formats"]
        self.assertEqual((formats["raw_pair"], formats["jpeg"]), (2, 1))

    def test_lookalike_groups_keep_their_best_photo(self):
        ids = [self.add(stem, size=size, rating=rating) for stem, size, rating in (("a", 10, 4), ("b", 20, 1), ("c", 30, 0))]
        lone = self.add("d")
        for asset_id in ids:
            self.connection.execute("INSERT INTO asset_visual (asset_id, phash, dup_group) VALUES (?, 1, 'g1')", (asset_id,))
        self.connection.execute("INSERT INTO asset_visual (asset_id, phash, dup_group) VALUES (?, 2, 'g2')", (lone,))
        lookalikes = catalog_stats(self.connection)["storage"]["lookalikes"]
        self.assertEqual(lookalikes, {"groups": 1, "count": 2, "bytes": 50})

    def test_filters_narrow_the_set_like_the_gallery(self):
        self.add("old", captured="2024-05-01T10:00:00")
        self.add("new", captured="2026-03-14T08:30:00")
        self.add("newer", captured="2026-03-15T21:10:00")
        stats = catalog_stats(self.connection, {"date_from": "2026-01-01"})
        self.assertEqual(stats["overview"]["total"], 2)
        self.assertEqual(stats["overview"]["days"], 2)
        self.assertEqual(stats["rhythm"]["days"], [["2026-03-14", 1], ["2026-03-15", 1]])
        self.assertEqual(stats["rhythm"]["hours"][8], 1)
        self.assertEqual(stats["rhythm"]["hours"][21], 1)
        # The temp table is gone: a second call starts clean.
        self.assertEqual(catalog_stats(self.connection)["overview"]["total"], 3)

    def test_an_empty_catalog_answers_zeros(self):
        stats = catalog_stats(self.connection)
        self.assertEqual(stats["overview"]["total"], 0)
        self.assertEqual(stats["gear"]["cameras"], [])
        self.assertEqual(stats["gear"]["months"], [])
        self.assertEqual(stats["exposure"]["aperture"], [])
        self.assertEqual(stats["storage"]["total_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
