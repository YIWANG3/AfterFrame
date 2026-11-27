"""Importing a folder again matches a photo that didn't change against the
RAW sources from the metadata the catalog holds (reverse_lookup.
rematch_unchanged_image) instead of reading it. Whatever it records must be
what reading the file again records: each test runs the same import on two
copies of one catalog, one reading every file and one skipping the
unchanged ones, and compares them."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from media_workspace import cli, reverse_lookup
from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, get_registry, init_db, set_catalog_path, upsert_raw_asset
from media_workspace.metadata import normalize_stem, stable_asset_id, stem_key
from media_workspace.models import RawMetadata
from media_workspace.reverse_lookup import resolve_image_batch

FIXTURES = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "e2e" / "fixtures"
DNG = FIXTURES / "raw" / "luna-morning.dng"
JPG = FIXTURES / "raw" / "luna-morning.jpg"

R5 = "Canon EOS R5"
RF = "RF24-70mm F2.8 L IS USM"


def photo(path: Path, *, model: str | None = None, lens: str | None = None, taken: str | None = None,
          size: tuple[int, int] = (60, 40), colour=(120, 90, 60)) -> Path:
    """A JPEG with the EXIF matching reads (`taken` as EXIF writes it)."""
    exif = Image.Exif()
    if model:
        exif[0x010F] = model.split()[0]
        exif[0x0110] = model
    ifd = exif.get_ifd(0x8769)
    if taken:
        ifd[0x9003] = taken
    if lens:
        ifd[0xA434] = lens
    Image.new("RGB", size, colour).save(path, exif=exif, quality=90)
    return path


def raw_source(connection, path: Path, *, model: str | None = None, lens: str | None = None,
               taken: str | None = None, size: tuple[int, int] = (6000, 4000)) -> str:
    """Register `path` as a RAW source (what Add RAW Sources records)."""
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(b"raw " + path.name.encode())
    fingerprint = hashlib.sha1(str(path).encode()).hexdigest()
    metadata = RawMetadata(
        asset_id=stable_asset_id("raw", fingerprint, str(path)),
        path=path, stem=path.stem, normalized_stem=normalize_stem(path.stem), stem_key=stem_key(path.stem),
        extension=path.suffix.lower(), fingerprint=fingerprint, file_size=path.stat().st_size,
        modified_time="2026-11-20T12:00:00", capture_time=taken, rating=None, camera_make=None,
        camera_model=model, lens_model=lens, software=None, iso=None, aperture=None, shutter_speed=None,
        focal_length=None, flash=None, white_balance=None, color_space=None, lens_specification=None,
        gps_latitude=None, gps_longitude=None, width=size[0], height=size[1],
        metadata_level="full", fingerprint_level="head", enrichment_status="complete",
    )
    upsert_raw_asset(connection, metadata, register_source=True)
    return metadata.asset_id


class RematchFromStoredMetadataTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        catalog = ensure_catalog(self.root / "first.afcatalog")
        self.connection = connect(catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        set_catalog_path(self.connection, catalog.root)
        self.exports = self.root / "Exports"
        self.exports.mkdir()
        self.raws = self.root / "RAW"
        # Before the first import: a source each photo below scores against
        # differently (bound, to confirm, vetoed, by time alone).
        raw_source(self.connection, self.raws / "IMG_0002.CR3", model=R5, lens=RF, taken="2026-11-20T10:05:00")
        raw_source(self.connection, self.raws / "DSC01234.ARW", model="ILCE-7M4", taken="2026-11-20T10:00:00")
        raw_source(self.connection, self.raws / "IMG_0003.CR3", model=R5, taken="2026-11-20T09:00:00", size=(4000, 6000))
        raw_source(self.connection, self.raws / "B0023525.CR3")
        raw_source(self.connection, self.raws / "IMG_0004.CR3", size=(4000, 6000))
        photo(self.exports / "IMG_0001.jpg", model=R5, lens=RF, taken="2026:11:20 10:00:00")
        photo(self.exports / "IMG_0002-Edit.jpg", model=R5, lens=RF, taken="2026:11:20 10:05:01")
        photo(self.exports / "DSC01234-2.jpg", model=R5, taken="2026:11:20 10:00:02", colour=(10, 200, 30))
        photo(self.exports / "IMG_0003 crop.jpg", model=R5, taken="2026:11:20 09:00:00", size=(40, 60))
        photo(self.exports / "IMG_0004.jpg", model=R5, taken="2026:11:20 11:00:00", colour=(60, 60, 160))
        photo(self.exports / "Sunset final.jpg", model=R5, taken="2026:11:20 10:00:04", colour=(200, 120, 20))
        photo(self.exports / "B0023524-2.jpg", colour=(30, 30, 200))
        photo(self.exports / "Manual pick.jpg", model=R5, colour=(90, 90, 90))
        # A RAW+JPG pair imported as photos: the RAW is not matched, but paired.
        shutil.copyfile(DNG, self.exports / "luna-morning.dng")
        shutil.copyfile(JPG, self.exports / "luna-morning.jpg")
        self.resolve(self.connection)
        # After it: sources the photos were imported without.
        self.added = {
            "IMG_0001.CR3": raw_source(self.connection, self.raws / "IMG_0001.CR3", model=R5, lens=RF,
                                       taken="2026-11-20T10:00:00"),
            "B0023524.CR3": raw_source(self.connection, self.raws / "B0023524.CR3"),
            "Sunset.CR3": raw_source(self.connection, self.raws / "Sunset.CR3", model=R5, taken="2026-11-20T10:00:04"),
        }
        manual = get_registry(self.connection, self.exports / "Manual pick.jpg")
        self.connection.execute(
            "UPDATE image_lookup_registry SET match_status = 'manual_confirmed', raw_asset_id = ?, score = 1.0 "
            "WHERE image_path = ?",
            (self.added["Sunset.CR3"], manual["image_path"]),
        )
        self.connection.commit()

    # ── helpers ──
    def copy(self, name: str):
        """A second catalog holding what this one holds."""
        catalog = ensure_catalog(self.root / f"{name}.afcatalog")
        connection = connect(catalog.db_path)
        self.addCleanup(connection.close)
        self.connection.commit()
        self.connection.backup(connection)
        set_catalog_path(connection, catalog.root)
        return connection

    def resolve(self, connection, **kwargs):
        """(result, names of the files whose metadata was read)"""
        read: list[str] = []
        image, raw = reverse_lookup.extract_image_candidate, reverse_lookup.extract_raw_metadata

        def spy(real):
            def wrapper(path, *args, **kw):
                read.append(Path(path).name)
                return real(path, *args, **kw)
            return wrapper

        with mock.patch.object(reverse_lookup, "extract_image_candidate", spy(image)), \
                mock.patch.object(reverse_lookup, "extract_raw_metadata", spy(raw)):
            result = resolve_image_batch(connection, [self.exports], **kwargs)
        return result, sorted(read)

    @staticmethod
    def recorded(connection) -> dict:
        """What matching recorded: every registry row, the RAW-source links
        it made, the RAW+JPG pairs."""
        registry = {
            Path(row["image_path"]).name: {
                "image_asset_id": row["image_asset_id"],
                "status": row["match_status"],
                "score": row["score"],
                "raw_asset_id": row["raw_asset_id"],
                "resolver_version": row["resolver_version"],
                "feature_vector": json.loads(row["feature_vector_json"]),
                "candidates": json.loads(row["candidate_json"]),
            }
            for row in connection.execute("SELECT * FROM image_lookup_registry")
        }
        links = sorted(
            tuple(row)
            for row in connection.execute(
                "SELECT parent_asset_id, child_asset_id, confidence, confirmed_by FROM asset_links "
                "WHERE relation_type = 'source_of'"
            )
        )
        pairs = sorted(tuple(row) for row in connection.execute("SELECT image_asset_id, raw_asset_id, state FROM raw_pairs"))
        return {"registry": registry, "links": links, "pairs": pairs}

    def assert_same_as_reading(self, **kwargs) -> tuple[dict, dict]:
        reading, stored = self.copy("reading"), self.copy("stored")
        read_result, read = self.resolve(reading, **kwargs)
        stored_result, not_read = self.resolve(stored, skip_unchanged=True, **kwargs)

        self.assertEqual(len(read), len(list(self.exports.iterdir())))
        self.assertEqual(not_read, [])
        recorded = self.recorded(stored)
        self.assertEqual(recorded, self.recorded(reading))
        self.assertEqual(stored_result, read_result)
        # Not an empty comparison: links to RAW sources and the RAW+JPG pair.
        self.assertTrue(recorded["links"])
        self.assertEqual(len(recorded["pairs"]), 1)
        return recorded["registry"], stored_result

    # ── tests ──
    def test_matching_again_from_the_catalog_records_what_reading_records(self):
        registry, result = self.assert_same_as_reading(refresh=True)

        # The sources added since the first import bind their photos, and
        # each photo met a different part of the matcher.
        self.assertEqual(registry["IMG_0001.jpg"]["status"], "auto_bound")
        self.assertEqual(registry["IMG_0001.jpg"]["raw_asset_id"], self.added["IMG_0001.CR3"])
        self.assertEqual(registry["B0023524-2.jpg"]["raw_asset_id"], self.added["B0023524.CR3"])
        self.assertEqual(registry["Manual pick.jpg"]["status"], "manual_confirmed")
        self.assertEqual(registry["Manual pick.jpg"]["raw_asset_id"], self.added["Sunset.CR3"])
        self.assertEqual(registry["luna-morning.dng"]["status"], "unmatched")
        self.assertEqual(registry["IMG_0004.jpg"]["status"], "pending_confirmation")
        statuses = {row["status"] for row in registry.values()}
        self.assertEqual(statuses, {"auto_bound", "manual_confirmed", "pending_confirmation", "unmatched"})
        self.assertTrue(any(row["candidates"] and row["status"] == "unmatched" for row in registry.values()))
        self.assertEqual((result["already_in_catalog"], result["newly_added"]), (10, 0))
        self.assertEqual(result["changed_paths"], [])
        self.assertEqual(result["raw_pairs_made"], 0)

    def test_without_refresh_an_automatic_match_stands_either_way(self):
        before = self.recorded(self.connection)["registry"]
        registry, _ = self.assert_same_as_reading(refresh=False)
        self.assertEqual(registry["IMG_0002-Edit.jpg"], before["IMG_0002-Edit.jpg"])
        self.assertEqual(registry["IMG_0002-Edit.jpg"]["status"], "auto_bound")
        # Not bound the first time, so matched again: the new source binds it.
        self.assertEqual(registry["IMG_0001.jpg"]["raw_asset_id"], self.added["IMG_0001.CR3"])

    def test_stems_come_from_the_name_as_they_do_when_the_file_is_read(self):
        """A stem key stored by an older version (keying has changed before)
        doesn't count: matching keys the name again, as reading does."""
        self.connection.execute(
            "UPDATE assets SET stem_key = 'stale', normalized_stem = 'stale', "
            "metadata_json = json_set(metadata_json, '$.stem_key', 'stale', '$.normalized_stem', 'stale') "
            "WHERE asset_type = 'image'"
        )
        self.connection.commit()
        self.assert_same_as_reading(refresh=True)

    def test_a_photo_whose_metadata_lacks_what_matching_reads_is_read(self):
        """A catalog from before metadata_json held a field: that photo is
        read, the others are not, and the outcome is still reading's."""
        self.connection.execute(
            "UPDATE assets SET metadata_json = json_remove(metadata_json, '$.lens_model') WHERE canonical_path = ?",
            (str(self.exports / "IMG_0001.jpg"),),
        )
        self.connection.commit()
        reading, stored = self.copy("reading"), self.copy("stored")
        self.resolve(reading, refresh=True)
        _, read = self.resolve(stored, refresh=True, skip_unchanged=True)
        self.assertEqual(read, ["IMG_0001.jpg"])
        self.assertEqual(self.recorded(stored), self.recorded(reading))
        lens = stored.execute(
            "SELECT json_extract(metadata_json, '$.lens_model') FROM assets WHERE canonical_path = ?",
            (str(self.exports / "IMG_0001.jpg"),),
        ).fetchone()[0]
        self.assertEqual(lens, RF)

    def test_a_changed_photo_is_read_and_the_rest_are_not(self):
        photo(self.exports / "Sunset final.jpg", model=R5, taken="2026:11:20 10:00:04", colour=(1, 2, 3), size=(61, 40))
        reading, stored = self.copy("reading"), self.copy("stored")
        read_result, _ = self.resolve(reading, refresh=True)
        stored_result, read = self.resolve(stored, refresh=True, skip_unchanged=True)
        self.assertEqual(read, ["Sunset final.jpg"])
        self.assertEqual(self.recorded(stored), self.recorded(reading))
        self.assertEqual(stored_result, read_result)
        self.assertEqual(stored_result["changed_paths"], [str(self.exports / "Sunset final.jpg")])


