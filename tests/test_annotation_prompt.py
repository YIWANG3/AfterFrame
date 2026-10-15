"""build_system_prompt reads data/annotation_prompt.json — the file the web
build's llm.js reads too (apps/desktop/src/api/browser/llm.test.js pins the
same cases on that side)."""

import unittest

from media_workspace.annotation import _PROMPT, TAG_REUSE_HINT_LIMIT, build_system_prompt, filter_tags_by_language


class AnnotationPromptTest(unittest.TestCase):
    def test_fills_the_shared_template(self):
        prompt = build_system_prompt(
            languages=["en", "zh"], max_tags=10, max_caption_chars=200, existing_tags=[], custom_instructions=None
        )
        self.assertTrue(prompt.startswith("You are an image annotator"))
        self.assertIn("Max 200 characters.", prompt)
        self.assertIn("up to 10 short tags. " + _PROMPT["lang_clause"]["en+zh"] + " Lowercase.", prompt)
        self.assertTrue(prompt.endswith("Respond with ONLY the JSON object, no commentary."))
        for placeholder in ("{max_caption_chars}", "{max_tags}", "{lang_clause}"):
            self.assertNotIn(placeholder, prompt)
        # The location schema's braces are literal, not placeholders.
        self.assertIn('{"country": str|null', prompt)

    def test_language_clause_tag_sample_and_instructions(self):
        en = build_system_prompt(
            languages=["en"], max_tags=5, max_caption_chars=120,
            existing_tags=["sunset", "海滩", "beach"], custom_instructions="  Be brief.  ",
        )
        self.assertIn(_PROMPT["lang_clause"]["en"], en)
        self.assertIn(_PROMPT["tag_pool_intro"] + "sunset, beach", en)
        self.assertTrue(en.endswith(_PROMPT["custom_instructions_intro"] + "Be brief."))

        zh = build_system_prompt(
            languages=["zh"], max_tags=7, max_caption_chars=80, existing_tags=["sunset"], custom_instructions=""
        )
        self.assertIn(_PROMPT["lang_clause"]["zh"], zh)
        # Every candidate tag is the other language: no tag block at all.
        self.assertNotIn(_PROMPT["tag_pool_intro"], zh)
        self.assertNotIn(_PROMPT["custom_instructions_intro"], zh)

    def test_tag_sample_is_capped_at_the_shared_limit(self):
        tags = [f"tag{i}" for i in range(TAG_REUSE_HINT_LIMIT + 5)]
        prompt = build_system_prompt(
            languages=["en"], max_tags=10, max_caption_chars=200, existing_tags=tags, custom_instructions=None
        )
        self.assertIn(f"tag{TAG_REUSE_HINT_LIMIT - 1}", prompt)
        self.assertNotIn(f"tag{TAG_REUSE_HINT_LIMIT},", prompt)

    def test_filter_tags_by_language(self):
        self.assertEqual(filter_tags_by_language(["a", "海"], ["en", "zh"]), ["a", "海"])
        self.assertEqual(filter_tags_by_language(["a", "海"], ["en"]), ["a"])
        self.assertEqual(filter_tags_by_language(["a", "海"], ["zh"]), ["海"])
