"""Previews through Image I/O (image_io_previews): the preview Pillow makes,
and Pillow whenever the helper can't."""
from __future__ import annotations

import os
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from media_workspace import image_io_previews
from media_workspace.catalog import ensure_catalog
from media_workspace.color_profiles import adobe_rgb_icc
from media_workspace.imaging import register_heif
from media_workspace.preview_service import PreviewService, preview_shape, render_pillow_preview
from media_workspace.visual import hamming, perceptual_hash

REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "apps" / "desktop" / "native" / "bin" / "image-features"
ORIENTATION = 0x0112


def built_helper_renders() -> bool:
    if sys.platform != "darwin" or not HELPER.is_file():
        return False
    return image_io_previews.HelperPool().renders(HELPER)


def photo(path: Path, size=(1200, 800), *, mode="RGB", orientation: int | None = None, icc: bytes | None = None) -> Path:
    """A picture whose layout shows which way it is turned: a blue band down
    the left, a red one along the bottom, on grey."""
    width, height = size
    image = Image.new("RGB", size, (150, 150, 150))
    image.paste((30, 60, 200), (0, 0, width // 5, height))
    image.paste((200, 40, 40), (0, height - height // 6, width, height))
    image = image.convert(mode)
    options: dict = {"quality": 92}
    if orientation:
        exif = Image.Exif()
        exif[ORIENTATION] = orientation
        options["exif"] = exif.tobytes()
    if icc:
        options["icc_profile"] = icc
    if path.suffix == ".heic":
        register_heif()
    image.save(path, **options)
    return path


def described(path: Path) -> tuple[tuple[int, int], int, bytes | None]:
    with Image.open(path) as image:
        return image.size, int(image.getexif().get(ORIENTATION) or 1), image.info.get("icc_profile")


@unittest.skipUnless(built_helper_renders(), "needs the image-features helper built on a Mac (npm run build:native)")
class BuiltHelperTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def both(self, source: Path, size: int = 512) -> tuple[Path, Path]:
        pillow = self.root / f"{source.stem}.pillow.jpg"
        image_io = self.root / f"{source.stem}.imageio.jpg"
        render_pillow_preview(source, pillow, size)
        image_io_previews.render(HELPER, source, image_io, size)
        return pillow, image_io

    def assert_same_preview(self, pillow: Path, image_io: Path) -> None:
        (p_size, p_tag, _), (i_size, i_tag, _) = described(pillow), described(image_io)
        self.assertEqual(i_tag, p_tag)
        for got, want in zip(i_size, p_size, strict=True):  # resamplers round the short edge apart
            self.assertLessEqual(abs(got - want), 1)
        self.assertEqual(preview_shape(image_io), preview_shape(pillow))
        self.assertLessEqual(hamming(perceptual_hash(image_io), perceptual_hash(pillow)), 4)

    def test_a_jpeg_keeps_its_pixels_as_stored_and_its_orientation_tag(self):
        pillow, image_io = self.both(photo(self.root / "turned.jpg", orientation=6))
        self.assertEqual(described(image_io)[:2], ((512, 341), 6))
        self.assertEqual(preview_shape(image_io), "portrait")
        self.assert_same_preview(pillow, image_io)

    def test_a_heif_comes_upright_without_the_tag_as_pillow_heif_hands_it_over(self):
        # pillow-heif writes the turn as the HEIF's own rotation (irot) and
        # applies it on reading; Image I/O is asked to do the same.
        pillow, image_io = self.both(photo(self.root / "turned.heic", orientation=6))
        (width, height), tag, _ = described(image_io)
        self.assertEqual((height, tag), (512, 1))
        self.assertLess(width, height)
        self.assert_same_preview(pillow, image_io)

    def test_the_photo_keeps_its_colour_space(self):
        adobe = adobe_rgb_icc()
        _, image_io = self.both(photo(self.root / "adobe.jpg", icc=adobe))
        profile = described(image_io)[2]
        self.assertIsNotNone(profile)
        from io import BytesIO

        from PIL import ImageCms

        name = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(BytesIO(profile)))
        self.assertIn("Adobe RGB", name)

    def test_what_pillow_converts_is_left_to_pillow(self):
        for name, mode in (("print.jpg", "CMYK"), ("mono.jpg", "L")):
            with self.subTest(mode=mode), self.assertRaises(image_io_previews.ImageIOPreviewError):
                image_io_previews.render(HELPER, photo(self.root / name, mode=mode), self.root / f"{name}.out.jpg", 512)

    def test_a_small_photo_is_not_enlarged(self):
        source = photo(self.root / "small.jpg", size=(300, 200))
        for size in (512, 2000):
            out = self.root / f"small-{size}.jpg"
            image_io_previews.render(HELPER, source, out, size)
            self.assertEqual(described(out)[0], (300, 200))

    def test_the_service_renders_jpeg_and_heif_here_and_the_rest_with_pillow(self):
        catalog = ensure_catalog(self.root / "demo.afcatalog")
        service = PreviewService(catalog)
        sources = {
            "jpeg": photo(self.root / "a.jpg"),
            "heif": photo(self.root / "b.heic"),
            "cmyk": photo(self.root / "c.jpg", mode="CMYK"),
            "png": photo(self.root / "d.png"),
        }
        with mock.patch.dict(os.environ, {"IMAGE_FEATURES_PATH": str(HELPER)}), \
                mock.patch.object(service, "_render_with_pillow", wraps=service._render_with_pillow) as pillow:
            for name, source in sources.items():
                out = service._render_image(source, self.root / f"{name}.preview.jpg", 512)
                with Image.open(out) as image:
                    self.assertEqual((image.format, image.mode), ("JPEG", "RGB"))
        rendered_by_pillow = sorted(Path(call.args[0]).name for call in pillow.call_args_list)
        self.assertEqual(rendered_by_pillow, ["c.jpg", "d.png"])


# Stand-ins for the helper, one per way it can let a render down. They speak
# its protocol; "ok" paints the preview green so a test can tell whose it is.
FAKE = textwrap.dedent(
    """\
    #!{python}
    import json, sys, time
    from PIL import Image
    MODE = {mode!r}
    if sys.argv[1:] == ["--thumb-protocol"]:
        # An older build reads the flag as a file to print.
        print(json.dumps({{"id": "--thumb-protocol", "ok": False, "error": "no such file"}}) if MODE == "old" else 1)
        sys.exit(0)
    for line in sys.stdin:
        request = json.loads(line)
        if MODE == "hang":
            time.sleep(120)
        if MODE == "die":
            sys.exit(3)
        if MODE == "chatty":
            print("MPSGraph says hello", flush=True)
        if MODE == "decline":
            print(json.dumps({{"id": request["id"], "ok": False, "declined": True, "error": "colour model CMYK"}}), flush=True)
            continue
        Image.new("RGB", (8, 8), (0, 255, 0)).save(request["out"], "JPEG")
        print(json.dumps({{"id": request["id"], "ok": True, "width": 8, "height": 8}}), flush=True)
    """
)


@unittest.skipIf(os.name == "nt", "previews through Image I/O are a Mac's; select() can't wait on a pipe on Windows")
class FallbackTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.service = PreviewService(ensure_catalog(self.root / "demo.afcatalog"))
        self.source = photo(self.root / "photo.jpg", orientation=6)
        # A pool of this test's own, so one test's helper is not the next's.
        pool = image_io_previews.HelperPool()
        self.addCleanup(pool.close_all)
        for patcher in (mock.patch.object(image_io_previews, "HELPERS", pool),
                        mock.patch.object(image_io_previews, "TIMEOUT_SECONDS", 1.0)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pool = pool

    def use(self, mode: str) -> Path:
        script = self.root / f"fake-{mode}.py"
        script.write_text(FAKE.format(python=sys.executable, mode=mode), encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        patcher = mock.patch.object(image_io_previews, "_helper_path", lambda: script)
        patcher.start()
        self.addCleanup(patcher.stop)
        return script

    def render(self) -> Path:
        return self.service._render_image(self.source, self.root / "preview.jpg", 512)

    def assert_pillow_rendered(self, out: Path) -> None:
        with Image.open(out) as image:
            self.assertEqual(image.size, (512, 341))
            self.assertEqual(image.getexif().get(ORIENTATION), 6)
            self.assertNotEqual(image.getpixel((256, 100)), (0, 255, 0))

    def test_the_helper_renders_jpeg_and_heif_when_it_can(self):
        self.use("ok")
        with Image.open(self.render()) as image:
            self.assertEqual(image.size, (8, 8))

    def test_an_older_helper_is_never_asked(self):
        script = self.use("old")
        self.assertIsNone(image_io_previews.helper_for(self.source))
        self.assertFalse(self.pool.renders(script))
        self.assert_pillow_rendered(self.render())

    def test_what_the_helper_declines_pillow_renders(self):
        self.use("decline")
        self.assert_pillow_rendered(self.render())

    def test_a_stuck_helper_is_put_down_and_pillow_renders(self):
        self.use("hang")
        started = time.monotonic()
        self.assert_pillow_rendered(self.render())
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.pool._idle.get(image_io_previews._helper_path(), []), [])
        self.assertTrue(all(not helper.alive for helper in self.pool._all))

    def test_a_helper_that_dies_is_replaced_on_the_next_render(self):
        self.use("die")
        self.assert_pillow_rendered(self.render())
        self.assert_pillow_rendered(self.render())
        self.assertEqual(len(self.pool._all), 2)

    def test_a_helper_that_prints_out_of_protocol_is_put_down(self):
        self.use("chatty")
        self.assert_pillow_rendered(self.render())
        self.assertTrue(all(not helper.alive for helper in self.pool._all))

    def test_no_helper_on_other_platforms(self):
        with mock.patch.object(sys, "platform", "win32"):
            self.assertIsNone(image_io_previews._helper_path())

    def test_formats_other_than_jpeg_and_heif_never_reach_the_helper(self):
        self.use("ok")
        png = photo(self.root / "photo.png")
        self.assertIsNone(image_io_previews.helper_for(png))
        out = self.service._render_image(png, self.root / "png.jpg", 512)
        with Image.open(out) as image:
            self.assertEqual(image.size, (512, 341))


if __name__ == "__main__":
    unittest.main()
