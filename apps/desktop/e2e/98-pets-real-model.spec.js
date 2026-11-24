// Pet recognition end to end with the models the app ships
// (native/PetEmbedding.mlpackage beside native/FaceEmbedding.mlpackage): real
// photos → the people-worker finds each animal and embeds it → the people
// job groups each species apart → the People & Pets wall → a name → her
// photos and the Inspector. 97-pets runs on groups written into the catalog,
// so it never runs the worker or the model.
//
// The photos are fixtures/pet-images (fixtures/pet-images/SOURCES.md): Mimi,
// a ragdoll cat, four times; Larry, another cat, once; Bo, a dog, twice.
// Needs both models fetched (npm run fetch:models) and macOS 14+; skips
// without them, which is the PR CI VM.

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, galleryCards } = require("./helpers/app");

const NATIVE = path.resolve(__dirname, "..", "native");
const MODELS = ["FaceEmbedding.mlpackage", "PetEmbedding.mlpackage"].map((name) => path.join(NATIVE, name, "Manifest.json"));
const PET_IMAGES = path.resolve(__dirname, "fixtures", "pet-images");

test.describe("pet recognition with the bundled pet model", () => {
  test.skip(process.platform !== "darwin" || !MODELS.every((model) => fs.existsSync(model)), "needs the bundled face and pet models (npm run fetch:models) on macOS");
  test.describe.configure({ mode: "serial" });

  let ctx, dir;
  const groups = {}; // mimi / bo → { id, photos }
  const cards = () => galleryCards(ctx.window);
  const photosOf = (groupId) => ctx.window.evaluate(
    (id) => window.mediaWorkspace.browseImages({ status: "all", limit: 500, filters: { person_group: id } })
      .then((rows) => rows.map((row) => row.image_path.split("/").pop())),
    groupId,
  );

  test.beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-pets-")));
    for (const name of fs.readdirSync(PET_IMAGES).filter((name) => name.endsWith(".jpg"))) {
      fs.copyFileSync(path.join(PET_IMAGES, name), path.join(dir, name));
    }
    ctx = await launchApp({ testName: "pets-real", peopleModel: "real", petModel: "real" });
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await ctx.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
    }, [dir]);
    await ctx.window.locator(".app-toolbar button").first().click();
    await ctx.window.getByRole("button", { name: "Import", exact: true }).click();
    await expect(ctx.window.locator(`[data-gallery-item='true'][data-image-path='${path.join(dir, "mimi_01.jpg")}']`))
      .toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), { timeout: 60_000 }).toBe(false);
    // Pets are off by default (Settings → People & Pets → Recognize pets).
    await ctx.window.evaluate(() => window.mediaWorkspace.setPetsEnabled(true));
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("Scan finds the cats and the dog, groups Mimi and Bo each by species, and keeps Larry apart", async () => {
    test.setTimeout(240_000);
    await ctx.window.getByRole("navigation").getByRole("button", { name: "People & Pets", exact: true }).click();
    await expect(ctx.window.getByRole("heading", { name: "People & Pets", exact: true })).toBeVisible();
    await ctx.window.getByRole("button", { name: "Scan", exact: true }).first().click();
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus().then((s) => s?.status)), {
      timeout: 180_000, intervals: [1_000],
    }).toBe("succeeded");
    const status = await ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus());
    expect(status.error || null).toBeNull();
    expect(status.result.pets).toBe(7);

    const listed = await ctx.window.evaluate(() => window.mediaWorkspace.listPeopleGroups());
    for (const group of listed) {
      const photos = await photosOf(group.group_id);
      for (const [who, subject] of [["mimi", "cat"], ["bo", "dog"]]) {
        if (!photos.some((name) => name.startsWith(`${who}_`))) continue;
        expect(groups[who], `${who} split over two groups`).toBeUndefined();
        expect(group.subject).toBe(subject);
        groups[who] = { id: group.group_id, photos };
      }
      // Larry is another cat: never in anyone's group.
      if (photos.includes("larry_01.jpg")) expect(photos).toEqual(["larry_01.jpg"]);
    }
    expect(groups.mimi?.photos.sort()).toEqual(["mimi_01.jpg", "mimi_02.jpg", "mimi_03.jpg", "mimi_04.jpg"]);
    expect(groups.bo?.photos.sort()).toEqual(["bo_01.jpg", "bo_02.jpg"]);

    // Both on the wall with a paw and a cover that decodes; this run had pets
    // on, so there is nothing to offer.
    await ctx.window.getByRole("button", { name: "Refresh" }).first().click();
    for (const who of ["mimi", "bo"]) {
      const tile = ctx.window.locator(`[data-person-group="${groups[who].id}"]`);
      await expect(tile).toBeVisible({ timeout: 10_000 });
      await expect(tile.getByTestId("pet-badge")).toHaveCount(1);
      await expect.poll(() => tile.locator("img").first().evaluate((img) => img.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
    }
    await expect(ctx.window.locator(`[data-person-group="${groups.mimi.id}"]`)).toContainText("4 photos");
    await expect(ctx.window.getByTestId("pets-prompt")).toHaveCount(0);
  });

  test("named Mimi opens exactly her photos, and the Inspector lists her as a cat", async () => {
    const tile = ctx.window.locator(`[data-person-group="${groups.mimi.id}"]`);
    await tile.getByRole("button", { name: "Add name", exact: true }).click();
    const popover = ctx.window.locator("div.fixed").filter({ has: ctx.window.getByPlaceholder("Type a name…") });
    await popover.getByPlaceholder("Type a name…").fill("Mimi");
    await popover.getByRole("button", { name: "Name", exact: true }).click();
    await expect(tile.getByRole("button", { name: "Mimi", exact: true })).toBeVisible();

    await ctx.window.getByRole("button", { name: "Open Mimi in the library" }).click();
    await ctx.window.getByRole("button", { name: "View photos" }).click();
    await expect(cards()).toHaveCount(4, { timeout: 10_000 });
    const shown = await cards().evaluateAll((els) => els.map((el) => el.dataset.imagePath.split("/").pop()));
    expect(shown.sort()).toEqual(groups.mimi.photos);

    await cards().first().click();
    const row = ctx.window.getByRole("button", { name: "Mimi Cat" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("inspector-pet-species")).toHaveText("Cat");
  });
});
