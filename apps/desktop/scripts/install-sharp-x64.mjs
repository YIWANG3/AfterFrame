#!/usr/bin/env node
// Add sharp's macOS x64 binaries for the Intel build (electron-builder.intel.cjs).
//
// npm installs only the current Mac's binaries, so on Apple silicon the Intel
// build would ship without sharp, and main.js requires it at the top: the app
// would start with no window (as an arm64 build without sharp once did). This
// installs the x64 packages at the versions this sharp asks for, next to the
// arm64 ones, without touching package.json or the lockfile.
//
//   node scripts/install-sharp-x64.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "node_modules", "sharp", "package.json"), "utf8"));
const wanted = Object.entries(sharp.optionalDependencies || {}).filter(([name]) => /^@img\/sharp-(libvips-)?darwin-x64$/.test(name));
if (wanted.length !== 2) {
  console.error(`✗ sharp ${sharp.version} doesn't list its two darwin-x64 packages; found: ${wanted.map(([name]) => name).join(", ") || "none"}`);
  process.exit(1);
}

const installedVersion = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

const missing = wanted.filter(([name, version]) => installedVersion(name) !== version);
if (missing.length) {
  const specs = missing.map(([name, version]) => `${name}@${version}`);
  console.log(`install-sharp-x64: ${specs.join(" ")}`);
  // --force: these packages declare cpu x64, which npm otherwise refuses here.
  execFileSync("npm", ["install", "--no-save", "--force", "--no-audit", "--no-fund", ...specs], { cwd: DESKTOP_DIR, stdio: "inherit" });
}
for (const [name, version] of wanted) {
  if (installedVersion(name) !== version) {
    console.error(`✗ ${name}@${version} did not install`);
    process.exit(1);
  }
}
console.log(`install-sharp-x64: sharp ${sharp.version} has its x64 binaries`);
