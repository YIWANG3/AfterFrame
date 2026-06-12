// JobDock for agent-started work: the dock card appears while an MCP-launched
// import runs, self-dismisses when idle, and its Cancel button performs the
// cooperative cancel (status → cancelled, observable back through MCP).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;

const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

function makeImportDir(prefix, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${prefix}-`));
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `${prefix}_${String(i).padStart(3, "0")}.jpg`), TINY_JPEG);
  }
  return dir;
}

async function callTool(name, args) {
  const result = await mcpCall(ctx.mcpPort, "tools/call", { name, arguments: args || {} });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function waitForMcp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await mcpCall(ctx.mcpPort, "initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" },
      });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError;
}

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "jobs" });
  await waitForMcp();
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("agent-started import shows a JobDock card and self-dismisses", async () => {
  test.setTimeout(120_000);
  // Big enough that the job is still running when the dock's first poll
  // lands — tiny files import fast; 300 is the empirically reliable size
  // (the cancel test below shows the card at 300 consistently).
  const dir = makeImportDir("dock", 300);
  try {
    // Fire and don't await — import_directory blocks until the job ends
    const importPromise = callTool("import_directory", { image_dirs: [dir] });

    // The jobs-poke broadcast wakes the poll loop → dock card appears
    // The card title carries phase progress while running: "Import · 1/4"
    await expect(ctx.window.getByText(/^Import( ·|$)/)).toBeVisible({ timeout: 15_000 });

    const result = await importPromise;
    expect(result.status).toBe("succeeded");

    // Dock self-dismisses once nothing is running
    await expect(ctx.window.getByText(/^Import( ·|$)/)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobDock Cancel cooperatively cancels an agent-started import", async () => {
  test.setTimeout(120_000);
  const dir = makeImportDir("cancel", 300);
  try {
    const importPromise = callTool("import_directory", { image_dirs: [dir] }).catch(() => null);

    // Grab the running job id through MCP while the dock is up
    let jobId = null;
    await expect(async () => {
      const { jobs } = await callTool("list_active_jobs");
      const job = jobs.find((j) => j.jobType === "import" && j.running);
      expect(job).toBeTruthy();
      jobId = job.jobId;
    }).toPass({ timeout: 15_000 });

    await ctx.window.getByRole("button", { name: /^Cancel$/ }).first().click();

    // Cooperative cancel lands at the runner's next checkpoint
    await expect(async () => {
      const status = await callTool("get_job_status", { job_id: jobId });
      expect(status.status).toBe("cancelled");
    }).toPass({ timeout: 30_000 });

    await expect(ctx.window.getByText(/^Import( ·|$)/)).toHaveCount(0, { timeout: 15_000 });
    await importPromise;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
