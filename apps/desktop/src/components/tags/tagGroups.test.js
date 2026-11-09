import { describe, expect, it } from "vitest";
import { bucketByGroup, tagChipSummary, tagMatchMode, tagMatchModes } from "./tagGroups";

const groups = [
  { group_id: "weather", name: "Weather", kind: "builtin" },
  { group_id: "subject", name: "Subject", kind: "builtin" },
  { group_id: "grp_x", name: "Pets", kind: "custom" },
];
const groupOf = { sunny: "weather", rain: "weather", street: "subject", mochi: "grp_gone", trip: null };

describe("bucketByGroup", () => {
  it("keeps the groups' order, skips empty groups, puts the ungrouped last", () => {
    const buckets = bucketByGroup(["trip", "street", "sunny", "mochi", "rain"], groups, (tag) => groupOf[tag]);
    expect(buckets.map((b) => [b.group?.group_id ?? null, b.items])).toEqual([
      ["weather", ["sunny", "rain"]],
      ["subject", ["street"]],
      // A group the list does not know counts as none, with the ungrouped.
      [null, ["trip", "mochi"]],
    ]);
  });

  it("is empty for nothing", () => {
    expect(bucketByGroup([], groups, () => null)).toEqual([]);
  });
});

describe("tagChipSummary", () => {
  const t = (key, vars) => (key === "filter.pickedMore" ? `${vars.first} +${vars.count}` : `any ${vars.group}`);
  const labelOf = (tag) => tag.toUpperCase();
  const groupLabelOf = (id) => id;
  it("names one pick, counts the rest, groups first", () => {
    expect(tagChipSummary({ tags: [], groups: [], labelOf, groupLabelOf, t })).toBeUndefined();
    expect(tagChipSummary({ tags: ["sunny"], groups: [], labelOf, groupLabelOf, t })).toBe("SUNNY");
    expect(tagChipSummary({ tags: ["sunny", "rain"], groups: [], labelOf, groupLabelOf, t })).toBe("SUNNY +1");
    expect(tagChipSummary({ tags: ["sunny"], groups: ["weather"], labelOf, groupLabelOf, t })).toBe("any weather +1");
  });
});

describe("tag match modes", () => {
  it("offers any / by group / all / exclude for several tags, include / exclude for one", () => {
    expect(tagMatchModes(1)).toEqual(["include", "exclude"]);
    expect(tagMatchModes(3)).toEqual(["any", "by_group", "all", "exclude"]);
    expect(tagMatchMode({ excluded: true, tagMatch: "all", pickedCount: 2 })).toBe("exclude");
    expect(tagMatchMode({ excluded: false, tagMatch: "by_group", pickedCount: 2 })).toBe("by_group");
    expect(tagMatchMode({ excluded: false, tagMatch: "all", pickedCount: 1 })).toBe("include");
    expect(tagMatchMode({ excluded: false, tagMatch: undefined, pickedCount: 2 })).toBe("any");
  });
});
