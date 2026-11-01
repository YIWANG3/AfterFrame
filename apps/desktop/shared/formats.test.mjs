import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_FORMAT_NAMES,
  MEDIA_RE,
  browserShowsOriginal,
  exportExtension,
  exportFormatForTarget,
  extensionOf,
  isImportable,
  kindOf,
  mimeForExport,
  needsBrowserTranscode,
  saveFilters,
  videoMime,
} from "./formats.mjs";

test("a file's kind comes from its extension, whatever its case or path style", () => {
  assert.equal(kindOf("/Volumes/CARD/DCIM/IMG_0001.JPG"), "image");
  assert.equal(kindOf("C:\\photos\\DSC_0001.NEF"), "raw");
  assert.equal(kindOf("clip.MOV"), "video");
  assert.equal(kindOf("notes.txt"), null);
  assert.equal(kindOf(".DS_Store"), null);
  assert.equal(extensionOf("archive.tar.gz"), ".gz");
});

test("the import, the watcher and the Dock agree on what is media", () => {
  for (const name of ["a.jpg", "a.heic", "a.HIF", "a.heif", "a.psd", "a.gif", "a.bmp", "a.jfif", "a.insp", "a.tif", "a.CR3", "a.3fr", "a.mp4", "a.mkv", "a.avi", "a.MTS", "a.m2ts", "a.3gp"]) {
    assert.ok(isImportable(name), name);
    assert.ok(MEDIA_RE.test(name), name);
  }
  for (const name of ["a.psb", "a.docx", "a.txt", "a.xmp", "a.thm", "a"]) {
    assert.equal(isImportable(name), false, name);
    assert.equal(MEDIA_RE.test(name), false, name);
  }
});

test("an <img> shows JPEG-like originals and a transcoded HEIF or PSD, not a TIFF or a RAW", () => {
  assert.ok(browserShowsOriginal("/p/d.JPG"));
  assert.ok(browserShowsOriginal("/p/d.gif") && browserShowsOriginal("/p/d.bmp") && browserShowsOriginal("/p/d.insp"));
  assert.ok(browserShowsOriginal("/p/IMG_0002.HEIC"));
  assert.ok(needsBrowserTranscode("/p/IMG_0002.HEIC"));
  assert.ok(needsBrowserTranscode("/p/IMG_0003.HIF") && needsBrowserTranscode("/p/layered.psd"));
  assert.equal(needsBrowserTranscode("/p/d.jpg"), false);
  assert.equal(needsBrowserTranscode("/p/d.gif"), false);
  assert.equal(browserShowsOriginal("/p/scan.tif"), false);
  assert.equal(browserShowsOriginal("/p/B0000333.3FR"), false);
  assert.equal(browserShowsOriginal(""), false);
});

test("video MIME types for the range server", () => {
  assert.equal(videoMime("a.mp4"), "video/mp4");
  assert.equal(videoMime("a.M4V"), "video/mp4");
  assert.equal(videoMime("a.mov"), "video/quicktime");
  assert.equal(videoMime("a.mkv"), "video/x-matroska");
  assert.equal(videoMime("00001.MTS"), "video/mp2t");
  assert.equal(videoMime("a.3gp"), "video/3gpp");
  assert.equal(videoMime("a.bin"), "application/octet-stream");
});

test("an edited copy keeps a JPEG, PNG or WebP extension and becomes a JPEG otherwise", () => {
  assert.equal(exportExtension("IMG.jpeg"), "jpeg");
  assert.equal(exportExtension("IMG.PNG"), "png");
  assert.equal(exportExtension("IMG.webp"), "webp");
  assert.equal(exportExtension("IMG.heic"), "jpg");
  assert.equal(exportExtension("IMG.jfif"), "jpg");
  assert.equal(exportExtension("IMG.psd"), "jpg");
  assert.equal(exportExtension("IMG.tif"), "jpg");
  assert.equal(exportExtension("IMG"), "jpg");
  assert.equal(exportFormatForTarget("out.png"), "png");
  assert.equal(exportFormatForTarget("out.HEIC"), "jpeg");
  assert.equal(mimeForExport("out.webp"), "image/webp");
  assert.equal(mimeForExport("out.jpg"), "image/jpeg");
});

test("save-dialog filters list JPEG, PNG and WebP in that order, or a chosen subset", () => {
  assert.deepEqual(EXPORT_FORMAT_NAMES, ["jpeg", "png", "webp"]);
  assert.deepEqual(saveFilters(), [
    { name: "JPEG", extensions: ["jpg", "jpeg"] },
    { name: "PNG", extensions: ["png"] },
    { name: "WebP", extensions: ["webp"] },
  ]);
  assert.deepEqual(saveFilters(["jpeg", "png"]).map((f) => f.name), ["JPEG", "PNG"]);
});
