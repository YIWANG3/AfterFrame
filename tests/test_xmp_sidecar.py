"""Lightroom, Bridge and darktable rate a RAW in an XMP sidecar beside it, not
in the file. Import reads the sidecar's stars over the embedded ones and
remembers the sidecar's mtime, so a re-rating of an untouched RAW shows."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from media_workspace.metadata import extract_image_candidate, iso_mtime, sidecar_path, sidecar_rating


def xmp(body: str) -> str:
    return (
        "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
        f"<rdf:Description rdf:about='' xmlns:xmp='http://ns.adobe.com/xap/1.0/' {body}</rdf:RDF></x:xmpmeta>"
    )


def rated(stars: str) -> str:
    """How Lightroom writes it: an attribute of rdf:Description."""
    return xmp(f"xmp:Rating='{stars}'/>")


class SidecarPathTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        self.raw = self.folder / "IMG_0001.CR2"
        self.raw.write_bytes(b"raw")

    def test_lightroom_names_the_sidecar_after_the_stem(self) -> None:
        sidecar = self.folder / "IMG_0001.xmp"
        sidecar.write_text(rated("4"))
        self.assertEqual(sidecar_path(self.raw), sidecar)

    def test_darktable_keeps_the_photos_extension(self) -> None:
        sidecar = self.folder / "IMG_0001.CR2.xmp"
        sidecar.write_text(rated("4"))
        self.assertEqual(sidecar_path(self.raw), sidecar)

    def test_either_case_of_the_extension(self) -> None:
        sidecar = self.folder / "IMG_0001.XMP"
        sidecar.write_text(rated("4"))
        found = sidecar_path(self.raw)
        # On a case-insensitive disk the lower-case candidate finds it first.
        self.assertTrue(found is not None and found.samefile(sidecar))

    def test_no_sidecar(self) -> None:
        (self.folder / "IMG_0002.xmp").write_text(rated("4"))
        self.assertIsNone(sidecar_path(self.raw))


class SidecarRatingTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.sidecar = Path(directory.name) / "IMG_0001.xmp"

    def rating_of(self, text: str) -> int | None:
        self.sidecar.write_text(text)
        return sidecar_rating(self.sidecar)

    def test_stars_as_an_attribute(self) -> None:
        self.assertEqual(self.rating_of(rated("4")), 4)
        self.assertEqual(self.rating_of(rated("0")), 0)

    def test_stars_as_an_element(self) -> None:
        self.assertEqual(self.rating_of(xmp("><xmp:Rating>3</xmp:Rating></rdf:Description>")), 3)

    def test_a_rejected_photo_has_no_star_count(self) -> None:
        self.assertIsNone(self.rating_of(rated("-1")))

    def test_a_sidecar_without_stars(self) -> None:
        self.assertIsNone(self.rating_of(xmp("xmp:Label='Red'/>")))

    def test_a_sidecar_that_isnt_xmp(self) -> None:
        self.assertIsNone(self.rating_of("<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF>"))
        self.assertIsNone(self.rating_of(rated("many")))


class ImportReadsTheSidecarTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        self.photo = self.folder / "B0016108.jpg"
        Image.new("RGB", (8, 8), (90, 120, 160)).save(self.photo, "JPEG", xmp=rated("5").encode("utf-8"))

    def test_the_sidecars_stars_beat_the_embedded_ones(self) -> None:
        sidecar = self.folder / "B0016108.xmp"
        sidecar.write_text(rated("4"))
        os.utime(sidecar, (1_700_000_000, 1_700_000_000))

        candidate = extract_image_candidate(self.photo)

        self.assertEqual(candidate.rating, 4)
        self.assertEqual(candidate.sidecar_modified_time, iso_mtime(sidecar))

    def test_a_sidecar_without_stars_leaves_the_embedded_ones(self) -> None:
        (self.folder / "B0016108.xmp").write_text(xmp("xmp:Label='Red'/>"))
        candidate = extract_image_candidate(self.photo)
        self.assertEqual(candidate.rating, 5)
        self.assertIsNotNone(candidate.sidecar_modified_time)

    def test_without_a_sidecar(self) -> None:
        candidate = extract_image_candidate(self.photo)
        self.assertEqual(candidate.rating, 5)
        self.assertIsNone(candidate.sidecar_modified_time)


if __name__ == "__main__":
    unittest.main()
