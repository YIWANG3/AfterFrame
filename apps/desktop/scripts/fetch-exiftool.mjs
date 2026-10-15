#!/usr/bin/env node
// Put ExifTool at native/exiftool/ so electron-builder ships it and the sidecar
// reads photo metadata with it (services/sidecar/src/media_workspace/exiftool.py).
//
// - Windows: the official 64-bit build, which brings its own Perl. Its
//   launcher is renamed to exiftool.exe: as "exiftool(-k).exe" it waits for a
//   key press after every run.
// - macOS (and Linux, for CI): the Perl distribution's script and modules,
//   run by the system's perl. The .pod manuals are left out (2.4 MB).
//
// Downloads the pinned archive once into native/.cache/, checks its SHA-256
// (the values in exiftool.org/checksums.txt), unpacks it and checks that the
// result reports the expected version. One already in place is left alone.
//
//   node scripts/fetch-exiftool.mjs             # fail if it can't be fetched (release builds)
//   node scripts/fetch-exiftool.mjs --optional  # warn and carry on (dev)

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyTree, ensureArchive, installFromStaging, runFetch } from "./lib/download.mjs";

const VERSION = "13.59";
const ARCHIVES = {
  perl: {
    name: `Image-ExifTool-${VERSION}.tar.gz`,
    sha256: "668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a",
  },
  windows: {
    name: `exiftool-${VERSION}_64.zip`,
    sha256: "44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec",
  },
};
// exiftool.org serves only the newest release; SourceForge keeps every one.
const downloadUrl = (name) => `https://sourceforge.net/projects/exiftool/files/${name}/download`;

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = path.join(DESKTOP_DIR, "native");
const CACHE_DIR = path.join(NATIVE_DIR, ".cache");
const TARGET = path.join(NATIVE_DIR, "exiftool");
const MARKER = path.join(TARGET, "AFTERFRAME_VERSION");
const optional = process.argv.includes("--optional");
const flavour = process.platform === "win32" ? "windows" : "perl";
const archive = ARCHIVES[flavour];

function log(message) {
  console.log(`fetch-exiftool: ${message}`);
}

// The command the sidecar runs (exiftool.py's find_command, in short).
function command(folder) {
  if (flavour === "windows") return [path.join(folder, "exiftool.exe"), []];
  const perl = process.platform === "darwin" ? "/usr/bin/perl" : "perl";
  return [perl, [path.join(folder, "exiftool")]];
}

function unpack(file) {
  return installFromStaging({ cacheDir: CACHE_DIR, target: TARGET, build: (staging, assembled) => {
    // bsdtar (macOS, Windows 10+) reads zip as well as tar.gz.
    execFileSync("tar", ["-xf", file, "-C", staging]);
    if (flavour === "windows") {
      const root = path.join(staging, `exiftool-${VERSION}_64`);
      copyTree(path.join(root, "exiftool_files"), path.join(assembled, "exiftool_files"));
      fs.copyFileSync(path.join(root, "exiftool(-k).exe"), path.join(assembled, "exiftool.exe"));
    } else {
      const root = path.join(staging, `Image-ExifTool-${VERSION}`);
      copyTree(path.join(root, "lib"), path.join(assembled, "lib"), (source) => !source.endsWith(".pod"));
      for (const name of ["exiftool", "README"]) fs.copyFileSync(path.join(root, name), path.join(assembled, name));
      fs.chmodSync(path.join(assembled, "exiftool"), 0o755);
    }
    const [cmd, args] = command(assembled);
    const reported = execFileSync(cmd, [...args, "-ver"], { encoding: "utf8" }).trim();
    if (reported !== VERSION) throw new Error(`unpacked ExifTool reports ${reported}, expected ${VERSION}`);
    fs.writeFileSync(path.join(assembled, "AFTERFRAME_VERSION"), `${VERSION} ${flavour}\n`);
  } });
}

async function main() {
  if (fs.existsSync(MARKER) && fs.readFileSync(MARKER, "utf8").trim() === `${VERSION} ${flavour}`) {
    log(`ExifTool ${VERSION} already in place`);
    return;
  }
  const file = await ensureArchive({ cacheDir: CACHE_DIR, name: archive.name, url: downloadUrl(archive.name), sha256: archive.sha256, log });
  await unpack(file);
  log(`ExifTool ${VERSION} (${flavour}) is in native/exiftool`);
}

runFetch(main, { name: "fetch-exiftool", optional, consequence: "Photo metadata needs it; run npm run fetch:exiftool." });
