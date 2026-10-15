// What the fetch-* scripts share (review 2026-10-14 §H): a pinned archive
// downloaded once into a cache and checked against its SHA-256, and an
// unpack that assembles the result beside the target and swaps it in only
// when it is complete, so a failed or interrupted run leaves no half-made
// target behind.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

export async function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function download(url, destination, { redirects = 0, maxRedirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "AfterFrame/build" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < maxRedirects) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, { redirects: redirects + 1, maxRedirects }).then(resolve, reject);
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

// The archive at cacheDir/name with the given SHA-256: kept if already there
// and intact, else fetched (into a .partial first) and checked. Returns its
// path. `fetch(url, destination)` defaults to download; `describe` is what
// the log says it is downloading.
export async function ensureArchive({ cacheDir, name, url, sha256, log = () => {}, describe = name, fetch = download }) {
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file) && await fileSha256(file) === sha256) return file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const partial = `${file}.partial`;
  log(`downloading ${describe}`);
  await fetch(url, partial);
  const actual = await fileSha256(partial);
  if (actual !== sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`${name} SHA-256 is ${actual}, expected ${sha256}`);
  }
  fs.renameSync(partial, file);
  return file;
}

// Run `build(staging, assembled)` with a fresh staging directory under
// cacheDir and an empty `${target}.partial`; what it returns (default: the
// assembled directory) replaces target in one rename. Both scratch
// directories are removed afterwards, whatever happened.
export async function installFromStaging({ cacheDir, target, build }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheDir, "unpack-"));
  const assembled = `${target}.partial`;
  try {
    fs.rmSync(assembled, { recursive: true, force: true });
    const result = (await build(staging, assembled)) || assembled;
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(result, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(assembled, { recursive: true, force: true });
  }
}

export function copyTree(from, to, keep = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, destination, keep);
    else if (keep(source)) fs.copyFileSync(source, destination);
  }
}

// The `main().catch(...)` tail the three scripts share: with --optional a
// failure is a warning and the build goes on; otherwise it fails the build.
export function runFetch(main, { name, optional, consequence }) {
  main().catch((error) => {
    if (optional) {
      console.log(`${name}: skipped: ${error.message}. ${consequence}`);
      return;
    }
    console.error(`${name}: ${error.message}`);
    process.exit(1);
  });
}
