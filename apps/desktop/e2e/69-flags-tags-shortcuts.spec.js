// Culling and organizing from the keyboard: Lightroom's P / X / U flags (Shift
// moves on to the next photo), Delete Rejected Photos…, Add Tags… for a
// selection, ⌘P for proof in the lightbox, and Settings → Keyboard Shortcuts,
// where keys are rebound, conflicts and system keys are caught, the menu
// follows, and the change outlives a restart. Last, the orientation filter,
// which goes by how a photo shows (a camera's upright shot is landscape
// pixels with a "rotate 90°" tag). One app; tests build in order.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage, mcpCall } = require("./helpers/app");
const { devPython } = require("../electron/sidecar/transport");

test.describe.configure({ mode: "serial" });

let ctx;
const cards = () => ctx.window.locator("[data-gallery-item='true']");
const card = (id) => ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
const shortcutRow = (id) => ctx.window.locator(`[data-shortcut-row='${id}']`);

async function rows() {
  return ctx.window.evaluate(async () => window.mediaWorkspace.browseImages({ status: "all", limit: 500 }));
}
async function flagOf(id) {
  return (await rows()).find((row) => row.asset_id === id)?.app_flag ?? null;
}
async function idAt(index) {
  return cards().nth(index).getAttribute("data-asset-id");
}
// The Settings item's accelerator, from the live application menu.
function settingsAccelerator() {
  return ctx.app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label === "Settings…") return item.accelerator || null;
        const found = item.submenu ? find(item.submenu.items) : undefined;
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return find(Menu.getApplicationMenu().items);
  });
}

async function restart() {
  await collectCoverage(ctx.app);
  await ctx.app.close();
  Object.assign(ctx, await launchApp({ testName: "flags-shortcuts", reuseUserDataDir: ctx.userDataDir, keepCatalog: true }));
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "flags-shortcuts" });
  await expect(cards().first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("P / X / U flag the photo; the tile, the Inspector and the filter follow", async () => {
  const first = await idAt(0);
  const second = await idAt(1);
  const flag = ctx.window.getByTestId("inspector-flag");
  await card(first).click();

  await ctx.window.keyboard.press("p");
  await expect(card(first)).toHaveAttribute("data-flag", "pick");
  await expect(flag).toHaveAttribute("data-value", "pick");
  await expect.poll(() => flagOf(first)).toBe(1);

  await ctx.window.keyboard.press("x");
  await expect(card(first)).toHaveAttribute("data-flag", "reject");
  await expect(card(first).locator("[data-flag-badge='reject']")).toBeVisible();
  await expect.poll(() => flagOf(first)).toBe(-1);

  await ctx.window.keyboard.press("u");
  await expect(card(first)).toHaveAttribute("data-flag", "none");
  await expect.poll(() => flagOf(first)).toBe(0);

  // The Inspector's buttons set it too; the one that's on clears it.
  await flag.locator("[data-flag-button='pick']").click();
  await expect.poll(() => flagOf(first)).toBe(1);
  await flag.locator("[data-flag-button='pick']").click();
  await expect.poll(() => flagOf(first)).toBe(0);

  // A selection is flagged as one.
  await card(second).click({ modifiers: ["Shift"] });
  await ctx.window.keyboard.press("x");
  await expect.poll(async () => [await flagOf(first), await flagOf(second)]).toEqual([-1, -1]);

  // \ shows the filter bar; "Rejected" narrows the grid to the two.
  await ctx.window.keyboard.press("Backslash");
  const rejected = ctx.window.locator("[data-facet-flag='true'] [data-flag-option='reject']");
  await rejected.click();
  await expect(cards()).toHaveCount(2);
  await rejected.click();
  await expect.poll(() => cards().count()).toBeGreaterThan(2);
});

test("Shift with a flag key moves on to the next photo", async () => {
  const third = await idAt(2);
  const fourth = await idAt(3);
  await card(third).click();
  await ctx.window.keyboard.press("Shift+X");
  await expect.poll(() => flagOf(third)).toBe(-1);
  await expect(card(fourth)).toHaveAttribute("data-selected", "true");
  await expect(card(third)).toHaveAttribute("data-selected", "false");
  // Shift+0 clears the rating and moves on too.
  await ctx.window.keyboard.press("Shift+Digit0");
  await expect(cards().nth(4)).toHaveAttribute("data-selected", "true");
});

test("⌘P is proof in the lightbox; P there flags the photo", async () => {
  const id = await idAt(5);
  await card(id).click();
  await ctx.window.keyboard.press("Space");
  const lightbox = ctx.window.locator("[data-lightbox-proof]");
  await expect(lightbox).toHaveAttribute("data-lightbox-proof", "false");

  await ctx.window.keyboard.press("p");
  await expect.poll(() => flagOf(id)).toBe(1);
  await expect(ctx.window.locator("[data-lightbox-flag='pick']")).toBeVisible();
  await expect(lightbox).toHaveAttribute("data-lightbox-proof", "false");

  await ctx.window.keyboard.press("ControlOrMeta+p");
  await expect(lightbox).toHaveAttribute("data-lightbox-proof", "true");
  await ctx.window.keyboard.press("Escape");
  await expect(lightbox).toHaveAttribute("data-lightbox-proof", "false");
  await ctx.window.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
});

test("T adds every tag to every selected photo", async () => {
  const a = await idAt(6);
  const b = await idAt(7);
  await card(a).click();
  await card(b).click({ modifiers: ["ControlOrMeta"] });
  await ctx.window.keyboard.press("t");
  const dialog = ctx.window.getByTestId("tag-batch-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Add Tags to 2 Photos");
  const input = ctx.window.getByTestId("tag-batch-input");
  await input.fill("trip");
  await input.press("Enter");
  await input.fill("beach");
  await input.press("Enter");
  await expect(dialog.locator("[data-batch-tag]")).toHaveCount(2);
  await ctx.window.getByTestId("tag-batch-apply").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const byId = Object.fromEntries((await rows()).map((row) => [row.asset_id, row.tags || []]));
    return [byId[a], byId[b]].map((tags) => ["trip", "beach"].every((tag) => tags.includes(tag)));
  }, { timeout: 5_000 }).toEqual([true, true]);
  // Hand tags are not an AI annotation: the photos are still un-annotated.
  const annotations = Object.fromEntries((await rows()).map((row) => [row.asset_id, row.annotation]));
  expect([annotations[a], annotations[b]]).toEqual([null, null]);
  // The menu offers the same.
  await card(a).click({ button: "right" });
  await expect(ctx.window.getByText("Add Tags…", { exact: true })).toBeVisible();
  await ctx.window.keyboard.press("Escape");
});