class MatchWithRawJobTest(unittest.TestCase):
    """Through the import job's "Match with RAW" phase: importing a folder
    again reads nothing that didn't change, and a RAW source added in
    between still binds its photo."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        self.catalog_root = root / "demo.afcatalog"
        ensure_catalog(self.catalog_root)
        self.folder = root / "Exports"
        self.folder.mkdir()
        self.sources = root / "RAW"
        self.sources.mkdir()
        for index in range(3):
            photo(self.folder / f"IMG_000{index}.jpg", model=R5, taken=f"2026:11:20 10:0{index}:00", colour=(40 * index, 90, 60))

    def cli(self, *argv: str) -> dict:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertIn(cli.main(["--catalog", str(self.catalog_root), *argv]), (0, None))
        return json.loads(out.getvalue())

    def import_folder(self) -> tuple[dict, list[str]]:
        read: list[str] = []
        real = reverse_lookup.extract_image_candidate

        def spy(path, *args, **kw):
            read.append(Path(path).name)
            return real(path, *args, **kw)

        mode = "processed_with_sources"
        job = self.cli("create-job", "--job-type", "import", "--payload-json",
                       json.dumps({"image_dirs": [str(self.folder)], "mode": mode}))
        with mock.patch.object(reverse_lookup, "extract_image_candidate", spy):
            self.cli("run-import-job", "--job-id", job["job_id"], "--mode", mode, "--image-dir", str(self.folder))
        return self.cli("get-job", "--job-id", job["job_id"]), sorted(read)

    def registry(self) -> dict[str, tuple]:
        connection = connect(ensure_catalog(self.catalog_root).db_path)
        try:
            return {
                Path(row["image_path"]).name: (row["match_status"], row["raw_asset_id"])
                for row in connection.execute("SELECT image_path, match_status, raw_asset_id FROM image_lookup_registry")
            }
        finally:
            connection.close()

    def test_a_second_import_reads_nothing_and_binds_a_raw_source_added_since(self):
        job, read = self.import_folder()
        self.assertEqual(len(read), 3)
        self.assertEqual(job["result"]["phase_results"][0]["key"], "match_processed_media")
        self.assertEqual(self.registry()["IMG_0001.jpg"], ("unmatched", None))

        (self.sources / "IMG_0001.CR3").write_bytes(b"raw placeholder")
        self.cli("scan-raw", "--raw-dir", str(self.sources))

        job, read = self.import_folder()
        self.assertEqual(read, [])
        # A source with no EXIF of its own: matched by name, to confirm.
        status, raw_asset_id = self.registry()["IMG_0001.jpg"]
        self.assertEqual(status, "pending_confirmation")
        self.assertIsNotNone(raw_asset_id)
        self.assertEqual(job["result"]["phase_results"][0]["result"]["already_in_catalog"], 3)


if __name__ == "__main__":
    unittest.main()
