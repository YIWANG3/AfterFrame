import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHdPreviewStore, hdPreviewIn, HD_PREFETCH_SETTLE_MS, HD_RETRY_AFTER_MS } from "./hdPreviewStore";

const raw = (n) => ({ asset_id: `r${n}`, asset_type: "raw", image_path: `/photos/r${n}.CR3` });
const idOf = (path) => path.match(/\/(r\d+)\.CR3$/)[1];

// The request chain (ensure → detail reads → next pump) is a few promise hops.
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// A store whose sidecar answers only when a test says so, one call at a time.
function harness(catalog = "/catalogs/A") {
  const calls = [];
  const made = new Map();
  const ensure = vi.fn((paths) => new Promise((resolve) => calls.push({ paths, resolve })));
  const readDetail = vi.fn(async (id) => ({ asset_id: id, image_preview_hd_path: made.get(id) || null }));
  const store = createHdPreviewStore({ ensure, readDetail });
  store.setCatalog(catalog);
  const sent = () => ensure.mock.calls.map(([paths]) => paths.map(idOf));
  // Answer the call that is out: `ok` ids get an HD in `prefix`, the rest none.
  async function answer({ ok = null, result = { generated: 1 }, prefix = catalog } = {}) {
    const call = calls.shift();
    for (const path of call.paths) {
      const id = idOf(path);
      if (!ok || ok.includes(id)) made.set(id, `${prefix}/previews-hd/${id}.jpg`);
    }
    call.resolve(result);
    await flush();
  }
  const hdOf = (id) => hdPreviewIn(store.getSnapshot(), id);
  return { store, calls, made, ensure, readDetail, sent, answer, hdOf };
}

