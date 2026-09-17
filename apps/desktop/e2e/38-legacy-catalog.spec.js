// Opening a catalog written by an old build must migrate it in place and keep
// its data. The sidecar's migration chain has unit tests (tests/
// test_schema_migrations.py); none of them opened a real catalog through the
// app, so db/migrations._migrate_to_3..7 had never run under Playwright
// (docs/review/2026-09-17-E2E覆盖率.md, A6). The schema-5 database comes from
// the same unit-test helper (fixtures/make-legacy-catalog.py): pre-rename
// export_* tables, one rated asset, one registry row.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({
    testName: "legacy-catalog",
    prepareCatalog(catalogDir) {
      // Keep the folder (previews dirs, settings.json); swap in the v5 database.
      execFileSync("python3", [path.resolve(__dirname, "fixtures", "make-legacy-catalog.py"), path.join(catalogDir, "catalog.sqlite3")]);
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(path.join(catalogDir, `catalog.sqlite3${suffix}`), { force: true });
    },
  });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("a schema-5 catalog opens, migrates to the current schema and keeps its asset", async () => {
  // The legacy asset's file never existed on this machine: it must still be
  // listed (as missing), with its rating and camera carried across.
  const card = ctx.window.locator("[data-gallery-item='true']");
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(ctx.window.getByRole("button", { name: "All Assets 1" })).toBeVisible();

  const result = await mcpCall(ctx.mcpPort, "tools/call", { name: "get_catalog_info", arguments: {} });
  const info = JSON.parse(result.content[0].text);
  expect(info.summary).toMatchObject({ unmatched_images: 1, rated_count: 1 });

  const rows = await ctx.window.evaluate(() => window.mediaWorkspace.browseImages({ status: "all", limit: 10 }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    asset_id: "export_legacy",
    asset_type: "image", // v5 called it 'export'
    image_path: "/legacy/images/sample.jpg",
    app_rating: 4,
    match_status: "unmatched",
    exists_on_disk: false,
  });

  // The app holds the database open (WAL); read with a busy timeout so a
  // checkpoint in flight doesn't surface as "database is locked". (Not
  // -readonly: that refuses to open a WAL database whose -shm it can't map.)
  const query = (sql) => execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(ctx.catalogDir, "catalog.sqlite3"), sql]).toString().trim();
  const version = query("SELECT schema_version FROM catalog_info");
  expect(Number(version)).toBeGreaterThanOrEqual(8);
  const tables = query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  expect(tables).toContain("image_lookup_registry");
  expect(tables).not.toContain("export_lookup_registry");
});
