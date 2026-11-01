"""Style reference images ride along with a repaint: every provider gets the
photo first and the references after it, and the prompt grows one sentence
that says which image is which. These tests catch the request each provider
sends instead of calling it."""
from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from media_workspace import ai_repaint
from media_workspace.ai_repaint import reference_note


def _png(path: Path, colour: tuple[int, int, int]) -> Path:
    Image.new("RGB", (8, 6), colour).save(path)
    return path


class ReferenceNoteTest(unittest.TestCase):
    def test_the_note_counts_the_references(self) -> None:
        self.assertIn("The second image is a style reference", reference_note(1))
        self.assertIn("The following 3 images are style references", reference_note(3))
        self.assertTrue(reference_note(1).startswith("\n\n"))

    def test_mock_records_the_references_and_the_grown_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            photo = _png(root / "photo.png", (10, 20, 30))
            ref = _png(root / "ref.png", (200, 100, 50))
            plain = ai_repaint.run_mock_repaint(photo, root / "out-plain.png", "p")
            self.assertEqual(plain.prompt, "p")
            self.assertEqual(len(plain.notes), 1)
            with_ref = ai_repaint.run_mock_repaint(photo, root / "out-ref.png", "p", reference_paths=[ref])
            self.assertEqual(with_ref.prompt, "p" + reference_note(1))
            self.assertIn("ref.png", with_ref.notes[1])


