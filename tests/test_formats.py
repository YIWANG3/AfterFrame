"""The format registry (media_workspace/formats.py) is the one list of what
the catalog imports; these tests keep its copies honest: the generated JS
module the Electron side reads, and the Dock's document types in
apps/desktop/package.json."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import formats
from media_workspace.derived import SUPPORTED_IMAGE_EXTS
from media_workspace.reverse_lookup import MEDIA_EXTENSIONS, is_raw
from media_workspace.video import is_video

REPO = Path(__file__).resolve().parents[1]
DESKTOP_PACKAGE = REPO / "apps" / "desktop" / "package.json"
GENERATED_JS = REPO / "apps" / "desktop" / "shared" / "formats.generated.mjs"


class RegistryTest(unittest.TestCase):
    def test_every_extension_is_lower_case_dotted_and_listed_once(self) -> None:
        seen: dict[str, str] = {}
        for fmt in formats.REGISTRY:
            self.assertIn(fmt.kind, ("image", "raw", "video"), fmt.family)
            for ext in fmt.extensions:
                self.assertTrue(ext.startswith(".") and ext == ext.lower(), ext)
                self.assertNotIn(ext, seen, f"{ext} is both {seen.get(ext)} and {fmt.family}")
                seen[ext] = fmt.family

    def test_the_import_set_is_what_it_was_before_the_registry(self) -> None:
        # The registry replaced four hand-kept lists (docs/format-support-plan.md
        # §2) without changing what imports. Widen it in formats.py, on purpose.
        self.assertEqual(formats.IMAGE_EXTENSIONS, {".avif", ".heic", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"})
        self.assertEqual(formats.VIDEO_EXTENSIONS, {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"})
        self.assertEqual(len(formats.RAW_EXTENSIONS), 38)
        self.assertEqual(MEDIA_EXTENSIONS, formats.IMPORTABLE_EXTENSIONS)
        self.assertEqual(SUPPORTED_IMAGE_EXTS, {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"})

    def test_kind_by_extension(self) -> None:
        self.assertEqual(formats.kind_of(Path("/p/IMG_0001.JPG")), "image")
        self.assertEqual(formats.kind_of(Path("/p/DSC_0001.NEF")), "raw")
        self.assertEqual(formats.kind_of(Path("/p/clip.MOV")), "video")
        self.assertIsNone(formats.kind_of(Path("/p/notes.txt")))
        self.assertIsNone(formats.kind_of(Path("/p/.DS_Store")))
        self.assertTrue(is_raw(Path("a.cr3")) and not is_raw(Path("a.jpg")))
        self.assertTrue(is_video(Path("a.mp4")) and not is_video(Path("a.cr3")))

    def test_raw_format_by_extension_then_by_content(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            by_name = Path(temp_dir) / "sample.ARW"
            by_name.write_bytes(b"not a real arw")
            self.assertEqual(formats.raw_format_of(by_name), "arw")
            image = Path(temp_dir) / "photo.jpg"
            image.write_bytes(b"\xff\xd8\xff\xd9")
            self.assertIsNone(formats.raw_format_of(image))
            cr3 = Path(temp_dir) / "sample"
            cr3.write_bytes(b"\x00\x00\x00\x18ftypcrx " + b"\x00" * 64)
            self.assertEqual(formats.raw_format_of(cr3), "cr3")
            self.assertIsNone(formats.raw_format_of(cr3, sniff=False))
            tiff = Path(temp_dir) / "scan"
            tiff.write_bytes(b"II*\x00" + b"\x00" * 64)
            self.assertEqual(formats.raw_format_of(tiff), "tiff-raw")

    def test_export_formats(self) -> None:
        self.assertEqual(formats.export_format_for(Path("a.JPEG")), "jpeg")
        self.assertEqual(formats.export_format_for(Path("a.png")), "png")
        self.assertIsNone(formats.export_format_for(Path("a.heic")))
        self.assertEqual(sorted(formats.EXPORT_FORMATS), ["jpeg", "png", "webp"])


class GeneratedJsTest(unittest.TestCase):
    def test_the_shared_module_matches_the_registry(self) -> None:
        self.assertEqual(
            GENERATED_JS.read_text(encoding="utf-8"),
            formats.emit_js(),
            "apps/desktop/shared/formats.generated.mjs is stale: run `npm run gen:formats`",
        )

    def test_the_module_carries_the_sets_the_electron_side_needs(self) -> None:
        text = formats.emit_js()
        for name in ("FORMATS", "IMPORTABLE_EXTENSIONS", "MEDIA_RE", "BROWSER_IMAGE_RE", "TRANSCODE_RE", "VIDEO_MIME", "EXPORT_FORMATS"):
            self.assertIn(f"export const {name} =", text)
        self.assertIn("|nef|", text)
        self.assertNotIn("|gif|", text)


class DockDropTypesTest(unittest.TestCase):
    """The Dock icon takes only the types Info.plist declares (build.mac.extendInfo in
    apps/desktop/package.json), so a format the registry learns must be added there too."""

    def test_the_dock_icon_takes_every_format_an_import_does(self) -> None:
        package = json.loads(DESKTOP_PACKAGE.read_text(encoding="utf-8"))
        declared = {entry["CFBundleTypeName"]: entry for entry in package["build"]["mac"]["extendInfo"]["CFBundleDocumentTypes"]}

        def extensions(name: str) -> set[str]:
            return {f".{ext}" for ext in declared[name]["CFBundleTypeExtensions"]}

        self.assertEqual(extensions("Photo"), formats.IMAGE_EXTENSIONS | formats.RAW_EXTENSIONS)
        self.assertEqual(extensions("Video"), formats.VIDEO_EXTENSIONS)
        self.assertEqual(declared["Folder"]["LSItemContentTypes"], ["public.folder"])
        # Accepts drops, but never becomes what Finder opens these files with.
        self.assertEqual({entry["LSHandlerRank"] for entry in declared.values()}, {"None"})


if __name__ == "__main__":
    unittest.main()
