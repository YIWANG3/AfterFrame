from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from media_workspace.file_types import detect_raw_format, in_system_folder, is_ignored_path, is_raw_file
from media_workspace.reverse_lookup import MEDIA_EXTENSIONS, iter_image_files
from media_workspace.scanner import iter_candidate_paths
from media_workspace.video import VIDEO_EXTENSIONS

DESKTOP_PACKAGE = Path(__file__).resolve().parents[1] / "apps" / "desktop" / "package.json"


class FileTypesTest(unittest.TestCase):
    def test_known_extension_is_classified_as_raw(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample.CR3"
            path.write_bytes(b"not-a-real-cr3")
            self.assertEqual(detect_raw_format(path), "cr3")
            self.assertTrue(is_raw_file(path))

    def test_no_extension_cr3_signature_is_classified_as_raw(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample"
            path.write_bytes(b"\x00\x00\x00\x18ftypcrx " + b"\x00" * 64)
            self.assertEqual(detect_raw_format(path), "cr3")
            self.assertTrue(is_raw_file(path))

    def test_no_extension_tiff_with_canon_marker_is_classified_as_raw(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample"
            path.write_bytes(b"II*\x00" + b"\x00" * 32 + b"Canon EOS R6m2" + b"\x00" * 32)
            self.assertEqual(detect_raw_format(path), "cr2")
            self.assertTrue(is_raw_file(path))

    def test_ds_store_is_not_classified_as_raw(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / ".DS_Store"
            path.write_bytes(b"\x00\x00\x00\x01Bud1" + b"\x00" * 32)
            self.assertIsNone(detect_raw_format(path))
            self.assertFalse(is_raw_file(path))


class SystemFolderTest(unittest.TestCase):
    """A whole-card import must not bring back what's in the volume's trash."""

    def test_system_folders_are_recognised_in_any_case(self) -> None:
        for path in (
            Path("E:/$RECYCLE.BIN/S-1-5-21/IMG_0001.JPG"),
            Path("E:/System Volume Information/x.jpg"),
            Path("/Volumes/CARD/.Trashes/501/IMG_0002.JPG"),
            Path("/media/card/.Trash-1000/files/IMG_0003.JPG"),
            Path("D:/$Recycle.Bin/IMG_0004.JPG"),
        ):
            self.assertTrue(in_system_folder(path), path)
            self.assertTrue(is_ignored_path(path), path)
        for path in (Path("/Users/me/Pictures/Trash talk/IMG_0005.JPG"), Path("E:/DCIM/100CANON/IMG_0006.JPG")):
            self.assertFalse(in_system_folder(path), path)
        self.assertTrue(is_ignored_path(Path("/Volumes/CARD/DCIM/._IMG_0007.JPG")))

    def test_card_imports_skip_the_recycle_bin_and_trashes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            card = Path(temp_dir) / "CARD"
            keep = card / "DCIM" / "100CANON" / "IMG_0001.JPG"
            deleted = card / "$RECYCLE.BIN" / "S-1-5-21" / "IMG_0002.JPG"
            trashed = card / ".Trashes" / "501" / "IMG_0003.JPG"
            for path in (keep, deleted, trashed):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"\xff\xd8\xff\xd9")
            self.assertEqual([p.name for p in iter_image_files([card])], ["IMG_0001.JPG"])
            raw = card / "DCIM" / "100CANON" / "IMG_0001.CR3"
            raw_deleted = card / "$RECYCLE.BIN" / "S-1-5-21" / "IMG_0002.CR3"
            for path in (raw, raw_deleted):
                path.write_bytes(b"raw")
            walked = [p.name for p in iter_candidate_paths(card)]
            self.assertIn("IMG_0001.CR3", walked)
            self.assertNotIn("IMG_0002.CR3", walked)


class DockDropTypesTest(unittest.TestCase):
    """The Dock icon takes only the types Info.plist declares (build.mac.extendInfo in
    apps/desktop/package.json), so a format import learns must be added there too."""

    def test_the_dock_icon_takes_every_format_an_import_does(self) -> None:
        package = json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))
        declared = {entry["CFBundleTypeName"]: entry for entry in package["build"]["mac"]["extendInfo"]["CFBundleDocumentTypes"]}

        def extensions(name: str) -> set[str]:
            return {f".{ext}" for ext in declared[name]["CFBundleTypeExtensions"]}

        self.assertEqual(extensions("Photo") | extensions("Video"), MEDIA_EXTENSIONS)
        self.assertEqual(extensions("Video"), VIDEO_EXTENSIONS)
        self.assertEqual(declared["Folder"]["LSItemContentTypes"], ["public.folder"])
        # Accepts drops, but never becomes what Finder opens these files with.
        self.assertEqual({entry["LSHandlerRank"] for entry in declared.values()}, {"None"})


if __name__ == "__main__":
    unittest.main()
