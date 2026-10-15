"""The folder (collection) view carries the same row fields as All Assets.

browse-collection used to build its row payload separately from browse-images
and never set has_face, so the face badge in Gallery.jsx only showed in All
Assets. Both commands now print rows through one helper."""
from __future__ import annotations

import contextlib
import io
import json
import math
import tempfile
import unittest
from pathlib import Path

from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    add_collection_items,
    connect,
    create_collection,
    init_db,
    replace_asset_faces,
    upsert_face_model,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.models import ImageCandidate, MatchDecision


class BrowseCollectionHasFaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.catalog = ensure_catalog(Path(self.directory.name) / "faces.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem in ("face", "noface"):
            path = Path(self.directory.name) / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model=None,
                lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=600, height=400,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        upsert_face_model(
            self.connection, model_id="arcface-r100", model_version="1.0.0", kind="arcface", manifest_hash="m",
        )
        replace_asset_faces(
            self.connection,
            asset_id="image_face",
            model_id="arcface-r100",
            model_version="1.0.0",
            input_hash="input-face",
            faces=[{
                "bounding_box": [0.1, 0.2, 0.3, 0.4],
                "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.11, 0.3, 0.19, 0.3],
                "quality": "standard",
                "confidence": 0.99,
                "embedding": [1.0 / math.sqrt(512)] * 512,
            }],
        )
        collection = create_collection(self.connection, "Trip")
        self.collection_id = collection["collection_id"]
        add_collection_items(self.connection, self.collection_id, ["image_face", "image_noface"])
        self.connection.commit()

    def run_cli(self, *argv: str) -> list[dict]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def test_browse_collection_rows_say_whether_the_photo_has_a_face(self) -> None:
        in_collection = {row["asset_id"]: row for row in self.run_cli("browse-collection", "--collection-id", self.collection_id)}
        self.assertEqual(set(in_collection), {"image_face", "image_noface"})
        self.assertIs(in_collection["image_face"]["has_face"], True)
        self.assertIs(in_collection["image_noface"]["has_face"], False)

    def test_browse_collection_rows_have_the_same_fields_as_browse_images(self) -> None:
        all_assets = {row["asset_id"]: row for row in self.run_cli("browse-images", "--status", "all")}
        in_collection = {row["asset_id"]: row for row in self.run_cli("browse-collection", "--collection-id", self.collection_id)}
        self.assertEqual(set(all_assets["image_face"]), set(in_collection["image_face"]))
        self.assertEqual(all_assets["image_face"], in_collection["image_face"])


if __name__ == "__main__":
    unittest.main()
