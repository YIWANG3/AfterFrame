"""Place search behind manual locations: type-ahead over the gazetteer.

A manual location is a named city or landmark, never a clicked coordinate (the
offline basemap is too coarse for that), so everything rests on this search
finding what a user types — in either script, most notable first.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from media_workspace import geo_resolver  # noqa: E402

FIXTURE = {
    "countries": [
        {"q": "Q17", "iso": "JP", "en": "Japan", "zh": "日本", "lat": 36.0, "lon": 138.0, "links": 380, "aliases": ["Nippon"]},
        {"q": "Q30", "iso": "US", "en": "United States of America", "zh": "美國", "lat": 39.8, "lon": -98.6,
         "links": 400, "aliases": ["USA"]},
    ],
    "admin1": [
        {"q": "Q120730", "en": "Kyoto Prefecture", "zh": "京都府", "lat": 35.02, "lon": 135.76, "country": "Q17", "links": 120},
    ],
    "localities": [
        # Wikidata's `zh` label is Traditional here, as in the real file.
        {"q": "Q1490", "en": "Tokyo", "zh": "東京都", "lat": 35.68, "lon": 139.69, "country": "Q17", "links": 299},
        {"q": "Q34600", "en": "Kyoto", "zh": "京都市", "lat": 35.01, "lon": 135.77, "country": "Q17", "links": 258},
        {"q": "Q1", "en": "Springfield", "lat": 39.8, "lon": -89.6, "country": "Q30", "links": 90},
        {"q": "Q2", "en": "Springfield", "lat": 37.2, "lon": -93.3, "country": "Q30", "links": 60},
        {"q": "Q3", "en": "West Kyoto Hills", "lat": 35.0, "lon": 135.6, "country": "Q17", "links": 500},
    ],
    "landmarks": [
        {"q": "Q183536", "en": "Tokyo Tower", "zh": "东京铁塔", "lat": 35.66, "lon": 139.75, "country": "Q17", "links": 110},
    ],
}


class PlaceSearchTestCase(unittest.TestCase):
    def setUp(self):
        geo_resolver.set_gazetteer_for_tests(FIXTURE)

    def tearDown(self):
        geo_resolver.set_gazetteer_for_tests(None)

    def names(self, query, **kwargs):
        return [r["name_en"] for r in geo_resolver.search_places(query, **kwargs)]

    def test_simplified_query_finds_a_traditional_label(self):
        # 东京 typed, 東京都 stored. Both the city and the (Simplified) landmark match.
        self.assertEqual(self.names("东京"), ["Tokyo", "Tokyo Tower"])

    def test_chinese_names_are_shown_simplified(self):
        tokyo = geo_resolver.search_places("tokyo")[0]
        self.assertEqual(tokyo["name_zh"], "东京都")
        self.assertEqual(geo_resolver.search_places("springfield")[0]["country_zh"], "美国")

    def test_prefix_matches_outrank_a_more_notable_substring_match(self):
        # "West Kyoto Hills" has the most sitelinks but only contains the query.
        self.assertEqual(self.names("kyoto"), ["Kyoto", "Kyoto Prefecture", "West Kyoto Hills"])

    def test_same_name_places_are_both_offered_most_notable_first(self):
        results = geo_resolver.search_places("springfield")
        self.assertEqual([r["place_id"] for r in results], ["wd:Q1", "wd:Q2"])

    def test_tier_becomes_the_precision_written_to_the_location(self):
        by_name = {r["name_en"]: r["precision_level"] for r in geo_resolver.search_places("o", limit=20)}
        self.assertEqual(by_name["Tokyo Tower"], "exact")
        self.assertEqual(by_name["Tokyo"], "locality")
        self.assertEqual(by_name["Kyoto Prefecture"], "admin1")
        self.assertEqual(geo_resolver.search_places("nippon")[0]["precision_level"], "country")

    def test_limit_and_empty_query(self):
        self.assertEqual(len(geo_resolver.search_places("o", limit=2)), 2)
        self.assertEqual(geo_resolver.search_places("   "), [])
        self.assertEqual(geo_resolver.search_places("zzzz"), [])

    def test_a_search_result_resolves_back_to_a_writable_location(self):
        hit = geo_resolver.search_places("kyoto")[0]
        resolved = geo_resolver.resolve_place_id(hit["place_id"])
        self.assertEqual(resolved.precision_level, "locality")
        self.assertEqual(resolved.country_code, "JP")
        self.assertLess(resolved.min_latitude, resolved.latitude)
        self.assertIsNone(geo_resolver.resolve_place_id("wd:Q999999"))
        self.assertIsNone(geo_resolver.resolve_place_id("not-a-place"))

    def test_the_index_follows_a_swapped_gazetteer(self):
        self.assertEqual(self.names("tokyo"), ["Tokyo", "Tokyo Tower"])
        geo_resolver.set_gazetteer_for_tests({**FIXTURE, "localities": [], "landmarks": []})
        self.assertEqual(self.names("tokyo"), [])


if __name__ == "__main__":
    unittest.main()