test("the Inspector's Tags are there without AI, and one more is added by hand", async () => {
  const tagged = await idAt(6);
  // A photo never annotated, never tagged (the fixture's 004-green has an
  // annotation whose tag "city" counts as a tag of the photo).
  const bare = (await rows()).find((row) => row.asset_type === "image" && !row.annotation && !(row.tags || []).length).asset_id;
  const tags = ctx.window.getByTestId("inspector-tags");
  // The section is there, empty.
  await card(bare).click();
  await expect(tags).toHaveAttribute("data-count", "0");
  await expect(tags).toContainText("No tags yet");
  // The one tagged in bulk shows those tags, and takes one more by hand.
  await card(tagged).click();
  await expect(tags.locator("[data-tag='trip']")).toBeVisible();
  await expect(tags.locator("[data-tag='beach']")).toBeVisible();
  await tags.getByTestId("tag-add").click();
  await tags.getByTestId("tag-add-input").fill("by-hand");
  await tags.getByTestId("tag-add-input").press("Enter");
  await expect(tags.locator("[data-tag='by-hand']")).toBeVisible();
  await expect.poll(async () => (await rows()).find((row) => row.asset_id === tagged)?.tags).toEqual(["trip", "beach", "by-hand"]);
  // Still not "AI annotated".
  const unannotated = await ctx.window.evaluate(async () => (await window.mediaWorkspace.browseImages({ status: "all", limit: 500, filters: { annotated: "without" } })).map((row) => row.asset_id));
  expect(unannotated).toContain(tagged);
});

