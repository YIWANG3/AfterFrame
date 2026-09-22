"""Which country a coordinate is in: borders first, centroids only at sea."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from media_workspace.country_shapes import load_country_shapes
from media_workspace.db import init_db
from media_workspace.db.locations import PLACE_DATA_VERSION, place_fields


class CountryBordersTest(unittest.TestCase):
    def test_a_point_near_a_border_gets_the_country_it_is_in(self):
        # Shangri-La: 300 km from the Kachin State centroid, 360 km from
        # Yunnan's. The nearest-centroid guess said Myanmar.
        self.assertEqual(place_fields(27.839, 99.661)["country_code"], "CN")
        self.assertEqual(place_fields(27.839, 99.661)["city_en"], None)  # no city within 40 km
        self.assertEqual(place_fields(26.93, 100.21), {"country_code": "CN", "city_key": "Q205914", "city_en": "Lijiang", "city_zh": "丽江市"})
        self.assertEqual(place_fields(48.58, 7.75)["country_code"], "FR")  # Strasbourg, across the Rhine from Germany
        self.assertEqual(place_fields(47.56, 7.59)["country_code"], "CH")  # Basel, 3 km from both France and Germany
        self.assertEqual(place_fields(42.31, -83.03)["country_code"], "CA")  # Windsor, across the river from Detroit
        self.assertEqual(place_fields(-29.3, 27.5)["country_code"], "LS")  # Lesotho, an enclave

    def test_the_city_is_taken_from_the_same_country(self):
        # Kreuzlingen (CH) grows into Konstanz (DE), which has far more sitelinks.
        self.assertEqual(place_fields(47.65, 9.17)["city_en"], "Kreuzlingen")

    def test_territories_and_city_states_keep_their_own_code(self):
        self.assertEqual(place_fields(22.281, 114.158)["country_code"], "HK")
        self.assertEqual(place_fields(22.281, 114.158)["city_en"], "Hong Kong")
        self.assertEqual(place_fields(22.19, 113.54)["country_code"], "MO")
        self.assertEqual(place_fields(25.04, 121.56)["country_code"], "TW")

    def test_at_sea_the_nearest_place_decides(self):
        self.assertIsNone(load_country_shapes().country_at(21.2, -157.7))  # just off Oahu
        self.assertEqual(place_fields(21.2, -157.7)["country_code"], "US")
        self.assertEqual(place_fields(10.0, -150.0)["country_code"], None)  # mid-Pacific

    def test_a_catalog_filled_with_older_place_data_is_refilled_on_open(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        connection = sqlite3.connect(Path(directory.name) / "catalog.sqlite3")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        init_db(connection)
        connection.execute(
            "INSERT INTO assets (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, "
            "extension, fingerprint, file_size, modified_time) VALUES ('a', 'export', '/a.jpg', 'a', 'a', 'a', '.jpg', 'a', 1, 't')"
        )
        connection.execute(
            "INSERT INTO asset_locations (asset_id, latitude, longitude, min_latitude, max_latitude, min_longitude, "
            "max_longitude, source, precision_level, country_code) VALUES ('a', 27.839, 99.661, 27.839, 27.839, 99.661, 99.661, 'exif', 'exact', 'MM')"
        )
        connection.execute("UPDATE catalog_info SET place_data_version = 'older'")
        connection.commit()

        init_db(connection)

        self.assertEqual(connection.execute("SELECT country_code FROM asset_locations").fetchone()[0], "CN")
        self.assertEqual(connection.execute("SELECT place_data_version FROM catalog_info").fetchone()[0], PLACE_DATA_VERSION)
