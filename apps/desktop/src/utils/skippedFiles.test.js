import { describe, expect, it } from "vitest";
import { describeSkippedExtensions } from "./skippedFiles";

describe("describeSkippedExtensions", () => {
  it("lists extensions upper-case, most frequent first, ties by name", () => {
    expect(describeSkippedExtensions({ ".zip": 1, ".docx": 3, ".Pdf": 1 })).toBe("DOCX ×3 · PDF ×1 · ZIP ×1");
  });
  it("names files without an extension", () => {
    expect(describeSkippedExtensions({ "": 2, ".txt": 1 }, "no extension")).toBe("no extension ×2 · TXT ×1");
  });
  it("is empty for nothing", () => {
    expect(describeSkippedExtensions(undefined)).toBe("");
  });
});
