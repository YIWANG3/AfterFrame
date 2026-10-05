"""data/places.idx: built from the bundled gazetteer, and placing coordinates
exactly as the whole gazetteer does."""
from __future__ import annotations

import gzip
import hashlib
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from media_workspace import place_index  # noqa: E402
from media_workspace.discover import ReverseGeocoder  # noqa: E402
from media_workspace.geo_resolver import GAZETTEER_PATH  # noqa: E402


class PlaceIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = GAZETTEER_PATH.read_bytes()
        cls.payload = json.loads(gzip.decompress(cls.source))
        cls.index = place_index.PlaceIndex(place_index.PLACE_INDEX_PATH.read_bytes())

    def test_the_index_is_built_from_the_bundled_gazetteer(self):
        self.assertEqual(
            self.index.source_sha256, hashlib.sha256(self.source).hexdigest(),
            "data/places.idx is out of date: run python -m media_workspace.place_index",
        )

    def test_every_locality_is_in_exactly_one_tile(self):
        held = [item["q"] for tile in self.index._tiles for item in self.index.localities(tile)]
        self.assertEqual(sorted(held), sorted(item["q"] for item in self.payload["localities"]))

    def test_coordinates_are_placed_as_with_the_whole_gazetteer(self):
        whole = ReverseGeocoder(self.payload)
        tiled = ReverseGeocoder.from_index(self.index)
        rng = random.Random(7)
        # Around real places, where most photos are…
        points = [(item["lat"] + rng.uniform(-0.3, 0.3), item["lon"] + rng.uniform(-0.3, 0.3))
                  for item in rng.sample(self.payload["localities"], 800)]
        # …on tile edges, where a search spans up to four tiles…
        points += [(lat + d, lon - d) for lat in range(-40, 70, 4) for lon in (-122, -74, 2, 116, 139) for d in (1e-9, -1e-9)]
        # …and anywhere at all, the sea included.
        points += [(rng.uniform(-60, 75), rng.uniform(-180, 180)) for _ in range(200)]
        for lat, lon in points:
            self.assertEqual(tiled.lookup(lat, lon), whole.lookup(lat, lon), (lat, lon))
            self.assertEqual(tiled.localities.nearest(lat, lon, 40.0), whole.localities.nearest(lat, lon, 40.0), (lat, lon))

    def test_a_lookup_reads_only_the_tiles_around_it(self):
        tiled = ReverseGeocoder.from_index(self.index)
        self.assertEqual(tiled.lookup(48.8566, 2.3522)["en"], "Paris")
        self.assertLessEqual(len(tiled.localities._loaded), 4)

    def test_build_writes_an_index_that_reads_back(self):
        gazetteer = {
            "countries": [{"q": "Q30", "en": "United States", "lat": 39.8, "lon": -98.6, "iso": "US"}],
            "admin1": [{"q": "Q99", "en": "California", "lat": 37.2, "lon": -119.5, "country": "Q30", "links": 1}],
            "localities": [
                {"q": "Q62", "en": "San Francisco", "zh": "旧金山", "lat": 37.7749, "lon": -122.4194, "country": "Q30", "links": 235},
                {"q": "Q1", "en": "Nowhere", "lat": None, "lon": 1.0},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "gazetteer.json.gz"
            source.write_bytes(gzip.compress(json.dumps(gazetteer).encode()))
            out = Path(tmp) / "places.idx"
            self.assertEqual(place_index.build(source, out), 1)
            index = place_index.PlaceIndex(out.read_bytes())
        self.assertEqual(index.admin1, gazetteer["admin1"])
        tile = place_index.tile_of(place_index.cell_of(37.7749, -122.4194))
        self.assertEqual(index.localities(tile), [gazetteer["localities"][0]])
        self.assertEqual(index.localities((0, 0)), [])
        with self.assertRaises(ValueError):
            place_index.PlaceIndex(b"not an index")


if __name__ == "__main__":
    unittest.main()
