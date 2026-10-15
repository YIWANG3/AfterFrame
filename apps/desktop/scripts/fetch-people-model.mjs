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

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ensureArchive, installFromStaging, runFetch } from "./lib/download.mjs";

const require = createRequire(import.meta.url);
const { BUNDLED_ARCFACE_R100: MODEL, pathDigest } = require("../electron/peopleModel.js");

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = path.join(DESKTOP_DIR, "native");
const CACHE_DIR = path.join(NATIVE_DIR, ".cache");
const ARCHIVE_NAME = `${MODEL.model_path}.tar.gz`;
const TARGET = path.join(NATIVE_DIR, MODEL.model_path);
const WORKER = path.join(NATIVE_DIR, "bin", "people-worker");
const optional = process.argv.includes("--optional");

function log(message) {
  console.log(`fetch-people-model: ${message}`);
}

function unpack(archive) {
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);
  const prefix = `${MODEL.model_path}/`;
  if (!listing.every((entry) => (entry === MODEL.model_path || entry.startsWith(prefix)) && !entry.split("/").includes(".."))) {
    throw new Error("archive has an unexpected layout");
  }
  return installFromStaging({ cacheDir: CACHE_DIR, target: TARGET, build: async (staging) => {
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    const unpacked = path.join(staging, MODEL.model_path);
    const { sha256 } = await pathDigest(unpacked);
    if (sha256 !== MODEL.manifest_hash) throw new Error(`unpacked model hash is ${sha256}, expected ${MODEL.manifest_hash}`);
    return unpacked;
  } });
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
  const archive = await ensureArchive({
    cacheDir: CACHE_DIR, name: ARCHIVE_NAME, url: MODEL.archive_url, sha256: MODEL.archive_sha256, log,
    describe: `${(MODEL.archive_bytes / 1e6).toFixed(0)} MB from ${new URL(MODEL.archive_url).host}`,
  });
  await unpack(archive);
  try {
    selfTest();
  } catch (error) {
    fs.rmSync(TARGET, { recursive: true, force: true });
    throw error;
  }
  log(`${MODEL.model_path} ready in native/`);
}

runFetch(main, { name: "fetch-people-model", optional, consequence: "People recognition needs a model chosen in Settings until this succeeds." });
