// The sidebar is the user's to arrange (docs/collections-and-folders-design.md):
// any entry but All Assets hides from its right-click menu, a section from
// its "⋯" too, and Settings › General › Sidebar shows them again. Each of the
// three sections has the same tools beside its heading (search, +, ⋯), and
// "Open in Manager" lands on that section's tab of the manager page, where
// Smart Collections, Collections and Folders are three tabs.
// One app launch, on the seeded catalog; the tests build on each other.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

test.describe("customizing the sidebar", () => {
  test.describe.configure({ mode: "serial" });
  let ctx;
  const w = () => ctx.window;
  const nav = () => w().locator("aside nav").first();
  const entryMenu = () => w().getByTestId("sidebar-entry-menu");
  const moreMenu = () => w().locator("[data-section-more-menu]");

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "sidebar-customize" });
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect(w().locator("[data-disk-folders] [data-disk-folder]").first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("an entry hides from its right-click menu, a section from its ⋯, and both stay hidden", async () => {
    await nav().getByRole("button", { name: "Discover", exact: true }).click({ button: "right" });
    await entryMenu().locator("[data-menu-item='hide']").click();
    await expect(nav().getByRole("button", { name: "Discover", exact: true })).toHaveCount(0);

    await w().getByTestId("sidebar-more-folders").click();
    await moreMenu().locator("[data-menu-item='hide']").click();
    await expect(w().locator("[data-disk-folders]")).toHaveCount(0);

    // All Assets has no menu: it can't be hidden.
    await nav().getByRole("button", { name: /^All Assets/ }).click({ button: "right" });
    await expect(entryMenu()).toHaveCount(0);

    await w().reload();
    await expect(galleryCards(w()).first()).toBeVisible({ timeout: 15_000 });
    await expect(nav().getByRole("button", { name: "Discover", exact: true })).toHaveCount(0);
    await expect(w().locator("[data-disk-folders]")).toHaveCount(0);
  });

  test("Customize Sidebar… opens Settings, where the switches show them again", async () => {
    await nav().getByRole("button", { name: "Tags", exact: true }).click({ button: "right" });
    await entryMenu().locator("[data-menu-item='customize']").click();
    const settings = w().getByTestId("sidebar-settings");
    await expect(settings).toBeVisible({ timeout: 10_000 });
    await expect(settings.locator("[data-sidebar-entry='all']")).toHaveCount(0);
    await expect(settings.locator("[data-sidebar-entry='discover'] [role='switch']")).toHaveAttribute("aria-checked", "false");
    await settings.locator("[data-sidebar-entry='discover'] [role='switch']").click();
    await settings.locator("[data-sidebar-entry='diskFolders'] [role='switch']").click();
    await expect(settings.locator("[data-sidebar-entry='diskFolders'] [role='switch']")).toHaveAttribute("aria-checked", "true");
    await w().keyboard.press("Escape");
    await expect(nav().getByRole("button", { name: "Discover", exact: true })).toBeVisible();
    await expect(w().locator("[data-disk-folders]")).toBeVisible();
  });

  test("the Folders section searches its tree", async () => {
    await w().locator("[data-sidebar-section-toggle='diskFolders']").locator("..").getByRole("button", { name: "Search folders" }).click();
    await w().getByTestId("disk-folder-search").fill("real");
    await expect(w().locator("[data-disk-folder]").filter({ hasText: "real-images" })).toBeVisible();
    await expect(w().locator("[data-disk-folder]").filter({ hasText: "test-images" })).toHaveCount(0);
    await w().getByTestId("disk-folder-search").press("Escape");
    await expect(w().getByTestId("disk-folder-search")).toHaveCount(0);
  });

  test("the smart section's + starts a new one in the filter bar", async () => {
    await w().locator("[data-smart-collections]").getByRole("button", { name: "New smart collection" }).click();
    await expect(w().locator("[data-filter-bar]")).toBeVisible();
    await expect(w().getByText("Set the conditions in the filter bar, then choose Save as smart collection.")).toBeVisible();
  });

  test("Open in Manager lands on that section's tab; the tabs switch between the three", async () => {
    await w().getByTestId("sidebar-more-folders").click();
    await moreMenu().locator("[data-menu-item='manage']").click();
    await expect(w().getByTestId("manager-tab-folders")).toHaveAttribute("aria-selected", "true");
    const realImages = w().locator("[data-manager-folder]").filter({ hasText: "real-images" });
    await expect(realImages).toBeVisible({ timeout: 10_000 });

    await w().getByTestId("manager-tab-smart").click();
    await expect(w().getByTestId("manager-smart")).toBeVisible();
    await expect(w().getByTestId("manager-smart")).toContainText("No smart collections yet");

    await w().getByTestId("manager-tab-collections").click();
    await expect(w().getByTestId("folders-new")).toBeVisible();

    // A folder card opens that folder in the gallery.
    await w().getByTestId("manager-tab-folders").click();
    await realImages.click();
    await expect(w().locator(".app-toolbar")).toContainText("real-images");
    await expect(galleryCards(w())).toHaveCount(3, { timeout: 15_000 });
  });
});
