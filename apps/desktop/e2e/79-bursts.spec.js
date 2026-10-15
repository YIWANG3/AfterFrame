// Bursts: frames one camera shot within two seconds of each other, of one
// scene, are grouped by the look-alike index (sidecar db/visual.py). In the
// grid a burst folds into its first frame with a count badge; the badge
// opens and folds the stack. The catalog (fixtures/seed-bursts.py) adds
// three such frames of a real photo and a fourth of the same scene a minute
// later, which stays a photo of its own.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp, callToolOk, waitForMcp, galleryCards } = require("./helpers/app");
const { devPython } = require("../electron/sidecar/transport");

const FRAMES = ["burst-frame-1", "burst-frame-2", "burst-frame-3"];

test.describe.configure({ mode: "serial" });

test.describe("Bursts", () => {
  let app, window, userDataDir, mcpPort;
  test.beforeAll(async () => {
    ({ app, window, userDataDir, mcpPort } = await launchApp({
      testName: "bursts",
      prepareCatalog(catalogDir) {
        execFileSync(devPython(process.platform), [path.join(__dirname, "fixtures/seed-bursts.py"), catalogDir]);
      },
    }));
    await waitForMcp(mcpPort);
  });
  test.afterAll(async () => closeApp(app, userDataDir));

  const card = (id) => window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  const badge = (id) => card(id).locator("[data-burst-badge]");

  test("the frames fold into one card with the count, the later frame stays its own photo", async () => {
    // Sorted by capture time the frames sit together; the catch-up job runs
    // at launch, and the grid re-browses when it ends.
    await window.getByRole("button", { name: /^(Imported|Captured|Added|Name|Rating)/ }).first().click();
    await window.getByRole("button", { name: "Captured ↑", exact: true }).click();
    await expect(badge("burst-frame-1")).toHaveText("3", { timeout: 30000 });
    await expect(badge("burst-frame-1")).toHaveAttribute("data-burst-badge", "collapsed");
    await expect(card("burst-frame-2")).toHaveCount(0);
    await expect(card("burst-frame-3")).toHaveCount(0);
    await expect(card("burst-later")).toBeVisible();
    await expect(card("burst-later").locator("[data-burst-badge]")).toHaveCount(0);
  });

  test("the badge opens the stack and folds it again; the frames select like any photo", async () => {
    await badge("burst-frame-1").click();
    for (const id of FRAMES) await expect(card(id)).toHaveAttribute("data-burst", "expanded");
    await card("burst-frame-2").click();
    await expect(window.getByTestId("inspector-asset-title")).toHaveText("burst-frame-2.jpg");
    await expect(card("burst-frame-1")).toHaveAttribute("data-selected", "false");
    await badge("burst-frame-3").click();
    await expect(card("burst-frame-2")).toHaveCount(0);
    await expect(badge("burst-frame-1")).toHaveAttribute("data-burst-badge", "collapsed");
  });

  test("MCP search_assets reports the burst on each frame", async () => {
    const result = await callToolOk(mcpPort, "search_assets", { query: "burst-frame", limit: 10 });
    const frames = result.assets.filter((asset) => FRAMES.includes(asset.asset_id));
    expect(frames).toHaveLength(3);
    expect(new Set(frames.map((asset) => asset.burst_group)).size).toBe(1);
    expect(frames.every((asset) => asset.burst_size === 3)).toBe(true);
    const later = await callToolOk(mcpPort, "search_assets", { query: "burst-later", limit: 2 });
    expect(later.assets[0].burst_group).toBeUndefined();
    const cards = await galleryCards(window).count();
    expect(cards).toBeGreaterThan(0);
  });
});
