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
    await ctx.window.getByTestId("tool-lut").click();
    await expect(ctx.window.getByTestId("lut-panel")).toBeVisible();
    await expect(ctx.window.getByTestId("lut-list")).toContainText("No LUTs yet", { timeout: 10_000 });
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
    await expect(ctx.window.getByTestId("lut-library-footer")).toContainText("3");
  });

  test("a LUT named for Log footage carries the Log badge; a Rec709 one doesn't", async () => {
    await expect(ctx.window.locator("[data-lut-name='Phntm_Test_Slog3'] [data-testid='lut-log-badge']")).toBeVisible();
    await expect(ctx.window.locator("[data-lut-name='Swap RB'] [data-testid='lut-log-badge']")).toHaveCount(0);
  });

  test("choosing a LUT grades the preview; strength mixes it; holding Compare shows the original", async () => {
    const at = [0.3, 0.4];
    const before = await displayPixel(...at);
    await ctx.window.locator("[data-lut-name='Swap RB']").click();
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
    const samples = await ctx.window.evaluate(async ([x, y]) => {
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
      document.querySelector("[data-lut-name='Invert']").click();
      await done;
      seen.push(t.sampleDisplayPixel(x, y));
      return seen;
    }, at);
    const original = [swapped[2], swapped[1], swapped[0]];
    const inverted = original.map((v) => 255 - v);
    expect(samples.length).toBeGreaterThan(1);
    // Every frame shows either the previous LUT or the new one, never the photo itself.
    for (const px of samples) expect(near(px, swapped, 2) || near(px, inverted, 2), JSON.stringify(px)).toBe(true);
    expect(near(samples[samples.length - 1], inverted, 2)).toBe(true);
    // Back to the half-strength Swap RB the save test expects.
    await ctx.window.locator("[data-lut-name='Swap RB']").click();
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

    await ctx.window.getByTestId("tool-lut").click();
    await expect.poll(async () => (await lutState()).sourcePath, { timeout: 60_000 }).toMatch(/raw-edit-cache/);
    await expect.poll(async () => ["apple", "libraw"].includes((await lutState()).base), { timeout: 10_000 }).toBe(true);
    await expect(ctx.window.getByTestId("lut-base")).toBeVisible();
    await waitForEditor(ctx.window, { preview: true, previewTimeout: 60_000 });
    const state = await ctx.window.evaluate(() => window.__afterframeTest.getState());
    expect(state.tool).toBe("lut");
    expect(state.aspectKey).toBe("1:1");

    await ctx.window.locator("[data-lut-name='Swap RB']").click();
    await expect.poll(async () => (await lutState()).gradedReady, { timeout: 15_000 }).toBe(true);
    const out = path.join(work, "raw-graded.jpg");
    await ctx.window.evaluate((p) => window.__afterframeTest.saveAs(p), out);
    await expect.poll(() => fs.existsSync(out), { timeout: 30_000 }).toBe(true);
    // The 1:1 crop of the RAW's full 2048×1152.
    expect(await sharp(out).metadata()).toMatchObject({ width: 1152, height: 1152 });
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
