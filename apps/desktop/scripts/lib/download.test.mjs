import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyTree, ensureArchive, fileSha256, installFromStaging } from "./download.mjs";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-download-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("fileSha256 streams the file", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "a.bin");
  fs.writeFileSync(file, "hello");
  assert.equal(await fileSha256(file), sha("hello"));
});

test("ensureArchive: fetches once into .partial, checks the hash, keeps an intact cached copy, replaces a corrupt one", async (t) => {
  const cacheDir = path.join(scratch(t), "cache");
  const fetched = [];
  const fetch = async (url, destination) => { fetched.push([url, path.basename(destination)]); fs.writeFileSync(destination, "payload"); };
  const spec = { cacheDir, name: "x.tar.gz", url: "https://example.test/x.tar.gz", sha256: sha("payload"), fetch };

  const file = await ensureArchive(spec);
  assert.equal(file, path.join(cacheDir, "x.tar.gz"));
  assert.deepEqual(fetched, [["https://example.test/x.tar.gz", "x.tar.gz.partial"]]);
  assert.equal(fs.existsSync(`${file}.partial`), false);

  await ensureArchive(spec);
  assert.equal(fetched.length, 1, "an intact cached archive is not fetched again");

  fs.writeFileSync(file, "corrupt");
  await ensureArchive(spec);
  assert.equal(fetched.length, 2, "a cached archive with the wrong hash is fetched again");
  assert.equal(fs.readFileSync(file, "utf8"), "payload");
});

test("ensureArchive: a download with the wrong hash is rejected and its .partial removed", async (t) => {
  const cacheDir = path.join(scratch(t), "cache");
  const fetch = async (_url, destination) => fs.writeFileSync(destination, "tampered");
  await assert.rejects(
    ensureArchive({ cacheDir, name: "x.zip", url: "https://example.test/x.zip", sha256: sha("payload"), fetch }),
    /x\.zip SHA-256 is .*, expected/,
  );
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test("installFromStaging: the target is replaced only by a completed build, and the scratch dirs never survive", async (t) => {
  const dir = scratch(t);
  const cacheDir = path.join(dir, "cache");
  const target = path.join(dir, "tool");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old"), "old");

  await assert.rejects(installFromStaging({
    cacheDir, target,
    build: (_staging, assembled) => { fs.mkdirSync(assembled); fs.writeFileSync(path.join(assembled, "half"), ""); throw new Error("unpack failed"); },
  }), /unpack failed/);
  assert.deepEqual(fs.readdirSync(target), ["old"], "a failed build leaves the old target alone");
  assert.deepEqual(fs.readdirSync(cacheDir), [], "no staging directory left behind");
  assert.equal(fs.existsSync(`${target}.partial`), false);

  await installFromStaging({
    cacheDir, target,
    build: (_staging, assembled) => { fs.mkdirSync(assembled); fs.writeFileSync(path.join(assembled, "new"), "new"); },
  });
  assert.deepEqual(fs.readdirSync(target), ["new"]);

  // A build may hand back a directory inside staging instead of assembling one.
  await installFromStaging({
    cacheDir, target,
    build: (staging) => { const made = path.join(staging, "unpacked"); fs.mkdirSync(made); fs.writeFileSync(path.join(made, "from-staging"), ""); return made; },
  });
  assert.deepEqual(fs.readdirSync(target), ["from-staging"]);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test("copyTree copies recursively and honours the keep filter", (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "keep.pm"), "");
  fs.writeFileSync(path.join(dir, "src", "lib", "drop.pod"), "");
  fs.writeFileSync(path.join(dir, "src", "lib", "keep2.pm"), "");
  copyTree(path.join(dir, "src"), path.join(dir, "out"), (f) => !f.endsWith(".pod"));
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")).sort(), ["keep.pm", "lib"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "out", "lib")), ["keep2.pm"]);
});
