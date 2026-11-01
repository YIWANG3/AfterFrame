// AI Repaint takes style reference images: photos whose colours and mood the
// result should follow. The panel's picker adds them (thumbnails, a remove
// button, the style list stepping aside), the job carries them to the
// provider after the photo, and the prompt sent grows the sentence that says
// which image is which. The mock provider copies the photo, so the checks are
// on what was sent, not on pixels.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, openEditorOn } = require("./helpers/app");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-repaint-ref-"));
const photoPath = path.join(tmp, "harbour.jpg");
const refA = path.join(tmp, "look-a.jpg");
const refB = path.join(tmp, "look-b.jpg");

let ctx;

const stubPicker = (paths) => ctx.app.evaluate(({ dialog }, picked) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
}, paths);
const pickButton = () => ctx.window.getByTestId("repaint-pick-ref");
const refThumbs = () => ctx.window.getByTestId("repaint-refs").locator("img");
const repaintStatus = () => ctx.window.evaluate(() => window.mediaWorkspace.getAiRepaintStatus());
const generate = () => ctx.window.getByRole("button", { name: "Generate", exact: true }).click();

async function solid(file, width, height, background) {
  await sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 90 }).toFile(file);
}

test.beforeAll(async () => {
  await solid(photoPath, 1200, 800, { r: 40, g: 110, b: 170 });
  await solid(refA, 600, 400, { r: 240, g: 190, b: 160 });
  await solid(refB, 600, 400, { r: 120, g: 200, b: 170 });
  ctx = await launchApp({ testName: "repaint-reference" });
  // A mock repaint provider: no network, the job copies the photo and
  // records what it was sent.
  await ctx.window.evaluate(async () => {
    await window.mediaWorkspace.saveAiPreferences({
      providers: [{ id: "p_mock", type: "mock", name: "Mock (local)" }],
      activeProvider: "p_mock",
    });
    await window.mediaWorkspace.setAiProviderToken("p_mock", "mock-token");
  });
  // Registering the photo lets its folder through media:// (the editor loads
  // the preview from there) and gives the repaint a version stack to join.
  await ctx.window.evaluate((p) => window.mediaWorkspace.quickRegister(p, null), photoPath);
  await openEditorOn(ctx.window, photoPath, "ai");
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("references are picked, shown and removed; the style presets step aside", async () => {
  await expect(pickButton()).toHaveText(/Add reference images/);
  await stubPicker([refA, refB]);
  await pickButton().click();
  await expect(refThumbs()).toHaveCount(2);
  await expect(pickButton()).toHaveText(/Add another/);
  await expect(ctx.window.getByText(/style presets are ignored/)).toBeVisible();

  // Picking a file already in the list adds nothing.
  await stubPicker([refA]);
  await pickButton().click();
  await expect(refThumbs()).toHaveCount(2);

  await ctx.window.getByTestId("repaint-ref-remove").last().click();
  await expect(refThumbs()).toHaveCount(1);
});

test("a repaint with a reference and no prompt asks for the reference's look", async () => {
  await generate();
  await expect.poll(async () => (await repaintStatus())?.status, { timeout: 30_000 }).toBe("succeeded");
  const { result } = await repaintStatus();
  // The panel's own prompt, then the sidecar's sentence about the images.
  expect(result.prompt).toMatch(/^Re-grade this photograph/);
  expect(result.prompt).toContain("The second image is a style reference");
  expect((result.notes || []).join(" ")).toContain("look-a.jpg");
  expect(fs.readdirSync(tmp).some((f) => f.startsWith("harbour_ai-repaint_"))).toBe(true);
});

test("a prompt of the user's own goes first; the reference still rides along", async () => {
  await ctx.window.getByPlaceholder("Enter a one-time prompt...").fill("make it dusk");
  await generate();
  await expect.poll(async () => {
    const status = await repaintStatus();
    return status?.running ? "running" : status?.result?.prompt || "";
  }, { timeout: 30_000 }).toMatch(/^make it dusk/);
  expect((await repaintStatus()).result.prompt).toContain("The second image is a style reference");

  // Without references the prompt is sent as typed.
  await ctx.window.getByTestId("repaint-ref-remove").click();
  await expect(refThumbs()).toHaveCount(0);
  await ctx.window.getByPlaceholder("Enter a one-time prompt...").fill("make it dawn");
  await generate();
  await expect.poll(async () => {
    const status = await repaintStatus();
    return status?.running ? "running" : status?.result?.prompt || "";
  }, { timeout: 30_000 }).toBe("make it dawn");
});
