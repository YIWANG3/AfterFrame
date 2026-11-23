// The Core ML models that ship inside the Mac app, in Resources/native/ next
// to the helpers that run them. None is committed: scripts/fetch-models.mjs
// downloads each archive from AfterFrame's own `models` release on GitHub,
// checks it, unpacks it into native/, and electron-builder copies
// native/*.mlpackage into the app (build.mac.extraResources in package.json,
// electron-builder.mac.cjs). Users never download a model.
//
// The release is a pre-release, so it never becomes "latest" (the site's
// download button points at releases/latest). Files on it are only ever
// added: never replaced or deleted, so every row an old checkout pins keeps
// working. A new model, or a new version of one, is a new file on the
// release and a row here.
//
// One row per model:
//   id            its name on the command line: fetch-models.mjs <id>
//   url           the archive (.tar.gz); its last path segment is also its
//                 file name in native/.cache/
//   fallbackUrls  tried in order when url can't be fetched or serves other bytes
//   sha256, bytes the archive's
//   license       and where the model comes from, in the comment above the row
//   target        the directory it unpacks to in native/; the archive holds
//                 that one directory and nothing else
//   dirHash       pathDigest() (electron/peopleModel.js) of the unpacked directory
//   missing       what doesn't work without it (dev runs carry on, with this warning)
//   selfTest      optional: { tool, check(toolPath, modelPath, scratchDir) },
//                 run when native/bin/<tool> is built (macOS)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { BUNDLED_ARCFACE_R100: FACE } = require("../electron/peopleModel.js");

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MODELS_RELEASE = "https://github.com/YIWANG3/AfterFrame/releases/download/models";

// A PNG's width and height from its IHDR chunk, or null.
function pngSize(file) {
  const header = fs.readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

export const MODELS = Object.freeze([
  // ArcFace R100 for people recognition, converted to Core ML from the ONNX
  // Model Zoo's arcfaceresnet100-8.onnx (Apache-2.0). Its pins live in
  // electron/peopleModel.js, because the app keys face indexes by them. The
  // archive is byte for byte the one on Hugging Face, which stays as the
  // fallback.
  {
    id: "face",
    url: FACE.archive_url,
    fallbackUrls: ["https://huggingface.co/RuiSumida/ArcFace-R100-CoreML/resolve/b51b655da6b4acc72bfdbfdcd316b3cf4f698e4e/FaceEmbedding.mlpackage.tar.gz"],
    sha256: FACE.archive_sha256,
    bytes: FACE.archive_bytes,
    license: FACE.license,
    target: FACE.model_path,
    dirHash: FACE.manifest_hash,
    missing: "People recognition needs a model chosen in Settings until this succeeds.",
    selfTest: {
      tool: "people-worker",
      check(tool, model) {
        const result = JSON.parse(execFileSync(tool, ["--model", model, "--self-test"], { encoding: "utf8" }).trim());
        if (!result?.ok || Number(result.embedding_dimensions) !== FACE.embedding_dimensions) {
          throw new Error(`people-worker self-test failed: ${JSON.stringify(result)}`);
        }
      },
    },
  },
  // Depth Anything V2 Small (F16) for scene depth behind text, Apple's Core ML
  // conversion (apple/coreml-depth-anything-v2-small on Hugging Face,
  // Apache-2.0). Run by native/compute-depth (electron/ipc/depth.js).
  {
    id: "depth",
    url: `${MODELS_RELEASE}/DepthAnythingV2SmallF16-c0c84db5.mlpackage.tar.gz`,
    sha256: "c0c84db536218b3103c9dafdec4bf0e8d26da86cc758bb85bc2b96056035aea8",
    bytes: 45821437,
    license: "Apache-2.0",
    target: "DepthAnythingV2SmallF16.mlpackage",
    dirHash: "a846ba9a5c2400b2d14f8ba84827015f0acfa602c7657aaf3b15a196de0dc174",
    missing: "Scene depth can't run until this succeeds.",
    selfTest: {
      tool: "compute-depth",
      check(tool, model, scratch) {
        const output = path.join(scratch, "depth.png");
        execFileSync(tool, [path.join(DESKTOP_DIR, "sample-photos", "sample-01.jpg"), output, model], { stdio: "pipe" });
        const size = fs.existsSync(output) ? pngSize(output) : null;
        if (!size?.width || !size?.height) throw new Error("compute-depth self-test wrote no depth map");
      },
    },
  },
]);

// The archive's file name: the last path segment of its URL.
export function archiveName(model) {
  return path.posix.basename(new URL(model.url).pathname);
}
