"""A shoot as a folder: a Finder folder dropped on the sidebar is filed by
its paths, and deleting a folder can take along the photos only it holds."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, upsert_image_asset, upsert_registry
from media_workspace.db.browse import browse_collection
from media_workspace.db.collections import (
    add_collection_items,
    add_collection_paths,
    collection_contents,
    create_collection,
)
from media_workspace.models import ImageCandidate, MatchDecision


def add_photo(connection, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"jpg")
    path = path.resolve()
    stem = path.stem
    candidate = ImageCandidate(
        asset_id=f"image_{path.parent.name}_{stem}", path=path, stem=stem, normalized_stem=stem.lower(), stem_key=stem.lower(),
        extension=path.suffix.lower(), fingerprint=f"fp-{path}", file_size=3, modified_time="2026-01-01T00:00:00",
        capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=None,
        lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
        flash=None, white_balance=None, color_space=None, lens_specification=None,
        gps_latitude=None, gps_longitude=None, width=6000, height=4000,
    )
    upsert_image_asset(connection, candidate)
    upsert_registry(connection, MatchDecision(
        image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
        raw_asset_id=None, feature_vector={},
    ))
    return candidate.asset_id


class FolderLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.connection = connect(self.root / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        self.ids = {
            name: add_photo(self.connection, self.root / name)
            for name in ("wedding/a.jpg", "wedding/b.3fr", "wedding/day2/c.jpg", "wedding_extra/d.jpg", "wed%ing/e.jpg", "other/f.jpg")
        }
        self.connection.commit()

    def members(self, folder, **options):
        return sorted(row["asset_id"] for row in browse_collection(self.connection, folder["collection_id"], **options))

    def test_a_folder_on_disk_files_everything_under_it(self):
        folder = create_collection(self.connection, "wedding")
        result = add_collection_paths(self.connection, folder["collection_id"], [self.root / "wedding"])
        self.assertEqual(result, {"matched": 3, "added": 3})
        # Under it: not the folder beside it whose name starts the same way.
        self.assertEqual(self.members(folder), sorted(self.ids[name] for name in ("wedding/a.jpg", "wedding/b.3fr", "wedding/day2/c.jpg")))

    def test_asking_again_adds_only_what_has_arrived_since(self):
        folder = create_collection(self.connection, "wedding")
        add_collection_paths(self.connection, folder["collection_id"], [self.root / "wedding"])
        late = add_photo(self.connection, self.root / "wedding" / "late.jpg")
        self.connection.commit()
        self.assertEqual(add_collection_paths(self.connection, folder["collection_id"], [self.root / "wedding"]), {"matched": 4, "added": 1})
        self.assertIn(late, self.members(folder))

    def test_single_files_and_several_paths(self):
        folder = create_collection(self.connection, "picks")
        result = add_collection_paths(self.connection, folder["collection_id"], [self.root / "other" / "f.jpg", self.root / "wedding" / "day2", self.root / "nowhere"])
        self.assertEqual(result, {"matched": 2, "added": 2})
        self.assertEqual(self.members(folder), sorted([self.ids["other/f.jpg"], self.ids["wedding/day2/c.jpg"]]))
        self.assertEqual(add_collection_paths(self.connection, folder["collection_id"], []), {"matched": 0, "added": 0})

    def test_a_percent_sign_in_a_path_is_a_percent_sign(self):
        folder = create_collection(self.connection, "odd")
        self.assertEqual(add_collection_paths(self.connection, folder["collection_id"], [self.root / "wed%ing"])["matched"], 1)
        self.assertEqual(self.members(folder), [self.ids["wed%ing/e.jpg"]])

    def test_a_smart_collection_takes_no_photos(self):
        smart = create_collection(self.connection, "five stars", kind="smart", rules_json=json.dumps({"filters": {"rating_min": 5}}))
        with self.assertRaises(ValueError):
            add_collection_paths(self.connection, smart["collection_id"], [self.root / "wedding"])

    def test_a_folders_own_photos_are_those_no_other_folder_holds(self):
        shoot = create_collection(self.connection, "shoot")
        selects = create_collection(self.connection, "selects", parent_id=shoot["collection_id"])
        portfolio = create_collection(self.connection, "portfolio")
        add_collection_items(self.connection, shoot["collection_id"], [self.ids["wedding/a.jpg"], self.ids["wedding/b.3fr"], self.ids["other/f.jpg"]])
        add_collection_items(self.connection, selects["collection_id"], [self.ids["wedding/a.jpg"], self.ids["wedding/day2/c.jpg"]])
        add_collection_items(self.connection, portfolio["collection_id"], [self.ids["other/f.jpg"]])

        contents = collection_contents(self.connection, [shoot["collection_id"]])
        # The folder and the one under it; four photos, one of them also in the portfolio.
        self.assertEqual((contents["folders"], contents["total"], contents["shared"]), (2, 4, 1))
        self.assertEqual(sorted(photo["asset_id"] for photo in contents["photos"]),
                         sorted(self.ids[name] for name in ("wedding/a.jpg", "wedding/b.3fr", "wedding/day2/c.jpg")))
        self.assertEqual({Path(photo["path"]).name for photo in contents["photos"]}, {"a.jpg", "b.3fr", "c.jpg"})

        # The subfolder alone: a.jpg is in its parent too, which stays.
        own = collection_contents(self.connection, [selects["collection_id"]])
        self.assertEqual((own["folders"], own["total"], own["shared"]), (1, 2, 1))
        self.assertEqual([photo["asset_id"] for photo in own["photos"]], [self.ids["wedding/day2/c.jpg"]])

        # Both folders going at once: nothing is left to hold f.jpg.
        both = collection_contents(self.connection, [shoot["collection_id"], portfolio["collection_id"], selects["collection_id"]])
        self.assertEqual((both["folders"], both["total"], both["shared"]), (3, 4, 0))

    def test_a_smart_collection_holding_a_photo_does_not_keep_it(self):
        shoot = create_collection(self.connection, "shoot")
        add_collection_items(self.connection, shoot["collection_id"], [self.ids["wedding/a.jpg"]])
        create_collection(self.connection, "everything", kind="smart", rules_json=json.dumps({"filters": {"name_contains": "a"}}))
        self.assertEqual(collection_contents(self.connection, [shoot["collection_id"]])["shared"], 0)

    def test_an_empty_or_unknown_folder_holds_nothing(self):
        empty = create_collection(self.connection, "empty")
        self.assertEqual(collection_contents(self.connection, [empty["collection_id"]]), {"folders": 1, "total": 0, "shared": 0, "photos": []})
        self.assertEqual(collection_contents(self.connection, []), {"folders": 0, "total": 0, "shared": 0, "photos": []})


class FolderLifecycleCommandsTest(unittest.TestCase):
    def test_the_commands_take_json_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = ensure_catalog(Path(tmp) / "shoot.afcatalog")

            def request(*argv):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(cli.main(["--catalog", str(catalog.root), *argv]), 0)
                return json.loads(out.getvalue())

            folder = request("create-collection", "--name", "shoot", "--kind", "manual")
            added = request("collection-add-paths", "--collection-id", folder["collection_id"], "--paths", json.dumps([str(Path(tmp) / "shoot")]))
            self.assertEqual((added["matched"], added["added"]), (0, 0))
            self.assertEqual(request("collection-contents", "--collection-ids", json.dumps([folder["collection_id"]])),
                             {"folders": 1, "total": 0, "shared": 0, "photos": []})


if __name__ == "__main__":
    unittest.main()
