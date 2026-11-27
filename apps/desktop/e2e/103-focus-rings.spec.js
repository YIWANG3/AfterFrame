// Keyboard focus (docs/focus-design.md). Chromium focuses a button when it is
// clicked; the app gives that focus up, so a key pressed after a click draws
// no focus ring and Space does not press the clicked button a second time.
// Focus reached from the keyboard draws one ring, in the accent colour. A
// sidebar row keeps the focus a click gave it (it reads arrow keys), without
// a ring.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, openEditorOn, closeEditor, galleryCards } = require("./helpers/app");

test.describe("Keyboard focus", () => {
  let app, window, userDataDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({ testName: "focus-rings" }));
    await expect(galleryCards(window).nth(1)).toBeVisible({ timeout: 15_000 });
  });
  test.afterAll(async () => { await closeApp(app, userDataDir); });

  // What has the focus, whether it counts as keyboard focus, and what ring it draws.
  const focus = () => window.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    const ring = getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim().split(/\s+/).join(", ");
    return {
      onBody: el === document.body,
      tag: el.tagName,
      visible: el.matches(":focus-visible"),
      anyVisible: !!document.querySelector(":focus-visible"),
      pointer: el.hasAttribute("data-pointer-focus"),
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      accent: `rgb(${ring})`,
    };
  });

  test("a clicked gallery card gives its focus up: the arrows move the selection, no ring", async () => {
    const cards = galleryCards(window);
    await cards.first().click();
    await expect(cards.first()).toHaveAttribute("data-selected", "true");
    await expect.poll(async () => (await focus()).onBody).toBe(true);

    await window.keyboard.press("ArrowRight");
    await expect(cards.nth(1)).toHaveAttribute("data-selected", "true");
    expect((await focus()).anyVisible).toBe(false);
  });

  test("in the editor a clicked button draws no ring, and Space does not press it again", async () => {
    const row = await window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 1 }).then((rows) => rows[0]));
    await openEditorOn(window, row);

    // The tool rail: clicked, then a key that does nothing in the editor.
    await window.getByTestId("tool-frame").click();
    await expect(window.locator("[data-frame-templates]")).toBeVisible();
    await expect.poll(async () => (await focus()).onBody).toBe(true);
    await window.keyboard.press("ArrowRight");
    expect((await focus()).anyVisible).toBe(false);

    // A template, clicked, then Space held and let go (the hand tool). Left
    // focused, the button would take the Space as a second press.
    const template = window.locator("[data-frame-template] > button").nth(1);
    await template.evaluate((el) => {
      window.__templateClicks = 0;
      el.addEventListener("click", () => { window.__templateClicks += 1; });
    });
    await template.click();
    await expect.poll(async () => (await focus()).onBody).toBe(true);
    await window.keyboard.down("Space");
    await window.keyboard.up("Space");
    expect(await window.evaluate(() => window.__templateClicks)).toBe(1);
    expect((await focus()).anyVisible).toBe(false);

    // Focus that did not come from the pointer stays, rings, and Space presses.
    await template.focus();
    await window.keyboard.press("Space");
    expect(await window.evaluate(() => window.__templateClicks)).toBe(2);
    const kept = await focus();
    expect(kept.tag).toBe("BUTTON");
    expect(kept.visible).toBe(true);
    expect(kept.outline).toBe("solid");
    await template.evaluate((el) => el.blur());
  });

  test("Tab draws one ring: 2px, in the accent colour", async () => {
    // Tab until a button has the focus (text fields keep their own style).
    let state = await focus();
    for (let i = 0; i < 30 && state.tag !== "BUTTON"; i++) {
      await window.keyboard.press("Tab");
      state = await focus();
    }
    expect(state.tag).toBe("BUTTON");
    expect(state.visible).toBe(true);
    expect(state.pointer).toBe(false);
    expect(state.outline).toBe("solid");
    expect(state.outlineWidth).toBe("2px");
    expect(state.outlineColor).toBe(state.accent);
    await closeEditor(window);
  });

  test("a clicked sidebar row keeps the focus for its keys but draws no ring", async () => {
    await window.evaluate(() => window.mediaWorkspace.createCollection("Focus row", "manual"));
    await window.reload();
    const row = window.locator("[data-collection-id]").filter({ hasText: "Focus row" });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.click();
    await window.keyboard.press("ArrowDown");
    const clicked = await focus();
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(clicked.pointer).toBe(true);
    expect(clicked.visible).toBe(true);
    expect(clicked.outline).toBe("none");

    // The same row reached without the pointer rings.
    await row.evaluate((el) => el.blur());
    await row.focus();
    const keyed = await focus();
    expect(keyed.pointer).toBe(false);
    expect(keyed.visible).toBe(true);
    expect(keyed.outline).toBe("solid");
  });
});
