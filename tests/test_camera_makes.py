"""The camera makes in the library, for picking each brand's frame logo."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.db import camera_makes, connect, init_db, upsert_image_asset, upsert_registry
from media_workspace.models import ImageCandidate, MatchDecision


class CameraMakesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.connection = connect(Path(self.directory.name) / "catalog.sqlite")
        self.addCleanup(self.connection.close)
        init_db(self.connection)

    def add(self, stem, make, model):
        path = Path(self.directory.name) / f"{stem}.jpg"
        path.write_bytes(b"jpg")
        candidate = ImageCandidate(
            asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
            extension=".jpg", fingerprint=f"fp-{stem}", file_size=3, modified_time="2026-01-01T00:00:00",
            capture_time="2026-01-01T00:00:00", rating=None, camera_make=make, camera_model=model,
            lens_model=None, software=None, iso=100, aperture=2.0, shutter_speed=0.004, focal_length=35.0,
            flash=None, white_balance=None, color_space=None, lens_specification=None,
            gps_latitude=None, gps_longitude=None, width=6000, height=4000,
        )
        upsert_image_asset(self.connection, candidate)
        upsert_registry(self.connection, MatchDecision(
            image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
            raw_asset_id=None, feature_vector={},
        ))

    def test_makes_with_counts_and_models_most_used_first(self):
        self.add("a", "Canon", "Canon EOS R6m2")
        self.add("b", "Canon", "Canon EOS R6m2")
        self.add("c", "Canon", "Canon EOS 6D")
        self.add("d", "Yingling Innovations Pte. Ltd.", "antigravity a1")
        self.add("e", "Hasselblad", "X2D II 100C")
        self.add("f", "Hasselblad", "X2D II 100C")
        self.add("g", None, None)  # no EXIF make: no brand to give a logo
        self.add("h", "  ", "Something")
        self.assertEqual(camera_makes(self.connection), [
            {"make": "Canon", "count": 3, "models": ["Canon EOS R6m2", "Canon EOS 6D"]},
            {"make": "Hasselblad", "count": 2, "models": ["X2D II 100C"]},
            {"make": "Yingling Innovations Pte. Ltd.", "count": 1, "models": ["antigravity a1"]},
        ])

    def test_an_empty_library_has_none(self):
        self.assertEqual(camera_makes(self.connection), [])


if __name__ == "__main__":
    unittest.main()
