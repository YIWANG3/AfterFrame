#!/usr/bin/env node
// Put the Core ML models listed in scripts/bundled-models.mjs into native/,
// where electron-builder picks them up.
//
// For each model: download its pinned archive once into native/.cache/ (from
// AfterFrame's `models` release, else from its fallbacks), check the
// archive's SHA-256, unpack it and check the unpacked directory's hash, then
// run its self-test if the native helper is built. A model already in place
// with the right hash is left alone.
//
//   node scripts/fetch-models.mjs                 # every model; fail if one can't be fetched (release builds)
//   node scripts/fetch-models.mjs --optional      # warn and carry on (dev)
//   node scripts/fetch-models.mjs depth           # only the models named (the PR E2E job needs depth only)
//   node scripts/fetch-models.mjs --verify <dir>  # check the models in a packaged app's Resources/native (release.sh)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { download, ensureArchive, installFromStaging } from "./lib/download.mjs";
import { MODELS, archiveName } from "./bundled-models.mjs";

const require = createRequire(import.meta.url);
const { pathDigest } = require("../electron/peopleModel.js");

const SCRIPT = fileURLToPath(import.meta.url);
const NATIVE_DIR = path.join(path.dirname(SCRIPT), "..", "native");

function log(message) {
  console.log(`fetch-models: ${message}`);
}

async function inPlace(dir, model) {
  const target = path.join(dir, model.target);
  return fs.existsSync(target) && (await pathDigest(target)).sha256 === model.dirHash;
}

// The archive in the cache, fetched from url or else from each fallback in turn.
async function fetchArchive(model, { cacheDir, fetch }) {
  const urls = [model.url, ...(model.fallbackUrls || [])];
  const name = archiveName(model);
  for (const [index, url] of urls.entries()) {
    try {
      return await ensureArchive({
        cacheDir, name, url, sha256: model.sha256, log, fetch,
        describe: `${name}, ${(model.bytes / 1e6).toFixed(0)} MB from ${new URL(url).host}`,
      });
    } catch (error) {
      if (index === urls.length - 1) throw error;
      log(`${new URL(url).host}: ${error.message}; trying ${new URL(urls[index + 1]).host}`);
    }
  }
}

function unpack(archive, model, { cacheDir, target }) {
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const prefix = `${model.target}/`;
  if (!listing.every((entry) => (entry === model.target || entry.startsWith(prefix)) && !entry.split("/").includes(".."))) {
    throw new Error(`${path.basename(archive)} holds more than ${model.target}/`);
  }
  return installFromStaging({ cacheDir, target, build: async (staging) => {
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    const unpacked = path.join(staging, model.target);
    const { sha256 } = await pathDigest(unpacked);
    if (sha256 !== model.dirHash) throw new Error(`unpacked ${model.target} hash is ${sha256}, expected ${model.dirHash}`);
    return unpacked;
  } });
}

async function selfTest(model, { nativeDir, cacheDir, target }) {
  if (!model.selfTest) return;
  const { tool, check } = model.selfTest;
  const toolPath = path.join(nativeDir, "bin", tool);
  if (!fs.existsSync(toolPath)) {
    log(`${tool} not built, skipping the ${model.id} self-test`);
    return;
  }
  const scratch = fs.mkdtempSync(path.join(cacheDir, "self-test-"));
  try {
    await check(toolPath, target, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  log(`${tool} self-test passed`);
}

// Put one model in nativeDir. `fetch(url, destination)` defaults to download.
export async function installModel(model, { nativeDir = NATIVE_DIR, fetch = download } = {}) {
  const cacheDir = path.join(nativeDir, ".cache");
  const target = path.join(nativeDir, model.target);
  if (await inPlace(nativeDir, model)) {
    log(`${model.target} already in place`);
    return;
  }
  const archive = await fetchArchive(model, { cacheDir, fetch });
  await unpack(archive, model, { cacheDir, target });
  try {
    await selfTest(model, { nativeDir, cacheDir, target });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  log(`${model.target} ready in native/`);
}

function parseArgs(argv) {
  const options = { optional: false, verify: null, ids: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--optional") options.optional = true;
    else if (argv[i] === "--verify") options.verify = argv[++i] || "";
    else options.ids.push(argv[i]);
  }
  if (options.verify === "") throw new Error("--verify needs a directory");
  const unknown = options.ids.filter((id) => !MODELS.some((model) => model.id === id));
  if (unknown.length) throw new Error(`no model called ${unknown.join(", ")}; one of: ${MODELS.map((model) => model.id).join(", ")}`);
  options.models = options.ids.length ? MODELS.filter((model) => options.ids.includes(model.id)) : MODELS;
  return options;
}

async function main() {
  const { optional, verify, models } = parseArgs(process.argv.slice(2));
  if (verify) {
    const missing = [];
    for (const model of models) if (!(await inPlace(verify, model))) missing.push(model.target);
    if (missing.length) throw new Error(`missing or altered in ${verify}: ${missing.join(", ")}`);
    log(`${models.map((model) => model.target).join(", ")} intact in ${verify}`);
    return;
  }
  for (const model of models) {
    try {
      await installModel(model);
    } catch (error) {
      if (!optional) throw new Error(`${model.target}: ${error.message}`, { cause: error });
      log(`skipped ${model.target}: ${error.message}. ${model.missing}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main().catch((error) => {
    console.error(`fetch-models: ${error.message}`);
    process.exit(1);
  });
}
