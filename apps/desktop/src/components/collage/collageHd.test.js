import { describe, expect, it, vi } from "vitest";
import { ensureHdInChunks, HD_CHUNK_SIZE, needsCollageHd } from "./collageHd";

const cell = (n) => ({ asset_id: `a${n}`, image_path: `/photos/a${n}.CR3` });

describe("collage HD previews", () => {
  it("are made for cells that draw from a thumbnail", () => {
    expect(needsCollageHd(cell(1))).toBe(true);
    expect(needsCollageHd({ ...cell(1), image_preview_hd_path: "/hd.jpg" })).toBe(false);
    expect(needsCollageHd({ ...cell(1), preview_hd_path: "/hd.jpg" })).toBe(false);
    expect(needsCollageHd({ asset_id: "a1" })).toBe(false);
    expect(needsCollageHd(null)).toBe(false);
  });

  it("are asked for a chunk at a time, each patched in before the next is asked for", async () => {
    const order = [];
    const ensureBatch = vi.fn(async (chunk) => {
      order.push(`ask ${chunk.length}`);
      // Every third photo can't be made.
      return new Map(chunk.map((item) => [item.asset_id, Number(item.asset_id.slice(1)) % 3 ? `/hd/${item.asset_id}.jpg` : null]));
    });
    const missed = [];
    await ensureHdInChunks(Array.from({ length: 20 }, (_, i) => cell(i + 1)), {
      ensureBatch,
      onChunk: async (made, notMade) => {
        order.push(`patch ${made.size}`);
        missed.push(...notMade.map((item) => item.asset_id));
      },
    });
    expect(HD_CHUNK_SIZE).toBe(8);
    expect(order).toEqual(["ask 8", "patch 6", "ask 8", "patch 5", "ask 4", "patch 3"]);
    expect(missed).toEqual(["a3", "a6", "a9", "a12", "a15", "a18"]);
  });

  it("treat a chunk that throws as not made, and stop once cancelled", async () => {
    let cancelled = false;
    const ensureBatch = vi.fn(async () => {
      cancelled = true;
      throw new Error("sidecar timed out");
    });
    const onChunk = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureHdInChunks(Array.from({ length: 12 }, (_, i) => cell(i)), {
      ensureBatch,
      onChunk,
      isCancelled: () => cancelled,
    });
    expect(ensureBatch).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();

    cancelled = false;
    const missed = [];
    await ensureHdInChunks([cell(1)], {
      ensureBatch: async () => { throw new Error("sidecar timed out"); },
      onChunk: (made, notMade) => missed.push(made.size, notMade.length),
    });
    expect(missed).toEqual([0, 1]);
    warn.mockRestore();
  });
});
