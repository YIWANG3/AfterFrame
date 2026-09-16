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

test("buildExifPayload drops empty directories and returns null for nothing", () => {
  const exif = buildExifPayload({ camera_model: "X" });
  assert.deepEqual(Object.keys(exif), ["IFD0"]);  // no exposure data → no IFD2, no GPS → no IFD3
  assert.equal(buildExifPayload(null), null);
});
