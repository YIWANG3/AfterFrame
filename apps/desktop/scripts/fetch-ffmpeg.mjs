#!/usr/bin/env node
// Put FFmpeg at native/ffmpeg/ on Windows, so electron-builder ships it and
// the sidecar makes video posters, durations, the filmstrip and the HEVC
// playback proxy with it (services/sidecar/src/media_workspace/ffmpeg_video.py).
// macOS has its own video-tool (AVFoundation) and needs none.
//
// The build is BtbN's LGPL one with shared libraries (no GPL parts: no x264,
// x265), from a month-end autobuild, which BtbN keeps for good; daily ones
// go after two weeks. Only bin/ is kept, without ffplay.exe, and the licence.
//
// Downloads the pinned archive once into native/.cache/, checks its SHA-256
// (the digest GitHub lists for the release asset), unpacks it and checks that
// the result reports the expected version. One already in place is left alone.
//
//   node scripts/fetch-ffmpeg.mjs             # fail if it can't be fetched (release builds)
//   node scripts/fetch-ffmpeg.mjs --optional  # warn and carry on (dev)

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "n9.0.2-17-g2a571b6068";
const RELEASE = "autobuild-2026-09-30-13-08";
const ARCHIVE = {
  name: `ffmpeg-${VERSION}-win64-lgpl-shared-9.0.zip`,
  sha256: "7157177b8a6cb2174c1650ba8c71b363f2c78cba5330f88c4c02cf5b2b880646",
};
const downloadUrl = (name) => `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${name}`;

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = path.join(DESKTOP_DIR, "native");
const CACHE_DIR = path.join(NATIVE_DIR, ".cache");
const TARGET = path.join(NATIVE_DIR, "ffmpeg");
const MARKER = path.join(TARGET, "AFTERFRAME_VERSION");
const optional = process.argv.includes("--optional");

function log(message) {
  console.log(`fetch-ffmpeg: ${message}`);
}

async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "AfterFrame/build" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 8) {
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
  const file = path.join(CACHE_DIR, ARCHIVE.name);
  if (fs.existsSync(file) && await fileSha256(file) === ARCHIVE.sha256) return file;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const partial = `${file}.partial`;
  log(`downloading ${ARCHIVE.name}`);
  await download(downloadUrl(ARCHIVE.name), partial);
  const actual = await fileSha256(partial);
  if (actual !== ARCHIVE.sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`${ARCHIVE.name} SHA-256 is ${actual}, expected ${ARCHIVE.sha256}`);
  }
  fs.renameSync(partial, file);
  return file;
}

function unpack(file) {
  const staging = fs.mkdtempSync(path.join(CACHE_DIR, "unpack-"));
  const assembled = `${TARGET}.partial`;
  try {
    // bsdtar (Windows 10+) reads zip.
    execFileSync("tar", ["-xf", file, "-C", staging]);
    fs.rmSync(assembled, { recursive: true, force: true });
    fs.mkdirSync(assembled, { recursive: true });
    const root = path.join(staging, ARCHIVE.name.replace(/\.zip$/, ""));
    for (const name of fs.readdirSync(path.join(root, "bin"))) {
      if (name === "ffplay.exe") continue;
      fs.copyFileSync(path.join(root, "bin", name), path.join(assembled, name));
    }
    fs.copyFileSync(path.join(root, "LICENSE.txt"), path.join(assembled, "LICENSE.txt"));
    const reported = execFileSync(path.join(assembled, "ffmpeg.exe"), ["-hide_banner", "-version"], { encoding: "utf8" });
    if (!reported.startsWith(`ffmpeg version ${VERSION}`)) {
      throw new Error(`unpacked FFmpeg reports "${reported.split("\n")[0]}", expected ${VERSION}`);
    }
    fs.writeFileSync(path.join(assembled, "AFTERFRAME_VERSION"), `${VERSION}\n`);
    fs.rmSync(TARGET, { recursive: true, force: true });
    fs.renameSync(assembled, TARGET);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(assembled, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "win32") {
    log("only Windows bundles FFmpeg (macOS has video-tool); nothing to do");
    return;
  }
  if (fs.existsSync(MARKER) && fs.readFileSync(MARKER, "utf8").trim() === VERSION) {
    log(`FFmpeg ${VERSION} already in place`);
    return;
  }
  unpack(await ensureArchive());
  log(`FFmpeg ${VERSION} is in native/ffmpeg`);
}

main().catch((error) => {
  if (optional) {
    log(`skipped: ${error.message}. Video posters and playback on Windows need it; run npm run fetch:ffmpeg.`);
    return;
  }
  console.error(`fetch-ffmpeg: ${error.message}`);
  process.exit(1);
});
