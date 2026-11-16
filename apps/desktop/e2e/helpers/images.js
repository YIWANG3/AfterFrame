// Test photos made on the fly, so a spec can move, delete or re-tag them
// without touching the committed fixtures.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

// The bundled ExifTool, run as the app runs it (media_workspace/exiftool.py):
// the Perl script with the system's perl on macOS, the packaged exiftool.exe on
// Windows, which has no perl.
const EXIFTOOL_DIR = path.resolve(__dirname, "..", "..", "native", "exiftool");
const EXIFTOOL = process.platform === "win32"
  ? [path.join(EXIFTOOL_DIR, "exiftool.exe")]
  : ["perl", path.join(EXIFTOOL_DIR, "exiftool")];

// The smallest valid JPEG (1×1, grey): for specs that need many files on
// disk fast and never look at the pixels, such as a 3000-file import.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

// A temp folder of `count` TINY_JPEG copies named <prefix>_000.jpg…, the
// cheapest import an MCP or job spec can start.
function makeImportDir(prefix, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${prefix}-`));
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `${prefix}_${String(i).padStart(3, "0")}.jpg`), TINY_JPEG);
  }
  return dir;
}

// A JPEG no other photo shares: random pixels, so neither the content hash nor
// the duplicate check ties it to anything already in the catalog.
async function writeUniqueJpeg(file, { width = 480, height = 320 } = {}) {
  await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
}

// Writes EXIF the way a camera would, with the bundled ExifTool, in one run
// for all the photos: starting ExifTool is most of the cost (seconds for
// exiftool.exe on Windows). Each photo: { file, taken: "2024:01:02 18:05:00"
// (the camera's clock, no zone), gps: [latitude, longitude] }. Returns the files.
function tagPhotos(photos) {
  const args = [];
  photos.forEach(({ file, taken, gps }, index) => {
    if (index) args.push("-execute");
    if (taken) args.push(`-DateTimeOriginal=${taken}`);
    if (gps) {
      const [lat, lon] = gps;
      args.push(`-GPSLatitude=${Math.abs(lat)}`, `-GPSLatitudeRef=${lat >= 0 ? "N" : "S"}`,
        `-GPSLongitude=${Math.abs(lon)}`, `-GPSLongitudeRef=${lon >= 0 ? "E" : "W"}`);
    }
    args.push(file);
  });
  const [command, ...script] = EXIFTOOL;
  execFileSync(command, [...script, ...args, "-common_args", "-q", "-overwrite_original"]);
  return photos.map(({ file }) => file);
}

// A minimal DNG whose embedded preview is smaller than its raw image: the
// shape of a Fuji GFX or Hasselblad file (a 4000 px JPEG inside an 11648 px
// RAW), at a size a test can afford. Uncompressed 16-bit RGGB data, a JPEG
// preview in IFD0, the raw image in a SubIFD; LibRaw, Image I/O and ExifTool
// all read it. The pixels are a smooth colour field, so no renderer turns it
// black and every size difference shows.
async function writeSyntheticDng(file, { width = 2048, height = 1152, previewWidth = 2000, previewHeight = 1125 } = {}) {
  const preview = await sharp({
    create: { width: previewWidth, height: previewHeight, channels: 3, background: { r: 200, g: 120, b: 60 } },
  }).jpeg({ quality: 90 }).toBuffer();
  const raw = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const red = (y % 2 === 0) && (x % 2 === 0);
      const blue = (y % 2 === 1) && (x % 2 === 1);
      const level = red ? 30000 + (x * 20000) / width : blue ? 12000 + (y * 20000) / height : 22000;
      raw.writeUInt16LE(Math.round(level), (y * width + x) * 2);
    }
  }

  const SHORT = 3;
  const LONG = 4;
  const BYTE = 1;
  const ASCII = 2;
  const RATIONAL = 5;
  const SRATIONAL = 10;
  const typeSize = { [BYTE]: 1, [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [RATIONAL]: 8, [SRATIONAL]: 8 };
  // Each IFD: [tag, type, values]; the layout below fills in the offsets.
  const ascii = (text) => [...Buffer.from(`${text}\0`, "latin1")];
  const ifd0 = (previewAt, subIfdAt) => [
    [254, LONG, [1]], [256, LONG, [previewWidth]], [257, LONG, [previewHeight]], [258, SHORT, [8, 8, 8]],
    [259, SHORT, [7]], [262, SHORT, [6]], [271, ASCII, ascii("AfterFrame")], [272, ASCII, ascii("Synthetic DNG")],
    [273, LONG, [previewAt]], [274, SHORT, [1]], [277, SHORT, [3]], [278, LONG, [previewHeight]],
    [279, LONG, [preview.length]], [284, SHORT, [1]], [330, LONG, [subIfdAt]],
    [50706, BYTE, [1, 4, 0, 0]], [50707, BYTE, [1, 1, 0, 0]], [50708, ASCII, ascii("AfterFrame Synthetic DNG")],
    [50721, SRATIONAL, [10000, 10000, 0, 10000, 0, 10000, 0, 10000, 10000, 10000, 0, 10000, 0, 10000, 0, 10000, 10000, 10000]],
    [50728, RATIONAL, [1, 1, 1, 1, 1, 1]], [50778, SHORT, [21]],
  ];
  const subIfd = (rawAt) => [
    [254, LONG, [0]], [256, LONG, [width]], [257, LONG, [height]], [258, SHORT, [16]], [259, SHORT, [1]],
    [262, SHORT, [32803]], [273, LONG, [rawAt]], [277, SHORT, [1]], [278, LONG, [height]],
    [279, LONG, [raw.length]], [284, SHORT, [1]], [33421, SHORT, [2, 2]], [33422, BYTE, [0, 1, 1, 2]],
    [50714, LONG, [0]], [50717, LONG, [65535]],
  ];
  // Bytes an IFD takes: the entries, then the values too big to sit inline.
  const ifdSize = (entries) => 2 + entries.length * 12 + 4
    + entries.reduce((sum, [, type, values]) => {
      const bytes = typeSize[type] * (type === RATIONAL || type === SRATIONAL ? values.length / 2 : values.length);
      return sum + (bytes > 4 ? bytes + (bytes % 2) : 0);
    }, 0);
  const ifd0At = 8;
  const subIfdAt = ifd0At + ifdSize(ifd0(0, 0));
  const previewAt = subIfdAt + ifdSize(subIfd(0));
  const rawAt = previewAt + preview.length + (preview.length % 2);
  const out = Buffer.alloc(rawAt + raw.length);
  out.write("II", 0, "latin1");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0At, 4);
  const writeIfd = (at, entries) => {
    entries.sort((a, b) => a[0] - b[0]);
    out.writeUInt16LE(entries.length, at);
    let extra = at + 2 + entries.length * 12 + 4;
    entries.forEach(([tag, type, values], index) => {
      const entry = at + 2 + index * 12;
      const count = type === RATIONAL || type === SRATIONAL ? values.length / 2 : values.length;
      out.writeUInt16LE(tag, entry);
      out.writeUInt16LE(type, entry + 2);
      out.writeUInt32LE(count, entry + 4);
      const bytes = typeSize[type] * count;
      let cursor = bytes > 4 ? extra : entry + 8;
      if (bytes > 4) {
        out.writeUInt32LE(extra, entry + 8);
        extra += bytes + (bytes % 2);
      }
      for (const value of values) {
        if (type === BYTE || type === ASCII) { out.writeUInt8(value, cursor); cursor += 1; }
        else if (type === SHORT) { out.writeUInt16LE(value, cursor); cursor += 2; }
        else if (type === SRATIONAL) { out.writeInt32LE(value, cursor); cursor += 4; }
        else { out.writeUInt32LE(value, cursor); cursor += 4; }
      }
    });
    out.writeUInt32LE(0, at + 2 + entries.length * 12);
  };
  writeIfd(ifd0At, ifd0(previewAt, subIfdAt));
  writeIfd(subIfdAt, subIfd(rawAt));
  preview.copy(out, previewAt);
  raw.copy(out, rawAt);
  fs.writeFileSync(file, out);
  return file;
}

// A RAW laid out like the ARW of a camera too new for LibRaw and Image I/O
// (the Sony A7 V under LibRaw 0.22): IFD0 points at a 160×120 thumbnail and
// at a SubIFD of raw data in a compression nothing decodes; the next IFD
// holds a full-size JPEG preview as its one strip. That preview, in `colour`,
// is all there is to show.
async function writeUnknownCameraArw(file, { width = 2400, height = 1600, orientation = 1, colour = { r: 40, g: 90, b: 210 } } = {}) {
  const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
  const preview = await sharp({ create: { width, height, channels: 3, background: colour } }).jpeg({ quality: 90 }).toBuffer();
  const blobs = { make: Buffer.from("SONY\0"), model: Buffer.from("ILCE-7M5\0"), thumb, preview, raw: Buffer.alloc(8192, 0x5a) };
  // [tag, type (2 ASCII, 3 SHORT, 4 LONG), value]: a number, or [what, name] filled in below.
  const ifds = [
    [[254, 4, 1], [259, 3, 6], [271, 2, "make"], [272, 2, "model"], [274, 3, orientation], [330, 4, ["ifd", 2]], [513, 4, ["at", "thumb"]], [514, 4, ["len", "thumb"]]],
    [[254, 4, 1], [256, 3, width], [257, 3, height], [259, 3, 7], [273, 4, ["at", "preview"]], [279, 4, ["len", "preview"]]],
    [[254, 4, 0], [256, 3, 7040], [257, 3, 4688], [259, 3, 32766], [273, 4, ["at", "raw"]], [279, 4, ["len", "raw"]]],
  ];
  const ifdAt = [8];
  for (const entries of ifds.slice(0, -1)) ifdAt.push(ifdAt.at(-1) + 2 + entries.length * 12 + 4);
  let cursor = ifdAt.at(-1) + 2 + ifds.at(-1).length * 12 + 4;
  const blobAt = {};
  for (const [name, blob] of Object.entries(blobs)) {
    blobAt[name] = cursor;
    cursor += blob.length + (blob.length % 2);
  }
  const out = Buffer.alloc(cursor);
  out.write("II", 0, "latin1");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  const resolve = ([what, name]) => ({ at: blobAt[name], len: blobs[name]?.length, ifd: ifdAt[name] })[what];
  ifds.forEach((entries, index) => {
    const at = ifdAt[index];
    out.writeUInt16LE(entries.length, at);
    entries.forEach(([tag, type, value], i) => {
      const entry = at + 2 + i * 12;
      out.writeUInt16LE(tag, entry);
      out.writeUInt16LE(type, entry + 2);
      if (type === 2) {
        out.writeUInt32LE(blobs[value].length, entry + 4);
        out.writeUInt32LE(blobAt[value], entry + 8);
        return;
      }
      out.writeUInt32LE(1, entry + 4);
      const number = Array.isArray(value) ? resolve(value) : value;
      if (type === 3) out.writeUInt16LE(number, entry + 8);
      else out.writeUInt32LE(number, entry + 8);
    });
    out.writeUInt32LE(index === 0 ? ifdAt[1] : 0, at + 2 + entries.length * 12);
  });
  for (const [name, blob] of Object.entries(blobs)) blob.copy(out, blobAt[name]);
  fs.writeFileSync(file, out);
  return file;
}

module.exports = { TINY_JPEG, makeImportDir, writeUniqueJpeg, tagPhotos, writeSyntheticDng, writeUnknownCameraArw };
