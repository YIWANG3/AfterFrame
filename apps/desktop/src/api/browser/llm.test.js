// The web build's annotation prompt is the sidecar's data/annotation_prompt.json
// filled in the way annotation.build_system_prompt fills it (the Python test
// is tests/test_annotation_prompt.py; both pin the same fixed cases).

import { describe, expect, it } from "vitest";
import PROMPT from "@sidecar-data/annotation_prompt.json";
import { buildAnnotationSystemPrompt, filterTagsByLanguage, parseTags } from "./llm";

describe("buildAnnotationSystemPrompt", () => {
  it("fills the shared template and leaves no placeholder behind", () => {
    const prompt = buildAnnotationSystemPrompt({ languages: ["en", "zh"], maxTags: 10, maxCaptionChars: 200 });
    expect(prompt.startsWith("You are an image annotator")).toBe(true);
    expect(prompt).toContain("Max 200 characters.");
    expect(prompt).toContain('"tags": an array of up to 10 short tags. ' + PROMPT.lang_clause["en+zh"] + " Lowercase.");
    expect(prompt.endsWith("Respond with ONLY the JSON object, no commentary.")).toBe(true);
    expect(prompt).not.toMatch(/\{(max_caption_chars|max_tags|lang_clause|tags_shape)\}/);
    // The location schema's braces are literal, not placeholders.
    expect(prompt).toContain('{"country": str|null');
  });

  it("picks the language clause and filters the tag sample like the sidecar", () => {
    const en = buildAnnotationSystemPrompt({
      languages: ["en"], maxTags: 5, maxCaptionChars: 120,
      existingTags: ["sunset", "海滩", "beach"], customInstructions: "  Be brief.  ",
    });
    expect(en).toContain(PROMPT.lang_clause.en);
    expect(en).toContain(PROMPT.tag_pool_intro + "sunset, beach");
    expect(en.endsWith(PROMPT.custom_instructions_intro + "Be brief.")).toBe(true);

    const zh = buildAnnotationSystemPrompt({ languages: ["zh"], maxTags: 7, maxCaptionChars: 80, existingTags: ["sunset"] });
    expect(zh).toContain(PROMPT.lang_clause.zh);
    // Every candidate tag is the other language: no tag block at all.
    expect(zh).not.toContain(PROMPT.tag_pool_intro);
    expect(zh).not.toContain(PROMPT.custom_instructions_intro);
  });

  it("caps the tag sample at the shared limit", () => {
    const tags = Array.from({ length: PROMPT.tag_reuse_hint_limit + 5 }, (_, i) => `tag${i}`);
    const prompt = buildAnnotationSystemPrompt({ languages: ["en"], existingTags: tags });
    expect(prompt).toContain(`tag${PROMPT.tag_reuse_hint_limit - 1}`);
    expect(prompt).not.toContain(`tag${PROMPT.tag_reuse_hint_limit},`);
  });
});

describe("grouped tags", () => {
  it("lists the groups with their examples, the way the sidecar does", () => {
    const groups = [
      { id: "weather", name: "Weather", examples: ["sunny", "雨"] },
      { id: "mood", name: "Mood", examples: [] },
      { id: "other", name: "Other", examples: ["mystery"] },
    ];
    const prompt = buildAnnotationSystemPrompt({ languages: ["en"], maxTags: 6, maxCaptionChars: 120, customInstructions: "Short.", tagGroups: groups });
    expect(prompt).toContain(PROMPT.tags_grouped.replaceAll("{max_tags}", "6"));
    expect(prompt).toContain(PROMPT.groups_intro + "- weather (Weather): sunny\n- mood (Mood)");
    expect(prompt).not.toContain("mystery");
    expect(prompt).not.toContain(PROMPT.tag_pool_intro);
    expect(prompt.endsWith(PROMPT.custom_instructions_intro + "Short.")).toBe(true);
  });

  it("reads grouped or flat tag output", () => {
    expect(parseTags({ subject: ["cat", "cat"], mood: ["cozy"], other: ["blanket"] }, 10)).toEqual({
      tags: ["cat", "cozy", "blanket"], groupsOf: { cat: "subject", cozy: "mood" },
    });
    expect(parseTags(["Sunset", { tag: "beach" }, "x"], 2)).toEqual({ tags: ["Sunset", "beach"], groupsOf: {} });
    expect(parseTags("nope", 5)).toEqual({ tags: [], groupsOf: {} });
  });
});

describe("filterTagsByLanguage", () => {
  it("keeps both languages when both are wanted, else only the matching script", () => {
    expect(filterTagsByLanguage(["a", "海"], ["en", "zh"])).toEqual(["a", "海"]);
    expect(filterTagsByLanguage(["a", "海"], ["en"])).toEqual(["a"]);
    expect(filterTagsByLanguage(["a", "海"], ["zh"])).toEqual(["海"]);
  });
});
