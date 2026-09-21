"""Location source and the single-field "contains" facets."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_registry
from media_workspace.db.browse import get_facet_values, search_facet_values
from media_workspace.db.locations import set_manual_asset_location, upsert_asset_location_from_metadata
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

PHOTOS = (  # stem, gps, caption, ocr
    ("gps_shot", (48.85, 2.35), "A neon sign over a wet street", "OPEN 24H"),
    ("manual_shot", None, "Fog over the bridge at dawn", None),
    ("nowhere", None, "A 100% plain wall", "50%_off"),
    ("unannotated", None, None, None),
)


class LocationAndTextFacetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, gps, caption, ocr in PHOTOS:
            folder = Path(self.directory.name) / ("Trips_2026" if gps else "misc")
            folder.mkdir(exist_ok=True)
            path = folder / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=gps[0] if gps else None, gps_longitude=gps[1] if gps else None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
            if gps:
                upsert_asset_location_from_metadata(self.connection, candidate.asset_id, {"gps_latitude": gps[0], "gps_longitude": gps[1]})
            if caption is not None:
                self.connection.execute(
                    "INSERT INTO asset_ai_annotations (asset_id, provider, model, caption, detected_text) VALUES (?, 'p', 'm', ?, ?)",
                    (candidate.asset_id, caption, ocr))
        set_manual_asset_location(self.connection, "image_manual_shot", 37.8, -122.4, commit=False)
        self.connection.commit()

    def stems(self, filters):
        return sorted(row["stem"] for row in list_image_assets(self.connection, "all", filters=filters))

    def test_country_and_city_come_from_the_coordinates_whatever_the_source(self):
        # A GPS fix and a manual pin never named a place; the gazetteer does.
        self.assertEqual(self.stems({"country": "FR"}), ["gps_shot"])
        self.assertEqual(self.stems({"country": "us"}), ["manual_shot"])
        self.assertEqual(self.stems({"country": ["FR", "US"]}), ["gps_shot", "manual_shot"])
        self.assertEqual(self.stems({"city": "Paris"}), ["gps_shot"])
        self.assertEqual(self.stems({"city": ["Paris", "San Francisco"]}), ["gps_shot", "manual_shot"])
        self.assertEqual(self.stems({"country": "FR", "city": "San Francisco"}), [])
        self.assertEqual(normalize_rules({"filters": {"country": ["FR"], "city": "Paris"}})["filters"],
                         {"country": "FR", "city": "Paris"})

    def test_country_and_city_options_with_names_in_both_languages(self):
        facets = get_facet_values(self.connection)
        self.assertEqual(
            [(o["value"], o["count"], o["label_en"], o["label_zh"]) for o in facets["countries"]],
            [("FR", 1, "France", "法国"), ("US", 1, "United States", "美国")],
        )
        self.assertEqual(
            [(o["value"], o["label_zh"], o["country"]) for o in facets["cities"]],
            [("Paris", "巴黎", "FR"), ("San Francisco", "旧金山", "US")],
        )
        # Picking a country narrows the cities, but not the countries themselves.
        narrowed = get_facet_values(self.connection, filters={"country": "FR"})
        self.assertEqual([o["value"] for o in narrowed["cities"]], ["Paris"])
        self.assertEqual([o["value"] for o in narrowed["countries"]], ["FR", "US"])
        self.assertEqual([o["value"] for o in search_facet_values(self.connection, "city", "旧金")], ["San Francisco"])
        self.assertEqual([o["value"] for o in search_facet_values(self.connection, "city", "pari")], ["Paris"])

    def test_a_location_that_moves_gets_its_new_city(self):
        set_manual_asset_location(self.connection, "image_gps_shot", 35.68, 139.76, commit=False)
        self.assertEqual(self.stems({"city": "Tokyo"}), ["gps_shot"])
        self.assertEqual(self.stems({"city": "Paris"}), [])

    def test_location_source_including_the_photos_with_no_location(self):
        self.assertEqual(self.stems({"location_source": "exif"}), ["gps_shot"])
        self.assertEqual(self.stems({"location_source": "manual"}), ["manual_shot"])
        self.assertEqual(self.stems({"location_source": "none"}), ["nowhere", "unannotated"])
        # Several values are OR, "none" included.
        self.assertEqual(self.stems({"location_source": ["manual", "none"]}), ["manual_shot", "nowhere", "unannotated"])
        self.assertEqual(self.stems({"location_source": ["bogus"]}), ["gps_shot", "manual_shot", "nowhere", "unannotated"])

    def test_location_source_counts_are_what_picking_each_shows(self):
        counts = {r["value"]: r["count"] for r in get_facet_values(self.connection)["location_sources"]}
        self.assertEqual(counts, {"exif": 1, "manual": 1, "none": 2})
        for value, count in counts.items():
            self.assertEqual(len(self.stems({"location_source": value})), count, value)
        # Inside another filter, and ignoring its own pick.
        inside = get_facet_values(self.connection, filters={"caption_contains": "a", "location_source": "exif"})["location_sources"]
        self.assertEqual({r["value"]: r["count"] for r in inside}, {"exif": 1, "manual": 1, "none": 1})

    def test_contains_matches_one_field_only_and_ignores_case(self):
        self.assertEqual(self.stems({"caption_contains": "NEON"}), ["gps_shot"])
        self.assertEqual(self.stems({"ocr_contains": "open"}), ["gps_shot"])
        self.assertEqual(self.stems({"ocr_contains": "neon"}), [])  # that word is in the caption, not in the picture
        self.assertEqual(self.stems({"path_contains": "trips_2026"}), ["gps_shot"])
        self.assertEqual(self.stems({"caption_contains": "   "}), ["gps_shot", "manual_shot", "nowhere", "unannotated"])

    def test_like_wildcards_in_the_text_are_literal(self):
        self.assertEqual(self.stems({"caption_contains": "100%"}), ["nowhere"])
        self.assertEqual(self.stems({"caption_contains": "%"}), ["nowhere"])  # not "everything"
        self.assertEqual(self.stems({"ocr_contains": "%_off"}), ["nowhere"])
        # "_" is one literal character, not "any character": Trips-2026 would match a wildcard.
        self.assertEqual(self.stems({"path_contains": "Trips_2026"}), ["gps_shot"])
        self.assertEqual(self.stems({"path_contains": "Trips%2026"}), [])
        self.assertEqual(self.stems({"caption_contains": "_"}), [])

    def test_they_save_into_smart_collection_rules(self):
        rules = normalize_rules({"filters": {"location_source": ["none"], "caption_contains": " fog ", "ocr_contains": ""}})
        self.assertEqual(rules["filters"], {"location_source": "none", "caption_contains": " fog "})


if __name__ == "__main__":
    unittest.main()
