import { describe, expect, it } from "vitest";

import { computeGroups, orderImages, shuffleImages, MAX_TEMPLATE_COUNT } from "./collageBatch";

function imgs(n) {
  return Array.from({ length: n }, (_, i) => ({ asset_id: `a${i + 1}`, stem: `img_${String(i + 1).padStart(2, "0")}` }));
}

describe("computeGroups", () => {
  it("splits evenly with no remainder", () => {
    const groups = computeGroups(imgs(12), 4, "own");
    expect(groups.map((g) => g.length)).toEqual([4, 4, 4]);
    expect(groups[0][0].asset_id).toBe("a1");
    expect(groups[2][3].asset_id).toBe("a12");
  });

  it("own: remainder becomes its own page", () => {
    const groups = computeGroups(imgs(14), 4, "own");
    expect(groups.map((g) => g.length)).toEqual([4, 4, 4, 2]);
  });

  it("merge: remainder appends to the last full page", () => {
    const groups = computeGroups(imgs(14), 4, "merge");
    expect(groups.map((g) => g.length)).toEqual([4, 4, 6]);
    expect(groups[2].map((g) => g.asset_id)).toEqual(["a9", "a10", "a11", "a12", "a13", "a14"]);
  });

  it("merge falls back to own page when it would exceed the template max", () => {
    // 23 images ÷ 12 → 12 + 11; merging would make 23 > MAX_TEMPLATE_COUNT
    const groups = computeGroups(imgs(23), 12, "merge");
    expect(groups.map((g) => g.length)).toEqual([12, 11]);
    expect(groups.every((g) => g.length <= MAX_TEMPLATE_COUNT)).toBe(true);
  });

  it("merge with a single partial group keeps it as-is", () => {
    const groups = computeGroups(imgs(3), 4, "merge");
    expect(groups.map((g) => g.length)).toEqual([3]);
  });

  it("drop: remainder is discarded", () => {
    const groups = computeGroups(imgs(14), 4, "drop");
    expect(groups.map((g) => g.length)).toEqual([4, 4, 4]);
  });

  it("drop with fewer images than one group yields nothing", () => {
    expect(computeGroups(imgs(3), 4, "drop")).toEqual([]);
  });
});

describe("orderImages", () => {
  const base = [
    { asset_id: "b", stem: "bbb", image_metadata: { capture_time: "2026-01-02T00:00:00Z" } },
    { asset_id: "c", stem: "ccc" },
    { asset_id: "a", stem: "aaa", image_metadata: { capture_time: "2026-01-01T00:00:00Z" } },
  ];

  it("selection order keeps input untouched", () => {
    expect(orderImages(base, "selection").map((i) => i.asset_id)).toEqual(["b", "c", "a"]);
  });

  it("filename sorts by stem", () => {
    expect(orderImages(base, "filename").map((i) => i.asset_id)).toEqual(["a", "b", "c"]);
  });

  it("captureTime sorts chronologically, missing times last", () => {
    expect(orderImages(base, "captureTime").map((i) => i.asset_id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [...base];
    orderImages(input, "filename");
    expect(input.map((i) => i.asset_id)).toEqual(["b", "c", "a"]);
  });
});

describe("shuffleImages", () => {
  // A small LCG: the same sequence every run.
  function seeded(seed) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it("is a permutation of the pool in another order, leaving the pool alone", () => {
    const pool = imgs(9);
    const copy = [...pool];
    const out = shuffleImages(pool, seeded(7));
    expect(out).toHaveLength(9);
    expect([...out].sort((a, b) => (a.asset_id < b.asset_id ? -1 : 1))).toEqual(copy);
    expect(out.map((i) => i.asset_id)).not.toEqual(copy.map((i) => i.asset_id));
    expect(pool).toEqual(copy);
  });

  it("never hands back the order it was given, even for two images", () => {
    const pool = imgs(2);
    for (let seed = 0; seed < 20; seed++) {
      expect(shuffleImages(pool, seeded(seed)).map((i) => i.asset_id)).toEqual(["a2", "a1"]);
    }
    // Dice that always leave every image in place: the first two trade.
    expect(shuffleImages(imgs(5), () => 0.999).map((i) => i.asset_id)).toEqual(["a2", "a1", "a3", "a4", "a5"]);
  });

  it("leaves fewer than two images as they are", () => {
    expect(shuffleImages([], seeded(1))).toEqual([]);
    expect(shuffleImages(imgs(1), seeded(1)).map((i) => i.asset_id)).toEqual(["a1"]);
  });
});
