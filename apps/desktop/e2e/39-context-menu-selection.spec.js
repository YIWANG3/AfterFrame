// The gallery's right-click menu and selection model — the pieces the
// coverage report found untouched (docs/review/2026-09-17-E2E覆盖率.md B1/B2):
// the menu itself, Edit/Compare from it, folders (create → add → remove →
// rename → delete), Delete from Disk with the in-app confirm, range / toggle
// selection, arrow-key moves, Space for the lightbox, number keys for rating.
// 05-catalog already covers Copy Path/Name, Refresh from Disk, Cmd+A and
// Delete from Catalog. One app launch; tests build on each other in order.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const selected = () => ctx.window.locator("[data-gallery-item='true'][data-selected='true']");

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function ratingOf(assetId) {
  return ctx.window.evaluate(async (id) => {
    const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 100 });
    return rows.find((r) => r.asset_id === id)?.app_rating ?? null;
  }, assetId);
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "context-menu" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("right-click lists the single-asset actions; a pair adds Compare and Collage", async () => {
  await cards().nth(0).click({ button: "right" });
  for (const label of ["Edit…", "Reveal in Finder", "Refresh from Disk", "Copy File Path", "Copy Name", "Delete from Catalog", "Delete from Disk…"]) {
    await expect(ctx.window.getByText(label, { exact: true })).toBeVisible();
  }
  // The Inspector carries the same "Annotate with AI" label; the menu adds a second.
  await expect(ctx.window.getByText("Annotate with AI", { exact: true })).toHaveCount(2);
  await expect(ctx.window.getByText("Compare", { exact: true })).toHaveCount(0);
  await expect(ctx.window.getByText("Collage", { exact: true })).toHaveCount(0);
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByText("Copy File Path", { exact: true })).toHaveCount(0);

  await cards().nth(0).click();
  await cards().nth(1).click({ modifiers: ["Shift"] });
  await expect(selected()).toHaveCount(2);
  await cards().nth(1).click({ button: "right" });
  await expect(ctx.window.getByText("Compare", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("Collage", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("Refresh 2 from Disk", { exact: true })).toBeVisible();
  await ctx.window.keyboard.press("Escape");
});

test("Compare from the menu opens the before/after view", async () => {
  await cards().nth(0).click();
  await cards().nth(1).click({ modifiers: ["Shift"] });
  await cards().nth(0).click({ button: "right" });
  await ctx.window.getByText("Compare", { exact: true }).click();
  const header = ctx.window.getByTestId("compare-header");
  await expect(header).toBeVisible({ timeout: 5_000 });
  await ctx.window.getByTestId("compare-layout-controls").getByRole("button").nth(1).click();
  await expect(header).toBeVisible();
  await ctx.window.getByTestId("compare-close").click();
  await expect(header).toHaveCount(0);
});

test("Edit… from the menu opens the editor", async () => {
  await cards().nth(0).click();
  await cards().nth(0).click({ button: "right" });
  await ctx.window.getByText("Edit…", { exact: true }).click();
  await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(true);
  await expect(ctx.window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await ctx.window.keyboard.press("Escape");
  await expect.poll(() => ctx.window.evaluate(() => window.__afterframeTest.getEditorOpen()), { timeout: 10_000 }).toBe(false);
});

test("shift-click ranges, cmd-click toggles, arrows move, Space toggles the lightbox", async () => {
  await cards().nth(0).click();
  await cards().nth(3).click({ modifiers: ["Shift"] });
  await expect(selected()).toHaveCount(4);
  await cards().nth(1).click({ modifiers: ["Meta"] });
  await expect(selected()).toHaveCount(3);
  await expect(cards().nth(1)).toHaveAttribute("data-selected", "false");

  await cards().nth(0).click();
  await expect(selected()).toHaveCount(1);
  await ctx.window.keyboard.press("ArrowRight");
  await expect(cards().nth(1)).toHaveAttribute("data-selected", "true");
  await expect(selected()).toHaveCount(1);
  await ctx.window.keyboard.press("ArrowLeft");
  await expect(cards().nth(0)).toHaveAttribute("data-selected", "true");

  await ctx.window.keyboard.press("Space");
  const viewport = ctx.window.locator("[data-lightbox-viewport='true']");
  await expect(viewport).toBeVisible({ timeout: 5_000 });
  await ctx.window.keyboard.press("Space");
  await expect(viewport).toHaveCount(0);
});

test("number keys rate the selection and 0 clears it", async () => {
  const assetId = await cards().nth(2).getAttribute("data-asset-id");
  await cards().nth(2).click();
  await ctx.window.keyboard.press("4");
  await expect.poll(() => ratingOf(assetId), { timeout: 5_000 }).toBe(4);
  await ctx.window.keyboard.press("0");
  await expect.poll(() => ratingOf(assetId), { timeout: 5_000 }).toBeFalsy();
});

test("folders: create, add from the menu, open, remove, rename, delete", async () => {
  await ctx.window.getByTitle("New folder", { exact: true }).click();
  const editor = ctx.window.getByTestId("sidebar-folder-scroll").locator("input");
  await editor.fill("Trip");
  await editor.press("Enter");
  const folder = () => ctx.window.getByTestId("sidebar-folder-scroll").getByText("Trip", { exact: true });
  await expect(folder()).toBeVisible({ timeout: 5_000 });

  const assetId = await cards().nth(0).getAttribute("data-asset-id");
  await cards().nth(0).click();
  await cards().nth(0).click({ button: "right" });
  await ctx.window.getByText("Add to Folder", { exact: true }).hover();
  await ctx.window.getByRole("button", { name: "Trip", exact: true }).click();
  await expect(ctx.window.getByText("Copy File Path", { exact: true })).toHaveCount(0);

  await folder().click();
  await expect(cards()).toHaveCount(1, { timeout: 10_000 });
  await expect(cards().first()).toHaveAttribute("data-asset-id", assetId);
  await cards().first().click({ button: "right" });
  await ctx.window.getByText("Remove from Folder", { exact: true }).click();
  await expect(cards()).toHaveCount(0, { timeout: 10_000 });

  const row = folder().locator("xpath=ancestor::*[contains(@class,'group')][1]");
  await row.hover();
  await row.getByTitle("Rename", { exact: true }).click();
  const rename = ctx.window.getByTestId("sidebar-folder-scroll").locator("input");
  await rename.fill("Trip 2");
  await rename.press("Enter");
  const renamed = () => ctx.window.getByTestId("sidebar-folder-scroll").getByText("Trip 2", { exact: true });
  await expect(renamed()).toBeVisible({ timeout: 5_000 });
  const row2 = renamed().locator("xpath=ancestor::*[contains(@class,'group')][1]");
  await row2.hover();
  await row2.getByTitle("Delete", { exact: true }).click();
  await expect(renamed()).toHaveCount(0, { timeout: 5_000 });

  await ctx.window.getByRole("button", { name: /^All Assets/ }).click();
  await expect(cards().first()).toBeVisible({ timeout: 10_000 });
});

test("Delete from Disk… moves the file to the Trash after the in-app confirm", async () => {
  test.setTimeout(90_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-trash-"));
  const file = path.join(dir, "trash_me.jpg");
  fs.writeFileSync(file, TINY_JPEG);
  try {
    const imported = await callTool("import_directory", { image_dirs: [dir] });
    expect(imported.status).toBe("succeeded");
    const card = ctx.window.locator("[data-gallery-item='true'][data-image-path$='/trash_me.jpg']");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await card.click({ button: "right" });
    await ctx.window.getByText("Delete from Disk…", { exact: true }).click();
    await expect(ctx.window.getByText("Delete from disk", { exact: true })).toBeVisible();
    await ctx.window.getByRole("button", { name: "Cancel" }).click();
    expect(fs.existsSync(file)).toBe(true);

    await card.click({ button: "right" });
    await ctx.window.getByText("Delete from Disk…", { exact: true }).click();
    await ctx.window.getByRole("button", { name: "Move to Trash" }).click();
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => fs.existsSync(file), { timeout: 10_000 }).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
