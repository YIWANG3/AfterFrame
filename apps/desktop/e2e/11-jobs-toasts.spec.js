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

// Files per import: the job has to outlast the dock's first poll (see below).
const IMPORT_SIZE = 3000;

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
  // lands (about 2 s in). Previews no longer spawn a process per file, so
  // tiny files import at about 1.6 ms each locally and about 5 ms on CI: 300,
  // the size this once used, finished 0.6 s after the card showed locally
  // and before it on CI. 3000 run about 6.5 s locally and 15 s on CI.
  const dir = makeImportDir("dock", IMPORT_SIZE);
  try {
    // Fire and don't await — import_directory blocks until the job ends
    const importPromise = callTool("import_directory", { image_dirs: [dir] });

    // The jobs-poke broadcast wakes the poll loop → dock card appears
    // The card title carries phase progress while running: "Import · 1/4"
    await expect(ctx.window.getByText(/^Import( ·|$)/)).toBeVisible({ timeout: 15_000 });
    const dock = ctx.window.getByTestId("job-dock-card").first();
    await expect(dock).toHaveCSS("border-top-width", "0px");
    await expect(dock).toHaveCSS("background-color", "rgb(24, 24, 27)");
    const surface = await dock.evaluate((el) => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, radius: css.borderRadius, shadow: css.boxShadow };
    });

    // import_directory returns after 25 s even if the job is still running
    // (the CI VM can take that long); then follow the job to its end.
    let result = await importPromise;
    if (result.status === "running") {
      // get_job_status answers with jobId, not job_id: keep the id from here.
      const jobId = result.job_id;
      await expect(async () => {
        result = await callTool("get_job_status", { job_id: jobId });
        expect(result.status).not.toBe("running");
      }).toPass({ timeout: 60_000 });
    }
    expect(result.status).toBe("succeeded");

    // Dock self-dismisses once nothing is running
    await expect(ctx.window.getByText(/^Import( ·|$)/)).toHaveCount(0, { timeout: 15_000 });
    // Real agent notification uses exactly the same surface as progress.
    // Read the id once the gallery shows the import (newest first): an older
    // first card ends up thousands of photos down, past what a reveal scans.
    const firstCard = ctx.window.locator("[data-gallery-item='true']").first();
    await expect(firstCard).toHaveAttribute("data-image-path", /dock_\d+\.jpg$/, { timeout: 15_000 });
    const assetId = await firstCard.getAttribute("data-asset-id");
    await callTool("show_in_app", { asset_ids: [assetId] });
    const toast = ctx.window.getByTestId("toast-card").filter({ hasText: "Selected 1 photo" }).first();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCSS("border-top-width", "0px");
    expect(await toast.evaluate((el) => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, radius: css.borderRadius, shadow: css.boxShadow };
    })).toEqual(surface);
    await ctx.window.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await expect(toast).toHaveCSS("background-color", "rgb(247, 247, 250)");
    await expect(toast).toHaveCSS("border-top-width", "0px");
    await ctx.window.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JobDock Cancel cooperatively cancels an agent-started import", async () => {
  test.setTimeout(120_000);
  const dir = makeImportDir("cancel", IMPORT_SIZE);
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
