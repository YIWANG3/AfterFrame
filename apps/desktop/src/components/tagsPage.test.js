import { describe, expect, it } from "vitest";
import { allTags, tagMatches, tagSections } from "./tagsPage";

const listed = {
  groups: [
    { group_id: "weather", name: "Weather", kind: "builtin", tags: [
      { tag: "rain", count: 1, pinned: false, aliases: ["雨"] },
      { tag: "sunny", count: 5, pinned: false, aliases: ["晴天"] },
      { tag: "fog", count: 2, pinned: true, aliases: [] },
    ] },
    { group_id: "mood", name: "Mood", kind: "builtin", tags: [] },
  ],
  ungrouped: [{ tag: "trip", count: 3, pinned: false, aliases: [] }, { tag: "Grandma", count: 1, pinned: false, aliases: [] }],
};
const labelOf = (tag) => tag;

describe("tagSections", () => {
  it("orders by use with pinned first, keeps empty groups, ungrouped last", () => {
    const sections = tagSections(listed, { sort: "usage", labelOf });
    expect(sections.map((s) => [s.group?.group_id ?? null, s.items.map((i) => i.tag)])).toEqual([
      ["weather", ["fog", "sunny", "rain"]],
      ["mood", []],
      [null, ["trip", "Grandma"]],
    ]);
  });

  it("sorts by name when asked, pinned still first", () => {
    const [weather] = tagSections(listed, { sort: "name", locale: "en", labelOf });
    expect(weather.items.map((i) => i.tag)).toEqual(["fog", "rain", "sunny"]);
  });

  it("a search hides empty groups and matches aliases and labels", () => {
    expect(tagSections(listed, { query: "雨", labelOf }).map((s) => [s.group?.group_id ?? null, s.items.map((i) => i.tag)]))
      .toEqual([["weather", ["rain"]]]);
    expect(tagSections(listed, { query: "grand", labelOf }).map((s) => s.group)).toEqual([null]);
    expect(tagMatches({ tag: "sunny", aliases: [] }, "SUN", (tag) => tag)).toBe(true);
    expect(tagMatches({ tag: "sunny", aliases: [] }, "晴", (tag) => (tag === "sunny" ? "晴天" : tag))).toBe(true);
  });

  it("lists every tag flat", () => {
    expect(allTags(listed).map((i) => i.tag)).toEqual(["rain", "sunny", "fog", "trip", "Grandma"]);
    expect(allTags(null)).toEqual([]);
  });
});
