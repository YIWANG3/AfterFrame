// Cats and dogs beside people (docs/pet-recognition-design.md): one wall
// renamed People & Pets, pet tiles with a paw and an All / People / Pets
// switch, a named pet opening its photos, corrections that never mix species,
// the Pets filter, the Inspector listing a photo's pet, the Recognize pets
// setting (off by default, with the built-in model ready), and the one-time
// prompt for a library analyzed before pets once pets are on.
//
// Groups come from the pet model in real use (sidecar tests cover the
// grouping); here they are written into the catalog once the app has
// upgraded it, so the spec needs no model.

const path = require("path");
const { execFileSync } = require("child_process");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, lacks, galleryCards } = require("./helpers/app");

test.skip(lacks("people"), "people and pet recognition are macOS-only for now (electron/capabilities.js)");

// Fixed asset ids of the seeded gradient photos.
const RED = "image_043092868eca02056a532a60";
const ORANGE = "image_6769ac07942cbb7a54186197";
const YELLOW = "image_fb9ba92d76611cf38f9ee5e8";
const GREEN = "image_e1fc5ae1a46b164b3c1aca60";
const TEAL = "image_bee90881397922cedde05ced";
const BLUE = "image_3463b48af7692633b36a49ca";

const LANDMARKS = "[0.3,0.3,0.4,0.3,0.35,0.4,0.31,0.5,0.39,0.5]";
const face = (id, asset, model, subject, landmarks) => `('${id}', '${asset}', '${model}', 'e2e', '[0.2,0.2,0.5,0.5]', '${landmarks}', 'standard', 0.9, x'00000000', '${subject}')`;

// Mochi, a named cat on red and orange; an unnamed dog on yellow and green;
// Ann, a person on teal and blue. And a people scan from before pets.
const SEED = `
INSERT INTO face_models (model_id, model_version, kind, manifest_hash) VALUES
  ('arcface-r100-coreml', 'e2e', 'arcface', 'f'), ('dinov2-small-coreml', 'e2e', 'pet', 'p');
INSERT INTO asset_faces (face_id, asset_id, model_id, model_version, bbox_json, landmarks_json, quality, detection_confidence, embedding_blob, subject) VALUES
  ${face("face_cat_1", RED, "dinov2-small-coreml", "cat", "[0.3,0.25,0.2,0.2]")},
  ${face("face_cat_2", ORANGE, "dinov2-small-coreml", "cat", "[]")},
  ${face("face_dog_1", YELLOW, "dinov2-small-coreml", "dog", "[]")},
  ${face("face_dog_2", GREEN, "dinov2-small-coreml", "dog", "[]")},
  ${face("face_ann_1", TEAL, "arcface-r100-coreml", "person", LANDMARKS)},
  ${face("face_ann_2", BLUE, "arcface-r100-coreml", "person", LANDMARKS)};
INSERT INTO person_groups (group_id, model_id, model_version, name, state, subject) VALUES
  ('person_mochi', 'dinov2-small-coreml', 'e2e', 'Mochi', 'confirmed', 'cat'),
  ('person_dog', 'dinov2-small-coreml', 'e2e', NULL, 'candidate', 'dog'),
  ('person_ann', 'arcface-r100-coreml', 'e2e', 'Ann', 'confirmed', 'person');
INSERT INTO person_group_faces (group_id, face_id) VALUES
  ('person_mochi', 'face_cat_1'), ('person_mochi', 'face_cat_2'),
  ('person_dog', 'face_dog_1'), ('person_dog', 'face_dog_2'),
  ('person_ann', 'face_ann_1'), ('person_ann', 'face_ann_2');
INSERT INTO jobs (job_id, job_type, status, result_json, progress) VALUES
  ('job_before_pets', 'people_index', 'succeeded', '{"processed": 13, "analyzed": 13, "faces": 2}', 1);
`;

let ctx;
let catalogDir;
const nav = () => ctx.window.getByRole("navigation").first();
const tiles = () => ctx.window.locator("[data-person-group]");

