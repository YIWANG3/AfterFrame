// Text layers by hand: the on-canvas gestures (drag, resize and rotate
// handles, inline edit) and the TextPanel controls (layer list, font
// dropdown, stroke/shadow switches, align bar). 19-editor-layers drives the
// stack through the backdoor; TextCanvas's pointer handlers and most of
// TextPanel had never run under e2e (coverage report B5). Layer x/y are
// fractions of imageRect (viewport space); the viewport's bounding box maps
// them to page coordinates for Playwright's mouse.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, waitForEditor } = require("./helpers/app");
const { ensureFixture } = require("./fixtures/make-fixture");

let ctx;
const state = () => ctx.window.evaluate(() => window.__afterframeTest.getState());
const layerById = async (id) => (await state()).layers.find((l) => l.id === id);
const addLayer = async (text) => {
  const before = (await state()).layers.length;
  const added = await ctx.window.evaluate((t) => window.__afterframeTest.addTextLayer(t), text);
  await expect.poll(async () => (await state()).layers.length).toBe(before + 1);
  return added.id;
};
const wrapper = (id) => ctx.window.locator(`[data-editor-layer-wrapper="${id}"]`);
// Every test starts from "one text layer, selected": a failed test restarts
// the worker with a fresh app, so nothing may rely on an earlier test's layer.
async function ensureLayer(text = "Alpha") {
  const existing = (await state()).layers.find((l) => l.type === "text");
  const id = existing ? existing.id : await addLayer(text);
  await ctx.window.evaluate((x) => window.__afterframeTest.selectLayers([x]), id);
  await expect.poll(async () => (await state()).selectedIds).toEqual([id]);
  return id;
}

async function pageCentre(id) {
  const s = await state();
  const box = await ctx.window.locator("[data-editor-viewport='true']").boundingBox();
  const d = s.displayLayers.find((l) => l.id === id);
  return { x: box.x + s.imageRect.x + d.x * s.imageRect.width, y: box.y + s.imageRect.y + d.y * s.imageRect.height, s, box };
}

async function drag(from, to, steps = 12) {
  await ctx.window.mouse.move(from.x, from.y);
  await ctx.window.mouse.down();
  await ctx.window.mouse.move(to.x, to.y, { steps });
  await ctx.window.mouse.up();
}

