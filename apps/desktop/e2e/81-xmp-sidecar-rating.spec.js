// Lightroom (Bridge, Camera Raw) rates a RAW in an XMP sidecar beside it,
// IMG.xmp; darktable writes IMG.CR2.xmp. Import takes the sidecar's stars for
// every format the catalog imports, a re-import follows a re-rating until the
// user rates the photo here, and the Inspector's stars show the change.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

const FIXTURES = path.resolve(__dirname, "fixtures");
const FORMATS = path.join(FIXTURES, "formats");
const DNG = path.join(FIXTURES, "raw", "luna-evening.dng");
const JPEG = path.join(FIXTURES, "test-image.jpg");
const HEIC = path.join(FIXTURES, "heic", "iphone-style.heic");

// name in the import folder → [fixture (null: made here), sidecar form, stars]
// "adobe": IMG.xmp (Lightroom, Bridge, Camera Raw); "darktable": IMG.ext.xmp.
const FILES = {
  "lightroomraw.dng": [DNG, "adobe", 4],
  "lightroomjpeg.jpg": [JPEG, "adobe", 3],
  "scantiff.tif": [null, "adobe", 2],
  "layeredpsd.psd": [path.join(FORMATS, "layered.psd"), "adobe", 5],
  "iphonestill.heic": [HEIC, "adobe", 1],
  "canonstill.HIF": [HEIC, "darktable", 3],
  "pixelgif.gif": [path.join(FORMATS, "pixel.gif"), "darktable", 4],
  "pixelbmp.bmp": [path.join(FORMATS, "pixel.bmp"), "adobe", 2],
  "camcorder.MTS": [path.join(FORMATS, "clip.mts"), "adobe", 5],
};
// A RAW+JPEG pair shares Lightroom's one sidecar, named after the stem.
const PAIR = { stem: "pairshot", stars: 3 };

let ctx;
let dir;

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stem = (name) => name.slice(0, name.lastIndexOf("."));
const sidecarName = (name, form) => (form === "darktable" ? `${name}.xmp` : `${stem(name)}.xmp`);

// Lightroom's sidecar, to the attribute: rdf:Description carries xmp:Rating.
const sidecar = (stars) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="${stars}"
   crs:Exposure2012="+0.50"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const writeSidecar = (file, stars) => fs.writeFileSync(path.join(dir, file), sidecar(stars));

async function importAndWait() {
  let status = await callTool("import_directory", { image_dirs: [dir] });
  const deadline = Date.now() + 120_000;
  while (!status.done && Date.now() < deadline) {
    await sleep(1000);
    const job = await callTool("get_job_status", { job_id: status.job_id });
    status = { ...status, done: !job.running, status: job.status, error: job.error };
  }
  expect(status.status, JSON.stringify(status)).toBe("succeeded");
}

async function assetsNamed(name) {
  const { assets } = await callTool("search_assets", { query: name, limit: 10 });
  return assets;
}

async function assetNamed(name) {
  const assets = await assetsNamed(stem(name));
  expect(assets, name).toHaveLength(1);
  return assets[0];
}

async function ratingOf(assetId) {
  return ctx.window.evaluate(async (id) => {
    const rows = await window.mediaWorkspace.browseImages({ status: "all", limit: 500 });
    return rows.find((row) => row.asset_id === id)?.app_rating ?? null;
  }, assetId);
}

