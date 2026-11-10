import { describe, expect, it } from "vitest";
import { MAX_KEYWORDS, parsePickList, pickStatus, pickedAssetIds } from "./pickList";

describe("parsePickList", () => {
  it("reads the numbers whatever separates them", () => {
    const picks = ["1723", "1746", "1754"];
    for (const text of [
      "1723 1746 1754",
      "1723,1746,1754",
      "1723，1746、1754",
      "1723 | 1746 | 1754",
      "1723|1746|1754",
      "1723\n1746\r\n1754\n",
      "1723;1746；1754。",
      "1723/1746\\1754",
      "1723和1746还有1754",
      "1723-1746-1754",
      "1723.1746.1754",
      "  1723\t1746   1754  ",
    ]) expect(parsePickList(text), JSON.stringify(text)).toEqual(picks);
  });

  it("reads them out of a sentence", () => {
    expect(parsePickList("这几张：B0001723.3FR 1746 还有1754 谢谢~")).toEqual(["B0001723", "1746", "1754"]);
    expect(parsePickList("要这些 👉 01442，01446，01454，谢谢老师🙏")).toEqual(["01442", "01446", "01454"]);
    expect(parsePickList("Please send DSC01442 and DSC01446, thanks!")).toEqual(["DSC01442", "DSC01446"]);
  });

  it("takes the extension off a file name", () => {
    expect(parsePickList("B0001723.3FR IMG_1754.jpeg DSC01442.ARW 0099.CR3 P1000123.RW2 clip_0042.mp4"))
      .toEqual(["B0001723", "IMG_1754", "DSC01442", "0099", "P1000123", "clip_0042"]);
    // A dot between two numbers separates them.
    expect(parsePickList("1723.1746")).toEqual(["1723", "1746"]);
  });

  it("keeps the leading zeros and the case as written", () => {
    expect(parsePickList("01442 dsc01446 DSC01454")).toEqual(["01442", "dsc01446", "DSC01454"]);
  });

  it("reads full-width digits and letters", () => {
    expect(parsePickList("１７２３，ＤＳＣ０１４４２")).toEqual(["1723", "DSC01442"]);
  });

  it("leaves out what names no photo", () => {
    // Words, a count, a timestamp's pieces, a lone prefix.
    expect(parsePickList("共12张 14:32 IMG 谢谢 ok _ __")).toEqual([]);
    expect(parsePickList("")).toEqual([]);
    expect(parsePickList(null)).toEqual([]);
  });

  it("lists a keyword once, whatever its case", () => {
    expect(parsePickList("1723 1723, dsc01442 DSC01442 1723")).toEqual(["1723", "dsc01442"]);
  });

  it("stops at a client's worth of keywords", () => {
    const text = Array.from({ length: MAX_KEYWORDS + 40 }, (_, index) => String(10000 + index)).join(" ");
    expect(parsePickList(text)).toHaveLength(MAX_KEYWORDS);
  });
});

describe("what a lookup found", () => {
  const match = (id) => ({ asset_id: id, file_name: `${id}.jpg` });
  const entries = [
    { keyword: "1723", count: 1, matches: [match("a")] },
    { keyword: "1746", count: 2, matches: [match("b"), match("c")] },
    { keyword: "1999", count: 0, matches: [] },
    { keyword: "100", count: 60, matches: [match("a"), match("z")] },
    { keyword: "B0001723", count: 1, matches: [match("a")] },
  ];

  it("names each keyword's case", () => {
    expect(entries.map((entry) => pickStatus(entry, 50))).toEqual(["one", "many", "none", "broad", "one"]);
    expect(pickStatus({ keyword: "x", count: 50, matches: [] }, 50)).toBe("many");
  });

  it("gathers each photo once, without the keywords that are too broad", () => {
    expect(pickedAssetIds(entries, 50)).toEqual(["a", "b", "c"]);
  });

  it("leaves out the keywords the user unticked", () => {
    expect(pickedAssetIds(entries, 50, new Set(["1746"]))).toEqual(["a"]);
    expect(pickedAssetIds(entries, 50, new Set(["1723", "b0001723", "1746"]))).toEqual([]);
  });
});