test.beforeAll(async () => {
  const fixturePath = await ensureFixture();
  ctx = await launchApp({ testName: "text-layers" });
  await ctx.window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
  await ctx.window.evaluate((p) => window.__afterframeTest.openEditor(p), fixturePath);
  await expect(ctx.window.getByRole("button", { name: /^Save$/i })).toBeVisible({ timeout: 15_000 });
  await waitForEditor(ctx.window, { preview: true });
  await ctx.window.evaluate(() => window.__afterframeTest.setTool("text"));
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("dragging a layer moves it and lands as one undo step", async () => {
  const id = await addLayer("Alpha");
  const before = await pageCentre(id);
  // Well clear of the 6 px snap targets at the canvas thirds/edges.
  await drag(before, { x: before.x + 90, y: before.y + 60 });
  const after = await pageCentre(id);
  expect(after.x - before.x).toBeGreaterThan(80);
  expect(after.y - before.y).toBeGreaterThan(50);
  expect(after.s.historyLength).toBe(before.s.historyLength + 1);
  expect(after.s.selectedIds).toEqual([id]);
});

test("resize and rotate handles change font size and rotation", async () => {
  const id = await ensureLayer();
  const box = await wrapper(id).locator("div").first().boundingBox();
  const before = await layerById(id);
  const history0 = (await state()).historyLength;
  // Bottom-right resize handle sits 8 px outside the text box corner; pull
  // it away from the centre → the layer grows.
  const corner = { x: box.x + box.width + 8, y: box.y + box.height + 8 };
  await drag(corner, { x: corner.x + 60, y: corner.y + 40 });
  const grown = await layerById(id);
  expect(grown.fontSize).toBeGreaterThan(before.fontSize * 1.2);

  // Rotate handle: 36 px above the top edge, centred. A short sideways pull
  // gives a clear angle that stays away from the 0° / 90° snaps (±3°).
  const box2 = await wrapper(id).locator("div").first().boundingBox();
  const knob = { x: box2.x + box2.width / 2, y: box2.y - 8 - 28 };
  await drag(knob, { x: knob.x + 40, y: knob.y + 12 });
  const turned = await layerById(id);
  expect(Math.abs(turned.rotation)).toBeGreaterThan(5);
  expect(Math.abs(turned.rotation)).toBeLessThan(85);
  expect((await state()).historyLength).toBe(history0 + 2); // resize + rotate, one step each
});

test("double-click edits the text inline", async () => {
  const id = await ensureLayer();
  const layer = { id };
  await wrapper(id).locator("div").first().dblclick();
  const editor = ctx.window.locator("[contenteditable]");
  await expect(editor).toBeVisible();
  await ctx.window.keyboard.press("Meta+a");
  await ctx.window.keyboard.type("Edited");
  await ctx.window.keyboard.press("Meta+Enter"); // Escape cancels; Cmd+Enter commits
  await expect.poll(async () => (await layerById(layer.id)).text).toBe("Edited");
  await expect(ctx.window.locator(`[data-layer-row="${layer.id}"]`)).toContainText("Edited");
});

test("the layer list selects, reorders by drag and deletes", async () => {
  const first = await ensureLayer();
  const second = await addLayer("Bravo");
  await ctx.window.locator(`[data-layer-row="${second}"]`).click();
  await expect.poll(async () => (await state()).selectedIds).toEqual([second]);
  await ctx.window.locator(`[data-layer-row="${first}"]`).click();
  await expect.poll(async () => (await state()).selectedIds).toEqual([first]);

  // HTML5 drag, dispatched by hand: the list decides the insertion side from
  // the dragover position it saw last (state), so a single synthetic drop
  // would land before that state exists. The list is displayed in reverse
  // stack order — dropping on the LOWER half of the row that is displayed
  // below moves the dragged layer under it in the stack (index 0).
  const src = ctx.window.locator(`[data-layer-row="${second}"]`);
  const dst = ctx.window.locator(`[data-layer-row="${first}"]`);
  const dstBox = await dst.boundingBox();
  const dt = await ctx.window.evaluateHandle(() => new DataTransfer());
  await src.dispatchEvent("dragstart", { dataTransfer: dt });
  for (let i = 0; i < 2; i += 1) {
    await dst.dispatchEvent("dragover", { dataTransfer: dt, clientX: dstBox.x + 30, clientY: dstBox.y + dstBox.height - 3 });
    await ctx.window.waitForTimeout(40);
  }
  await dst.dispatchEvent("drop", { dataTransfer: dt, clientX: dstBox.x + 30, clientY: dstBox.y + dstBox.height - 3 });
  await src.dispatchEvent("dragend", { dataTransfer: dt });
  await expect.poll(async () => (await state()).layers.map((l) => l.id)).toEqual([second, first]);

  const row = ctx.window.locator(`[data-layer-row="${second}"]`);
  await row.hover();
  await row.getByTitle("Delete layer", { exact: true }).click();
  await expect.poll(async () => (await state()).layers.map((l) => l.id)).toEqual([first]);
});

test("shift-click builds a multi-selection and the align bar centres it", async () => {
  const first = await ensureLayer();
  const second = await addLayer("Charlie");
  const a = await pageCentre(first);
  await ctx.window.mouse.click(a.x, a.y);
  // page.mouse.click has no modifiers option — hold Shift on the keyboard.
  const b = await pageCentre(second);
  await ctx.window.keyboard.down("Shift");
  await ctx.window.mouse.click(b.x, b.y);
  await ctx.window.keyboard.up("Shift");
  await expect.poll(async () => (await state()).selectedIds.length).toBe(2);
  await expect(ctx.window.getByTitle("Center H", { exact: true })).toBeVisible();
  await ctx.window.getByTitle("Center H", { exact: true }).click();
  await expect.poll(async () => {
    const s = await state();
    const xs = s.layers.filter((l) => [first, second].includes(l.id)).map((l) => l.x);
    return Math.abs(xs[0] - xs[1]);
  }).toBeLessThan(0.001);
  await ctx.window.evaluate((id) => window.__afterframeTest.deleteLayer(id), second);
  await expect.poll(async () => (await state()).layers.length).toBe(1);
});

test("the font dropdown filters and applies with Enter", async () => {
  const layer = { id: await ensureLayer() };
  await ctx.window.getByTestId("font-select").click();
  const search = ctx.window.getByPlaceholder("Search fonts…");
  await expect(search).toBeVisible();
  // Bundled families are always listed; the query must match exactly one
  // (system fonts join the list — "Space" alone also hits "…Monospace"),
  // because ArrowDown steps to the entry AFTER the current one.
  await search.fill("Space Mono");
  await search.press("ArrowDown"); // arrow keys preview the highlighted family live
  await search.press("Enter"); // Enter commits the highlighted one and closes
  await expect.poll(async () => (await layerById(layer.id)).fontFamily).toBe("Space Mono");
  await expect(search).toHaveCount(0);
});

test("stroke and shadow switches enable their fields; typed values apply", async () => {
  const layer = { id: await ensureLayer() };
  const stroke = ctx.window.locator('[data-editor-section="Stroke"]');
  await stroke.locator("button").first().click(); // the Switch
  await expect.poll(async () => (await layerById(layer.id)).strokeEnabled).toBe(true);
  const width = stroke.locator('input[type="number"]').first();
  await width.fill("6");
  await width.press("Enter");
  await expect.poll(async () => (await layerById(layer.id)).strokeWidth).toBe(6);

  const shadow = ctx.window.locator('[data-editor-section="Shadow"]');
  await shadow.locator("button").first().click();
  await expect.poll(async () => (await layerById(layer.id)).shadow).toBe(true);
  const x = shadow.locator('input[type="number"]').first();
  await x.fill("12");
  await x.press("Enter");
  await expect.poll(async () => (await layerById(layer.id)).shadowX).toBe(12);
});
