// The editor's LUT tool, end to end (docs/lut-plan.md): import into the
// library (copied, duplicates skipped), the Log badge, the graded preview,
// strength, hold-to-compare, a full-size save graded after the crop, and on a
// RAW the swap to Apple's rendering that keeps the edits. macOS only in P1;
// elsewhere the tool must not show at all.
//
// The LUTs are made here: swapping red and blue is affine, so tetrahedral
// interpolation reproduces it exactly and a pixel can be checked by hand.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall, waitForEditor } = require("./helpers/app");
const { writeSyntheticDng } = require("./helpers/images");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cubeText(n, f) {
  const rows = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(" "));
  }
  return `TITLE "e2e"\nLUT_3D_SIZE ${n}\n${rows.join("\n")}\n`;
}

let ctx;
let work;

async function openEditorOnFirstAsset(window) {
  await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
  await window.locator("[data-gallery-item='true']").first().click();
  await window.keyboard.press("e");
  await expect(window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(window, { preview: true });
}

const lutState = () => ctx.window.evaluate(() => window.__afterframeTest.getLutState());
const displayPixel = (fx, fy) => ctx.window.evaluate(([x, y]) => window.__afterframeTest.sampleDisplayPixel(x, y), [fx, fy]);
const near = (a, b, tolerance) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);
// A LUT also shows in Favorites and Recently used once it's there; its own
// pack's or folder's cell is the one whose group key is "source|root|group".
const PACK_CELL = "[data-lut-cell][data-lut-group-key*='|']";
const cell = (name) => ctx.window.locator(`${PACK_CELL}[data-lut-name='${name}']`);

