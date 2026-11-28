// People recognition end to end with the face model the app ships
// (native/FaceEmbedding.mlpackage): real photos → the bundled Core ML model →
// person groups → the People UI → a name → the person's photos → a restart.
// 71-people-view runs with a stub model and 72-people-flows on embeddings
// baked into a fixture, so neither ever ran a scan; the 0.5.8 report did it
// by hand on real portraits.
//
// The photos are fixtures/people-images (AI-generated fictional people: Lin
// Xi alone four times, Chen Mo three, both on a rooftop). Needs the model
// fetched (npm run fetch:models) and macOS 14+; skips without it, which
// is the PR CI VM.
//
// The model has to be compiled before it loads. Each worker used to compile
// it into the temporary directory and leave the copy there, 125 MB a worker
// and three workers a scan; now the first compiles it into the app's folder
// and every later one loads that.

const { test, expect } = require("@playwright/test");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp, closeApp, collectCoverage, galleryCards } = require("./helpers/app");

const MODEL = path.resolve(__dirname, "..", "native", "FaceEmbedding.mlpackage", "Manifest.json");
const PET_MODEL = path.resolve(__dirname, "..", "native", "PetEmbedding.mlpackage", "Manifest.json");
const PEOPLE_IMAGES = path.resolve(__dirname, "fixtures", "people-images");
const WORKER = path.resolve(__dirname, "..", "native", "bin", "people-worker");

// Core ML compiles into the per-user temporary directory, whatever TMPDIR
// says. Another app compiling a model meanwhile would show up here too.
const USER_TEMP_DIR = process.platform === "darwin"
  ? execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim()
  : os.tmpdir();
const compiledInTemp = () => fs.readdirSync(USER_TEMP_DIR).filter((name) => /Embedding_.*\.mlmodelc$/.test(name));
// Several workers at once, wherever this runs: they share one compile.
const WORKERS_ENV = { PEOPLE_WORKERS: "3" };

