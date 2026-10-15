"""Look-alike photos: the perceptual hash, the feature-print helper, the
visual job that stores both, and the similar / duplicate lookups."""
from __future__ import annotations

import os
import sqlite3
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, init_db, list_image_assets, summary, upsert_image_asset, upsert_registry
from media_workspace.db.visual import count_duplicate_assets, find_similar, list_duplicate_groups, similar_assets, visual_status
from media_workspace.job_runner import run_visual_job
from media_workspace.models import ImageCandidate, MatchDecision
from media_workspace.preview_service import PreviewService
from media_workspace.schema import SCHEMA_VERSION
from media_workspace.visual import (
    FeatureHelper,
    FeatureHelperError,
    from_signed,
    hamming,
    hamming_to_all,
    pack_embedding,
    perceptual_hash,
    to_signed,
    unpack_embedding,
)


def scene(path: Path, seed: int, *, flip: bool = False, quality: int = 92, scale: float = 1.0) -> None:
    """A JPEG with enough structure for a hash: a gradient and a few shapes
    placed by `seed`. The same seed is the same picture, at any scale."""
    rng = np.random.default_rng(seed)
    width, height = 640, 480
    base = np.zeros((height, width, 3), dtype=np.uint8)
    base[..., 0] = np.linspace(20, 235, width, dtype=np.uint8)[None, :]
    base[..., 1] = np.linspace(200, 30, height, dtype=np.uint8)[:, None]
    base[..., 2] = 90
    image = Image.fromarray(base)
    draw = ImageDraw.Draw(image)
    for _ in range(6):
        x, y = int(rng.integers(0, width - 160)), int(rng.integers(0, height - 160))
        colour = tuple(int(c) for c in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            draw.ellipse([x, y, x + int(rng.integers(40, 160)), y + int(rng.integers(40, 160))], fill=colour)
        else:
            draw.rectangle([x, y, x + int(rng.integers(40, 160)), y + int(rng.integers(40, 160))], fill=colour)
    if flip:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if scale != 1.0:
        image = image.resize((int(width * scale), int(height * scale)))
    image.save(path, quality=quality)


# A stand-in for native/image-features.swift that speaks its protocol: the
# vector is the picture's 4×4 grey thumbnail, normalised, so re-encodes of
# one picture come out close and different pictures apart.
FAKE_HELPER = textwrap.dedent(
    """\
    #!{python}
    import base64, json, sys
    import numpy as np
    from PIL import Image
    if sys.argv[1:] == ["--model"]:
        print("fake-fp-1")
        sys.exit(0)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with Image.open(request["path"]) as image:
                grey = np.asarray(image.convert("L").resize((4, 4)), dtype=np.float32).flatten()
            vector = grey / (np.linalg.norm(grey) or 1.0)
            print(json.dumps({{"id": request["id"], "ok": True, "model": "fake-fp-1", "dim": 16,
                              "b64": base64.b64encode(vector.astype("<f4").tobytes()).decode()}}), flush=True)
        except Exception as error:
            print(json.dumps({{"id": request["id"], "ok": False, "error": str(error)}}), flush=True)
    """
)


class HashTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_re_encodes_of_one_picture_are_close_and_other_pictures_far(self):
        scene(self.root / "a.jpg", 1)
        scene(self.root / "a_again.jpg", 1, quality=60, scale=0.5)
        scene(self.root / "a_flipped.jpg", 1, flip=True)
        scene(self.root / "b.jpg", 2)
        a, again, flipped, b = (perceptual_hash(self.root / name) for name in ("a.jpg", "a_again.jpg", "a_flipped.jpg", "b.jpg"))
        self.assertLessEqual(hamming(a, again), 4)
        self.assertGreater(hamming(a, b), 12)
        self.assertGreater(hamming(a, flipped), 12)

    def test_an_unreadable_file_has_no_hash(self):
        (self.root / "junk.jpg").write_bytes(b"not a jpeg")
        self.assertIsNone(perceptual_hash(self.root / "junk.jpg"))

    def test_hashes_round_trip_through_sqlite_and_compare_in_bulk(self):
        high = (1 << 63) | 5
        self.assertEqual(from_signed(to_signed(high)), high)
        self.assertLess(to_signed(high), 0)
        distances = hamming_to_all(np.array([high, 5, 0], dtype=np.uint64), high)
        self.assertEqual(distances.tolist(), [0, 1, 3])

    def test_embeddings_survive_the_half_precision_blob(self):
        vector = np.random.default_rng(0).standard_normal(768).astype(np.float32)
        vector /= np.linalg.norm(vector)
        back = unpack_embedding(pack_embedding(vector))
        self.assertEqual(back.dtype, np.float32)
        self.assertLess(float(np.linalg.norm(back - vector)), 1e-2)


class VisualJobTest(unittest.TestCase):
    SCENES = {"one": 1, "one_again": 1, "two": 2, "three": 3}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.root = root
        self.catalog = ensure_catalog(root / "demo.afcatalog")
        self.connection = connect(self.catalog.root / "catalog.sqlite3")
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem, seed in self.SCENES.items():
            path = root / f"{stem}.jpg"
            scene(path, seed, quality=60 if stem.endswith("again") else 92)
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time="2026-01-01T00:00:00", rating=None, camera_make=None, camera_model="X",
                lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=640, height=480,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    def render_previews(self, **kwargs):
        return PreviewService(self.catalog).generate_batch(self.connection, kind="preview", asset_type="image", **kwargs)

    def queue(self, job_id: str) -> None:
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES (?, 'visual', 'queued', '{}', '{}')", (job_id,)
        )
        self.connection.commit()

    def fake_helper(self) -> Path:
        path = self.root / "image-features"
        path.write_text(FAKE_HELPER.format(python=sys.executable))
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return path

    def test_previews_bring_their_hash_and_group_the_re_encode(self):
        self.render_previews()
        self.assertEqual(visual_status(self.connection), {"hashed": 4, "embedded": 0, "missing": 0, "duplicate_groups": 1})
        self.assertEqual([sorted(g["asset_ids"]) for g in list_duplicate_groups(self.connection)], [["image_one", "image_one_again"]])
        # The catch-up job then has nothing to do…
        self.queue("job-0")
        self.assertEqual(run_visual_job(self.connection, self.catalog.root, "job-0", helper_path=None)["total"], 0)
        # …and a second preview pass hashes only what the first missed.
        self.connection.execute("DELETE FROM asset_visual WHERE asset_id = 'image_two'")
        self.connection.commit()
        self.assertEqual(self.render_previews()["skipped"], 4)
        self.assertEqual(visual_status(self.connection)["missing"], 0)

    def test_the_preview_pass_uses_the_helper_the_app_names(self):
        with patch.dict(os.environ, {"IMAGE_FEATURES_PATH": str(self.fake_helper())}):
            self.render_previews()
        self.assertEqual(visual_status(self.connection, embedding_model="fake-fp-1")["embedded"], 4)
        self.assertEqual(find_similar(self.connection, "image_one", limit=1)[0]["asset_id"], "image_one_again")

    def test_hashes_alone_find_the_re_encode_and_group_it(self):
        self.render_previews(analyze_visual=False)
        self.assertEqual(visual_status(self.connection)["missing"], 4)
        self.queue("job-1")

        result = run_visual_job(self.connection, self.catalog.root, "job-1", helper_path=None)

        self.assertEqual(result, {"analyzed": 4, "embedded": 0, "grouped": 1, "failed": 0, "total": 4})
        self.assertEqual(self.connection.execute("SELECT status FROM jobs WHERE job_id = 'job-1'").fetchone()[0], "succeeded")
        self.assertEqual(visual_status(self.connection), {"hashed": 4, "embedded": 0, "missing": 0, "duplicate_groups": 1})
        groups = list_duplicate_groups(self.connection)
        self.assertEqual([sorted(group["asset_ids"]) for group in groups], [["image_one", "image_one_again"]])
        self.assertEqual(count_duplicate_assets(self.connection), 2)
        similar = find_similar(self.connection, "image_one", limit=2)
        self.assertEqual(similar[0]["asset_id"], "image_one_again")
        self.assertIsNone(similar[0]["distance"])
        self.assertLessEqual(similar[0]["hamming"], 4)
        enriched = similar_assets(self.connection, self.catalog.root, "image_one", limit=1)
        self.assertEqual(enriched[0]["stem"], "one_again")
        self.assertTrue(enriched[0]["preview_path"].endswith(".jpg"))
        # The sidebar's Look-alikes: the grouped photos, and their count.
        self.assertEqual(sorted(row["stem"] for row in list_image_assets(self.connection, "lookalikes")), ["one", "one_again"])
        self.assertEqual(summary(self.connection)["lookalike_count"], 2)
        # The "photos like this one" view: the photo, then its look-alikes, nearest first.
        view = [row["stem"] for row in list_image_assets(self.connection, "all", similar_to="image_one", limit=3)]
        self.assertEqual(view[:2], ["one", "one_again"])
        self.assertEqual(len(view), 3)
        # A second pass has nothing left to do.
        self.queue("job-2")
        self.assertEqual(run_visual_job(self.connection, self.catalog.root, "job-2", helper_path=None)["total"], 0)

    def test_the_helper_adds_feature_prints_and_ranks_by_them(self):
        self.render_previews(analyze_visual=False)
        helper = self.fake_helper()
        self.queue("job-1")

        result = run_visual_job(self.connection, self.catalog.root, "job-1", helper_path=helper)

        self.assertEqual(result["embedded"], 4)
        self.assertEqual(result["grouped"], 1)
        row = self.connection.execute("SELECT embedding_model, length(embedding) FROM asset_visual WHERE asset_id = 'image_one'").fetchone()
        self.assertEqual(tuple(row), ("fake-fp-1", 32))
        similar = find_similar(self.connection, "image_one", limit=3)
        self.assertEqual(similar[0]["asset_id"], "image_one_again")
        self.assertLess(similar[0]["distance"], similar[1]["distance"])
        self.assertEqual(len(similar), 3)
        # With a helper, a photo that only has a hash still counts as missing.
        self.connection.execute("UPDATE asset_visual SET embedding = NULL, embedding_model = NULL WHERE asset_id = 'image_two'")
        self.connection.commit()
        self.assertEqual(visual_status(self.connection, embedding_model="fake-fp-1")["missing"], 1)
        self.assertEqual(visual_status(self.connection)["missing"], 0)

    def test_a_helper_that_cannot_read_a_file_does_not_stop_the_hashes(self):
        self.render_previews(analyze_visual=False)
        with FeatureHelper(self.fake_helper()) as helper:
            with self.assertRaises(FeatureHelperError):
                helper.embed("x", self.root / "missing.jpg")
            model, vector = helper.embed("one", self.root / "one.jpg")
        self.assertEqual((model, len(vector)), ("fake-fp-1", 16))
        with self.assertRaises(FeatureHelperError):
            FeatureHelper(self.root / "no-such-helper")

    def test_a_photo_without_a_preview_is_not_counted(self):
        self.render_previews(analyze_visual=False)
        self.connection.execute("DELETE FROM preview_entries WHERE asset_id = 'image_three'")
        self.connection.commit()
        self.assertEqual(visual_status(self.connection)["missing"], 3)


class VisualMigrationTest(unittest.TestCase):
    def test_v11_catalog_gets_the_visual_table(self) -> None:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        init_db(connection)
        connection.execute("DROP TABLE asset_visual")
        connection.execute("UPDATE catalog_info SET schema_version = 11")
        connection.commit()

        init_db(connection)

        self.assertEqual(connection.execute("SELECT schema_version FROM catalog_info").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM asset_visual").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
