// "Show in All Assets" (gallery context menu): a photo found by a search, or
// in a narrower view, is shown among its neighbours in the whole library, in
// the toolbar's current order. Sorted by capture time, the photos taken at
// the same moment are around it — which is what the search alone can't show.
//
// The catalog (fixtures/seed-show-in-all-assets.py) adds 100 bursts of 4
// photos; each burst shares one capture time and the names are scattered, so
// name order is not capture order. The targets sit past the first page.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp } = require("./helpers/app");
const { devPython } = require("../electron/sidecar/transport");

const SHOTS = 4;
const stemOf = (burst, shot) => `DSC_${String((burst * SHOTS + shot) * 7919 % 400).padStart(4, "0")}`;
const burstIds = (burst) => Array.from({ length: SHOTS }, (_, shot) => `burst-${String(burst).padStart(3, "0")}-${shot}`);
// Within a burst (one capture time) the gallery orders by name.
const burstInOrder = (burst) => burstIds(burst)
  .map((id, shot) => ({ id, stem: stemOf(burst, shot) }))
  .sort((a, b) => a.stem.localeCompare(b.stem));

test.describe("Show in All Assets", () => {
  let app, window, userDataDir;
  test.beforeAll(async () => {
    ({ app, window, userDataDir } = await launchApp({
      testName: "show-in-all-assets",
      prepareCatalog(catalogDir) {
        execFileSync(devPython(process.platform), [path.join(__dirname, "fixtures/seed-show-in-all-assets.py"), catalogDir]);
      },
    }));
  });
  test.afterAll(async () => closeApp(app, userDataDir));

  const card = (id) => window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  const search = () => window.getByPlaceholder("Search", { exact: true });
  const menuItem = () => window.getByRole("button", { name: "Show in All Assets", exact: true });
  const sortButton = () => window.getByRole("button", { name: /^(Imported|Captured|Added|Name|Rating)/ }).first();

  // The target and the photos taken with it, plus the photo just before and
  // just after the burst, are on screen and the target is selected. No
  // click or scrollIntoView here: the app must scroll to it itself.
  async function expectAmongNeighbours(burst, targetId) {
    await expect(window.getByTestId("inspector-asset-title")).toHaveText(`${burstInOrder(burst).find((s) => s.id === targetId).stem}.jpg`);
    await expect(card(targetId)).toBeInViewport({ timeout: 15000 });
    await expect(card(targetId)).toHaveAttribute("data-selected", "true");
    for (const id of burstIds(burst)) await expect(card(id), id).toBeInViewport();
    await expect(card(burstInOrder(burst - 1).at(-1).id)).toBeInViewport();
    await expect(card(burstInOrder(burst + 1)[0].id)).toBeInViewport();
    await expect(window.locator("[data-gallery-item='true'][data-selected='true']")).toHaveCount(1);
  }

  test("from a search, keeps the capture-time order and shows the burst around the photo", async () => {
    await sortButton().click();
    await window.getByRole("button", { name: "Captured ↑", exact: true }).click();
    await expect(sortButton()).toHaveText("Captured ↑");

    // Nothing narrows All Assets, so there is nothing to show it in.
    const first = window.locator("[data-gallery-item='true']").first();
    await expect(first).toBeVisible();
    await first.click({ button: "right" });
    await expect(window.getByRole("button", { name: "Copy Name", exact: true })).toBeVisible();
    await expect(menuItem()).toHaveCount(0);
    await window.keyboard.press("Escape");

    const target = "burst-080-1";
    await search().fill(stemOf(80, 1));
    await expect(window.locator("[data-gallery-item='true']")).toHaveCount(1);
    await card(target).click({ button: "right" });
    await menuItem().click();

    await expectAmongNeighbours(80, target);
    await expect(search()).toHaveValue("");
    await expect(sortButton()).toHaveText("Captured ↑");
    await expect(window.getByTestId("gallery-title")).toHaveText("All Assets");
    // Scrolled down to it, past the first page.
    await expect(card("image_043092868eca02056a532a60")).not.toBeInViewport();

    // The grid is the library now: arrow keys walk the burst.
    const order = burstInOrder(80).map((s) => s.id);
    const next = order[order.indexOf(target) + 1] ?? burstInOrder(81)[0].id;
    await window.keyboard.press("ArrowRight");
    await expect(card(next)).toHaveAttribute("data-selected", "true");
  });

  test("from another view, goes to All Assets", async () => {
    await window.getByRole("button", { name: /^Rated/ }).first().click();
    await expect(window.getByTestId("gallery-title")).toHaveText("Rated");
    const target = "burst-060-2";
    await expect(card(target)).toBeVisible();
    await card(target).click({ button: "right" });
    await menuItem().click();

    await expect(window.getByTestId("gallery-title")).toHaveText("All Assets");
    await expectAmongNeighbours(60, target);
    await expect(sortButton()).toHaveText("Captured ↑");
  });
});
