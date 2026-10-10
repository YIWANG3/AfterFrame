// Culling and organizing from the keyboard: Lightroom's P / X / U flags (Shift
// moves on to the next photo), Delete Rejected Photos…, Add Tags… for a
// selection, ⌘P for proof in the lightbox, and Settings → Keyboard Shortcuts,
// where keys are rebound, conflicts and system keys are caught, the menu
// follows, and the change outlives a restart. One app; tests build in order.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, collectCoverage } = require("./helpers/app");

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
    const byId = Object.fromEntries((await rows()).map((row) => [row.asset_id, row.annotation?.tags || []]));
    return [byId[a], byId[b]].map((tags) => ["trip", "beach"].every((tag) => tags.includes(tag)));
  }, { timeout: 5_000 }).toEqual([true, true]);
  // The menu offers the same.
  await card(a).click({ button: "right" });
  await expect(ctx.window.getByText("Add Tags…", { exact: true })).toBeVisible();
  await ctx.window.keyboard.press("Escape");
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
});