describe("on-demand HD preview store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks for the current photo alone, and its neighbours once the index holds still", async () => {
    const { store, sent, answer, hdOf } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2), raw(0)] });
    expect(sent()).toEqual([["r1"]]);
    expect(hdOf("r1")).toBeUndefined();

    await answer();
    expect(hdOf("r1")).toBe("/catalogs/A/previews-hd/r1.jpg");
    expect(sent()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS);
    expect(sent()).toEqual([["r1"], ["r2"]]);
    await answer();
    expect(sent()).toEqual([["r1"], ["r2"], ["r0"]]);
  });

  it("keeps one request out at a time and never sends a photo stepped past", async () => {
    const { store, sent, answer } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2), raw(0)] });
    // Holding the arrow key: a step every 40 ms while r1's HD is being made.
    for (let n = 2; n <= 6; n += 1) {
      await vi.advanceTimersByTimeAsync(40);
      store.want(lightbox, { key: `r${n}`, current: raw(n), prefetch: [raw(n + 1), raw(n - 1)] });
    }
    expect(sent()).toEqual([["r1"]]);

    await answer();
    // Only the photo now on screen goes next; r2–r5 were passed.
    expect(sent()).toEqual([["r1"], ["r6"]]);
    await answer();
    expect(sent()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS);
    expect(sent()).toEqual([["r1"], ["r6"], ["r7"]]);
    await answer();
    expect(sent()).toEqual([["r1"], ["r6"], ["r7"], ["r5"]]);
  });

  it("measures the hold from when the photo changed, even when neighbours arrive later", async () => {
    const { store, sent, answer } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    await answer();
    await vi.advanceTimersByTimeAsync(100);
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2)] });
    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS - 101);
    expect(sent()).toEqual([["r1"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([["r1"], ["r2"]]);
  });

  it("shares what it made between views, and never sends a photo already out", async () => {
    const { store, sent, answer, hdOf } = harness();
    const lightbox = {};
    const editor = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    store.want(editor, { key: "r1", current: raw(1) });
    expect(sent()).toEqual([["r1"]]);
    await answer();
    store.want(editor, { key: "r1", current: raw(1) });
    store.release(editor);
    store.want(editor, { key: "r1", current: raw(1) });
    expect(sent()).toEqual([["r1"]]);
    expect(hdOf("r1")).toBe("/catalogs/A/previews-hd/r1.jpg");
  });

  it("records a timeout as a failure without reading details, and retries it when the photo is current again", async () => {
    const { store, sent, answer, readDetail, hdOf } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    await answer({ ok: [], result: { error: "sidecar timed out after 30000ms" } });
    expect(readDetail).not.toHaveBeenCalled();
    expect(hdOf("r1")).toBeNull();

    // Same view asking again (a re-render, the neighbour list changing) isn't a retry.
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [] });
    expect(sent()).toEqual([["r1"]]);

    store.want(lightbox, { key: "r2", current: raw(2) });
    await answer();
    store.want(lightbox, { key: "r1", current: raw(1) });
    expect(sent()).toEqual([["r1"], ["r2"], ["r1"]]);
    expect(hdOf("r1")).toBeUndefined();
    await answer();
    expect(hdOf("r1")).toBe("/catalogs/A/previews-hd/r1.jpg");
  });

  it("retries a neighbour that failed once the failure is old enough", async () => {
    const { store, sent, answer, hdOf } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2)] });
    await answer();
    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS);
    await answer({ ok: [] });
    expect(hdOf("r2")).toBeNull();

    // Stepping away and back within the retry window leaves r2 alone.
    store.want(lightbox, { key: "r0", current: raw(0), prefetch: [] });
    await answer();
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2)] });
    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS);
    expect(sent()).toEqual([["r1"], ["r2"], ["r0"]]);

    await vi.advanceTimersByTimeAsync(HD_RETRY_AFTER_MS);
    store.want(lightbox, { key: "r0", current: raw(0), prefetch: [] });
    store.want(lightbox, { key: "r1", current: raw(1), prefetch: [raw(2)] });
    await vi.advanceTimersByTimeAsync(HD_PREFETCH_SETTLE_MS);
    expect(sent()).toEqual([["r1"], ["r2"], ["r0"], ["r2"]]);
  });

  it("drops what it made when the catalog changes, and results that land after", async () => {
    const { store, sent, answer, hdOf } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    await answer();
    store.want(lightbox, { key: "r2", current: raw(2) });
    expect(sent()).toEqual([["r1"], ["r2"]]);

    store.setCatalog("/catalogs/B");
    expect(hdOf("r1")).toBeUndefined();
    store.want(lightbox, { key: "r1", current: raw(1) });
    // Catalog A's r2 is still out on the sidecar: B's r1 waits for it.
    expect(sent()).toEqual([["r1"], ["r2"]]);

    await answer({ prefix: "/catalogs/A" });
    expect(hdOf("r2")).toBeUndefined();
    expect(sent()).toEqual([["r1"], ["r2"], ["r1"]]);
    await answer({ prefix: "/catalogs/B" });
    expect(hdOf("r1")).toBe("/catalogs/B/previews-hd/r1.jpg");
  });

  it("makes batches behind the photo on screen and answers what it already has", async () => {
    const { store, sent, answer } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    const batch = store.ensureBatch([raw(1), raw(2), raw(3)]);
    store.want(lightbox, { key: "r9", current: raw(9) });
    await answer();
    // r9 is on screen now, so it goes before the batch; r1 is made already.
    expect(sent()).toEqual([["r1"], ["r9"]]);
    await answer();
    expect(sent()).toEqual([["r1"], ["r9"], ["r2", "r3"]]);
    await answer({ ok: ["r2"] });
    expect(await batch).toEqual(new Map([
      ["r1", "/catalogs/A/previews-hd/r1.jpg"],
      ["r2", "/catalogs/A/previews-hd/r2.jpg"],
      ["r3", null],
    ]));

    // Made, or failed moments ago: answered without asking the sidecar.
    expect(await store.ensureBatch([raw(2), raw(3)])).toEqual(new Map([
      ["r2", "/catalogs/A/previews-hd/r2.jpg"],
      ["r3", null],
    ]));
    expect(sent()).toHaveLength(3);
  });

  it("never sends a batch aborted before its turn, or one for a catalog no longer open", async () => {
    const { store, sent, answer } = harness();
    const lightbox = {};
    store.want(lightbox, { key: "r1", current: raw(1) });
    const controller = new AbortController();
    const batch = store.ensureBatch([raw(2)], { signal: controller.signal });
    controller.abort();
    await answer();
    expect(await batch).toEqual(new Map([["r2", null]]));
    expect(await store.ensureBatch([raw(3)], { catalogKey: "/catalogs/old" })).toEqual(new Map([["r3", null]]));
    expect(sent()).toEqual([["r1"]]);
  });
});
