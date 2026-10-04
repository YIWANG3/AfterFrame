import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAddToFolder, writeAddToFolder } from "./useAddToFolder";

describe("the add-to-folder choice", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts on", () => {
    expect(readAddToFolder()).toBe(true);
  });

  it("keeps an 'off' set in the collage before the editor had the box", () => {
    store.set("afterframe-collage-add-to-folder", "0");
    expect(readAddToFolder()).toBe(false);
  });

  it("is one choice: setting it again wins over the collage's old one", () => {
    store.set("afterframe-collage-add-to-folder", "0");
    writeAddToFolder(true);
    expect(readAddToFolder()).toBe(true);
    writeAddToFolder(false);
    expect(readAddToFolder()).toBe(false);
  });
});