test("a description is written by hand; the AI's shows until one is, and comes back on request", async () => {
  const description = ctx.window.getByTestId("inspector-description");
  const shownOf = async (id) => {
    const row = (await rows()).find((r) => r.asset_id === id);
    return [row?.description ?? null, row?.description_source ?? null];
  };
  // A photo with nothing: "Add a description…", typed, saved with Enter.
  const bare = (await rows()).find((row) => row.asset_type === "image" && !row.annotation && !row.description).asset_id;
  await card(bare).click();
  await expect(description).toHaveAttribute("data-source", "none");
  await description.getByTestId("description-add").click();
  await ctx.window.getByTestId("description-input").fill("Grandma's 80th");
  await ctx.window.getByTestId("description-input").press("Enter");
  await expect(description).toHaveAttribute("data-source", "user");
  await expect(description).toContainText("Grandma's 80th");
  await expect.poll(() => shownOf(bare)).toEqual(["Grandma's 80th", "user"]);
  // Still not an AI annotation.
  expect((await rows()).find((row) => row.asset_id === bare).annotation).toBeNull();

  // The fixture's 004-green has an AI caption: shown, badged AI.
  const green = (await rows()).find((row) => row.stem === "004-green");
  await card(green.asset_id).click();
  await expect(description).toHaveAttribute("data-source", "ai");
  const aiText = green.description;
  expect(aiText).toBeTruthy();
  await expect(ctx.window.getByTestId("annotation-meta")).toBeVisible();
  // Edited, it is the user's — and the AI's can be had back.
  await description.getByRole("button", { name: aiText }).click();
  await ctx.window.getByTestId("description-input").fill("Sydney, the night we landed");
  await ctx.window.getByTestId("description-input").press("Enter");
  await expect(description).toHaveAttribute("data-source", "user");
  await expect.poll(() => shownOf(green.asset_id)).toEqual(["Sydney, the night we landed", "user"]);
  await description.getByTestId("description-use-ai").click();
  await expect(description).toHaveAttribute("data-source", "ai");
  await expect.poll(() => shownOf(green.asset_id)).toEqual([aiText, "ai"]);
  // Emptied, it stays empty: the AI's doesn't creep back.
  await description.getByRole("button", { name: aiText }).click();
  await ctx.window.getByTestId("description-input").fill("");
  await ctx.window.getByTestId("description-input").press("Enter");
  await expect(description.getByTestId("description-add")).toBeVisible();
  await expect.poll(() => shownOf(green.asset_id)).toEqual([null, "user"]);
  // Escape leaves a draft unsaved.
  await description.getByTestId("description-add").click();
  await ctx.window.getByTestId("description-input").fill("not this");
  await ctx.window.getByTestId("description-input").press("Escape");
  await expect.poll(() => shownOf(green.asset_id)).toEqual([null, "user"]);

  // An agent writes one the same way.
  const response = await mcpCall(ctx.mcpPort, "tools/call", { name: "update_assets", arguments: { asset_ids: [bare], description: "Party at home" } });
  expect(response.isError).toBeFalsy();
  await expect.poll(() => shownOf(bare)).toEqual(["Party at home", "user"]);
});

test("⌘⌫ deletes the rejected photos of the view from the library", async () => {
  const before = await rows();
  const rejectedIds = before.filter((row) => row.app_flag === -1).map((row) => row.asset_id);
  expect(rejectedIds.length).toBe(3);
  await cards().first().click();
  await ctx.window.keyboard.press("ControlOrMeta+Backspace");
  await expect(ctx.window.getByText("3 rejected photos in this view.")).toBeVisible();
  await ctx.window.locator("[data-choice='library']").click();
  await expect.poll(async () => (await rows()).length).toBe(before.length - 3);
  const after = new Set((await rows()).map((row) => row.asset_id));
  for (const id of rejectedIds) expect(after.has(id)).toBe(false);

  // None left: it says so instead of asking.
  await ctx.window.keyboard.press("ControlOrMeta+Backspace");
  await expect(ctx.window.getByText("No rejected photos in this view")).toBeVisible();
});

test("Settings lists the shortcuts; a key is rebound, a conflict taken over, a system key refused", async () => {
  await ctx.window.keyboard.press("ControlOrMeta+Slash");
  await expect(ctx.window.getByTestId("shortcuts-settings")).toBeVisible();
  // The locked keys are listed too.
  await expect(ctx.window.locator("[data-shortcut-fixed='fixed.undo']")).toBeVisible();

  // Pick: P → K.
  await shortcutRow("flag.pick").locator("[data-shortcut-key='KeyP']").click();
  await expect(ctx.window.locator("[data-shortcut-recorder='true']")).toBeFocused();
  await ctx.window.keyboard.press("k");
  await expect(shortcutRow("flag.pick").locator("[data-shortcut-key='KeyK']")).toBeVisible();
  await expect(shortcutRow("flag.pick").locator("[data-shortcut-reset='flag.pick']")).toBeVisible();

  // Edit → X, which Reject has: asked, then taken over.
  await shortcutRow("photo.edit").locator("[data-shortcut-key='KeyE']").click();
  await ctx.window.keyboard.press("x");
  await expect(shortcutRow("photo.edit").locator("[data-shortcut-notice='conflict']")).toContainText("Flag as Rejected");
  await shortcutRow("photo.edit").locator("[data-shortcut-take-over='true']").click();
  await expect(shortcutRow("photo.edit").locator("[data-shortcut-key='KeyX']")).toBeVisible();
  await expect(shortcutRow("flag.reject")).toContainText("None");

  // ⌘C is the system's.
  await shortcutRow("flag.none").locator("[data-shortcut-key='KeyU']").click();
  await ctx.window.keyboard.press("ControlOrMeta+c");
  await expect(shortcutRow("flag.none").locator("[data-shortcut-notice='reserved']")).toBeVisible();
  await expect(shortcutRow("flag.none").locator("[data-shortcut-key='KeyU']")).toBeVisible();

  // The Settings menu item's keys follow; while recording, the menu lets go.
  expect(await settingsAccelerator()).toBe("CmdOrCtrl+,");
  await shortcutRow("app.settings").locator("[data-shortcut-key='Mod+Comma']").click();
  await expect.poll(settingsAccelerator).toBeFalsy();
  await ctx.window.keyboard.press("ControlOrMeta+Shift+Comma");
  await expect(shortcutRow("app.settings").locator("[data-shortcut-key='Mod+Shift+Comma']")).toBeVisible();
  await expect.poll(settingsAccelerator).toBe("CmdOrCtrl+Shift+,");

  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByTestId("shortcuts-settings")).toHaveCount(0);

  // K picks now; P no longer does.
  const id = await idAt(0);
  await card(id).click();
  await ctx.window.keyboard.press("p");
  await ctx.window.keyboard.press("k");
  await expect.poll(() => flagOf(id)).toBe(1);
});

