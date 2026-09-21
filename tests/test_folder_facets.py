"""Facet options and their counts describe the current view: the folder, the
search text and every other active filter."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import connect, init_db, upsert_image_asset, upsert_registry
from media_workspace.db.browse import browse_collection, get_facet_values, search_facet_values
from media_workspace.db.collections import add_collection_items, create_collection
from media_workspace.models import ImageCandidate, MatchDecision


class FolderFacetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        self.ids = {}
        for stem, camera, iso in (("a", "CFV 100C", 100), ("b", "CFV 100C", 400), ("c", "Canon R6", 3200), ("d", "Canon R6", 800)):
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"jpg")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=camera,
                lens_model=None, software=None, iso=iso, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=6000, height=4000,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
            self.ids[stem] = candidate.asset_id
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'coast', 'user')", (self.ids["a"],))
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'coast', 'user')", (self.ids["c"],))
        self.connection.execute("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'city', 'user')", (self.ids["d"],))
        self.folder = create_collection(self.connection, "Trip")["collection_id"]
        add_collection_items(self.connection, self.folder, [self.ids["a"], self.ids["b"], self.ids["c"]])

    @staticmethod
    def counts(rows):
        return {row["value"]: row["count"] for row in rows}

    def test_library_counts_are_unchanged(self):
        facets = get_facet_values(self.connection)
        self.assertEqual(self.counts(facets["cameras"]), {"CFV 100C": 2, "Canon R6": 2})
        self.assertEqual(self.counts(facets["tags"]), {"coast": 2, "city": 1})
        self.assertEqual(facets["iso"], {"min": 100, "max": 3200})

    def test_folder_counts_and_ranges_describe_the_folder(self):
        facets = get_facet_values(self.connection, self.folder)
        self.assertEqual(self.counts(facets["cameras"]), {"CFV 100C": 2, "Canon R6": 1})
        # "city" is only on a photo outside the folder: not offered at all.
        self.assertEqual(self.counts(facets["tags"]), {"coast": 2})
        self.assertEqual(self.counts(facets["extensions"]), {"jpg": 3})
        self.assertEqual(facets["iso"], {"min": 100, "max": 3200})

    def test_each_count_is_what_choosing_that_option_shows(self):
        for row in get_facet_values(self.connection, self.folder)["cameras"]:
            shown = browse_collection(self.connection, self.folder, filters={"camera": row["value"]})
            self.assertEqual(len(shown), row["count"], row["value"])

    def test_facet_search_is_scoped_too(self):
        self.assertEqual(self.counts(search_facet_values(self.connection, "tag", "c")), {"coast": 2, "city": 1})
        self.assertEqual(self.counts(search_facet_values(self.connection, "tag", "c", collection_id=self.folder)), {"coast": 2})
        self.assertEqual(self.counts(search_facet_values(self.connection, "camera", "canon", collection_id=self.folder)), {"Canon R6": 1})

    # ── counts follow the other active filters ─────────────────────────────

    def test_a_count_is_what_picking_that_option_would_show_given_the_other_filters(self):
        from media_workspace.db import list_image_assets

        active = {"tag": "coast"}  # a and c
        facets = get_facet_values(self.connection, filters=active)
        self.assertEqual(self.counts(facets["cameras"]), {"CFV 100C": 1, "Canon R6": 1})
        for row in facets["cameras"]:
            shown = list_image_assets(self.connection, "all", filters={**active, "camera": row["value"]})
            self.assertEqual(len(shown), row["count"], row["value"])
        # Ranges narrow too: only a (ISO 100) and c (ISO 3200) carry the tag.
        self.assertEqual(get_facet_values(self.connection, filters={"tag": "city"})["iso"], {"min": 800, "max": 800})

    def test_a_facet_ignores_its_own_selection_so_it_can_still_be_switched(self):
        facets = get_facet_values(self.connection, filters={"camera": "CFV 100C"})
        # Canon is still offered with ITS count; only the OTHER facets narrowed.
        self.assertEqual(self.counts(facets["cameras"]), {"CFV 100C": 2, "Canon R6": 2})
        self.assertEqual(self.counts(facets["tags"]), {"coast": 1})
        self.assertEqual(facets["iso"], {"min": 100, "max": 400})
        # A range facet ignores its own bounds the same way.
        self.assertEqual(get_facet_values(self.connection, filters={"iso_min": 3000})["iso"], {"min": 100, "max": 3200})

    def test_an_option_the_other_filters_rule_out_is_not_offered(self):
        # "city" is only on d, a Canon: with CFV picked, choosing it would show nothing.
        tags = self.counts(get_facet_values(self.connection, filters={"camera": "CFV 100C"})["tags"])
        self.assertNotIn("city", tags)
        self.assertEqual(self.counts(search_facet_values(self.connection, "tag", "c", filters={"camera": "CFV 100C"})), {"coast": 1})

    def test_search_text_status_and_folder_all_narrow_the_counts(self):
        self.assertEqual(self.counts(get_facet_values(self.connection, search="canon")["tags"]), {"coast": 1, "city": 1})
        self.connection.execute("UPDATE assets SET app_rating = 5 WHERE asset_id = ?", (self.ids["a"],))
        self.assertEqual(self.counts(get_facet_values(self.connection, status="rated")["cameras"]), {"CFV 100C": 1})
        # Inside a folder the status is replaced by membership, as in browse_collection.
        in_folder = get_facet_values(self.connection, self.folder, status="rated", filters={"tag": "coast"})
        self.assertEqual(self.counts(in_folder["cameras"]), {"CFV 100C": 1, "Canon R6": 1})

    def test_no_arguments_still_describes_the_whole_library(self):
        # get_catalog_info reports these to agents as the library's facets.
        self.assertEqual(get_facet_values(self.connection), get_facet_values(self.connection, None, status="all", search=None, filters={}))


if __name__ == "__main__":
    unittest.main()
