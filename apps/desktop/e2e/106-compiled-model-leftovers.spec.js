// Launching the app removes the compiled copies of its bundled models that the
// native helpers left in the temporary folder (electron/compiledModelLeftovers.js).
// people-worker left one there each time a worker started, 125 MB each and
// three workers a scan, until #359; macOS empties that folder only when the
// Mac restarts, so a Mac that stays on collected gigabytes. Only the face, pet
// and depth models' copies in Core ML's own <Name>_<UUID>.mlmodelc form go,
// and only once they are a few minutes old: anything else there may be
// another app's, and a young one may still be compiling.

const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { launchApp, closeApp } = require("./helpers/app");

test.skip(process.platform !== "darwin", "Core ML compiles into a macOS-only folder");

const DAY = 24 * 60 * 60 * 1000;

test("launching removes the compiled models left in the temporary folder, and nothing else", async () => {
  // Core ML's folder, whatever TMPDIR says.
  const temp = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  const compiled = (model, ageMs) => {
    const dir = path.join(temp, `${model}_${crypto.randomUUID().toUpperCase()}.mlmodelc`);
    fs.mkdirSync(path.join(dir, "model.mil"), { recursive: true });
    fs.writeFileSync(path.join(dir, "coremldata.bin"), "x");
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  };
  const leftovers = [compiled("FaceEmbedding", DAY), compiled("PetEmbedding", DAY), compiled("DepthAnythingV2SmallF16", 3 * DAY)];
  const kept = [compiled("FaceEmbedding", 0), compiled("AfterFrameE2EOtherModel", DAY)];
  const present = (dirs) => dirs.filter((dir) => fs.existsSync(dir));

  let ctx;
  try {
    ctx = await launchApp({ testName: "compiled-leftovers" });
    await expect.poll(() => present(leftovers), { timeout: 15_000 }).toEqual([]);
    expect(present(kept)).toEqual(kept);
  } finally {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    for (const dir of [...leftovers, ...kept]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
