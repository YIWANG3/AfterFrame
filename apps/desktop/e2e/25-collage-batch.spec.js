// Batch collage — select many images, split into several collages, export all.
// Covers: batch default for large selections, grouping controls (size /
// remainder), per-page layout override, and the folder export pipeline
// (pick-directory IPC → per-page offscreen render → saveImage → quickRegister).

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { launchApp, closeApp } = require("./helpers/app");

// Real catalogs have HD previews off by default; the collage generates them
// lazily and patches them into the open canvases. The fixture ships with HD
// pre-baked, so strip it to exercise that thumbnail→HD swap path.
function stripHdPreviews(catalogDir) {
  execFileSync("sqlite3", [path.join(catalogDir, "catalog.sqlite3"), "DELETE FROM preview_entries WHERE kind = 'preview-hd'"]);
  fs.rmSync(path.join(catalogDir, "previews-hd"), { recursive: true, force: true });
}

test.describe("Batch collage", () => {
  let app, window, userDataDir;
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-collage-out-"));

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "collage-batch", prepareCatalog: stripHdPreviews }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  test("selection within the single-template limit opens in single mode", async () => {
    const cards = window.locator("[data-gallery-item='true']");
    await cards.first().waitFor({ timeout: 15_000 });

    // 4 images ≤ 12 (single-canvas template max) → single mode
    await cards.nth(0).click();
    await cards.nth(3).click({ modifiers: ["Shift"] });
    await cards.nth(0).click({ button: "right" });
    await window.getByText(/^Collage$/).click();
    await expect(window.getByRole("button", { name: "Single", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(window.locator("[data-testid='batch-page-card']")).toHaveCount(0);
    await expect(window.getByText("Images", { exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByRole("button", { name: "Single", exact: true })).not.toBeVisible();
  });

  test("selection beyond the single-template limit opens in batch mode", async () => {
    const cards = window.locator("[data-gallery-item='true']");
    // All 14 seeded assets > 12 → batch mode by default: 14 ÷ 4 = 3 pages + 2 leftover
    await cards.nth(0).click();
    await cards.nth(13).click({ modifiers: ["Shift"] });
    await cards.nth(0).click({ button: "right" });
    await window.getByText(/^Collage$/).click();

    await expect(window.getByText("14 images · 4 per collage · 4 collages")).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText("Page 1 · 4 images")).toBeVisible();

    // No flash while HD previews are generated and patched in: once page 1
    // has painted real photos, it must never fall back to placeholder-only
    // frames (that was the thumbnail→HD swap flashing grey).
    const frames = await window.evaluate(async () => {
      const c = document.querySelector("[data-testid='batch-page-card'] canvas");
      const ctx = c.getContext("2d");
      const sample = () => {
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        let bright = 0, n = 0;
        for (let i = 0; i < data.length; i += 4 * 61) { n++; if (data[i] + data[i + 1] + data[i + 2] > 60) bright++; }
        return bright / n;
      };
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        out.push(sample());
        await new Promise((r) => setTimeout(r, 40));
      }
      return out;
    });
    const firstReal = frames.findIndex((f) => f > 0.3);
    expect(firstReal).toBeGreaterThanOrEqual(0);
    const regressions = frames.slice(firstReal).filter((f) => f < 0.1);
    expect(regressions).toEqual([]);
    await expect(window.getByText("Page 4 · 2 images")).toBeVisible();
    await expect(window.getByRole("button", { name: /Export 4 to folder/ })).toBeVisible();

    // Batch panel lists every image (like single mode) in a capped, internally
    // scrolling list — 14 rows would otherwise push the rest of the panel away.
    const list = window.locator("[data-testid='batch-panel'] [data-testid='collage-image-list']");
    await expect(list.locator("img")).toHaveCount(14);
    const { clientHeight, scrollHeight } = await list.evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }));
    expect(clientHeight).toBeLessThanOrEqual(264);
    expect(scrollHeight).toBeGreaterThan(clientHeight);

    // Grid is centered as a block, but rows fill left→right: the lone page on
    // the last row lines up with the first page's left edge (not centered).
    const pages = window.locator("[data-testid='batch-page-card']");
    const boxes = [];
    for (let i = 0; i < 4; i++) boxes.push(await pages.nth(i).boundingBox());
    const row1 = boxes.filter((b) => Math.abs(b.y - boxes[0].y) < 2);
    expect(row1.length).toBeGreaterThanOrEqual(2);
    expect(row1.length).toBeLessThan(4); // window is narrow enough that page 4 wraps
    const last = boxes[3];
    expect(last.y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1); // wrapped to a new row
    expect(Math.abs(last.x - boxes[0].x)).toBeLessThan(2);            // …left-aligned with row 1
    const area = await pages.first().locator("xpath=../..").boundingBox();
    const rowRight = Math.max(...row1.map((b) => b.x + b.width));
    const leftGap = boxes[0].x - area.x;
    const rightGap = area.x + area.width - rowRight;
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(40); // block roughly centered
  });

  test("group size and remainder controls regroup pages", async () => {
    // 14 ÷ 3 → 4 full pages + 2 leftover on their own page
    await window.getByRole("button", { name: "3", exact: true }).click();
    await expect(window.getByText("14 images · 3 per collage · 5 collages")).toBeVisible();
    await expect(window.getByText("Page 5 · 2 images")).toBeVisible();

    // Merge leftover into the last page → 4 pages, last one has 5
    await window.getByRole("button", { name: "Merge into last" }).click();
    await expect(window.getByText("14 images · 3 per collage · 4 collages")).toBeVisible();
    await expect(window.getByText("Page 4 · 5 images")).toBeVisible();

    // Drop leftover → 4 pages of 3
    await window.getByRole("button", { name: "Don't use" }).click();
    await expect(window.getByText("14 images · 3 per collage · 4 collages")).toBeVisible();
    await expect(window.getByText("Page 4 · 3 images")).toBeVisible();

    // Settle on 7-per-page → exactly 2 pages, no leftover, for the tests below
    await window.getByRole("button", { name: "Own page" }).click();
    await window.locator("input[type='number'][max='12']").fill("7");
    await expect(window.getByText("14 images · 7 per collage · 2 collages")).toBeVisible();
    await expect(window.getByText("Page 2 · 7 images")).toBeVisible();
  });

  test("panel layout applies to all pages; card button tweaks one page", async () => {
    // Pixel hash of a page canvas — lets us prove which pages re-rendered.
    const pixelsOf = (idx) => window.evaluate((i) => {
      const c = document.querySelectorAll("[data-testid='batch-page-card'] canvas")[i];
      const ctx = c.getContext("2d");
      const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 40)).data;
      let h = 0;
      for (let k = 0; k < d.length; k += 97) h = (h * 31 + d[k]) >>> 0;
      return h;
    }, idx);
    const cards = window.locator("[data-testid='batch-page-card']");
    const p1a = await pixelsOf(0);
    const p2a = await pixelsOf(1);

    // Card button (hover-revealed) → popover scoped to that page
    await cards.nth(1).hover();
    await cards.nth(1).locator("[data-testid='page-layout-btn']").click();
    const popover = window.locator("[data-testid='page-layout-popover']");
    await expect(popover).toBeVisible();
    await expect(popover.getByText("Page 2 · 7 images")).toBeVisible();
    await popover.locator(".grid button").nth(2).click();
    await expect.poll(() => pixelsOf(1), { timeout: 3000 }).not.toBe(p2a);
    await window.waitForTimeout(200);
    expect(await pixelsOf(0)).toBe(p1a); // page 1 untouched

    // Esc closes the popover; overlay stays open
    await window.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(window.getByText("14 images · 7 per collage · 2 collages")).toBeVisible();

    // Panel layout → every page (page 2's tweak is replaced too)
    const p2b = await pixelsOf(1);
    const panelGrid = window.locator("[data-testid='batch-panel'] .grid").first();
    await panelGrid.locator("button").nth(1).click();
    await expect.poll(() => pixelsOf(0), { timeout: 3000 }).not.toBe(p1a);
    await expect.poll(() => pixelsOf(1), { timeout: 3000 }).not.toBe(p2b);
    // Restore the default template so export assertions below stay stable
    await panelGrid.locator("button").nth(0).click();
  });

  test("dragging a cell onto another page swaps the two images", async () => {
    const cards = window.locator("[data-testid='batch-page-card']");
    // Read back which image sits in a cell by sampling its centre colour.
    const cellColor = (page, cell) => window.evaluate(([p, ci]) => {
      const c = document.querySelectorAll("[data-testid='batch-page-card'] canvas")[p];
      const ctx = c.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      // 7-image default template "3 top + 4 bottom": cell 0 is top-left third
      const x = cell => (cell < 3 ? (cell + 0.5) * (c.width / 3) : ((cell - 3) + 0.5) * (c.width / 4));
      const y = cell => (cell < 3 ? c.height * 0.25 : c.height * 0.75);
      const d = ctx.getImageData(Math.floor(x(ci)), Math.floor(y(ci)), 1, 1).data;
      return [d[0], d[1], d[2]].join(",");
    }, [page, cell]);

    const before1 = await cellColor(0, 0);
    const before2 = await cellColor(1, 0);
    expect(before1).not.toBe(before2);

    // Drag page 1 / cell 0 → page 2 / cell 0
    const src = await cards.nth(0).locator("canvas").boundingBox();
    const dst = await cards.nth(1).locator("canvas").boundingBox();
    const from = { x: src.x + src.width / 6, y: src.y + src.height / 4 };
    const to = { x: dst.x + dst.width / 6, y: dst.y + dst.height / 4 };
    await window.mouse.move(from.x, from.y);
    await window.mouse.down();
    await window.mouse.move(from.x + 10, from.y + 10);
    await window.mouse.move(to.x, to.y, { steps: 8 });
    // Ghost thumbnail follows the cursor while dragging
    await expect(window.locator("img.object-cover.h-full.w-full").last()).toBeVisible();
    await window.mouse.up();

    await expect.poll(() => cellColor(0, 0), { timeout: 3000 }).toBe(before2);
    await expect.poll(() => cellColor(1, 0), { timeout: 3000 }).toBe(before1);
    // Page structure unchanged
    await expect(window.getByText("14 images · 7 per collage · 2 collages")).toBeVisible();
  });

  test("dragging inside a cell pans it; wheel zooms; the state follows the image", async () => {
    const cards = window.locator("[data-testid='batch-page-card']");
    const canvasHash = (page, x0, y0, w, h) => window.evaluate(([p, a, b, cw, ch]) => {
      const c = document.querySelectorAll("[data-testid='batch-page-card'] canvas")[p];
      const dpr = window.devicePixelRatio || 1;
      const d = c.getContext("2d").getImageData(Math.floor(a * dpr), Math.floor(b * dpr), Math.floor(cw * dpr), Math.floor(ch * dpr)).data;
      let hsh = 0;
      for (let k = 0; k < d.length; k += 53) hsh = (hsh * 31 + d[k]) >>> 0;
      return hsh;
    }, [page, x0, y0, w, h]);
    const box = await cards.nth(1).locator("canvas").boundingBox();
    // page 2 / cell 0 (top-left third in the 7-image "3 top + 4 bottom" template)
    const cellW = box.width / 3, cellH = box.height / 2;
    const region = [4, 4, cellW - 8, cellH - 8];
    const before = await canvasHash(1, ...region);
    const otherBefore = await canvasHash(1, cellW + 4, 4, cellW - 8, cellH - 8);

    // Small drag that stays inside the cell → pan, no swap
    const cx = box.x + cellW / 2, cy = box.y + cellH / 2;
    await window.mouse.move(cx, cy);
    await window.mouse.down();
    await window.mouse.move(cx + 6, cy + 4);
    await window.mouse.move(cx + 22, cy + 14, { steps: 4 });
    await window.mouse.up();
    await expect.poll(() => canvasHash(1, ...region), { timeout: 2000 }).not.toBe(before);
    expect(await canvasHash(1, cellW + 4, 4, cellW - 8, cellH - 8)).toBe(otherBefore); // neighbour untouched
    await expect(window.getByText("14 images · 7 per collage · 2 collages")).toBeVisible();
    const panned = await canvasHash(1, ...region);

    // Wheel over the cell → zoom
    await window.mouse.move(cx, cy);
    await window.mouse.wheel(0, -240);
    await expect.poll(() => canvasHash(1, ...region), { timeout: 2000 }).not.toBe(panned);

    // Swap this (panned+zoomed) image with page 1 / cell 0. Pan/zoom is keyed
    // by image and shared across pages, so the exact same rendering must show
    // up in page 1 / cell 0 (both canvases share size + template).
    const tweaked = await canvasHash(1, ...region);
    const box1 = await cards.nth(0).locator("canvas").boundingBox();
    const p1DefaultOtherCell = await canvasHash(0, cellW + 4, 4, cellW - 8, cellH - 8);
    await window.mouse.move(cx, cy);
    await window.mouse.down();
    await window.mouse.move(cx + 8, cy + 8);
    await window.mouse.move(box1.x + cellW / 2, box1.y + cellH / 2, { steps: 8 });
    await window.mouse.up();
    await expect.poll(() => canvasHash(0, ...region), { timeout: 3000 }).toBe(tweaked);
    expect(await canvasHash(0, cellW + 4, 4, cellW - 8, cellH - 8)).toBe(p1DefaultOtherCell);
  });

  test("export to folder writes one JPEG per page and registers them", async () => {
    // Stub the native directory picker (register() holds a reference to the
    // same dialog module object, so mutating it here reaches the handler).
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, exportDir);

    // Give page canvases a beat to finish loading previews before export
    await expect(window.locator("[data-testid='batch-page-card']")).toHaveCount(2);
    await window.waitForTimeout(500);

    await window.getByRole("button", { name: /Export 2 to folder/ }).click();

    const expected = ["collage_01.jpg", "collage_02.jpg"].map((n) => path.join(exportDir, n));
    await expect.poll(
      () => expected.every((p) => fs.existsSync(p) && fs.statSync(p).size > 0),
      { timeout: 30_000 },
    ).toBe(true);

    // Default export: 3000px wide, 1:1 ratio
    for (const file of expected) {
      const meta = await sharp(file).metadata();
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(3000);
      expect(meta.height).toBe(3000);
    }
  });

  test("single mode still works after toggling", async () => {
    await window.getByRole("button", { name: "Single", exact: true }).click();
    // Single mode: page cards give way to the one editing canvas + image list
    await expect(window.locator("[data-testid='batch-page-card']")).toHaveCount(0);
    await expect(window.getByText("Images", { exact: true })).toBeVisible();
    await expect(window.getByText("14 images · 7 per collage · 2 collages")).not.toBeVisible();
    await window.getByRole("button", { name: "Batch", exact: true }).click();
    await expect(window.locator("[data-testid='batch-page-card']")).toHaveCount(2);
  });
});
