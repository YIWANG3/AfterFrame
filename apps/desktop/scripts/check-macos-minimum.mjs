#!/usr/bin/env node
// Fail when anything built for the app needs a newer macOS than the app itself.
//
// 0.5.8 declared macOS 12 (Electron's minimum) but shipped a sidecar built
// with Homebrew's Python 3.14, whose framework, standard-library modules and
// numpy all said macOS 15. On macOS 12–14 the window opened, but the sidecar
// couldn't load, so nothing could be imported or browsed — and nothing in the
// build noticed.
//
//   node scripts/check-macos-minimum.mjs [dir ...]   # default: the built sidecar
//
// The app's minimum is package.json build.mac.minimumSystemVersion, or
// Electron's own (LSMinimumSystemVersion in its Info.plist) when that isn't
// set. Every Mach-O file under the given folders must need no newer macOS.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRS = [path.resolve(DESKTOP_DIR, "../../services/sidecar/dist/media-workspace")];
// Thin and universal Mach-O, either byte order.
const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

function appMinimum() {
  const require = createRequire(import.meta.url);
  const { build } = require(path.join(DESKTOP_DIR, "package.json"));
  if (build?.mac?.minimumSystemVersion) return build.mac.minimumSystemVersion;
  const plist = path.join(path.dirname(require.resolve("electron")), "dist", "Electron.app", "Contents", "Info.plist");
  return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :LSMinimumSystemVersion", plist], { encoding: "utf8" }).trim();
}

const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};

function isMachO(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGICS.has(head.readUInt32BE(0));
  } finally {
    fs.closeSync(fd);
  }
}

// The newest macOS any slice of `file` asks for: LC_BUILD_VERSION's minos, or
// LC_VERSION_MIN_MACOSX's version on older binaries. (vtool's other "version"
// lines are tool versions, so only that load command's is read.)
function minimumOf(file) {
  const out = execFileSync("xcrun", ["vtool", "-show-build", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const found = [];
  for (const block of out.split(/Load command \d+/)) {
    if (/cmd LC_BUILD_VERSION/.test(block) && /platform MACOS\b/.test(block)) {
      const match = /^\s*minos\s+([\d.]+)/m.exec(block);
      if (match) found.push(match[1]);
    } else if (/cmd LC_VERSION_MIN_MACOSX/.test(block)) {
      const match = /^\s*version\s+([\d.]+)/m.exec(block);
      if (match) found.push(match[1]);
    }
  }
  return found.sort(compareVersions).pop() || null;
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

const minimum = appMinimum();
const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((dir) => path.resolve(dir)) : DEFAULT_DIRS;
const tooNew = [];
let checked = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.error(`check-macos-minimum: ${dir} does not exist`);
    process.exit(1);
  }
  for (const file of files(dir)) {
    if (!isMachO(file)) continue;
    checked += 1;
    const needs = minimumOf(file);
    if (needs && compareVersions(needs, minimum) > 0) tooNew.push({ needs, file: path.relative(dir, file) });
  }
}

if (tooNew.length) {
  console.error(`✗ ${tooNew.length} of ${checked} binaries need a newer macOS than the app's ${minimum}:`);
  for (const { needs, file } of tooNew.slice(0, 15)) console.error(`    macOS ${needs}  ${file}`);
  if (tooNew.length > 15) console.error(`    … and ${tooNew.length - 15} more`);
  console.error("  The sidecar must be built with a Python made for an older macOS: scripts/build-sidecar-mac.sh.");
  process.exit(1);
}
console.log(`check-macos-minimum: ${checked} binaries, none needs more than macOS ${minimum}`);
