const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const exifr = require("exifr");

const { createImageMetadataWriter } = require("./imageMetadata");

const XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
  + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/>'
  + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

const SOURCE_FIELDS = { camera_make: "TestMake", camera_model: "TestCam X1", iso: 200, aperture: 2.8 };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-image-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function editedPixels() {
  return sharp({ create: { width: 8, height: 6, channels: 3, background: "#808080" } }).png().toBuffer();
}

async function sourceWithXmp(dir) {
  const sourcePath = path.join(dir, "source.jpg");
  await sharp({ create: { width: 8, height: 6, channels: 3, background: "#404040" } })
    .withXmp(XMP).jpeg().toFile(sourcePath);
  return sourcePath;
}

test("an edited export carries the source's EXIF (from the sidecar) and XMP", async (t) => {
  const dir = tempDir(t);
  const sourcePath = await sourceWithXmp(dir);
  const asked = [];
  const { writeImageWithSourceMetadata } = createImageMetadataWriter({
    readSourceMetadata: async (p) => { asked.push(p); return SOURCE_FIELDS; },
  });

  const target = path.join(dir, "out", "edited.jpg");
  await writeImageWithSourceMetadata(target, await editedPixels(), sourcePath);

  assert.deepEqual(asked, [sourcePath]);
  const exif = await exifr.parse(target);
  assert.equal(exif.Make, "TestMake");
  assert.equal(exif.Model, "TestCam X1");
  assert.equal(exif.ISO, 200);
  assert.equal(exif.FNumber, 2.8);
  const { xmp } = await sharp(target).metadata();
  assert.match(xmp.toString("utf8"), /xmp:Rating="4"/);
});

test("EXIF survives a source sharp cannot open (HEIC, most RAW)", async (t) => {
  t.mock.method(console, "warn", () => {});
  const dir = tempDir(t);
  const sourcePath = path.join(dir, "IMG_0001.HEIC");
  fs.writeFileSync(sourcePath, Buffer.from("not an image sharp can decode"));
  const { writeImageWithSourceMetadata } = createImageMetadataWriter({
    readSourceMetadata: async () => SOURCE_FIELDS,
  });

  const target = path.join(dir, "edited.jpg");
  await writeImageWithSourceMetadata(target, await editedPixels(), sourcePath);

  assert.equal((await exifr.parse(target)).Make, "TestMake");
});

test("XMP survives a failed sidecar read, rejected or thrown", async (t) => {
  t.mock.method(console, "warn", () => {});
  const dir = tempDir(t);
  const sourcePath = await sourceWithXmp(dir);
  const failures = [
    async () => { throw new Error("resident sidecar stopped"); },
    () => { throw new Error("No catalog is open"); },
  ];
  for (const [i, readSourceMetadata] of failures.entries()) {
    const { writeImageWithSourceMetadata } = createImageMetadataWriter({ readSourceMetadata });
    const target = path.join(dir, `edited-${i}.jpg`);
    await writeImageWithSourceMetadata(target, await editedPixels(), sourcePath);
    const { xmp } = await sharp(target).metadata();
    assert.match(xmp.toString("utf8"), /xmp:Rating="4"/);
  }
});

test("no source path: nothing is read, the pixels are still written", async (t) => {
  const dir = tempDir(t);
  let called = false;
  const { writeImageWithSourceMetadata } = createImageMetadataWriter({
    readSourceMetadata: async () => { called = true; return SOURCE_FIELDS; },
  });

  const target = path.join(dir, "edited.png");
  const result = await writeImageWithSourceMetadata(target, await editedPixels(), null);

  assert.equal(called, false);
  assert.equal(result.path, target);
  assert.equal((await sharp(target).metadata()).format, "png");
});
