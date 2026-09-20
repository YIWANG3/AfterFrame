// Copy edits in the editor, paste them onto several photos from the gallery
// (docs/next-features-plan.md §F). The photos live in a temp folder because a
// paste writes <name>_edited.jpg NEXT TO each original. Drives the real header
// button, checklist and context menu; asserts on the written files with sharp.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const sharp = require("sharp");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-paste-"));
const file = (name) => path.join(tmp, name);
// A distinctive prefix: the gallery search is how the test finds its photos.
const SOURCE = file("pasteedit-source.jpg"); // 600×400
const SAME_SHAPE = file("pasteedit-same.jpg"); // 300×200
const TURNED = file("pasteedit-turned.jpg"); // stored 300×200, EXIF says it is portrait

async function writeJpeg(target, width, height, orientation) {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      buf[i] = Math.floor((x / width) * 255);
      buf[i + 1] = Math.floor((y / height) * 255);
      buf[i + 2] = 128;
    }
  }
  let image = sharp(buf, { raw: { width, height, channels: 3 } });
  if (orientation) image = image.withMetadata({ orientation });
  await image.jpeg({ quality: 92 }).toFile(target);
}

test.describe("Copy edits → paste edits", () => {
  let app, window, userDataDir;
  const ids = {};

  test.beforeAll(async () => {
    await writeJpeg(SOURCE, 600, 400);
    await writeJpeg(SAME_SHAPE, 300, 200);
    await writeJpeg(TURNED, 300, 200, 6);
    // The user's earlier edit of the same photo. A paste must not replace it.
    fs.writeFileSync(file("pasteedit-same_edited.jpg"), "an earlier edit");

    ({ app, window, userDataDir } = await launchApp({ testName: "paste-edits" }));
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    for (const p of [SOURCE, SAME_SHAPE, TURNED]) {
      await window.evaluate((target) => window.mediaWorkspace.quickRegister(target, null), p);
      await expect.poll(
        async () => (ids[p] = await window.evaluate((target) => window.mediaWorkspace.getAssetDetail(target).then((d) => d?.asset_id || null), p)),
        { timeout: 10_000 },
      ).toBeTruthy();
    }
    // Nothing copied yet, from this or an earlier run.
    await window.evaluate(() => localStorage.removeItem("afterframe-edit-clipboard"));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("an untouched photo has nothing to copy", async () => {
    await window.evaluate((p) => window.__afterframeTest.openEditor(p), SOURCE);
    await waitForEditor(window, { preview: true });
    await expect(window.locator("[data-copy-edits='button']")).toBeDisabled();
  });

  test("the checklist offers only the edits this photo has", async () => {
    await window.getByRole("button", { name: /90° L/ }).click();
    const copy = window.locator("[data-copy-edits='button']");
    await expect(copy).toBeEnabled();
    await copy.click();
    const panel = window.locator("[data-copy-edits='panel']");
    await expect(panel.getByRole("checkbox")).toHaveCount(1);
    await expect(panel.getByLabel("Rotation")).toBeChecked();
    await panel.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(copy).toHaveText("Copied");
    const stored = await window.evaluate(() => JSON.parse(localStorage.getItem("afterframe-edit-clipboard")));
    expect(stored).toEqual({ rotate: { quarterTurns: 3 } });
    await window.evaluate(() => window.__afterframeTest.closeEditor());
  });

  test("pasting onto a selection writes a rotated copy beside each original", async () => {
    await window.getByPlaceholder("Search").fill("pasteedit-");
    const cards = window.locator("[data-gallery-item='true']");
    await expect(cards).toHaveCount(3, { timeout: 10_000 });
    await window.locator(`[data-asset-id='${ids[SAME_SHAPE]}']`).click();
    await window.locator(`[data-asset-id='${ids[TURNED]}']`).click({ modifiers: ["Meta"] });
    await window.locator(`[data-asset-id='${ids[TURNED]}']`).click({ button: "right" });
    await window.getByText("Paste edits onto 2 photos", { exact: true }).click();
    await expect(window.getByText("Pasted edits onto 2 photos", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Same-shape target: 300×200 turned a quarter → 200×300. The earlier
    // _edited file is untouched and the new one took the next free name.
    expect(fs.readFileSync(file("pasteedit-same_edited.jpg"), "utf8")).toBe("an earlier edit");
    const same = await sharp(file("pasteedit-same_edited_2.jpg")).metadata();
    expect([same.width, same.height]).toEqual([200, 300]);

    // EXIF-portrait target: displayed 200×300, so a quarter turn lands on
    // 300×200 — not 200×300, which is what ignoring the orientation tag gives.
    const turned = await sharp(file("pasteedit-turned_edited.jpg")).metadata();
    expect([turned.width, turned.height]).toEqual([300, 200]);
    expect(turned.orientation || 1).toBe(1);

    // Originals are never modified.
    expect((await sharp(SAME_SHAPE).metadata()).width).toBe(300);

    // Each result joined its original's version stack.
    const detail = await window.evaluate((p) => window.mediaWorkspace.getAssetDetail(p), file("pasteedit-turned_edited.jpg"));
    expect(detail?.asset_id).toBeTruthy();
  });

  test("the pasted top-left pixel is the one a left turn puts there", async () => {
    // Red runs left→right, green top→bottom. After 90° counter-clockwise the
    // original top-RIGHT corner (red high, green low) is the new top-left.
    const { data } = await sharp(file("pasteedit-same_edited_2.jpg")).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(40);
  });

  test("a single photo gets the singular menu wording", async () => {
    // (What gets skipped — video, RAW, HEIC — is unit tested in pasteEdits.test.js.)
    await window.locator(`[data-asset-id='${ids[SOURCE]}']`).click();
    await window.locator(`[data-asset-id='${ids[SOURCE]}']`).click({ button: "right" });
    await expect(window.getByText("Paste edits", { exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
    await window.getByPlaceholder("Search").fill("");
  });
});
