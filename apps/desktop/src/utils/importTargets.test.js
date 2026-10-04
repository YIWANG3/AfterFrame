import { describe, expect, it } from "vitest";
import { importTargets } from "./importTargets";

describe("watched-folder import targets", () => {
  it("keeps files when there are few", () => {
    const files = ["/trips/a/1.CR3", "/trips/b/2.CR3"];
    expect(importTargets(files)).toEqual(files);
  });

  it("passes many files as their outermost folders", () => {
    const files = [
      ...Array.from({ length: 300 }, (_, i) => `/trips/tokyo/${i}.CR3`),
      ...Array.from({ length: 300 }, (_, i) => `/trips/tokyo/day 2/${i}.CR3`),
      ...Array.from({ length: 10 }, (_, i) => `/trips/tokyo 2/${i}.CR3`),
      "C:\\Photos\\Seoul\\IMG_1.CR3",
    ];
    expect(importTargets(files)).toEqual(["/trips/tokyo", "/trips/tokyo 2", "C:\\Photos\\Seoul"]);
  });
});
