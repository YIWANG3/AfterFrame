import { describe, expect, it } from "vitest";

import { awaitingThumbnail, staleSourceRepairs, thumbnailNeeds } from "./galleryRepair";

const raw = (assetId, path, sourceChanged) => ({
  asset_id: assetId,
  asset_type: "raw",
  image_path: path,
  source_changed: sourceChanged,
});

describe("stale-source repairs", () => {
  it("repairs a changed source and returns the budget of a healthy one", () => {
    const changed = raw("raw_a", "/p/a.3fr", true);
    expect(staleSourceRepairs([changed, raw("raw_b", "/p/b.3fr", false)])).toEqual({
      stale: [changed],
      healthyIds: ["raw_b"],
    });
  });

  it("doesn't call an asset healthy while another of its cards is stale", () => {
    // Byte-identical RAW copies sharing an asset: the healthy card used to
    // reset the stale card's budget every pass, and the repair never stopped.
    const copy = raw("raw_shared", "/p/B0000333 (1).3FR", true);
    const original = raw("raw_shared", "/p/B0000333.3FR", false);
    for (const items of [[copy, original], [original, copy]]) {
      expect(staleSourceRepairs(items)).toEqual({ stale: [copy], healthyIds: [] });
    }
  });

  it("repairs a shared asset once, not once per card", () => {
    const first = raw("raw_shared", "/p/x.3fr", true);
    const second = raw("raw_shared", "/p/x (1).3fr", true);
    expect(staleSourceRepairs([first, second]).stale).toEqual([first]);
  });

  it("repairs an image that never got its dimensions", () => {
    const image = { asset_id: "image_a", asset_type: "image", image_metadata: { width: 0, height: 0 } };
    expect(staleSourceRepairs([image]).stale).toEqual([image]);
  });
});

describe("cards awaiting their thumbnail", () => {
  const card = (fields) => ({ asset_id: "a1", asset_type: "image", exists_on_disk: true, ...fields });

  it("awaits a thumbnail when the original is one an <img> can't show", () => {
    expect(awaitingThumbnail(card({ asset_type: "raw", image_path: "/p/B0000333.3FR" }))).toBe(true);
    expect(awaitingThumbnail(card({ image_path: "/p/scan.tif" }))).toBe(true);
    expect(awaitingThumbnail(card({ asset_type: "video", image_path: "/p/clip.mov" }))).toBe(true);
  });

  it("shows the original itself when it can: a JPEG, and a HEIC (media:// makes it a JPEG)", () => {
    expect(awaitingThumbnail(card({ image_path: "/p/IMG_0001.JPG" }))).toBe(false);
    expect(awaitingThumbnail(card({ image_path: "/p/IMG_0002.HEIC" }))).toBe(false);
  });

  it("awaits nothing once the thumbnail is there, or when the file is gone", () => {
    expect(awaitingThumbnail(card({ asset_type: "raw", image_path: "/p/a.dng", preview_path: "/c/previews/a.jpg" }))).toBe(false);
    expect(awaitingThumbnail(card({ asset_type: "raw", image_path: "/p/a.dng", exists_on_disk: false }))).toBe(false);
    expect(awaitingThumbnail(null)).toBe(false);
  });
});

describe("thumbnail needs", () => {
  const raw = (assetId, path, fields = {}) => ({ asset_id: assetId, asset_type: "raw", image_path: path, exists_on_disk: true, ...fields });

  it("names the assets still awaiting a thumbnail, and gives the others their budget back", () => {
    expect(thumbnailNeeds([raw("a", "/p/a.dng"), raw("b", "/p/b.dng", { preview_path: "/c/b.jpg" })]))
      .toEqual({ awaitingIds: ["a"], settledIds: ["b"] });
  });

  it("keeps a shared asset awaiting while one of its cards still waits", () => {
    // Byte-identical RAW copies share an asset; one copy's file is gone.
    const waiting = raw("shared", "/p/B0000333.3FR");
    const gone = raw("shared", "/p/B0000333 (1).3FR", { exists_on_disk: false });
    for (const items of [[waiting, gone], [gone, waiting]]) {
      expect(thumbnailNeeds(items)).toEqual({ awaitingIds: ["shared"], settledIds: [] });
    }
  });
});
