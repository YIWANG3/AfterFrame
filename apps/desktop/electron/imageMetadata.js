// Writing an edited image back to disk WITH the original's metadata: the
// structured EXIF (rebuilt from the sidecar's parser, since sharp cannot copy
// EXIF between two different pixel buffers) plus the source's XMP packet.
// Extracted from main.js (review 2026-09-16 §2).

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");

const { buildExifPayload } = require("./exif");

function runPythonJson(script, args, { rootDir, sidecarSrc, isPackaged }) {
  if (isPackaged) {
    // In packaged mode, python3 may not be available. Use sidecar binary if possible,
    // otherwise fall back to python3 and let it fail gracefully.
    console.warn("[runPythonJson] called in packaged mode — python3 may not be available");
  }
  const result = spawnSync("python3", ["-c", script, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      PYTHONPATH: sidecarSrc,
    },
    encoding: "utf-8",
    timeout: 10000,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "python helper failed");
  }

  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function readSourceMetadataForExport(sourcePath, env) {
  if (!sourcePath) return null;
  const script = `
import json
import sys
from pathlib import Path
from media_workspace.metadata import extract_image_candidate

meta = extract_image_candidate(Path(sys.argv[1]))
print(json.dumps({
    "capture_time": meta.capture_time,
    "camera_make": meta.camera_make,
    "camera_model": meta.camera_model,
    "lens_model": meta.lens_model,
    "software": meta.software,
    "iso": meta.iso,
    "aperture": meta.aperture,
    "shutter_speed": meta.shutter_speed,
    "focal_length": meta.focal_length,
    "flash": meta.flash,
    "white_balance": meta.white_balance,
    "color_space": meta.color_space,
    "gps_latitude": meta.gps_latitude,
    "gps_longitude": meta.gps_longitude,
}))
`;
  return runPythonJson(script, [sourcePath], env);
}

async function writeImageWithSourceMetadata(env, targetPath, outputBuffer, sourceMetadataPath, { quality } = {}) {
  const ext = path.extname(targetPath).toLowerCase();
  let pipeline = sharp(outputBuffer, { limitInputPixels: false }).withMetadata({ orientation: 1 });

  if (sourceMetadataPath) {
    try {
      const [structuredMetadata, sourceSharpMeta] = await Promise.all([
        Promise.resolve(readSourceMetadataForExport(sourceMetadataPath, env)),
        sharp(sourceMetadataPath, { limitInputPixels: false }).metadata(),
      ]);
      const exif = buildExifPayload(structuredMetadata);
      if (exif) {
        pipeline = pipeline.withExif(exif);
      }
      if (sourceSharpMeta.xmp) {
        pipeline = pipeline.withXmp(sourceSharpMeta.xmp.toString("utf8"));
      }
    } catch (error) {
      console.warn("[save-image] failed to preserve source metadata:", error);
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

// env: { rootDir, sidecarSrc, isPackaged } — where the sidecar's Python lives.
function createImageMetadataWriter(env) {
  return {
    writeImageWithSourceMetadata: (targetPath, outputBuffer, sourceMetadataPath, options) =>
      writeImageWithSourceMetadata(env, targetPath, outputBuffer, sourceMetadataPath, options),
    readSourceMetadataForExport: (sourcePath) => readSourceMetadataForExport(sourcePath, env),
  };
}

module.exports = { createImageMetadataWriter };
