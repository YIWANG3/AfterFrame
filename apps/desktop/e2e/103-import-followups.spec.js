// What follows an import, decided by the main process (electron/pipeline.js):
// annotating on import takes the photos that import added, and a cancelled
// import gets its follow-ups too; a people scan asked for while an import
// runs waits for it and goes on by itself, unless the user paused it; an
// agent's import behind a running one is queued, not refused.
//
// Annotation runs against a provider this spec serves on localhost (an
// OpenAI-compatible chat endpoint answering a fixed caption), so it costs
// nothing and counts exactly what was sent.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, callTool: mcpTool, waitForMcp, galleryCards } = require("./helpers/app");
const { makeImportDir } = require("./helpers/images");

// Big enough that the import is still running while the test acts on it
// (tiny files import at about 2 ms each here, 5 ms on CI), as in e2e/11.
const IMPORT_SIZE = process.platform === "win32" ? 1500 : 3000;
const FOLLOW_MS = process.platform === "win32" ? 180_000 : 90_000;

function fakeAnnotationProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, body: body.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ caption: "A photo the e2e provider looked at", tags: ["e2e"] }) } }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

const mw = (ctx) => ctx.window.evaluate.bind(ctx.window);

async function waitForImportsToEnd(ctx) {
  await expect.poll(() => mw(ctx)(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), {
    timeout: FOLLOW_MS, intervals: [500],
  }).toBe(false);
}

async function importRunning(ctx) {
  await expect.poll(() => mw(ctx)(() => window.mediaWorkspace.getImportStatus().then((s) => !!s?.running)), {
    timeout: 15_000, intervals: [100],
  }).toBe(true);
}

