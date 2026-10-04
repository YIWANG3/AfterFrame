const test = require("node:test");
const assert = require("node:assert/strict");

const { buildExifPayload, toExifRational, toExifGpsCoordinate, formatExifDateTime } = require("./exif");

test("toExifRational reduces to lowest terms and keeps the sign", () => {
  assert.equal(toExifRational(2.8, 1000), "14/5");          // f/2.8
  assert.equal(toExifRational(1 / 250, 1000000), "1/250");  // shutter
  assert.equal(toExifRational(0, 1000), "0/1");
  assert.equal(toExifRational(-1.5, 1000), "-3/2");
  assert.equal(toExifRational("not a number"), null);
});

test("toExifGpsCoordinate yields degrees/minutes/seconds with a rational seconds term", () => {
  // 40.7128° → 40° 42' 46.08"
  assert.equal(toExifGpsCoordinate(40.7128), "40/1 42/1 1152/25");
  assert.equal(toExifGpsCoordinate(-74.0060), "74/1 0/1 108/5"); // sign lives in the Ref, not here
  assert.equal(toExifGpsCoordinate(""), null);
  assert.equal(toExifGpsCoordinate(null), null);
});

test("a capture time is written back as the camera's clock showed it, wherever the viewer is", () => {
  // Capture times are stored without an offset (the camera's clock). Read as
  // local, they come back with the same digits in any time zone; the old
  // +00:00 label moved them by the viewer's offset, here 8 hours.
  const zone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    assert.equal(formatExifDateTime("2024-07-13T18:05:00"), "2024:07:13 18:05:00");
    process.env.TZ = "America/Los_Angeles";
    assert.equal(formatExifDateTime("2024-07-13T18:05:00"), "2024:07:13 18:05:00");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("formatExifDateTime uses the EXIF colon-date form and rejects junk", () => {
  assert.match(formatExifDateTime("2026-09-16T10:20:30"), /^2026:09:16 \d\d:20:30$/);
  assert.equal(formatExifDateTime("yesterday"), null);
  assert.equal(formatExifDateTime(null), null);
});

test("buildExifPayload maps sidecar metadata onto sharp's IFD layout", () => {
  const exif = buildExifPayload({
    camera_make: "Canon", camera_model: "EOS R5m2", lens_model: "RF 24-70",
    iso: 400, aperture: 2.8, shutter_speed: 0.004, focal_length: 50,
    gps_latitude: 40.7128, gps_longitude: -74.006,
  });
  assert.equal(exif.IFD0.Make, "Canon");
  assert.equal(exif.IFD0.Orientation, "1");         // pixels are already upright after export
  assert.equal(exif.IFD2.ISOSpeedRatings, "400");
  assert.equal(exif.IFD2.FNumber, "14/5");
  assert.equal(exif.IFD2.ExposureTime, "1/250");
  assert.equal(exif.IFD2.FocalLength, "50/1");
  assert.equal(exif.IFD3.GPSLatitudeRef, "N");
  assert.equal(exif.IFD3.GPSLongitudeRef, "W");
  assert.equal(exif.IFD3.GPSLongitude, "74/1 0/1 108/5");
});

test("a framed copy keeps the lens maker: LensMake is written and reads back", async () => {
  const exif = buildExifPayload({ camera_make: "SONY", camera_model: "ILCE-7M4", lens_make: "TAMRON", lens_model: "E 70-180mm F2.8 A056" });
  assert.equal(exif.IFD2.LensMake, "TAMRON");
  assert.equal(buildExifPayload({ camera_model: "X", lens_make: null }).IFD2, undefined);
  // libvips writes only the tags it knows by name: check this one survives.
  const sharp = require("sharp");
  const exifr = require("exifr");
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).withExif(exif).jpeg().toBuffer();
  const read = await exifr.parse(jpeg);
  assert.equal(read.LensMake, "TAMRON");
  assert.equal(read.LensModel, "E 70-180mm F2.8 A056");
});

test("buildExifPayload drops empty directories and returns null for nothing", () => {
  const exif = buildExifPayload({ camera_model: "X" });
  assert.deepEqual(Object.keys(exif), ["IFD0"]);  // no exposure data → no IFD2, no GPS → no IFD3
  assert.equal(buildExifPayload(null), null);
});
