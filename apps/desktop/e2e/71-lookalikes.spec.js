// Look-alikes: photos that look the same (another export, a re-encode, a
// crop) are grouped by the visual index — a perceptual hash of every 512 px
// preview and, on a Mac, Apple Vision's feature print. The catalog
// (fixtures/seed-lookalikes.py) adds a smaller, lower-quality copy of one
// real photo; at launch the catch-up job hashes the library and the two
// land in one group: the sidebar's Look-alikes, the gallery's Find Similar,
// the Inspector's Similar strip and the MCP tools all show it.

const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { launchApp, closeApp, callToolOk, waitForMcp, galleryCards } = require("./helpers/app");
const { devPython } = require("../electron/sidecar/transport");

const ORIGINAL = "image_1f9dab80c352819829ab31a8";
const COPY = "image_lookalike_copy";

test.describe.configure({ mode: "serial" });

test.describe("Look-alikes", () => {
  let app, window, userDataDir, mcpPort;
  test.beforeAll(async () => {
    ({ app, window, userDataDir, mcpPort } = await launchApp({
      testName: "lookalikes",
      prepareCatalog(catalogDir) {
        execFileSync(devPython(process.platform), [path.join(__dirname, "fixtures/seed-lookalikes.py"), catalogDir]);
      },
    }));
    await waitForMcp(mcpPort);
  });
  test.afterAll(async () => closeApp(app, userDataDir));

  const card = (id) => window.locator(`[data-gallery-item='true'][data-asset-id='${id}']`);
  const title = () => window.getByTestId("gallery-title");

  test("the catch-up job groups the copy with its original and the sidebar lists them", async () => {
    // The entry appears once the job has run and the summary was re-read.
    const entry = window.getByRole("button", { name: /^Look-alikes/ });
    await expect(entry).toBeVisible({ timeout: 30000 });
    await expect(entry).toContainText("2");
    await entry.click();
    await expect(title()).toHaveText("Look-alikes");
    await expect(galleryCards(window)).toHaveCount(2);
    await expect(card(ORIGINAL)).toBeVisible();
    await expect(card(COPY)).toBeVisible();
  });

  test("Find Similar shows the photo first, then the ones that look like it", async () => {
    await window.getByRole("button", { name: /^All Assets/ }).click();
    await expect(title()).toHaveText("All Assets");
    await card(ORIGINAL).click({ button: "right" });
    await window.getByRole("button", { name: "Find Similar", exact: true }).click();
    await expect(title()).toHaveText("Similar Photos");
    await expect(card(COPY)).toBeVisible();
    const ids = await galleryCards(window).evaluateAll((cards) => cards.map((c) => c.dataset.assetId));
    expect(ids[0]).toBe(ORIGINAL);
    expect(ids[1]).toBe(COPY);
    expect(ids.length).toBeGreaterThan(2);
    // The Inspector shows the open photo's look-alikes too.
    await expect(card(ORIGINAL)).toHaveAttribute("data-selected", "true");
    await expect(window.getByTestId("inspector-similar")).toBeVisible();
    await expect(window.locator("[data-testid='similar-asset']").first()).toHaveAttribute("data-similar-asset-id", COPY);
    // Show in All Assets is offered: this is a narrower view.
    await card(COPY).click({ button: "right" });
    await expect(window.getByRole("button", { name: "Show in All Assets", exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
  });

  test("MCP: find_similar, list_lookalikes and search_assets similar_to see the same group", async () => {
    const similar = await callToolOk(mcpPort, "find_similar", { asset_id: ORIGINAL, limit: 3 });
    expect(similar.similar[0].asset_id).toBe(COPY);
    expect(similar.similar[0].hamming).toBeLessThanOrEqual(8);
    expect(similar.similar[0].thumbnail_url).toContain(`/assets/${COPY}`);

    const groups = await callToolOk(mcpPort, "list_lookalikes", {});
    expect(groups.group_count).toBe(1);
    expect(groups.groups[0].asset_ids.sort()).toEqual([ORIGINAL, COPY].sort());

    const view = await callToolOk(mcpPort, "search_assets", { similar_to: ORIGINAL, limit: 2 });
    expect(view.assets.map((a) => a.asset_id)).toEqual([ORIGINAL, COPY]);

    const idle = await callToolOk(mcpPort, "index_lookalikes", {});
    expect(idle.job_id).toBeNull();
  });
});
