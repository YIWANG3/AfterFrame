import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bool, clearPref, fields, hexColor, intIn, numberIn, oneOf, readPref, recordOf, text, writePref,
} from "./prefs";

describe("remembered choices", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("gives the default until something is written, then the written value", () => {
    expect(readPref("collage.gap", 0)).toBe(0);
    writePref("collage.gap", 24);
    expect(readPref("collage.gap", 0)).toBe(24);
    expect(store.get("afterframe.pref.collage.gap")).toBe("24");
  });

  it("forgets on clear, so the default comes back", () => {
    writePref("collage.gap", 24);
    clearPref("collage.gap");
    expect(readPref("collage.gap", 0)).toBe(0);
  });

  it("falls back on a value the check rejects, or that is not JSON", () => {
    writePref("collage.width", 1234);
    expect(readPref("collage.width", 3000, oneOf([1080, 2048, 3000, 4096]))).toBe(3000);
    store.set("afterframe.pref.collage.width", "{not json");
    expect(readPref("collage.width", 3000, oneOf([1080, 2048, 3000, 4096]))).toBe(3000);
  });

  it("still works when storage throws (private mode, a blocked origin)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => writePref("a", 1)).not.toThrow();
    expect(() => clearPref("a")).not.toThrow();
    expect(readPref("a", 7)).toBe(7);
  });

  describe("checks", () => {
    it("clamp numbers into range and reject what is not a number", () => {
      expect(numberIn(0, 10)(12)).toBe(10);
      expect(numberIn(0, 10)(-1)).toBe(0);
      expect(numberIn(0, 10)(Number.NaN)).toBeUndefined();
      expect(numberIn(0, 10)("5")).toBeUndefined();
      expect(intIn(2, 12)(4)).toBe(4);
      expect(intIn(2, 12)(4.5)).toBeUndefined();
      expect(intIn(2, 12)(40)).toBe(12);
    });

    it("accept only listed values, booleans, hex colours and strings", () => {
      expect(oneOf(["side", "stack"])("stack")).toBe("stack");
      expect(oneOf(["side", "stack"])("diagonal")).toBeUndefined();
      expect(bool(false)).toBe(false);
      expect(bool("false")).toBeUndefined();
      expect(hexColor("#1E3A2F")).toBe("#1E3A2F");
      expect(hexColor("#fff")).toBe("#fff");
      expect(hexColor("red")).toBeUndefined();
      expect(text(5)("collage-prefix")).toBe("colla");
      expect(text(5)(5)).toBeUndefined();
    });

    it("keep an object's good fields and drop the bad ones", () => {
      const check = fields({ width: intIn(0, 32), color: hexColor });
      expect(check({ width: 8, color: "#ffffff" })).toEqual({ width: 8, color: "#ffffff" });
      expect(check({ width: "wide", color: "#ffffff", extra: 1 })).toEqual({ color: "#ffffff" });
      expect(check([1, 2])).toBeUndefined();
      expect(check(null)).toBeUndefined();
    });

    it("check every entry of a keyed map", () => {
      const check = recordOf(text(40));
      expect(check({ 2: "split-h", 4: 9 })).toEqual({ 2: "split-h" });
      expect(check("nope")).toBeUndefined();
    });
  });
});