test("rebound keys outlive a restart, and Restore Defaults brings the old ones back", async () => {
  await restart();
  expect(await settingsAccelerator()).toBe("CmdOrCtrl+Shift+,");
  const id = await idAt(1);
  await card(id).click();
  await ctx.window.keyboard.press("k");
  await expect.poll(() => flagOf(id)).toBe(1);

  await ctx.window.keyboard.press("ControlOrMeta+Slash");
  await expect(shortcutRow("flag.pick").locator("[data-shortcut-key='KeyK']")).toBeVisible();
  await ctx.window.getByRole("button", { name: "Restore Defaults" }).click();
  await ctx.window.getByRole("button", { name: "Restore Defaults" }).last().click();
  await expect(shortcutRow("flag.pick").locator("[data-shortcut-key='KeyP']")).toBeVisible();
  await expect(shortcutRow("photo.edit").locator("[data-shortcut-key='KeyE']")).toBeVisible();
  await expect(shortcutRow("flag.reject").locator("[data-shortcut-key='KeyX']")).toBeVisible();
  await expect.poll(settingsAccelerator).toBe("CmdOrCtrl+,");
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.getByTestId("shortcuts-settings")).toHaveCount(0);
});

test("the orientation filter finds a camera's upright shot as portrait", async () => {
  // A catalog from before the shape was recorded: the catch-up job reads it
  // off the thumbnails. (The fixture has it, so nothing ran at launch.)
  const unknown = async () => (await rows()).filter((row) => row.asset_type === "image" && !row.display_shape).length;
  expect(await unknown()).toBe(0);
  execFileSync(devPython(process.platform), ["-c",
    "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('UPDATE assets SET display_shape = NULL'); c.commit()",
    path.join(ctx.catalogDir, "catalog.sqlite3")]);
  expect(await unknown()).toBeGreaterThan(0);
  const started = await ctx.window.evaluate(() => window.mediaWorkspace.startOrientationScan());
  expect(started.missing).toBeGreaterThan(0);
  await expect.poll(unknown, { timeout: 20_000 }).toBe(0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-orientation-"));
  const upright = path.join(dir, "upright-shot.jpg");
  const wide = path.join(dir, "wide-shot.jpg");
  const pixels = { create: { width: 600, height: 400, channels: 3, background: { r: 60, g: 90, b: 140 } } };
  await sharp(pixels).jpeg().withMetadata({ orientation: 6 }).toFile(upright);
  await sharp(pixels).jpeg().toFile(wide);
  try {
    await ctx.app.evaluate(({ app }, paths) => {
      for (const p of paths) app.emit("open-file", { preventDefault() {} }, p);
    }, [upright, wide]);
    await expect.poll(async () => {
      const found = Object.fromEntries((await rows()).map((row) => [row.stem, row.display_shape]));
      return [found["upright-shot"], found["wide-shot"]];
    }, { timeout: 30_000 }).toEqual(["portrait", "landscape"]);

    const shown = () => cards().evaluateAll((els) => els.map((el) => el.getAttribute("data-image-path").split(/[\\/]/).pop()));
    if (!(await ctx.window.locator("[data-facet-orientation='true']").isVisible())) await ctx.window.keyboard.press("Backslash");
    const portrait = ctx.window.locator("[data-facet-orientation='true'] [data-orientation-option='portrait']");
    await portrait.click();
    await expect.poll(shown).toContain("upright-shot.jpg");
    expect(await shown()).not.toContain("wide-shot.jpg");
    await portrait.click();
    await expect.poll(shown).toContain("wide-shot.jpg");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
