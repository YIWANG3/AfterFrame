import { describe, expect, it } from "vitest";

import { staleSourceRepairs } from "./galleryRepair";

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
