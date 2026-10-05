// Test photos made on the fly, so a spec can move, delete or re-tag them
// without touching the committed fixtures.

const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const EXIFTOOL = path.resolve(__dirname, "..", "..", "native", "exiftool", "exiftool");

// A JPEG no other photo shares: random pixels, so neither the content hash nor
// the duplicate check ties it to anything already in the catalog.
async function writeUniqueJpeg(file, { width = 480, height = 320 } = {}) {
  await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
}

// Writes EXIF the way a camera would, with the bundled ExifTool (perl, as the
// app runs it on macOS). taken: "2024:01:02 18:05:00" (the camera's clock, no
// zone); gps: [latitude, longitude].
function tagPhoto(file, { taken, gps } = {}) {
  const args = ["-q", "-overwrite_original"];
  if (taken) args.push(`-DateTimeOriginal=${taken}`);
  if (gps) {
    const [lat, lon] = gps;
    args.push(`-GPSLatitude=${Math.abs(lat)}`, `-GPSLatitudeRef=${lat >= 0 ? "N" : "S"}`,
      `-GPSLongitude=${Math.abs(lon)}`, `-GPSLongitudeRef=${lon >= 0 ? "E" : "W"}`);
  }
  execFileSync("perl", [EXIFTOOL, ...args, file]);
  return file;
}

module.exports = { writeUniqueJpeg, tagPhoto };
