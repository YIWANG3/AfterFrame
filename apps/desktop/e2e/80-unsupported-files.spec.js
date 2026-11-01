// What an import says about the files it doesn't take (docs/format-support-plan.md
// §4.4, P1b). A folder with a .docx and a .zip beside the photos imports the
// photos and ends with a toast naming the two, whose button opens Settings →
// Library at the list of supported formats. Sidecars (.xmp, .thm) are skipped
// without a word. A lone unsupported file dropped on the window is not
// registered as a root.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

const JPEG = path.resolve(__dirname, "fixtures", "test-image.jpg");

let ctx;
let dirs = [];

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const toasts = () => ctx.window.getByTestId("toast-card");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// import_directory waits up to ~25 s itself; poll get_job_status after. The
// resolve phase's result is where the import counts what it skipped.
async function importAndWait(args) {
  let status = await callTool("import_directory", args);
  const deadline = Date.now() + 90_000;
  while (!status.done && Date.now() < deadline) {
    await sleep(1500);
    const job = await callTool("get_job_status", { job_id: status.job_id });
    status = { ...status, done: !job.running, status: job.status, error: job.error, result: job.result };
  }
  expect(status.status, JSON.stringify(status)).toBe("succeeded");
  return (status.result?.phase_results || []).find((p) => p?.result && typeof p.result.already_in_catalog === "number").result;
}

function makeDir(tag, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${tag}-`));
  for (const [name, source] of Object.entries(files)) {
    if (source) fs.copyFileSync(source, path.join(dir, name));
    else fs.writeFileSync(path.join(dir, name), `not a photo: ${name}`);
  }
  dirs.push(dir);
  return dir;
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "unsupported-files" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a folder with documents among the photos imports the photos and reports the rest", async () => {
  test.setTimeout(60_000);
  const dir = makeDir("mixed", { "mixedphoto.jpg": JPEG, "notes.docx": null, "slides.DOCX": null, "backup.zip": null, "mixedphoto.xmp": null });
  // The job's own account, for the agent surface.
  const resolve = await importAndWait({ image_dirs: [dir] });
  expect(resolve.skipped_unsupported).toEqual({ count: 3, by_extension: { ".docx": 2, ".zip": 1 } });
  expect(resolve.skipped_companion).toEqual({ count: 1, by_extension: { ".xmp": 1 } });
  const { assets } = await callTool("search_assets", { query: "mixedphoto", limit: 5 });
  expect(assets).toHaveLength(1);

  // The toast names what was skipped, not the sidecar.
  const toast = toasts().filter({ hasText: "Skipped 3 unsupported files" });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText("DOCX ×2 · ZIP ×1");
  await expect(toast).not.toContainText("XMP");

  // Its button lands on the list of what does import.
  await toast.getByRole("button", { name: "Supported formats" }).click();
  await expect(ctx.window.getByText("Supported formats", { exact: true })).toBeVisible({ timeout: 5_000 });
  const photos = ctx.window.locator("[data-format-list='image']");
  await expect(photos).toContainText("jpg");
  await expect(photos).toContainText("heic");
  await expect(ctx.window.locator("[data-format-list='raw']")).toContainText("cr3");
  await expect(ctx.window.locator("[data-format-list='video']")).toContainText("mov");
  await ctx.window.keyboard.press("Escape");
});

test("a folder whose extras are only sidecars imports without a word", async () => {
  test.setTimeout(60_000);
  const dir = makeDir("quiet", { "quietphoto.jpg": JPEG, "quietphoto.xmp": null, "quietphoto.THM": null });
  const resolve = await importAndWait({ image_dirs: [dir] });
  expect(resolve.skipped_unsupported.count).toBe(0);
  expect(resolve.skipped_companion.count).toBe(2);
  const { assets } = await callTool("search_assets", { query: "quietphoto", limit: 5 });
  expect(assets).toHaveLength(1);
  // Give a toast the time it would need to appear, then make sure none did.
  await ctx.window.waitForTimeout(2_000);
  await expect(toasts().filter({ hasText: "unsupported" })).toHaveCount(0);
});

test("a lone document dropped on the window becomes no root", async () => {
  test.setTimeout(60_000);
  const dir = makeDir("lone", { "proposal.pdf": null });
  const file = path.join(dir, "proposal.pdf");
  const roots = () => ctx.window.evaluate(() => window.mediaWorkspace.getCatalogRoots());
  const before = await roots();
  // The renderer's drop path registers the roots first, then imports them.
  await ctx.window.evaluate((p) => window.mediaWorkspace.registerRoots("image", [p]), file);
  expect(await roots()).toEqual(before);
  // A folder is a root whatever it holds.
  await ctx.window.evaluate((p) => window.mediaWorkspace.registerRoots("image", [p]), dir);
  expect((await roots()).map((root) => root.path)).toContain(fs.realpathSync(dir));
});
