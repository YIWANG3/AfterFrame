// Writing an edited image back to disk WITH the original's metadata: the
// structured EXIF (rebuilt from the sidecar's parser, since sharp cannot copy
// EXIF between two different pixel buffers) plus the source's XMP packet.
// Extracted from main.js (review 2026-09-16 §2).
//
// The parser is reached through the sidecar's `read-image-metadata` command
// (resident process, so the packaged binary in release builds). It used to be
// a `python3 -c` spawn importing the sidecar's source tree, which packaged
// builds don't ship — every edited export from a release build lost its EXIF.

const path = require("node:path");
const fs = require("node:fs");
const sharp = require("sharp");

const { buildExifPayload } = require("./exif");

async function writeImageWithSourceMetadata(readSourceMetadata, targetPath, outputBuffer, sourceMetadataPath, { quality } = {}) {
  const ext = path.extname(targetPath).toLowerCase();
  let pipeline = sharp(outputBuffer, { limitInputPixels: false }).withMetadata({ orientation: 1 });

  if (sourceMetadataPath) {
    // Settled independently: a source sharp can't open (HEIC, most RAW) still
    // gets its EXIF, and a sidecar failure still keeps the XMP.
    const [structured, sourceSharpMeta] = await Promise.allSettled([
      Promise.resolve().then(() => readSourceMetadata(sourceMetadataPath)),
      sharp(sourceMetadataPath, { limitInputPixels: false }).metadata(),
    ]);
    if (structured.status === "fulfilled") {
      const exif = buildExifPayload(structured.value);
      if (exif) {
        pipeline = pipeline.withExif(exif);
      }
    } else {
      console.warn("[save-image] failed to read source EXIF:", structured.reason);
    }
    if (sourceSharpMeta.status === "fulfilled") {
      if (sourceSharpMeta.value.xmp) {
        pipeline = pipeline.withXmp(sourceSharpMeta.value.xmp.toString("utf8"));
      }
    } else {
      console.warn("[save-image] failed to read source XMP:", sourceSharpMeta.reason);
    }
  }

  if (ext === ".png") {
    pipeline = pipeline.png();
  } else if (ext === ".webp") {
    pipeline = pipeline.webp(quality ? { quality } : undefined);
  } else {
    pipeline = pipeline.jpeg(quality ? { quality } : undefined);
  }

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline.toFile(targetPath);
  return { path: targetPath };
}

// readSourceMetadata(path) → Promise<structured fields | null>: the sidecar's
// read-image-metadata (main.js binds it to sidecarCommands).
function createImageMetadataWriter({ readSourceMetadata }) {
  return {
    writeImageWithSourceMetadata: (targetPath, outputBuffer, sourceMetadataPath, options) =>
      writeImageWithSourceMetadata(readSourceMetadata, targetPath, outputBuffer, sourceMetadataPath, options),
  };
}

module.exports = { createImageMetadataWriter };