test.describe("LUT tool (macOS)", () => {
  test.skip(process.platform !== "darwin", "the LUT tool is macOS-only for now");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "lut" });
    await ctx.window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-lut-")));
    const pack = path.join(work, "Test Pack", "STANDARD");
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, "Swap RB.cube"), cubeText(17, (r, g, b) => [b, g, r]));
    fs.writeFileSync(path.join(pack, "Invert.cube"), cubeText(5, (r, g, b) => [1 - r, 1 - g, 1 - b]));
    const log = path.join(work, "Test Pack", "SLog3");
    fs.mkdirSync(log, { recursive: true });
    fs.writeFileSync(path.join(log, "Phntm_Test_Slog3.cube"), cubeText(9, (r, g, b) => [r, g, b]));
  });
  test.afterAll(async () => {
    await closeApp(ctx?.app, ctx?.userDataDir);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  test("the editor has a LUT tool, and an empty library says how to add LUTs", async () => {
    await openEditorOnFirstAsset(ctx.window);
    // The untouched save, for the graded one to be checked against.
    await ctx.window.evaluate((p) => window.__afterframeTest.saveAs(p), path.join(work, "plain.jpg"));
    // Second in the rail, right after Crop; its icon is the word LUT in a
    // rounded frame (a badge, not a pictogram), and it's named on hover.
    const tab = ctx.window.getByTestId("tool-lut");
    await expect(tab).toHaveText("LUT");
    await expect(tab).toHaveAttribute("title", "LUT");
    const rail = await ctx.window.locator("[data-editor-wheel-scope='toolbar'] [data-testid^='tool-']").evaluateAll(
      (els) => els.map((el) => el.dataset.testid),
    );
    expect(rail.slice(0, 2)).toEqual(["tool-crop", "tool-lut"]);
    const badge = await tab.locator("span").first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: parseFloat(s.borderTopWidth), radius: parseFloat(s.borderTopLeftRadius), height: el.getBoundingClientRect().height };
    });
    expect(badge.border).toBeGreaterThan(0);
    expect(badge.radius).toBeGreaterThan(0);
    expect(badge.height).toBeGreaterThanOrEqual(12);
    expect(badge.height).toBeLessThanOrEqual(16);
    await tab.click();
    await expect(ctx.window.getByTestId("lut-panel")).toBeVisible();
    await expect(ctx.window.getByTestId("lut-list")).toContainText("No LUTs yet", { timeout: 10_000 });
    // Two plain buttons; what each does to the files is the hover hint.
    const importButton = ctx.window.getByTestId("lut-empty-import");
    await expect(importButton).toHaveText("Import LUT files…");
    await expect(importButton).toHaveAttribute("title", /Copied into the LUT library/);
    await expect(ctx.window.getByTestId("lut-empty-add-folder")).toHaveAttribute("title", /nothing copied/);
    // The filled button's text reads in both themes: the accent is white in
    // the dark one, so white text vanished there.
    for (const theme of ["dark", "light"]) {
      await ctx.window.evaluate((name) => document.documentElement.setAttribute("data-theme", name), theme);
      const [text, fill] = await importButton.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
      expect(text, `${theme} theme`).not.toBe(fill);
    }
    await ctx.window.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  });

  test("importing a folder copies its LUTs into the library, keeps the pack's name, and skips duplicates", async () => {
    const first = await ctx.window.evaluate((p) => window.mediaWorkspace.importLuts([p]), path.join(work, "Test Pack"));
    expect(first.imported).toHaveLength(3);
    expect(first.failed).toEqual([]);
    const again = await ctx.window.evaluate((p) => window.mediaWorkspace.importLuts([p]), path.join(work, "Test Pack"));
    expect(again.imported).toHaveLength(0);
    expect(again.duplicates).toHaveLength(3);
    const lib = path.join(ctx.userDataDir, "afterframe", "luts", "Test Pack");
    expect(fs.existsSync(path.join(lib, "STANDARD", "Swap RB.cube"))).toBe(true);
    expect(fs.existsSync(path.join(lib, "SLog3", "Phntm_Test_Slog3.cube"))).toBe(true);

    await ctx.window.evaluate(() => window.__afterframeTest.refreshLuts());
    await expect(ctx.window.locator("[data-lut-cell]")).toHaveCount(3);
    await expect(ctx.window.locator(PACK_CELL)).toHaveCount(3);
    await expect(ctx.window.getByTestId("lut-library-footer")).toContainText("3");
  });

  test("a LUT named for Log footage carries the Log badge; a Rec709 one doesn't", async () => {
    await expect(cell("Phntm_Test_Slog3").getByTestId("lut-log-badge")).toBeVisible();
    await expect(cell("Swap RB").getByTestId("lut-log-badge")).toHaveCount(0);
  });

  test("choosing a LUT grades the preview; strength mixes it; holding Compare shows the original", async () => {
    const at = [0.3, 0.4];
    const before = await displayPixel(...at);
    await cell("Swap RB").click();
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => near(await displayPixel(...at), [before[2], before[1], before[0]], 2), { timeout: 5_000 }).toBe(true);

    await ctx.window.getByTestId("lut-strength").fill("50");
    expect((await lutState()).lut.strength).toBe(0.5);
    const half = [0, 1, 2].map((i) => (before[i] + [before[2], before[1], before[0]][i]) / 2);
    await expect.poll(async () => near(await displayPixel(...at), half, 2), { timeout: 5_000 }).toBe(true);

    const compare = ctx.window.getByTestId("lut-compare");
    await compare.hover();
    await ctx.window.mouse.down();
    await expect.poll(async () => near(await displayPixel(...at), before, 1), { timeout: 5_000 }).toBe(true);
    await ctx.window.mouse.up();
    await expect.poll(async () => near(await displayPixel(...at), half, 2), { timeout: 5_000 }).toBe(true);
  });

  test("switching to another LUT never flashes the ungraded photo in between", async () => {
    const at = [0.3, 0.4];
    await ctx.window.getByTestId("lut-strength").fill("100");
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);
    const swapped = await displayPixel(...at);
    // Sample every frame from the click until the new grade has landed.
    const samples = await ctx.window.evaluate(async ([x, y, packCell]) => {
      const t = window.__afterframeTest;
      const seen = [];
      const done = new Promise((resolve) => {
        const tick = () => {
          seen.push(t.sampleDisplayPixel(x, y));
          const s = t.getLutState();
          if (s.lut?.name === "Invert" && s.gradedReady) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      document.querySelector(`${packCell}[data-lut-name='Invert']`).click();
      await done;
      seen.push(t.sampleDisplayPixel(x, y));
      return seen;
    }, [...at, PACK_CELL]);
    const original = [swapped[2], swapped[1], swapped[0]];
    const inverted = original.map((v) => 255 - v);
    expect(samples.length).toBeGreaterThan(1);
    // Every frame shows either the previous LUT or the new one, never the photo itself.
    for (const px of samples) expect(near(px, swapped, 2) || near(px, inverted, 2), JSON.stringify(px)).toBe(true);
    // The canvas is redrawn in an effect after the grade lands: give it its frame.
    await expect.poll(async () => near(await displayPixel(...at), inverted, 2), { timeout: 5_000 }).toBe(true);
    // Back to the half-strength Swap RB the save test expects.
    await cell("Swap RB").click();
    await ctx.window.getByTestId("lut-strength").fill("50");
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);
  });

  test("the save is graded at full size, at the chosen strength", async () => {
    const out = path.join(work, "graded.jpg");
    await ctx.window.evaluate((p) => window.__afterframeTest.saveAs(p), out);
    await expect.poll(() => fs.existsSync(out), { timeout: 30_000 }).toBe(true);
    // Graded in workers (several for the full-size save), even from file://.
    const pool = (await lutState()).pool;
    expect(pool.broken).toBe(false);
    expect(pool.workers).toBeGreaterThan(0);
    const plain = await sharp(path.join(work, "plain.jpg")).raw().toBuffer({ resolveWithObject: true });
    const graded = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([graded.info.width, graded.info.height]).toEqual([plain.info.width, plain.info.height]);
    // Half the photo, half the photo with red and blue swapped; two JPEG
    // encodings apart, so a mean within a couple of levels.
    const c = plain.info.channels;
    let sum = 0;
    let n = 0;
    for (let p = 0; p < plain.data.length; p += c * 7) {
      const expected = [
        (plain.data[p] + plain.data[p + 2]) / 2,
        plain.data[p + 1],
        (plain.data[p + 2] + plain.data[p]) / 2,
      ];
      for (let i = 0; i < 3; i++) sum += Math.abs(graded.data[p + i] - expected[i]);
      n += 3;
    }
    expect(sum / n).toBeLessThan(3);
  });

  test("undo steps back through the LUTs chosen, to none", async () => {
    // Chosen in order: Swap RB, Invert, Swap RB (strength changes are live).
    await ctx.window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe("Invert");
    await ctx.window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe("Swap RB");
    await ctx.window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await lutState()).lut, { timeout: 5_000 }).toBe(null);
    await ctx.window.keyboard.press("Escape");
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);
  });

  test("on a RAW, the LUT tool grades Apple's rendering of it, keeping the edits made before", async () => {
    test.setTimeout(150_000);
    const dir = path.join(work, "raw");
    fs.mkdirSync(dir);
    // The embedded preview is the RAW's full size, so the editor opens on it.
    await writeSyntheticDng(path.join(dir, "full-preview.dng"), { previewWidth: 2048, previewHeight: 1152 });
    const tool = async (name, args) => {
      const response = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args });
      expect(response.isError, `${name}: ${JSON.stringify(response.content)}`).toBeFalsy();
      return JSON.parse(response.content[0].text);
    };
    let status = await tool("import_directory", { image_dirs: [dir] });
    const deadline = Date.now() + 90_000;
    while (!status.done && Date.now() < deadline) {
      await sleep(1500);
      const job = await tool("get_job_status", { job_id: status.job_id });
      status = { ...status, done: !job.running, status: job.status };
    }
    expect(status.status).toBe("succeeded");
    const rows = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 200 }));
    const raw = (rows.items || rows).find((r) => (r.image_path || "").endsWith("full-preview.dng"));
    expect(raw).toBeTruthy();

    await tool("show_in_app", { asset_ids: [raw.asset_id] });
    await ctx.window.locator(`[data-gallery-item='true'][data-asset-id="${raw.asset_id}"]`).click();
    await ctx.window.keyboard.press("e");
    await expect(ctx.window.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 30_000 });
    await waitForEditor(ctx.window, { preview: true, previewTimeout: 90_000 });
    expect((await lutState()).sourcePath).not.toMatch(/raw-edit-cache/);

    // An edit made before the LUT tool is opened.
    await ctx.window.evaluate(() => window.__afterframeTest.setAspect("1:1"));
    await expect.poll(async () => (await ctx.window.evaluate(() => window.__afterframeTest.getState())).aspectKey).toBe("1:1");

    // Every frame until Apple's render is in: while it's on its way the photo
    // says so, and no LUT thumbnail is made of the camera's JPEG.
    const frames = ctx.window.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const tick = () => {
        const s = window.__afterframeTest.getLutState?.();
        seen.push({
          base: s?.base || null,
          thumbs: document.querySelectorAll("[data-lut-cell] img").length,
          loading: document.querySelector("[data-testid='editor-loading-label']")?.textContent || null,
        });
        if (s?.base === "apple" || s?.base === "libraw" || seen.length > 3000) resolve(seen);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await ctx.window.getByTestId("tool-lut").click();
    const rendering = (await frames).filter((f) => f.base === "rendering");
    expect(rendering.length).toBeGreaterThan(0); // sips takes a few frames even for this small DNG
    for (const f of rendering) {
      expect(f.thumbs, JSON.stringify(f)).toBe(0);
      expect(f.loading, JSON.stringify(f)).toContain("Rendering the RAW with Apple's engine");
    }
    await expect.poll(async () => (await lutState()).sourcePath, { timeout: 60_000 }).toMatch(/raw-edit-cache/);
    await expect.poll(async () => ["apple", "libraw"].includes((await lutState()).base), { timeout: 10_000 }).toBe(true);
    await expect(ctx.window.getByTestId("lut-base")).toBeVisible();
    await waitForEditor(ctx.window, { preview: true, previewTimeout: 60_000 });
    const state = await ctx.window.evaluate(() => window.__afterframeTest.getState());
    expect(state.tool).toBe("lut");
    expect(state.aspectKey).toBe("1:1");

    await cell("Swap RB").click();
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);
    const out = path.join(work, "raw-graded.jpg");
    await ctx.window.evaluate((p) => window.__afterframeTest.saveAs(p), out);
    await expect.poll(() => fs.existsSync(out), { timeout: 30_000 }).toBe(true);
    // The 1:1 crop of the RAW's full 2048×1152.
    expect(await sharp(out).metadata()).toMatchObject({ width: 1152, height: 1152 });
    await ctx.window.keyboard.press("Escape");
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);
  });

  test("Add LUTs says what each way does to the files; the groups expand and collapse together", async () => {
    await openEditorOnFirstAsset(ctx.window);
    await ctx.window.getByTestId("tool-lut").click();
    await ctx.window.getByTestId("lut-add").click();
    await expect(ctx.window.getByTestId("lut-import")).toHaveAttribute("title", /Copied into the LUT library/);
    await expect(ctx.window.getByTestId("lut-add-folder")).toHaveAttribute("title", /nothing copied/);
    await ctx.window.keyboard.press("Escape");
    await expect(ctx.window.getByTestId("lut-add-menu")).toHaveCount(0);

    // Recently used, Test Pack / STANDARD and Test Pack / SLog3.
    const toggle = ctx.window.getByTestId("lut-toggle-all");
    await expect(toggle).toHaveText("Collapse all");
    await toggle.click();
    await expect(ctx.window.locator("[data-lut-cell]")).toHaveCount(0);
    await expect(toggle).toHaveText("Expand all");
    await toggle.click();
    await expect(ctx.window.locator(PACK_CELL)).toHaveCount(3);
    await expect(ctx.window.locator("[data-lut-group='recent'] [data-lut-cell]")).not.toHaveCount(0);
  });

  test("a LUT dropped into the library folder in Finder shows up when the window comes back", async () => {
    const byHand = path.join(ctx.userDataDir, "afterframe", "luts", "By hand");
    fs.mkdirSync(byHand, { recursive: true });
    fs.writeFileSync(path.join(byHand, "Warm Hand.cube"), cubeText(5, (r, g, b) => [Math.min(1, r * 1.1), g, b * 0.9]));
    await ctx.window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(cell("Warm Hand")).toHaveCount(1, { timeout: 10_000 });
    fs.rmSync(path.join(byHand, "Warm Hand.cube"));
    await ctx.window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(cell("Warm Hand")).toHaveCount(0, { timeout: 10_000 });
  });

  test("an added folder that moved is called out with Locate and Stop reading; a chosen LUT from it says it's gone", async () => {
    const drive = path.join(work, "Drive");
    fs.mkdirSync(path.join(drive, "Kodak"), { recursive: true });
    fs.writeFileSync(path.join(drive, "Kodak", "Portra.cube"), cubeText(5, (r, g, b) => [r, g * 0.95, b * 0.9]));
    const added = await ctx.window.evaluate((p) => window.mediaWorkspace.addLutFolder(p), drive);
    expect(added.ok).toBe(true);
    await ctx.window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await cell("Portra").click();
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);

    fs.renameSync(drive, path.join(work, "Drive (moved)"));
    await ctx.window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(ctx.window.getByTestId("lut-folder-missing")).toContainText("Drive", { timeout: 10_000 });
    await expect(ctx.window.getByTestId("lut-selected-error")).toContainText("is gone");

    await ctx.window.getByTestId("lut-folder-missing").getByRole("button", { name: "Stop reading it" }).click();
    await expect(ctx.window.getByTestId("lut-folder-missing")).toHaveCount(0, { timeout: 10_000 });
    await ctx.window.getByTestId("lut-clear").click();
    await ctx.window.keyboard.press("Escape");
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);
  });

  test("the arrow keys step through the LUTs on screen; only the one they stop on is an undo step", async () => {
    await openEditorOnFirstAsset(ctx.window);
    await ctx.window.getByTestId("tool-lut").click();
    await expect(ctx.window.locator(PACK_CELL)).toHaveCount(3, { timeout: 10_000 });
    // The pack cells in the order shown: the arrows walk them like text.
    const order = await ctx.window.locator(PACK_CELL).evaluateAll((els) => els.map((el) => el.dataset.lutName));
    const currentCell = ctx.window.locator("[data-lut-cell][data-current='true']");
    const expectAt = async (name) => {
      await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe(name);
      await expect(currentCell).toHaveCount(1);
      await expect(currentCell).toHaveAttribute("data-lut-name", name);
      await expect(currentCell).toHaveAttribute("data-lut-group-key", /\|/);
    };

    // Clicked: an undo step of its own.
    await cell(order[0]).click();
    await expectAt(order[0]);
    await ctx.window.keyboard.press("ArrowRight");
    await expectAt(order[1]);
    await ctx.window.keyboard.press("ArrowRight");
    await expectAt(order[2]);
    // Past the last one: stays.
    await ctx.window.keyboard.press("ArrowRight");
    await expectAt(order[2]);
    await ctx.window.keyboard.press("ArrowLeft");
    await expectAt(order[1]);
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);

    // Typing in the search box keeps its arrows.
    await ctx.window.getByTestId("lut-search").focus();
    await ctx.window.keyboard.press("ArrowRight");
    await ctx.window.keyboard.press("ArrowLeft");
    await sleep(200);
    expect((await lutState()).lut.name).toBe(order[1]);
    await ctx.window.getByTestId("lut-search").blur();

    // The stop is recorded once the keys rest: one undo goes back to the
    // clicked LUT, not through every one passed on the way.
    await sleep(1_000);
    await ctx.window.evaluate(() => window.__afterframeTest.undo());
    await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe(order[0]);
    await ctx.window.evaluate(() => window.__afterframeTest.redo());
    await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe(order[1]);

    // The LUT stopped on leads Recently used.
    await expect(ctx.window.locator("[data-lut-group='recent'] [data-lut-cell]").first()).toHaveAttribute("data-lut-name", order[1]);

    // ↑ ↓ go to the cell drawn above or below (the last of a shorter row),
    // across group headers; read off the screen before each press.
    const below = (dir) => ctx.window.evaluate((d) => {
      const cells = [...document.querySelectorAll("[data-lut-cell]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { el, top: Math.round(r.top), left: Math.round(r.left) };
      });
      const cur = cells.find((c) => c.el.dataset.current === "true");
      const tops = [...new Set(cells.map((c) => c.top))].sort((a, b) => a - b);
      const rowTop = tops[tops.indexOf(cur.top) + d];
      const row = cells.filter((c) => c.top === rowTop).sort((a, b) => a.left - b.left);
      const pick = rowTop === undefined ? cur : row.filter((c) => c.left <= cur.left + 1).pop() || row[0];
      return { name: pick.el.dataset.lutName, group: pick.el.dataset.lutGroupKey };
    }, dir);
    for (const [key, dir] of [["ArrowUp", -1], ["ArrowUp", -1], ["ArrowDown", 1], ["ArrowDown", 1]]) {
      const want = await below(dir);
      await ctx.window.keyboard.press(key);
      await expect(currentCell).toHaveAttribute("data-lut-name", want.name);
      await expect(currentCell).toHaveAttribute("data-lut-group-key", want.group);
      await expect.poll(async () => (await lutState()).lut?.name, { timeout: 5_000 }).toBe(want.name);
    }
    await ctx.window.getByTestId("lut-clear").click();
    await expect.poll(async () => (await lutState()).lut, { timeout: 5_000 }).toBe(null);
  });

  test("a favourite is starred, listed first, and the Favorites filter shows only those", async () => {
    // From the cell's menu.
    await cell("Invert").click({ button: "right" });
    await ctx.window.locator("button", { hasText: "Add to Favorites" }).click();
    await expect(ctx.window.locator("[data-lut-group='favorites'] [data-lut-cell]")).toHaveCount(1);
    await expect(ctx.window.locator("[data-lut-group='favorites'] [data-lut-name='Invert']")).toBeVisible();
    // Favorites come before Recently used, which comes before the packs.
    const order = await ctx.window.locator("[data-lut-group]").evaluateAll((els) => els.map((el) => el.dataset.lutGroup));
    expect(order.slice(0, 2)).toEqual(["favorites", "recent"]);
    await expect(cell("Invert").getByTestId("lut-favorite-badge")).toBeVisible();
    await expect(cell("Swap RB").getByTestId("lut-favorite-badge")).toHaveCount(0);

    // Filtered down to one, the panel keeps its height.
    const panelHeight = () => ctx.window.getByTestId("lut-panel").evaluate((el) => el.getBoundingClientRect().height);
    const fullHeight = await panelHeight();
    await ctx.window.getByTestId("lut-filter-favorites").click();
    await expect(ctx.window.locator("[data-lut-cell]")).toHaveCount(1);
    expect(await panelHeight()).toBe(fullHeight);
    await expect(ctx.window.locator("[data-lut-group='favorites'], [data-lut-group='recent']")).toHaveCount(0);

    // And from the star on the chosen LUT: unstarred, the filter is empty and says how to star one.
    await cell("Invert").click();
    await expect(ctx.window.getByTestId("lut-favorite-toggle")).toHaveAttribute("aria-pressed", "true");
    await ctx.window.getByTestId("lut-favorite-toggle").click();
    await expect(ctx.window.locator("[data-lut-cell]")).toHaveCount(0);
    await expect(ctx.window.getByTestId("lut-no-match")).toContainText("No favorites yet");
    await ctx.window.getByTestId("lut-favorite-toggle").click();
    await expect(ctx.window.locator("[data-lut-cell]")).toHaveCount(1);
    await ctx.window.getByTestId("lut-filter-all").click();
    await expect(ctx.window.locator(PACK_CELL)).toHaveCount(3);
  });

  test("Hide Log LUTs leaves out the Log-tagged; previews come two or three to a row, remembered", async () => {
    await ctx.window.getByTestId("lut-hide-log").click();
    await expect(ctx.window.locator("[data-lut-name='Phntm_Test_Slog3']")).toHaveCount(0);
    await expect(cell("Swap RB")).toHaveCount(1);
    await ctx.window.getByTestId("lut-hide-log").click();
    await expect(cell("Phntm_Test_Slog3")).toHaveCount(1);

    const tracks = () => cell("Swap RB").evaluate((el) => getComputedStyle(el.parentElement).gridTemplateColumns.split(" ").length);
    expect(await tracks()).toBe(3);
    await ctx.window.getByTestId("lut-columns-2").click();
    await expect.poll(tracks).toBe(2);
    // Still two after the editor is closed and opened again.
    await ctx.window.getByTestId("lut-clear").click();
    await ctx.window.keyboard.press("Escape");
    await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);
    await openEditorOnFirstAsset(ctx.window);
    await ctx.window.getByTestId("tool-lut").click();
    await expect(ctx.window.getByTestId("lut-columns-2")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(tracks).toBe(2);
    await ctx.window.getByTestId("lut-columns-3").click();
    await expect.poll(tracks).toBe(3);
  });

  test("the chosen LUT shows its whole name, its size and where it's kept; the file's path on hover", async () => {
    await cell("Swap RB").click();
    await expect(ctx.window.getByTestId("lut-selected-name")).toHaveText("Swap RB");
    const info = ctx.window.getByTestId("lut-info");
    await expect(info).toContainText("17³");
    await expect(info).toContainText("In the LUT library");
    await expect(info).toHaveAttribute("title", /Test Pack\/STANDARD\/Swap RB\.cube$/);
    await ctx.window.getByTestId("lut-clear").click();
    await ctx.window.keyboard.press("Escape");
  });
});

test.describe("LUT tool (other platforms)", () => {
  test.skip(process.platform === "darwin", "covered above");

  test("the editor has no LUT tool off macOS", async () => {
    const app = await launchApp({ testName: "lut-hidden" });
    try {
      await openEditorOnFirstAsset(app.window);
      await expect(app.window.getByTestId("tool-crop")).toBeVisible();
      await expect(app.window.getByTestId("tool-lut")).toHaveCount(0);
    } finally {
      await closeApp(app.app, app.userDataDir);
    }
  });
});
