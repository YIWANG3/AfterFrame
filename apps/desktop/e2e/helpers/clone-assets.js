const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const SOURCE_STEM = "001-red";

// Clone the 001-red row (asset, registry, preview) under new names, each with
// its own copy of the file so browse sees a present, unchanged source. Paging
// specs use it to build a catalog several pages of 180 long.
function cloneAssets(catalogDir, stems) {
  const db = path.join(catalogDir, "catalog.sqlite3");
  const sqlite = (sql) => execFileSync("sqlite3", ["-cmd", ".timeout 10000", "-separator", "\t", db, sql]).toString().trim();
  const [srcId, srcPath, mtimeIso] = sqlite(
    `SELECT asset_id, canonical_path, modified_time FROM assets WHERE stem = '${SOURCE_STEM}'`,
  ).split("\t");
  const dir = path.join(catalogDir, "clone-images");
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

module.exports = { cloneAssets };
