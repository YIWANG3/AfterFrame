#!/usr/bin/env node
// Put the ArcFace face model at native/FaceEmbedding.mlpackage so
// electron-builder ships it (see electron/peopleModel.js for why it is bundled
// and not committed).
//
// Downloads the pinned archive once into native/.cache/, checks its SHA-256,
// unpacks it and checks the unpacked package against the hash the app expects.
// If native/bin/people-worker is built, it also runs the worker's self-test.
// A model already in place with the right hash is left alone.
//
//   node scripts/fetch-people-model.mjs             # fail if it can't be fetched (release builds)
//   node scripts/fetch-people-model.mjs --optional  # warn and carry on (dev)

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { BUNDLED_ARCFACE_R100: MODEL, pathDigest } = require("../electron/peopleModel.js");

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = path.join(DESKTOP_DIR, "native");
const CACHE_DIR = path.join(NATIVE_DIR, ".cache");
const ARCHIVE = path.join(CACHE_DIR, `${MODEL.model_path}.tar.gz`);
const TARGET = path.join(NATIVE_DIR, MODEL.model_path);
const WORKER = path.join(NATIVE_DIR, "bin", "people-worker");
const optional = process.argv.includes("--optional");

function log(message) {
  console.log(`fetch-people-model: ${message}`);
}

async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "AfterFrame/build" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} from ${new URL(url).host}`));
        return;
      }
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on("finish", resolve);
      output.on("error", reject);
      response.on("error", reject);
    });
    request.setTimeout(60_000, () => request.destroy(new Error("download stalled for 60 s")));
    request.on("error", reject);
  });
}

async function ensureArchive() {
  if (fs.existsSync(ARCHIVE) && await fileSha256(ARCHIVE) === MODEL.archive_sha256) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const partial = `${ARCHIVE}.partial`;
  log(`downloading ${(MODEL.archive_bytes / 1e6).toFixed(0)} MB from ${new URL(MODEL.archive_url).host}`);
  await download(MODEL.archive_url, partial);
  const actual = await fileSha256(partial);
  if (actual !== MODEL.archive_sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`archive SHA-256 is ${actual}, expected ${MODEL.archive_sha256}`);
  }
  fs.renameSync(partial, ARCHIVE);
}

async function unpack() {
  const listing = execFileSync("tar", ["-tzf", ARCHIVE], { encoding: "utf8" }).split("\n").filter(Boolean);
  const prefix = `${MODEL.model_path}/`;
  if (!listing.every((entry) => (entry === MODEL.model_path || entry.startsWith(prefix)) && !entry.split("/").includes(".."))) {
    throw new Error("archive has an unexpected layout");
  }
  const staging = fs.mkdtempSync(path.join(CACHE_DIR, "unpack-"));
  try {
    execFileSync("tar", ["-xzf", ARCHIVE, "-C", staging]);
    const unpacked = path.join(staging, MODEL.model_path);
    const { sha256 } = await pathDigest(unpacked);
    if (sha256 !== MODEL.manifest_hash) throw new Error(`unpacked model hash is ${sha256}, expected ${MODEL.manifest_hash}`);
    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.renameSync(unpacked, TARGET);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function selfTest() {
  if (process.platform !== "darwin" || !fs.existsSync(WORKER)) {
    log("people-worker not built, skipping the self-test");
    return;
  }
  const result = JSON.parse(execFileSync(WORKER, ["--model", TARGET, "--self-test"], { encoding: "utf8" }).trim());
  if (!result?.ok || Number(result.embedding_dimensions) !== MODEL.embedding_dimensions) {
    throw new Error(`people-worker self-test failed: ${JSON.stringify(result)}`);
  }
  log("people-worker self-test passed");
}

async function main() {
  if (fs.existsSync(TARGET) && (await pathDigest(TARGET)).sha256 === MODEL.manifest_hash) {
    log(`${MODEL.model_path} already in place`);
    return;
  }
  await ensureArchive();
  await unpack();
  try {
    selfTest();
  } catch (error) {
    fs.rmSync(TARGET, { recursive: true, force: true });
    throw error;
  }
  log(`${MODEL.model_path} ready in native/`);
}

main().catch((error) => {
  if (optional) {
    log(`skipped: ${error.message}. People recognition needs a model chosen in Settings until this succeeds.`);
    return;
  }
  console.error(`fetch-people-model: ${error.message}`);
  process.exit(1);
});