async function openWall() {
  await nav().getByRole("button", { name: "People & Pets", exact: true }).click();
  await expect(ctx.window.getByRole("heading", { name: "People & Pets", exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  ctx = await launchApp({
    testName: "pets",
    peopleModel: "stub",
    petModel: "stub",
    prepareCatalog(dir) { catalogDir = dir; },
  });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
  // The app has upgraded the catalog to the schema with pets by now. It still
  // holds the database open and may be writing at startup; without a busy
  // timeout the seed fails outright with "database is locked".
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", path.join(catalogDir, "catalog.sqlite3"), SEED]);
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("pets share the wall with people, each with a paw", async () => {
  await openWall();
  await ctx.window.getByRole("button", { name: "Refresh" }).click();
  await expect(tiles()).toHaveCount(3);
  await expect(ctx.window.getByTestId("pet-badge")).toHaveCount(2);
  await expect(tiles().filter({ hasText: "Mochi" }).getByTestId("pet-badge")).toHaveCount(1);
  await expect(tiles().filter({ hasText: "Ann" }).getByTestId("pet-badge")).toHaveCount(0);
  await expect(tiles().filter({ hasText: "Mochi" })).toContainText("2 photos");
  await expect(tiles().filter({ hasText: "Ann" })).toContainText("2 faces");
});

test("the switch shows only pets or only people", async () => {
  await ctx.window.getByTestId("people-show-pets").click();
  await expect(tiles()).toHaveCount(2);
  await expect(tiles().filter({ hasText: "Ann" })).toHaveCount(0);
  await ctx.window.getByTestId("people-show-people").click();
  await expect(tiles()).toHaveCount(1);
  await expect(tiles().first()).toContainText("Ann");
  await ctx.window.getByTestId("people-show-all").click();
  await expect(tiles()).toHaveCount(3);
});

test("naming the dog offers no cat to merge into", async () => {
  const dog = tiles().filter({ has: ctx.window.getByTestId("pet-badge") }).filter({ hasText: "Add name" });
  await dog.getByRole("button", { name: "Add name" }).click();
  const field = ctx.window.getByPlaceholder("Type a name…");
  await field.fill("Mo");
  await expect(ctx.window.getByRole("button", { name: /Merge into Mochi/ })).toHaveCount(0);
  await ctx.window.keyboard.press("Escape");
});

test("a named pet opens its photos", async () => {
  await tiles().filter({ hasText: "Mochi" }).locator("button").first().dblclick();
  await expect(galleryCards(ctx.window)).toHaveCount(2);
});

test("the Pets filter cycles pets, cats and dogs", async () => {
  await nav().getByRole("button", { name: /All Assets/i }).first().click();
  // Leaving Mochi's photos clears that refinement as the place changes; wait
  // for the whole library before filtering, or the clear lands after the click.
  await expect.poll(() => galleryCards(ctx.window).count()).toBeGreaterThan(4);
  const everything = await galleryCards(ctx.window).count();
  if (!await ctx.window.getByTestId("filter-pets").isVisible()) await ctx.window.getByRole("button", { name: "Filters" }).click();
  const chip = ctx.window.getByTestId("filter-pets");
  await chip.click();
  await expect(chip).toHaveText("Pets");
  await expect(galleryCards(ctx.window)).toHaveCount(4);
  await chip.click();
  await expect(chip).toHaveText("Cats");
  await expect(galleryCards(ctx.window)).toHaveCount(2);
  await chip.click();
  await expect(chip).toHaveText("Dogs");
  await expect(galleryCards(ctx.window)).toHaveCount(2);
  await chip.click();
  await expect(galleryCards(ctx.window)).toHaveCount(everything);
});

test("the Inspector lists a photo's pet with its species", async () => {
  await galleryCards(ctx.window).filter({ hasText: "001-red" }).first().click();
  const row = ctx.window.getByRole("button", { name: "Mochi Cat" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("inspector-pet-species")).toHaveText("Cat");
});

test("while pets are off, the wall doesn't offer to analyze them", async () => {
  await openWall();
  await expect(tiles()).toHaveCount(3);
  await expect(ctx.window.getByTestId("pets-prompt")).toHaveCount(0);
});

test("Recognize pets is off by default with the built-in pet model ready, and stays on once turned on", async () => {
  const openTab = async () => {
    await ctx.window.keyboard.press("ControlOrMeta+,");
    await ctx.window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "People & Pets" }).click();
  };
  const toggle = () => ctx.window.getByText("Recognize pets", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]").getByRole("switch");
  await openTab();
  await expect(ctx.window.getByText("Pet model", { exact: true })).toBeVisible();
  await expect(ctx.window.getByText("DINOv2 Small · Core ML")).toBeVisible();
  await expect(toggle()).toHaveAttribute("aria-checked", "false");
  await toggle().click();
  await expect(toggle()).toHaveAttribute("aria-checked", "true");
  await ctx.window.keyboard.press("Escape");
  await openTab();
  await expect(toggle()).toHaveAttribute("aria-checked", "true");
  await ctx.window.keyboard.press("Escape");
});

test("with pets on, a library analyzed before pets is offered the pets once", async () => {
  await openWall();
  const prompt = ctx.window.getByTestId("pets-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Analyze pets" })).toBeVisible();
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toHaveCount(0);
  await ctx.window.reload();
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
  await openWall();
  await expect(tiles()).toHaveCount(3);
  await expect(ctx.window.getByTestId("pets-prompt")).toHaveCount(0);
});
