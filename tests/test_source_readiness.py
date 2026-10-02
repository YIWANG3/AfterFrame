"""A JPEG is ready once its main image is complete, wherever the file ends."""
import tempfile
import unittest
from pathlib import Path

from media_workspace.source_readiness import SourceNotReadyError, validate_source_ready


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload


# SOI, an APP1 whose EXIF thumbnail ends in FF D9, a scan whose data stuffs
# FF as FF 00, then the main image's EOI.
THUMB = b"\xff\xd8thumbnail\xff\xd9"
IMAGE = (
    b"\xff\xd8"
    + _segment(0xE1, b"Exif\x00\x00" + THUMB)
    + _segment(0xDB, b"\x00" * 65)
    + _segment(0xDA, b"\x01\x01\x00\x00\x3f\x00")
    + b"scan\xff\x00data\xff\xd3more scan"
    + b"\xff\xd9"
)
# What DJI appends behind the image: an embedded preview and padding that
# does not end in FF D9.
TRAILER = b"\xff\xd8preview\xff\xd9" + b"\x42\x3e\x3b\x37" * 64


class SourceReadinessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def ready(self, data: bytes) -> bool:
        path = Path(self.directory.name) / "photo.jpg"
        path.write_bytes(data)
        try:
            validate_source_ready(path)
        except SourceNotReadyError:
            return False
        return True

    def test_a_complete_image_followed_by_appended_data_is_ready(self):
        self.assertTrue(self.ready(IMAGE + TRAILER))
        self.assertTrue(self.ready(IMAGE))
        self.assertTrue(self.ready(IMAGE + b"\x00" * 100))

    def test_a_partial_image_is_not_ready_though_its_thumbnail_has_an_eoi(self):
        end_of_scan = IMAGE.index(b"more scan") + 4
        self.assertFalse(self.ready(IMAGE[:end_of_scan]))
        # A file being written is a prefix of the finished one: every cut
        # before the main image's EOI is partial, every cut after it is not.
        finished = IMAGE + TRAILER
        main_eoi = len(IMAGE)
        for cut in range(IMAGE.index(b"scan"), len(finished)):
            self.assertEqual(self.ready(finished[:cut]), cut >= main_eoi, cut)
        self.assertFalse(self.ready(b"\xff\xd8partial-jpeg-without-eoi"))

    def test_an_empty_file_is_not_ready(self):
        self.assertFalse(self.ready(b""))


if __name__ == "__main__":
    unittest.main()