class ReferenceImageTest(unittest.TestCase):
    """What is sent for a reference: a JPEG no longer than REFERENCE_MAX_EDGE,
    whatever the file was, so a 7 MB export does not ride along whole."""

    def test_a_large_reference_is_shrunk_and_a_small_one_still_becomes_a_jpeg(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            big = root / "big.png"
            Image.new("RGB", (4000, 2500), (200, 100, 50)).save(big)
            data, mime = ai_repaint._reference_image(big)
            self.assertEqual(mime, "image/jpeg")
            with Image.open(io.BytesIO(data)) as sent:
                self.assertEqual(sent.size, (ai_repaint.REFERENCE_MAX_EDGE, 960))
            self.assertLess(len(data), big.stat().st_size)

            small = _png(root / "small.png", (1, 2, 3))
            data, mime = ai_repaint._reference_image(small)
            self.assertEqual(mime, "image/jpeg")
            with Image.open(io.BytesIO(data)) as sent:
                self.assertEqual(sent.size, (8, 6))

            # Not an image at all: sent as it is rather than failing the job here.
            text = root / "notes.txt"
            text.write_text("not a picture")
            self.assertEqual(ai_repaint._reference_image(text), (b"not a picture", "text/plain"))


class SourceImageTest(unittest.TestCase):
    """The photo itself goes as the file while it fits SOURCE_MAX_EDGE, and
    shrunk to that edge (no provider renders larger) when it does not."""

    def test_a_small_source_is_the_file_and_a_large_one_is_shrunk(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            small = _png(root / "small.png", (9, 8, 7))
            self.assertEqual(ai_repaint._source_image(small), (small.read_bytes(), "image/png"))

            big = root / "big.jpg"
            Image.new("RGB", (6000, 4000), (30, 60, 90)).save(big, quality=90)
            data, mime = ai_repaint._source_image(big)
            self.assertEqual(mime, "image/jpeg")
            with Image.open(io.BytesIO(data)) as sent:
                self.assertEqual(sent.size, (ai_repaint.SOURCE_MAX_EDGE, 2731))

            # Within the pixel limit but heavy on disk (maximum-quality export):
            # re-encoded at the same pixels, so the upload shrinks.
            heavy = root / "heavy.png"
            Image.effect_noise((3000, 2000), 80).convert("RGB").save(heavy)
            self.assertGreater(heavy.stat().st_size, ai_repaint.SOURCE_MAX_BYTES)
            data, mime = ai_repaint._source_image(heavy)
            self.assertEqual(mime, "image/jpeg")
            self.assertLess(len(data), heavy.stat().st_size)
            with Image.open(io.BytesIO(data)) as sent:
                self.assertIn(sent.size, [(3000, 2000), (ai_repaint.SOURCE_FALLBACK_EDGE, 2048)])


class ProviderRequestsTest(unittest.TestCase):
    """What each provider is sent when two references ride along."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        root = Path(self._temp.name)
        self.photo = _png(root / "photo.png", (10, 20, 30))
        self.refs = [_png(root / "ref-a.png", (200, 100, 50)), _png(root / "ref-b.png", (50, 100, 200))]
        self.out = root / "out.png"
        self.photo_b64 = base64.b64encode(self.photo.read_bytes()).decode()
        # References travel shrunk and re-encoded (see _reference_image), so
        # the expected bytes are what that helper gives, not the files.
        self.ref_b64 = [base64.b64encode(ai_repaint._reference_image(p)[0]).decode() for p in self.refs]
        # A 1x1 PNG the fake providers answer with.
        self.answer_png = base64.b64encode(_png(root / "answer.png", (0, 0, 0)).read_bytes()).decode()

    def tearDown(self) -> None:
        self._temp.cleanup()

    def test_gemini_sends_the_photo_then_the_references(self) -> None:
        sent: dict = {}

        def fake_post(_label, _url, *, data, headers):
            sent["body"] = json.loads(data)
            return {"candidates": [{"content": {"parts": [{"inlineData": {"data": self.answer_png, "mimeType": "image/png"}}]}}]}

        with mock.patch.object(ai_repaint, "_post_image_api", fake_post):
            result = ai_repaint.run_nanobanana_repaint(
                self.photo, self.out, "make it warm", api_key="k", reference_paths=self.refs,
            )
        parts = sent["body"]["contents"][0]["parts"]
        self.assertEqual(parts[0]["text"], "make it warm" + reference_note(2))
        self.assertEqual([p["inline_data"]["data"] for p in parts[1:]], [self.photo_b64, *self.ref_b64])
        self.assertEqual(result.prompt, "make it warm" + reference_note(2))

    def test_gemini_without_references_is_unchanged(self) -> None:
        sent: dict = {}

        def fake_post(_label, _url, *, data, headers):
            sent["body"] = json.loads(data)
            return {"candidates": [{"content": {"parts": [{"inlineData": {"data": self.answer_png, "mimeType": "image/png"}}]}}]}

        with mock.patch.object(ai_repaint, "_post_image_api", fake_post):
            result = ai_repaint.run_nanobanana_repaint(self.photo, self.out, "make it warm", api_key="k")
        parts = sent["body"]["contents"][0]["parts"]
        self.assertEqual(len(parts), 2)
        self.assertEqual(parts[0]["text"], "make it warm")
        self.assertEqual(result.prompt, "make it warm")

    def test_seedream_sends_a_list_of_images_only_with_references(self) -> None:
        bodies: list[dict] = []

        def fake_post(_label, _url, *, data, headers):
            bodies.append(json.loads(data))
            return {"data": [{"b64_json": self.answer_png}]}

        with mock.patch.object(ai_repaint, "_post_image_api", fake_post):
            ai_repaint.run_ark_repaint(self.photo, self.out, "p", api_key="k")
            ai_repaint.run_ark_repaint(self.photo, self.out, "p", api_key="k", reference_paths=self.refs)
        self.assertIsInstance(bodies[0]["image"], str)
        self.assertEqual(bodies[0]["prompt"], "p")
        self.assertIsInstance(bodies[1]["image"], list)
        self.assertEqual(len(bodies[1]["image"]), 3)
        self.assertTrue(bodies[1]["image"][0].endswith(self.photo_b64))
        self.assertTrue(bodies[1]["image"][1].endswith(self.ref_b64[0]))
        self.assertEqual(bodies[1]["prompt"], "p" + reference_note(2))

    def test_openai_edits_carry_one_image_part_per_file(self) -> None:
        sent: dict = {}

        def fake_post(_label, _url, *, data, headers):
            sent["data"] = data
            return {"data": [{"b64_json": self.answer_png}]}

        with mock.patch.object(ai_repaint, "_post_image_api", fake_post):
            ai_repaint.run_openai_repaint(self.photo, self.out, "p", api_key="k", reference_paths=self.refs)
        body = sent["data"]
        self.assertEqual(body.count(b'name="image[]"'), 3)
        self.assertLess(body.find(b'filename="photo.png"'), body.find(b'filename="ref-a.png"'))
        self.assertLess(body.find(b'filename="ref-a.png"'), body.find(b'filename="ref-b.png"'))
        self.assertIn(reference_note(2).encode(), body)

    def test_jimeng_generation_takes_references_but_the_upscaler_does_not(self) -> None:
        submitted: list[dict] = []

        def fake_submit(_vs, body, _req_key):
            submitted.append(body)
            return base64.b64decode(self.answer_png), "image/png"

        with mock.patch.object(ai_repaint, "_jimeng_client", lambda ak, sk: object()), \
                mock.patch.object(ai_repaint, "_jimeng_submit_poll_extract", fake_submit):
            ai_repaint.run_jimeng_repaint(
                self.photo, self.out, "p", access_key_id="a", secret_access_key="s",
                model="jimeng_t2i_v40", reference_paths=self.refs,
            )
            ai_repaint.run_jimeng_repaint(
                self.photo, self.out, "p", access_key_id="a", secret_access_key="s",
                model="jimeng_i2i_seed3_tilesr_cvtob", reference_paths=self.refs,
            )
        self.assertEqual(submitted[0]["binary_data_base64"], [self.photo_b64, *self.ref_b64])
        self.assertEqual(submitted[0]["prompt"], "p" + reference_note(2))
        self.assertEqual(submitted[1]["binary_data_base64"], [self.photo_b64])
        self.assertNotIn("prompt", submitted[1])


if __name__ == "__main__":
    unittest.main()