test.describe("annotation and the queue", () => {
  let ctx;
  let provider;
  const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
  const annotatable = (onlyMissing) => mw(ctx)((only) => window.mediaWorkspace.countAnnotationTargets({ onlyMissing: only }).then((r) => r.count), onlyMissing);
  const latestAnnotation = () => mw(ctx)(() => window.mediaWorkspace.getAnnotationJobStatus());

  test.beforeAll(async () => {
    provider = await fakeAnnotationProvider();
    ctx = await launchApp({ testName: "followups" });
    await waitForMcp(ctx.mcpPort);
    await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
    await mw(ctx)(async (baseUrl) => {
      await window.mediaWorkspace.saveAnnotationSettings({
        providers: [{ id: "a_e2e_local", type: "openai_compatible", name: "E2E local", baseUrl, model: "e2e-model" }],
        activeProviderId: "a_e2e_local",
        autoOnImport: true,
      });
    }, provider.baseUrl);
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
    provider?.server.close();
  });

  test("annotating on import takes the photos the import added, not the rest of the library", async () => {
    test.setTimeout(FOLLOW_MS + 30_000);
    const waiting = await annotatable(true);
    expect(waiting, "the seeded library has photos without captions").toBeGreaterThan(2);
    const dir = makeImportDir("annotate", 2);
    try {
      const result = await callTool("import_directory", { image_dirs: [dir] });
      expect(result.status).toBe("succeeded");
      await expect.poll(async () => (await latestAnnotation())?.status, { timeout: FOLLOW_MS, intervals: [500] }).toBe("succeeded");
      const job = await latestAnnotation();
      expect(job.result?.succeeded).toBe(2);
      expect(provider.requests.length).toBe(2);
      // The library's own photos still wait for the user to ask.
      expect(await annotatable(true)).toBe(waiting);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an import cancelled half-way has the photos it brought in annotated all the same", async () => {
    test.setTimeout(2 * FOLLOW_MS + 30_000);
    provider.requests.length = 0;
    const before = await annotatable(false);
    const waiting = await annotatable(true);
    const dir = makeImportDir("cut", IMPORT_SIZE);
    try {
      const pending = callTool("import_directory", { image_dirs: [dir] });
      await importRunning(ctx);
      // Some of it is in: then the user changes their mind.
      await expect.poll(() => annotatable(false), { timeout: FOLLOW_MS, intervals: [200] }).toBeGreaterThan(before + 50);
      const running = await mw(ctx)(() => window.mediaWorkspace.getImportStatus());
      await callTool("cancel_job", { job_id: running.jobId });
      await pending;
      await expect.poll(() => callTool("get_job_status", { job_id: running.jobId }).then((s) => s.status), { timeout: FOLLOW_MS }).toBe("cancelled");
      const added = (await annotatable(false)) - before;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(IMPORT_SIZE);

      await expect.poll(async () => {
        const job = await latestAnnotation();
        return job?.status === "succeeded" ? job.result?.succeeded : null;
      }, { timeout: FOLLOW_MS, intervals: [500] }).toBe(added);
      expect(provider.requests.length).toBe(added);
      expect(await annotatable(true)).toBe(waiting);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent's import behind a running one is queued and imported when that one ends", async () => {
    test.setTimeout(2 * FOLLOW_MS + 30_000);
    await mw(ctx)(() => window.mediaWorkspace.saveAnnotationSettings({ autoOnImport: false }));
    const before = await annotatable(false);
    const first = makeImportDir("first", IMPORT_SIZE);
    const second = makeImportDir("second", 3);
    try {
      const pending = callTool("import_directory", { image_dirs: [first] });
      await importRunning(ctx);
      const queued = await callTool("import_directory", { image_dirs: [second] });
      expect(queued.queued).toBe(true);
      expect(queued.job_id).toBeNull();
      expect(queued.note).toMatch(/queued/);
      await pending;
      await expect.poll(() => annotatable(false), { timeout: 2 * FOLLOW_MS, intervals: [1_000] }).toBe(before + IMPORT_SIZE + 3);
      await waitForImportsToEnd(ctx);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

test.describe("a people scan and an import", () => {
  let ctx;
  const callTool = (name, args) => mcpTool(ctx.mcpPort, name, args);
  const scan = () => mw(ctx)(() => window.mediaWorkspace.getPeopleIndexStatus());

  const MODEL = path.join(__dirname, "..", "native", "FaceEmbedding.mlpackage");
  test.skip(process.platform !== "darwin" || !fs.existsSync(MODEL), "needs the bundled face model (npm run fetch:models) on macOS");

  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "followups-people", peopleModel: "real" });
    await waitForMcp(ctx.mcpPort);
    await expect(galleryCards(ctx.window).first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  async function stopScan() {
    const job = await scan();
    if (job?.active) await mw(ctx)((jobId) => window.mediaWorkspace.cancelJob(jobId), job.jobId);
    await expect.poll(async () => (await scan())?.active, { timeout: 30_000 }).toBe(false);
  }

  test("a scan asked for while an import runs waits for it, then goes on by itself", async () => {
    test.setTimeout(2 * FOLLOW_MS);
    const dir = makeImportDir("busy", IMPORT_SIZE);
    try {
      const pending = callTool("import_directory", { image_dirs: [dir] });
      await importRunning(ctx);
      const started = await mw(ctx)(() => window.mediaWorkspace.startPeopleIndex({}));
      expect(started.status).toBe("paused");
      expect(started.pausedForImport).toBe(true);
      await expect(ctx.window.getByText("Waits for the import")).toBeVisible({ timeout: 10_000 });

      await pending;
      await waitForImportsToEnd(ctx);
      await expect.poll(async () => (await scan())?.status, { timeout: 30_000, intervals: [250] }).not.toBe("paused");
      expect((await scan()).jobId).toBe(started.jobId);
      await stopScan();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scan the user paused while it waited stays paused after the import", async () => {
    test.setTimeout(2 * FOLLOW_MS);
    const dir = makeImportDir("busy2", IMPORT_SIZE);
    try {
      const pending = callTool("import_directory", { image_dirs: [dir] });
      await importRunning(ctx);
      const started = await mw(ctx)(() => window.mediaWorkspace.startPeopleIndex({}));
      expect(started.pausedForImport).toBe(true);
      await mw(ctx)((jobId) => window.mediaWorkspace.pauseJob(jobId), started.jobId);

      await pending;
      await waitForImportsToEnd(ctx);
      // The sweep after an import's end runs within a quarter second of it:
      // long enough to have resumed it, had it been the app's to resume.
      await ctx.window.waitForTimeout(2_000);
      const job = await scan();
      expect(job.status).toBe("paused");
      expect(job.pausedForImport).toBe(false);
      await expect(ctx.window.getByText("Waits for the import")).toHaveCount(0);
      await stopScan();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
