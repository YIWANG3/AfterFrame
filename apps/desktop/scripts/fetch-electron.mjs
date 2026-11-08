#!/usr/bin/env node
// Put the Electron binary in place before anything launches it.
//
// Electron 43 has no postinstall: `npm ci` leaves node_modules/electron
// without its binary, and the first `require("electron")` — in CI, every
// Playwright worker's electron.launch — downloads the zip from GitHub's
// release CDN right then. A bad moment there (two 504s on 2026-11-08,
// #266) fails every spec with "Electron failed to install correctly".
//
// This runs Electron's own installer once, retrying on a failed download,
// with the zip kept in native/.cache/electron/ so CI can keep it between
// runs (actions/cache keyed by the Electron version) and a later run never
// asks GitHub at all. One already in place is left alone.
//
//   node scripts/fetch-electron.mjs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON_DIR = path.join(DESKTOP_DIR, "node_modules", "electron");
const CACHE_DIR = path.join(DESKTOP_DIR, "native", ".cache", "electron");
const ATTEMPTS = 5;

const { version } = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, "package.json"), "utf8"));
fs.mkdirSync(CACHE_DIR, { recursive: true });

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  // install.js exits 0 at once when the binary is there and current.
  const result = spawnSync(process.execPath, [path.join(ELECTRON_DIR, "install.js")], {
    stdio: "inherit",
    env: { ...process.env, electron_config_cache: CACHE_DIR },
  });
  if (result.status === 0) {
    console.log(`[fetch-electron] Electron ${version} in place (${path.relative(DESKTOP_DIR, ELECTRON_DIR)}/dist)`);
    process.exit(0);
  }
  if (attempt < ATTEMPTS) {
    const wait = 15 * attempt;
    console.warn(`[fetch-electron] download of Electron ${version} failed (attempt ${attempt}/${ATTEMPTS}); retrying in ${wait}s`);
    const until = Date.now() + wait * 1000;
    // Nothing else to do meanwhile: a plain wait keeps the script dependency-free.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());
  }
}
console.error(`[fetch-electron] Electron ${version} could not be downloaded after ${ATTEMPTS} attempts`);
process.exit(1);