async function selectCard(assetId) {
  const card = ctx.window.locator(`[data-gallery-item='true'][data-asset-id='${assetId}']`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await expect(card).toHaveAttribute("data-selected", "true");
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-sidecar-"));
  for (const [name, [fixture, form, stars]] of Object.entries(FILES)) {
    if (fixture) fs.copyFileSync(fixture, path.join(dir, name));
    writeSidecar(sidecarName(name, form), stars);
  }
  await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .toColourspace("rgb16").tiff({ compression: "lzw" }).toFile(path.join(dir, "scantiff.tif"));
  fs.copyFileSync(DNG, path.join(dir, `${PAIR.stem}.dng`));
  fs.copyFileSync(JPEG, path.join(dir, `${PAIR.stem}.jpg`));
  writeSidecar(`${PAIR.stem}.xmp`, PAIR.stars);
  ctx = await launchApp({ testName: "xmp-sidecar" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("import takes the stars from the sidecar beside every format, Lightroom's name or darktable's", async () => {
  test.setTimeout(180_000);
  await importAndWait();
  for (const [name, [, form, stars]] of Object.entries(FILES)) {
    expect((await assetNamed(name)).rating, `${name} with ${sidecarName(name, form)}`).toBe(stars);
  }
  const pair = await assetsNamed(PAIR.stem);
  expect(pair.map((asset) => asset.asset_type).sort(), "the RAW and the JPEG").toEqual(["image", "raw"]);
  for (const asset of pair) expect(asset.rating, `${asset.stem}: one sidecar for the pair`).toBe(PAIR.stars);
});

test("a re-rating in the sidecar follows on re-import, unless the photo was rated here, and the Inspector shows it", async () => {
  test.setTimeout(180_000);
  const raw = await assetNamed("lightroomraw.dng");
  const jpeg = await assetNamed("lightroomjpeg.jpg");
  const clip = await assetNamed("camcorder.MTS");
  await callTool("update_assets", { asset_ids: [jpeg.asset_id], rating: 2 });

  // The Inspector shows the RAW's stars while Lightroom re-rates it.
  const stars = ctx.window.getByTestId("inspector-rating");
  await selectCard(raw.asset_id);
  await expect(stars).toHaveAttribute("data-value", "4");

  writeSidecar("lightroomraw.xmp", 5);
  writeSidecar("lightroomjpeg.xmp", 5);
  writeSidecar("camcorder.xmp", 1);
  await importAndWait();

  expect((await assetNamed("lightroomraw.dng")).asset_id, "the same photo").toBe(raw.asset_id);
  expect(await ratingOf(raw.asset_id), "never rated here: Lightroom's new stars").toBe(5);
  expect(await ratingOf(clip.asset_id), "a video follows too").toBe(1);
  expect(await ratingOf(jpeg.asset_id), "rated here: the user's stars stay").toBe(2);
  await expect(stars, "the Inspector follows without a re-select").toHaveAttribute("data-value", "5", { timeout: 10_000 });
});

test.describe("watched folder", () => {
  // As e2e/17: fs-watch delivery on the CI runner is too slow and uneven to
  // assert on; nightly and local runs cover it.
  test.skip(!!process.env.CI, "fs-watch delivery on the GitHub runner is too slow and uneven to assert on");

  test("a sidecar rewritten in a watched folder re-rates its photo, previews untouched", async () => {
    test.setTimeout(120_000);
    const raw = await assetNamed("lightroomraw.dng");
    let previewBefore;
    await expect.poll(async () => {
      previewBefore = (await callTool("get_asset", { asset_id: raw.asset_id })).image_preview_path;
      return previewBefore && fs.existsSync(previewBefore);
    }, { timeout: 15_000 }).toBeTruthy();
    const previewMtime = fs.statSync(previewBefore).mtimeMs;
    await ctx.window.evaluate((d) => window.mediaWorkspace.addWatchedDir(d), dir);
    const stars = ctx.window.getByTestId("inspector-rating");
    await selectCard(raw.asset_id);
    await expect(stars).toHaveAttribute("data-value", "5");

    await sleep(1000); // the watcher settles on the new folder
    writeSidecar("lightroomraw.xmp", 2);

    await expect.poll(() => ratingOf(raw.asset_id), { timeout: 60_000, intervals: [500] }).toBe(2);
    await expect(stars).toHaveAttribute("data-value", "2", { timeout: 10_000 });
    expect(fs.statSync(previewBefore).mtimeMs, "the photo didn't change, so its preview wasn't remade").toBe(previewMtime);
  });
});
