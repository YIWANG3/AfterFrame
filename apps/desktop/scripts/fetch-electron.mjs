#!/usr/bin/env node
// Put the Electron binary in place before anything launches it.
//
// Electron 43 has no postinstall: `npm ci` leaves node_modules/electron
// without its binary, and the first `require("electron")` — in CI, every
// Playwright worker's electron.launch — downloads the zip from GitHub's
// release CDN right then. A bad moment there (504s on 2026-11-08, #266)
// fails every spec with "Electron failed to install correctly".
//
// This runs Electron's own installer, with the zip kept in
// native/.cache/electron/ so CI can keep it between runs (actions/cache
// keyed by the Electron version) and a later run never downloads at all.
// One already in place is left alone.
//
// When the installer's download fails, the same release asset is fetched
// through GitHub's REST API instead (api.github.com → the asset CDN), which
// kept working on 2026-11-08 while the releases/download/ link returned
// 504 for hours. The zip goes into the installer's cache under the name
// it looks for, and the installer then checks it against the checksums.json
// shipped inside the electron npm package before extracting, as it does
// with its own downloads. GITHUB_TOKEN, when set, authenticates the API
// calls (a shared runner IP can run out of anonymous requests).
//
//   node scripts/fetch-electron.mjs            # the installer first, the API when it fails
//   node scripts/fetch-electron.mjs --via-api  # the API first (a known-bad release link)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON_DIR = path.join(DESKTOP_DIR, "node_modules", "electron");
const CACHE_DIR = path.join(DESKTOP_DIR, "native", ".cache", "electron");
const ATTEMPTS = 4;
const RELEASES = "https://github.com/electron/electron/releases/download";
const API = "https://api.github.com/repos/electron/electron/releases";

const { version } = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, "package.json"), "utf8"));
const checksums = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, "checksums.json"), "utf8"));
// The platform and arch install.js resolves (its own env overrides first).
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
fs.mkdirSync(CACHE_DIR, { recursive: true });

function runInstaller() {
  // install.js exits 0 at once when the binary is there and current.
  const result = spawnSync(process.execPath, [path.join(ELECTRON_DIR, "install.js")], {
    stdio: "inherit",
    env: { ...process.env, electron_config_cache: CACHE_DIR },
  });
  return result.status === 0;
}

// Where @electron/get keeps (and looks for) this zip: cacheRoot / sha256 of
// the download URL's directory / file name (its Cache.getCacheDirectory).
function cachePath() {
  const dir = crypto.createHash("sha256").update(`${RELEASES}/v${version}`).digest("hex");
  return path.join(CACHE_DIR, dir, fileName);
}

function apiHeaders(accept) {
  const headers = { Accept: accept, "User-Agent": "afterframe-fetch-electron", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

// Fetches the release asset through the API into the installer's cache.
// Checked against the shipped checksum before it is put there (the
// installer checks again), so a wrong download is never left in the cache.
async function seedCacheFromApi() {
  const expected = checksums[fileName];
  if (!expected) throw new Error(`no shipped checksum for ${fileName}`);
  const release = await fetch(`${API}/tags/v${version}`, { headers: apiHeaders("application/vnd.github+json") });
  if (!release.ok) throw new Error(`release lookup: HTTP ${release.status}`);
  const asset = (await release.json()).assets?.find((entry) => entry.name === fileName);
  if (!asset) throw new Error(`${fileName} is not among the release's assets`);
  // The API answers with a redirect to the asset CDN; fetch follows it and
  // drops the Authorization header on the way (a different origin).
  const download = await fetch(asset.url, { headers: apiHeaders("application/octet-stream") });
  if (!download.ok || !download.body) throw new Error(`asset download: HTTP ${download.status}`);
  const target = cachePath();
  const partial = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const hash = crypto.createHash("sha256");
  await pipeline(
    Readable.fromWeb(download.body),
    async function* (chunks) { for await (const chunk of chunks) { hash.update(chunk); yield chunk; } },
    fs.createWriteStream(partial),
  );
  const actual = hash.digest("hex");
  if (actual !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error(`checksum mismatch: ${actual} (expected ${expected})`);
  }
  fs.renameSync(partial, target);
  return target;
}

if (process.argv.includes("--via-api")) {
  try {
    await seedCacheFromApi();
    console.log(`[fetch-electron] fetched ${fileName} through the GitHub API into the installer's cache`);
  } catch (err) {
    console.warn(`[fetch-electron] the API route failed (${err.message}); the installer downloads itself`);
  }
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  if (runInstaller()) {
    const how = attempt === 1 ? "" : ` on attempt ${attempt}`;
    console.log(`[fetch-electron] Electron ${version} in place (${path.relative(DESKTOP_DIR, ELECTRON_DIR)}/dist)${how}`);
    process.exit(0);
  }
  if (attempt === ATTEMPTS) break;
  console.warn(`[fetch-electron] the installer could not download ${fileName} (attempt ${attempt}/${ATTEMPTS})`);
  try {
    await seedCacheFromApi();
    console.log(`[fetch-electron] fetched ${fileName} through the GitHub API into the installer's cache; installing from it`);
  } catch (err) {
    const wait = 15 * attempt;
    console.warn(`[fetch-electron] the API route failed too (${err.message}); retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}
console.error(`[fetch-electron] Electron ${version} could not be downloaded after ${ATTEMPTS} attempts`);
process.exit(1);
