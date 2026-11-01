// Lightroom (Bridge, Camera Raw) rates a RAW in an XMP sidecar beside it,
// IMG.xmp; darktable writes IMG.CR2.xmp. Import takes the sidecar's stars,
// and a re-import follows a re-rating until the user rates the photo here.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, galleryCards } = require("./helpers/app");

const FIXTURES = path.resolve(__dirname, "fixtures");
const DNG = path.join(FIXTURES, "raw", "luna-evening.dng");
const JPEG = path.join(FIXTURES, "test-image.jpg");

let ctx;
let dir;

const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function importAndWait() {
  let status = await callTool("import_directory", { image_dirs: [dir] });
  const deadline = Date.now() + 90_000;
  while (!status.done && Date.now() < deadline) {
    await sleep(1000);
    const job = await callTool("get_job_status", { job_id: status.job_id });
    status = { ...status, done: !job.running, status: job.status, error: job.error };
  }
  expect(status.status, JSON.stringify(status)).toBe("succeeded");
}

async function assetNamed(stem) {
  const { assets } = await callTool("search_assets", { query: stem, limit: 5 });
  expect(assets, stem).toHaveLength(1);
  return assets[0];
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-e2e-sidecar-"));
  fs.copyFileSync(DNG, path.join(dir, "lightroomraw.dng"));
  fs.writeFileSync(path.join(dir, "lightroomraw.xmp"), sidecar(4));
  fs.copyFileSync(JPEG, path.join(dir, "darktablejpeg.jpg"));
  fs.writeFileSync(path.join(dir, "darktablejpeg.jpg.xmp"), sidecar(3));
  ctx = await launchApp({ testName: "xmp-sidecar" });
  await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("import takes the stars from the photo's XMP sidecar, Lightroom's name or darktable's", async () => {
  test.setTimeout(120_000);
  await importAndWait();
  expect((await assetNamed("lightroomraw")).rating, "IMG.xmp beside the RAW").toBe(4);
  expect((await assetNamed("darktablejpeg")).rating, "IMG.jpg.xmp beside the JPEG").toBe(3);
});

test("a re-rating in the sidecar follows, unless the photo was rated here", async () => {
  test.setTimeout(120_000);
  const rawBefore = await assetNamed("lightroomraw");
  const jpeg = await assetNamed("darktablejpeg");
  await callTool("update_assets", { asset_ids: [jpeg.asset_id], rating: 2 });

  fs.writeFileSync(path.join(dir, "lightroomraw.xmp"), sidecar(5));
  fs.writeFileSync(path.join(dir, "darktablejpeg.jpg.xmp"), sidecar(5));
  await importAndWait();

  const rawAfter = await assetNamed("lightroomraw");
  expect(rawAfter.asset_id, "the same photo").toBe(rawBefore.asset_id);
  expect(rawAfter.rating, "never rated here: Lightroom's new stars").toBe(5);
  expect((await assetNamed("darktablejpeg")).rating, "rated here: the user's stars stay").toBe(2);
});
