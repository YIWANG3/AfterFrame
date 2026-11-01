"""The import walk (reverse_lookup.iter_image_files) takes what the format
registry lists and counts what it leaves out, so the import can say so."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from media_workspace import formats
from media_workspace.reverse_lookup import iter_image_files, new_skip_counts, skip_summary


class ImportGateTest(unittest.TestCase):
    def test_skipped_files_are_counted_by_extension_in_two_buckets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for name in ("a.jpg", "b.NEF", "clip.mp4", "notes.docx", "Notes2.DOCX", "archive.zip", "README",
                         "a.xmp", "clip.THM", "clip.lrv", ".DS_Store", "._a.jpg"):
                (root / name).write_bytes(b"x")
            (root / "sub").mkdir()
            (root / "sub" / "c.png").write_bytes(b"x")
            (root / "sub" / "layered.psb").write_bytes(b"x")

            skipped = new_skip_counts()
            taken = [path.name for path in iter_image_files([root], skipped)]

        self.assertEqual(taken, ["a.jpg", "b.NEF", "clip.mp4", "c.png"])
        self.assertEqual(skip_summary(skipped["unsupported"]), {
            "count": 5,
            "by_extension": {".docx": 2, "": 1, ".psb": 1, ".zip": 1},
        })
        self.assertEqual(skip_summary(skipped["companion"]), {
            "count": 3,
            "by_extension": {".lrv": 1, ".thm": 1, ".xmp": 1},
        })

    def test_a_single_file_is_taken_or_counted_too(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            photo = Path(temp_dir) / "IMG.JPG"
            doc = Path(temp_dir) / "deck.pptx"
            photo.write_bytes(b"x")
            doc.write_bytes(b"x")
            skipped = new_skip_counts()
            self.assertEqual(list(iter_image_files([photo, doc], skipped)), [photo.resolve()])
        self.assertEqual(dict(skipped["unsupported"]), {".pptx": 1})
        self.assertEqual(dict(skipped["companion"]), {})

    def test_without_a_counter_the_walk_is_as_before(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "x.docx").write_bytes(b"x")
            self.assertEqual(list(iter_image_files([Path(temp_dir)])), [])

    def test_companions_are_never_importable(self) -> None:
        self.assertFalse(formats.COMPANION_EXTENSIONS & formats.IMPORTABLE_EXTENSIONS)
        self.assertTrue(formats.is_companion(Path("/p/DSC_0001.xmp")))
        self.assertFalse(formats.is_companion(Path("/p/DSC_0001.jpg")))


if __name__ == "__main__":
    unittest.main()
