// The native application menu and the two file-handoff paths that no spec
// had driven (coverage report B3/B9): every menu item's click handler in
// main.js was dead (13-i18n only reads labels), and so were the drop
// affordance, queueExternalImport / flushExternalImports (macOS open-file,
// i.e. files dropped on the Dock icon) and the renderer's external-import
// listener. Menu items are clicked in the main process through Electron's
// Menu API — the same handlers the real menu runs.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");

async function clickMenu(menuLabel, itemLabel) {
  const found = await ctx.app.evaluate(({ Menu, BrowserWindow }, labels) => {
    const top = Menu.getApplicationMenu()?.items.find((i) => i.label === labels.menuLabel);
    const item = top?.submenu?.items.find((i) => i.label === labels.itemLabel);
    if (!item) return false;
    const win = BrowserWindow.getAllWindows()[0];
    item.click(undefined, win, win?.webContents);
    return true;
  }, { menuLabel, itemLabel });
  expect(found, `${menuLabel} › ${itemLabel} should exist in the application menu`).toBe(true);
}

const bridge = (fn) => ctx.window.evaluate(fn);

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "drop-menu" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("AfterFrame › Settings… opens the settings overlay", async () => {
  await clickMenu("AfterFrame", "Settings…");
  await expect(ctx.window.getByText("Auto-annotation providers")).toBeVisible({ timeout: 5_000 });
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByText("Auto-annotation providers")).toHaveCount(0);
});

test("Edit › Select All, Copy Name, Copy File Path, Delete act on the gallery selection", async () => {
  const first = cards().first();
  const firstName = path.basename(await first.getAttribute("data-image-path"));
  await first.click();
  await clickMenu("Edit", "Select All");
  await expect(ctx.window.locator("[data-gallery-item='true'][data-selected='true']")).toHaveCount(await cards().count());

  await first.click(); // back to a single selection
  await clickMenu("Edit", "Copy Name");
  await expect.poll(() => ctx.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(firstName);
  await clickMenu("Edit", "Copy File Path");
  await expect.poll(() => ctx.app.evaluate(({ clipboard }) => clipboard.readText())).toMatch(new RegExp(`/${firstName.replace(".", "\\.")}$`));

  await clickMenu("Edit", "Delete");
  await expect(ctx.window.getByText("Remove from catalog")).toBeVisible({ timeout: 5_000 });
  await ctx.window.getByRole("button", { name: "Cancel" }).click();
  await expect(ctx.window.getByText("Remove from catalog")).toHaveCount(0);
});

test("View › Toggle Theme flips the applied theme; Refresh reloads the gallery", async () => {
  const before = await bridge(() => document.documentElement.dataset.theme);
  await clickMenu("View", "Toggle Theme");
  await expect.poll(() => bridge(() => document.documentElement.dataset.theme)).not.toBe(before);
  await clickMenu("View", "Toggle Theme");
  await expect.poll(() => bridge(() => document.documentElement.dataset.theme)).toBe(before);
  const count = await cards().count();
  await clickMenu("View", "Refresh");
  await expect(cards()).toHaveCount(count);
});

test("File › Generate Previews and Run Enrichment start their jobs; Verify Files reports", async () => {
  test.setTimeout(90_000);
  await clickMenu("File", "Generate Previews");
  await expect.poll(() => bridge(() => window.mediaWorkspace.getPreviewStatus().then((s) => s.jobId)), { timeout: 10_000 }).toBeTruthy();
  await expect.poll(() => bridge(() => window.mediaWorkspace.getPreviewStatus().then((s) => s.status)), { timeout: 60_000 }).toBe("succeeded");

  await clickMenu("File", "Run Enrichment");
  await expect.poll(() => bridge(() => window.mediaWorkspace.getEnrichmentStatus().then((s) => s.jobId)), { timeout: 10_000 }).toBeTruthy();
  await expect.poll(() => bridge(() => window.mediaWorkspace.getEnrichmentStatus().then((s) => s.status)), { timeout: 60_000 }).toBe("succeeded");

  await clickMenu("File", "Verify Files");
  await expect(ctx.window.getByText("All files present")).toBeVisible({ timeout: 15_000 });
});

test("dragging files over the gallery shows the drop affordance and leaving hides it", async () => {
  const zone = ctx.window.getByTestId("gallery-drop-zone");
  const dt = await ctx.window.evaluateHandle(() => {
    const t = new DataTransfer();
    t.items.add(new File(["x"], "drop.jpg", { type: "image/jpeg" }));
    return t;
  });
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(ctx.window.getByText("Drop to import")).toBeVisible();
  await zone.dispatchEvent("dragleave", { dataTransfer: dt, relatedTarget: null });
  await expect(ctx.window.getByText("Drop to import")).toHaveCount(0);
  // A synthetic File has no on-disk path, so the drop resolves nothing to
  // import — and must not crash or leave the affordance behind.
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(ctx.window.getByText("Drop to import")).toHaveCount(0);
});

test("files handed over by macOS open-file are batched and imported", async () => {
  test.setTimeout(90_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-openfile-"));
  const files = ["dock_a.jpg", "dock_b.jpg"].map((name) => path.join(dir, name));
  for (const file of files) fs.writeFileSync(file, TINY_JPEG);
  try {
    const before = (await bridge(() => window.mediaWorkspace.getSummary())).image_assets;
    // Two open-file events inside the 50 ms batching window → one import.
    await ctx.app.evaluate(({ app }, paths) => {
      for (const p of paths) app.emit("open-file", { preventDefault() {} }, p);
    }, files);
    // The gallery windows its cards (a small CI viewport renders fewer than
    // the catalog holds), so verify through the catalog and the sidebar badge.
    await expect(ctx.window.getByRole("button", { name: `All Assets ${before + 2}` })).toBeVisible({ timeout: 30_000 });
    const names = await bridge(async () => (await window.mediaWorkspace.browseImages({ status: "all", limit: 100 })).map((r) => r.image_path.split("/").pop()));
    expect(names).toEqual(expect.arrayContaining(["dock_a.jpg", "dock_b.jpg"]));
    await expect(ctx.window.locator(`[data-gallery-item='true'][data-image-path$="/dock_a.jpg"]`)).toBeVisible({ timeout: 10_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
