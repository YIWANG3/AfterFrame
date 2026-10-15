import { describe, expect, it } from "vitest";
import { parentDir, pathParts } from "./pathParts";

describe("parentDir", () => {
  it("takes the folder off either kind of path", () => {
    expect(parentDir("/Users/me/Photos/IMG_0001.jpg")).toBe("/Users/me/Photos");
    expect(parentDir("C:\\Photos\\IMG_0001.jpg")).toBe("C:\\Photos");
  });
  it("is empty for a bare name or a root file", () => {
    expect(parentDir("IMG_0001.jpg")).toBe("");
    expect(parentDir("/IMG_0001.jpg")).toBe("");
  });
});

describe("pathParts", () => {
  it("splits dir, stem and a lower-cased extension", () => {
    expect(pathParts("/a/b/pano.JPG")).toEqual({ dir: "/a/b", name: "pano.JPG", stem: "pano", ext: "jpg" });
  });
  it("decodes a web bridge name and copes with no extension", () => {
    expect(pathParts("blob:x#/my%20shot.png")).toMatchObject({ name: "my shot.png", stem: "my shot", ext: "png" });
    expect(pathParts("/a/README")).toMatchObject({ stem: "README", ext: "" });
    expect(pathParts("/a/.hidden")).toMatchObject({ stem: ".hidden", ext: "" });
  });
});
