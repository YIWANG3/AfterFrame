// People recognition end to end with the face model the app ships
// (native/FaceEmbedding.mlpackage): real photos → the bundled Core ML model →
// person groups → the People UI → a name → the person's photos → a restart.
// 12-people-view runs with a stub model and 18-people-flows on embeddings
// baked into a fixture, so neither ever ran a scan; the 0.5.8 report did it
// by hand on real portraits.
//
// The photos are fixtures/people-images (AI-generated fictional people: Lin
// Xi alone four times, Chen Mo three, both on a rooftop). Needs the model
// fetched (npm run fetch:people-model) and macOS 14+; skips without it, which
// is the PR CI VM.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, collectCoverage } = require("./helpers/app");

const MODEL = path.resolve(__dirname, "..", "native", "FaceEmbedding.mlpackage", "Manifest.json");
const PEOPLE_IMAGES = path.resolve(__dirname, "fixtures", "people-images");

test.describe("people recognition with the bundled face model", () => {
  test.skip(process.platform !== "darwin" || !fs.existsSync(MODEL), "needs the bundled face model (npm run fetch:people-model) on macOS");
  test.describe.configure({ mode: "serial" });

  let ctx, dir;
  const groups = {}; // who → { id, photos }
  const cards = () => ctx.window.locator("[data-gallery-item='true']");
  const nameOf = (file) => path.basename(file);
  const openPeople = async () => {
    await ctx.window.getByRole("navigation").getByRole("button", { name: "People" }).click();
    await expect(ctx.window.getByRole("heading", { name: "People" })).toBeVisible();
  };
  const photosOf = (groupId) => ctx.window.evaluate(
    (id) => window.mediaWorkspace.browseImages({ status: "all", limit: 500, filters: { person_group: id } })
      .then((rows) => rows.map((row) => row.image_path)),
    groupId,
  );

  test.beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-people-")));
    for (const name of fs.readdirSync(PEOPLE_IMAGES)) fs.copyFileSync(path.join(PEOPLE_IMAGES, name), path.join(dir, name));
    ctx = await launchApp({ testName: "people-real", peopleModel: "real" });
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await ctx.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
    }, [dir]);
    await ctx.window.locator(".app-toolbar button").first().click();
    await ctx.window.getByRole("button", { name: "Import", exact: true }).click();
    await expect(ctx.window.locator(`[data-gallery-item='true'][data-image-path='${path.join(dir, "group_rooftop.jpg")}']`))
      .toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), { timeout: 60_000 }).toBe(false);
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("Scan faces runs the model and groups each person's photos, and only theirs", async () => {
    test.setTimeout(240_000);
    await openPeople();
    await ctx.window.getByRole("button", { name: "Scan faces" }).first().click();
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus().then((s) => s?.status)), {
      timeout: 180_000, intervals: [1_000],
    }).toBe("succeeded");
    const status = await ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus());
    expect(status.error || null).toBeNull();

    const listed = await ctx.window.evaluate(() => window.mediaWorkspace.listPeopleGroups());
    for (const group of listed) {
      const photos = (await photosOf(group.group_id)).map(nameOf);
      for (const who of ["linxi", "chenmo"]) {
        const own = photos.filter((name) => name.startsWith(`${who}_`));
        if (own.length >= 2) {
          expect(groups[who], `${who} split over two groups`).toBeUndefined();
          // Nobody else's photo in it: the rooftop shot has both of them.
          expect(photos.filter((name) => !name.startsWith(`${who}_`) && name !== "group_rooftop.jpg")).toEqual([]);
          groups[who] = { id: group.group_id, photos };
        }
      }
    }
    expect(groups.linxi?.photos.filter((name) => name.startsWith("linxi_")).length).toBeGreaterThanOrEqual(3);
    expect(groups.chenmo?.photos.filter((name) => name.startsWith("chenmo_")).length).toBeGreaterThanOrEqual(2);
    expect(groups.linxi.id).not.toBe(groups.chenmo.id);

    // Both are on the wall, with a face crop that decodes.
    await ctx.window.getByRole("button", { name: "Refresh" }).first().click();
    for (const who of ["linxi", "chenmo"]) {
      const tile = ctx.window.locator(`[data-person-group="${groups[who].id}"]`);
      await expect(tile).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => tile.locator("img").first().evaluate((img) => img.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
    }
  });

  test("a Chinese name sticks, and the person's photos are exactly their group", async () => {
    const tile = ctx.window.locator(`[data-person-group="${groups.linxi.id}"]`);
    await tile.getByRole("button", { name: "Add name", exact: true }).click();
    const popover = ctx.window.locator("div.fixed").filter({ has: ctx.window.getByPlaceholder("Type a name…") });
    await popover.getByPlaceholder("Type a name…").fill("林夕");
    await popover.getByRole("button", { name: "Name", exact: true }).click();
    await expect(tile.getByRole("button", { name: "林夕", exact: true })).toBeVisible();

    await ctx.window.getByRole("button", { name: "Open 林夕 in the library" }).click();
    await ctx.window.getByRole("button", { name: "View photos" }).click();
    await expect(cards()).toHaveCount(groups.linxi.photos.length, { timeout: 10_000 });
    const shown = await cards().evaluateAll((els) => els.map((el) => el.dataset.imagePath.split("/").pop()));
    expect(shown.sort()).toEqual([...groups.linxi.photos].sort());
  });

  test("after a restart the person, the name and the photos are still there", async () => {
    await collectCoverage(ctx.app);
    await ctx.app.close();
    ctx = { ...ctx, ...(await launchApp({ testName: "people-real", peopleModel: "real", reuseUserDataDir: ctx.userDataDir, keepCatalog: true })) };
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await openPeople();
    const tile = ctx.window.locator(`[data-person-group="${groups.linxi.id}"]`);
    await expect(tile.getByRole("button", { name: "林夕", exact: true })).toBeVisible({ timeout: 10_000 });
    expect((await photosOf(groups.linxi.id)).map(nameOf).sort()).toEqual([...groups.linxi.photos].sort());
    expect((await photosOf(groups.chenmo.id)).map(nameOf).sort()).toEqual([...groups.chenmo.photos].sort());
  });
});
