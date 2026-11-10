"""Find by list: a client's picks, each keyword looked up by file name inside
one place, with a count per keyword so a typo and a stray number both show."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, upsert_image_asset, upsert_raw_asset, upsert_registry
from media_workspace.db.browse import FIND_MATCH_LIMIT, browse_collection, find_by_keywords
from media_workspace.db.collections import add_collection_items, create_collection
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision, RawMetadata

# stem, rating
PHOTOS = (
    ("B0001723", 5),
    ("B0001746", 0),
    ("B0011723", 0),   # also holds 1723
    ("IMG_1754", 3),
    ("dsc_0009", 0),
)


def add_photo(connection, directory: Path, stem: str, *, rating: int = 0, raw_asset_id: str | None = None) -> str:
    path = directory / f"{stem}.JPG"
    path.write_bytes(b"jpg")
    candidate = ImageCandidate(
        asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem.lower(), stem_key=stem.lower(),
        extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time="2026-01-01T00:00:00",
        capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="1723 Mark II",
        lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
        flash=None, white_balance=None, color_space=None, lens_specification=None,
        gps_latitude=None, gps_longitude=None, width=6000, height=4000,
    )
    upsert_image_asset(connection, candidate)
    upsert_registry(connection, MatchDecision(
        image_asset_id=candidate.asset_id, image_path=path,
        status="auto_bound" if raw_asset_id else "unmatched", score=1.0 if raw_asset_id else 0.0,
        raw_asset_id=raw_asset_id, feature_vector={},
    ))
    connection.execute("UPDATE assets SET app_rating = ? WHERE asset_id = ?", (rating, candidate.asset_id))
    return candidate.asset_id


class FindByKeywordsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.connection = connect(self.root / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, rating in PHOTOS:
            add_photo(self.connection, self.root, stem, rating=rating)
        self.connection.commit()

    def find(self, *keywords, **place):
        return find_by_keywords(self.connection, list(keywords), **place)["keywords"]

    def names(self, entry):
        return [match["file_name"] for match in entry["matches"]]

    def test_each_keyword_answers_for_itself(self):
        one, several, none = self.find("1746", "1723", "1999")
        self.assertEqual((one["keyword"], one["count"], self.names(one)), ("1746", 1, ["B0001746.JPG"]))
        self.assertEqual((several["count"], self.names(several)), (2, ["B0001723.JPG", "B0011723.JPG"]))
        self.assertEqual((none["count"], none["matches"]), (0, []))
        self.assertEqual(one["matches"][0]["asset_id"], "image_B0001746")

    def test_a_name_matches_whatever_its_case(self):
        (entry,) = self.find("img_1754")
        self.assertEqual(self.names(entry), ["IMG_1754.JPG"])
        (entry,) = self.find("DSC_0009")
        self.assertEqual(self.names(entry), ["dsc_0009.JPG"])

    def test_only_the_file_name_is_read(self):
        # Every photo's camera is the "1723 Mark II": the search box would find
        # all five, and none of them is what the client meant.
        (entry,) = self.find("Mark")
        self.assertEqual(entry["count"], 0)
        # LIKE's wildcards are plain characters here.
        self.assertEqual([entry["count"] for entry in self.find("%", "_17", "B000____")], [0, 1, 0])

    def test_keywords_come_back_once_in_the_order_given(self):
        found = self.find(" 1754 ", "1723", "", "1754", "b0001723", "B0001723")
        self.assertEqual([entry["keyword"] for entry in found], ["1754", "1723", "b0001723"])

    def test_the_place_is_a_status_a_smart_collection_or_a_folder(self):
        self.assertEqual(self.find("1723", status="rated")[0]["count"], 1)
        rules = {"status": "all", "filters": {"rating_min": 3}}
        self.assertEqual([entry["count"] for entry in self.find("1723", "1754", "1746", base=rules)], [1, 1, 0])

        parent = create_collection(self.connection, "Wedding")
        child = create_collection(self.connection, "Selects", parent_id=parent["collection_id"])
        add_collection_items(self.connection, parent["collection_id"], ["image_B0001723"])
        add_collection_items(self.connection, child["collection_id"], ["image_B0011723", "image_B0001723"])
        in_parent = self.find("1723", collection_id=parent["collection_id"])[0]
        self.assertEqual(self.names(in_parent), ["B0001723.JPG"])
        # With its subfolders, each photo still counts once.
        with_children = self.find("1723", collection_id=parent["collection_id"], include_descendants=True)[0]
        self.assertEqual((with_children["count"], self.names(with_children)), (2, ["B0001723.JPG", "B0011723.JPG"]))

    def test_a_photo_answers_to_its_raws_name_too(self):
        # The JPEG was renamed on export; the client reads the number off the RAW.
        raw_path = self.root / "A7R05521.ARW"
        raw_path.write_bytes(b"raw")
        upsert_raw_asset(self.connection, RawMetadata(
            asset_id="raw_A7R05521", path=raw_path, stem="A7R05521", normalized_stem="a7r05521", stem_key="a7r05521",
            extension=".arw", fingerprint="fp-raw", file_size=3, modified_time="2026-01-01T00:00:00",
            capture_time=None, rating=None, camera_make=None, camera_model=None,
            lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
            flash=None, white_balance=None, color_space=None, lens_specification=None,
            gps_latitude=None, gps_longitude=None, width=None, height=None,
            metadata_level="light", fingerprint_level="quick", enrichment_status="pending",
        ))
        add_photo(self.connection, self.root, "wedding-final-01", raw_asset_id="raw_A7R05521")
        self.connection.commit()
        (entry,) = self.find("5521")
        self.assertEqual((entry["count"], self.names(entry)), (1, ["wedding-final-01.JPG"]))

    def test_a_keyword_that_names_too_many_is_counted_and_cut_short(self):
        for index in range(FIND_MATCH_LIMIT + 5):
            add_photo(self.connection, self.root, f"P88{index:04d}")
        self.connection.commit()
        result = find_by_keywords(self.connection, ["P88", "1746"])
        broad, exact = result["keywords"]
        self.assertEqual(result["limit"], FIND_MATCH_LIMIT)
        self.assertEqual((broad["count"], len(broad["matches"])), (FIND_MATCH_LIMIT + 5, FIND_MATCH_LIMIT))
        self.assertEqual(exact["count"], 1)

    # The list as a filter (filters.name_contains): what the grid shows when
    # the dialog's keywords are applied instead of put into a folder.
    def shown(self, filters, **view):
        return sorted(row["stem"] for row in list_image_assets(self.connection, view.pop("status", "all"), filters=filters, **view))

    def test_the_filter_shows_the_photos_any_keyword_names(self):
        self.assertEqual(self.shown({"name_contains": "1746"}), ["B0001746"])
        self.assertEqual(self.shown({"name_contains": ["1746", "img_1754", "1999"]}), ["B0001746", "IMG_1754"])
        # The name only, with LIKE's wildcards read as plain characters.
        self.assertEqual(self.shown({"name_contains": ["Mark", "%", "B000____"]}), [])
        self.assertEqual(self.shown({"name_contains": "_17"}), ["IMG_1754"])
        self.assertEqual(self.shown({"name_contains": ["", "  "]}), sorted(stem for stem, _ in PHOTOS))

    def test_the_filter_shows_what_the_lookup_counted(self):
        keywords = ["1723", "1746", "dsc", "1999", "B00"]
        counted = {match["asset_id"] for entry in self.find(*keywords) for match in entry["matches"]}
        shown = {row["asset_id"] for row in list_image_assets(self.connection, "all", filters={"name_contains": keywords})}
        self.assertEqual(shown, counted)
        self.assertEqual(len(shown), 4)

    def test_the_filter_stacks_flips_and_saves_like_any_other(self):
        self.assertEqual(self.shown({"name_contains": "1723", "rating_min": 5}), ["B0001723"])
        self.assertEqual(self.shown({"name_contains": ["1723", "1746"], "exclude": "name_contains"}), ["IMG_1754", "dsc_0009"])
        folder = create_collection(self.connection, "Selects")
        add_collection_items(self.connection, folder["collection_id"], ["image_B0011723", "image_IMG_1754"])
        rows = browse_collection(self.connection, folder["collection_id"], filters={"name_contains": ["1723", "0009"]})
        self.assertEqual([row["stem"] for row in rows], ["B0011723"])
        rules = normalize_rules({"filters": {"name_contains": ["1723", "1754"]}})
        self.assertEqual(rules["filters"], {"name_contains": ["1723", "1754"]})
        self.assertEqual(self.shown(None, base=rules), ["B0001723", "B0011723", "IMG_1754"])

    def test_the_filter_reads_the_raws_name_too(self):
        raw_path = self.root / "A7R05521.ARW"
        raw_path.write_bytes(b"raw")
        upsert_raw_asset(self.connection, RawMetadata(
            asset_id="raw_A7R05521", path=raw_path, stem="A7R05521", normalized_stem="a7r05521", stem_key="a7r05521",
            extension=".arw", fingerprint="fp-raw", file_size=3, modified_time="2026-01-01T00:00:00",
            capture_time=None, rating=None, camera_make=None, camera_model=None,
            lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
            flash=None, white_balance=None, color_space=None, lens_specification=None,
            gps_latitude=None, gps_longitude=None, width=None, height=None,
            metadata_level="light", fingerprint_level="quick", enrichment_status="pending",
        ))
        add_photo(self.connection, self.root, "wedding-final-01", raw_asset_id="raw_A7R05521")
        self.connection.commit()
        self.assertEqual(self.shown({"name_contains": "5521"}), ["wedding-final-01"])

    def test_nothing_asked_nothing_found(self):
        self.assertEqual(find_by_keywords(self.connection, [" ", ""]), {"limit": FIND_MATCH_LIMIT, "keywords": []})


class FindByKeywordsCommandTest(unittest.TestCase):
    def test_the_command_takes_the_keywords_as_one_json_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = ensure_catalog(Path(tmp) / "find.afcatalog")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = cli.main(["--catalog", str(catalog.root), "find-by-keywords", "--keywords", json.dumps(["1723", "婚礼"])])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue()), {
                "limit": FIND_MATCH_LIMIT,
                "keywords": [{"keyword": "1723", "count": 0, "matches": []}, {"keyword": "婚礼", "count": 0, "matches": []}],
            })


if __name__ == "__main__":
    unittest.main()
