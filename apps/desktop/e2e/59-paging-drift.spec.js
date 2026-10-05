const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

// The gallery pages by offset. When the view gains photos between two pages
// (a watched folder importing, an annotation run adding matches) the next page
// starts with rows already on screen. The grid keys cards by asset_id, so the
// repeats were duplicate React keys: one copy remounted on every scroll and
// its thumbnail blinked as it reloaded, and a selection ring showed on both.

const SOURCE_STEM = "001-red";
const BULK = 600; // several pages of 180, so a page is still to come once the first loads settle

// Clone the 001-red row (asset, registry, preview) under new names, each with
// its own copy of the file so browse sees a present, unchanged source.
function cloneAssets(catalogDir, stems) {
  const db = path.join(catalogDir, "catalog.sqlite3");
  const sqlite = (sql) => execFileSync("sqlite3", ["-cmd", ".timeout 10000", "-separator", "\t", db, sql]).toString().trim();
  const [srcId, srcPath, mtimeIso] = sqlite(
    `SELECT asset_id, canonical_path, modified_time FROM assets WHERE stem = '${SOURCE_STEM}'`,
  ).split("\t");
  const dir = path.join(catalogDir, "drift-images");
  fs.mkdirSync(dir, { recursive: true });
  // Same mtime the catalog recorded (see restoreSeededMtimes in helpers/app.js).
  const whole = Math.floor(Date.parse(mtimeIso) / 1000);
  const micros = Number((/\.(\d{1,6})/.exec(mtimeIso)?.[1] || "0").padEnd(6, "0"));
  const seconds = whole + micros / 1e6;
  const values = [];
  for (const stem of stems) {
    const file = path.join(dir, `${stem}.jpg`);
    fs.copyFileSync(srcPath, file);
    fs.utimesSync(file, seconds, seconds);
    values.push(`('image_${stem.replace(/\W/g, "_")}', '${stem}', '${file.replace(/'/g, "''")}')`);
  }
  sqlite(`
    CREATE TEMP TABLE clones(asset_id TEXT, stem TEXT, path TEXT);
    INSERT INTO clones VALUES ${values.join(",")};
    INSERT INTO assets (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, extension,
                        fingerprint, file_size, modified_time, status, exists_on_disk, metadata_json)
      SELECT c.asset_id, a.asset_type, c.path, c.stem, c.stem, c.stem, a.extension,
             a.fingerprint || c.stem, a.file_size, a.modified_time, a.status, 1, a.metadata_json
      FROM clones c, assets a WHERE a.asset_id = '${srcId}';
    INSERT INTO image_lookup_registry (image_path, image_asset_id, match_status, score, resolver_version,
                                       feature_vector_json, candidate_json)
      SELECT c.path, c.asset_id, r.match_status, r.score, r.resolver_version, r.feature_vector_json, r.candidate_json
      FROM clones c, image_lookup_registry r WHERE r.image_asset_id = '${srcId}';
    INSERT INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status)
      SELECT 'preview_' || p.kind || '_' || c.asset_id, c.asset_id, p.kind, p.relative_path, p.width, p.height, p.status
      FROM clones c, preview_entries p WHERE p.asset_id = '${srcId}';
  `);
}

test.describe("Gallery paging", () => {
  let app, window, userDataDir, catalogDir;

  test.beforeAll(async () => {
    ({ app, window, userDataDir, catalogDir } = await launchApp({
      testName: "paging-drift",
      prepareCatalog: (dir) => cloneAssets(dir, Array.from({ length: BULK }, (_, i) => `bulk-${String(i + 1).padStart(4, "0")}`)),
    }));
  });

  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("photos landing ahead of the loaded pages don't repeat cards", async () => {
    const scroller = window.locator("[data-testid='gallery-scroll']");
    await expect(window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });

    // Let the opening page (and any preload it triggers) settle.
    const scrollHeight = () => scroller.evaluate((el) => el.scrollHeight);
    let last = -1;
    await expect.poll(async () => {
      const now = await scrollHeight();
      const settled = now === last;
      last = now;
      return settled;
    }, { timeout: 15_000, intervals: [1000] }).toBe(true);

    // Eight photos arrive that sort ahead of everything loaded so far.
    cloneAssets(catalogDir, Array.from({ length: 8 }, (_, i) => `000-late-${i + 1}`));

    const before = await scrollHeight();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(scrollHeight, { timeout: 15_000 }).toBeGreaterThan(before);

    // Walk the whole grid; a repeated card sits within a row or two of its
    // twin, so both are rendered in the same window.
    const repeated = await scroller.evaluate(async (el) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const found = new Set();
      for (let top = 0; top <= el.scrollHeight; top += Math.max(100, el.clientHeight / 2)) {
        el.scrollTop = top;
        await frame();
        const seen = new Set();
        for (const card of el.querySelectorAll("[data-gallery-item='true']")) {
          if (seen.has(card.dataset.assetId)) found.add(card.dataset.assetId);
          seen.add(card.dataset.assetId);
        }
      }
      return [...found];
    });
    expect(repeated).toEqual([]);
  });
});