test.describe("people recognition with the bundled face model", () => {
  test.skip(process.platform !== "darwin" || !fs.existsSync(MODEL), "needs the bundled face model (npm run fetch:models) on macOS");
  test.describe.configure({ mode: "serial" });

  let ctx, dir, tempBefore, faceCopy;
  const groups = {}; // who → { id, photos }
  const compiledDir = () => path.join(ctx.userDataDir, "people-compiled-models");
  const compiledCopies = () => fs.readdirSync(compiledDir()).filter((name) => /^[0-9a-f]{40}\.mlmodelc$/.test(name));
  const newInTemp = () => compiledInTemp().filter((name) => !tempBefore.has(name));
  const cards = () => galleryCards(ctx.window);
  const nameOf = (file) => path.basename(file);
  const openPeople = async () => {
    await ctx.window.getByRole("navigation").getByRole("button", { name: "People & Pets", exact: true }).click();
    await expect(ctx.window.getByRole("heading", { name: "People & Pets", exact: true })).toBeVisible();
  };
  const photosOf = (groupId) => ctx.window.evaluate(
    (id) => window.mediaWorkspace.browseImages({ status: "all", limit: 500, filters: { person_group: id } })
      .then((rows) => rows.map((row) => row.image_path)),
    groupId,
  );

  test.beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-people-")));
    for (const name of fs.readdirSync(PEOPLE_IMAGES)) fs.copyFileSync(path.join(PEOPLE_IMAGES, name), path.join(dir, name));
    tempBefore = new Set(compiledInTemp());
    ctx = await launchApp({ testName: "people-real", peopleModel: "real", env: WORKERS_ENV });
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

  test("Scan runs the model and groups each person's photos, and only theirs", async () => {
    test.setTimeout(240_000);
    await openPeople();
    await ctx.window.getByRole("button", { name: "Scan", exact: true }).first().click();
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus().then((s) => s?.status)), {
      timeout: 180_000, intervals: [1_000],
    }).toBe("succeeded");
    const status = await ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus());
    expect(status.error || null).toBeNull();

    // The workers compiled the model once, into the app's folder: one copy,
    // its lock, no staging copy, and nothing left in the temporary directory.
    expect(newInTemp()).toEqual([]);
    const [copy, ...others] = compiledCopies();
    expect(others).toEqual([]);
    expect(fs.readdirSync(compiledDir()).sort()).toEqual([`.${copy}.lock`, copy].sort());
    faceCopy = { name: copy, ino: fs.statSync(path.join(compiledDir(), copy)).ino };

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
    ctx = { ...ctx, ...(await launchApp({ testName: "people-real", peopleModel: "real", reuseUserDataDir: ctx.userDataDir, keepCatalog: true, env: WORKERS_ENV })) };
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await openPeople();
    const tile = ctx.window.locator(`[data-person-group="${groups.linxi.id}"]`);
    await expect(tile.getByRole("button", { name: "林夕", exact: true })).toBeVisible({ timeout: 10_000 });
    expect((await photosOf(groups.linxi.id)).map(nameOf).sort()).toEqual([...groups.linxi.photos].sort());
    expect((await photosOf(groups.chenmo.id)).map(nameOf).sort()).toEqual([...groups.chenmo.photos].sort());
  });

  test("turning on pets later doesn't redo the faces, even when the photos no longer decode to the hashes on record", async () => {
    test.skip(!fs.existsSync(PET_MODEL), "needs the bundled pet model too");
    test.setTimeout(240_000);
    await collectCoverage(ctx.app);
    await ctx.app.close();
    // A macOS update can change how an untouched photo decodes: its pixel
    // hash no longer matches the one on record. The first pets scan used to
    // re-detect every such face, and a re-detected face left its person.
    execFileSync("sqlite3", ["-cmd", ".timeout 10000", path.join(ctx.catalogDir, "catalog.sqlite3"),
      "UPDATE people_asset_index SET input_hash = 'decoded-by-another-macos-' || asset_id;"]);
    ctx = { ...ctx, ...(await launchApp({ testName: "people-real", peopleModel: "real", petModel: "real", reuseUserDataDir: ctx.userDataDir, keepCatalog: true, env: WORKERS_ENV })) };
    await expect(cards().first()).toBeVisible({ timeout: 15_000 });
    await ctx.window.evaluate(() => window.mediaWorkspace.setPetsEnabled(true));
    const before = await ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus().then((s) => s?.jobId));
    await openPeople();
    await ctx.window.getByRole("button", { name: "Scan", exact: true }).first().click();
    await expect.poll(() => ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus()), {
      timeout: 180_000, intervals: [1_000],
    }).toMatchObject({ status: "succeeded", jobId: expect.not.stringMatching(`^${before}$`) });
    const status = await ctx.window.evaluate(() => window.mediaWorkspace.getPeopleIndexStatus());
    expect(status.result.faces).toBe(0);

    // The second scan's workers loaded the face model the first one compiled
    // (the very same copy) and compiled the pet model beside it.
    expect(newInTemp()).toEqual([]);
    expect(fs.statSync(path.join(compiledDir(), faceCopy.name)).ino).toBe(faceCopy.ino);
    expect(compiledCopies()).toHaveLength(2);

    const tile = ctx.window.locator(`[data-person-group="${groups.linxi.id}"]`);
    await expect(tile.getByRole("button", { name: "林夕", exact: true })).toBeVisible({ timeout: 10_000 });
    expect((await photosOf(groups.linxi.id)).map(nameOf).sort()).toEqual([...groups.linxi.photos].sort());
    // Chen Mo is still a candidate, rebuilt under a new id by every scan.
    const candidates = await ctx.window.evaluate(() => window.mediaWorkspace.listPeopleGroups());
    const grouped = await Promise.all(candidates.map(async (group) => (await photosOf(group.group_id)).map(nameOf).sort()));
    expect(grouped).toContainEqual([...groups.chenmo.photos].sort());
  });
});

test.describe("people-worker and the compiled model", () => {
  test.skip(process.platform !== "darwin" || !fs.existsSync(MODEL) || !fs.existsSync(WORKER), "needs the bundled face model and the built people-worker on macOS");

  let dir;
  test.afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (args) => new Promise((resolve) => {
    execFile(WORKER, args, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const passed = (result) => result.code === 0 && JSON.parse(result.stdout).embedding_dimensions === 512;
  const compiles = (results) => results.filter((result) => result.stderr.includes("compiled FaceEmbedding.mlpackage")).length;

  test("three workers starting together compile it once, a later one not at all, and none leaves a copy in the temporary directory", async () => {
    test.setTimeout(180_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-compiled-"));
    const tempBefore = new Set(compiledInTemp());
    const compiled = path.join(dir, "cache", "face.mlmodelc");
    const selfTest = () => run(["--model", path.dirname(MODEL), "--compiled-model", compiled, "--self-test"]);

    const together = await Promise.all([selfTest(), selfTest(), selfTest()]);
    expect(together.map(passed)).toEqual([true, true, true]);
    expect(compiles(together)).toBe(1);
    expect(fs.readdirSync(path.dirname(compiled)).sort()).toEqual([".face.mlmodelc.lock", "face.mlmodelc"]);

    const later = await selfTest();
    expect(passed(later)).toBe(true);
    expect(compiles([later])).toBe(0);

    // With nowhere to keep it (a model check from Settings), the worker
    // removes its own copy when it exits.
    expect(passed(await run(["--model", path.dirname(MODEL), "--self-test"]))).toBe(true);

    expect(compiledInTemp().filter((name) => !tempBefore.has(name))).toEqual([]);
  });
});
