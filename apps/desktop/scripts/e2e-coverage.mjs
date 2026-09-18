// Coverage runner.
//
//   npm run e2e:coverage   e2e only
//   npm run coverage       unit tests + e2e, reported side by side
//
// Builds an instrumented renderer, runs the Playwright suite with all three
// collectors armed (see e2e/helpers/app.js coverageEnv), then prints one
// summary per process and writes HTML reports under .coverage/report/:
//   renderer  src/**            istanbul (vite-plugin-istanbul) → nyc
//   main      electron/**       V8 (NODE_V8_COVERAGE)           → c8
//   sidecar   media_workspace   Python coverage (parallel data)  → coverage
//
// With --with-unit the three unit suites run first, into .coverage/unit/*:
//   renderer  vitest --coverage.provider=istanbul (same babel-plugin-istanbul
//             instrumentation as the e2e build, so the maps merge statement
//             for statement)
//   main      node --test under NODE_V8_COVERAGE
//   sidecar   unittest under coverage run --parallel-mode
// Both sets are then copied into .coverage/merged/* and reported again, so
// the summary shows what e2e covers alone and what the whole test suite
// covers. `--report-only` skips build + tests and re-renders from the data
// already on disk.
//
// Not measured: electron/preload.js (renderer isolated world, invisible to
// NODE_V8_COVERAGE), the Swift helpers, and the web build.
//
// Only modules a run actually loads are counted for the renderer (istanbul
// instruments what Vite bundles, and the unit pass uses --coverage.all=false
// to match); main and sidecar use --all / --source, so never-imported files
// count as 0 %.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(DESKTOP, "..", "..");
const COV = path.join(DESKTOP, ".coverage");
const UNIT = path.join(COV, "unit");
const MERGED = path.join(COV, "merged");
const REPORT = path.join(COV, "report");
const PYLIB = path.join(DESKTOP, ".coverage-tools", "pylib");
const SIDECAR_SRC = path.join(REPO, "services", "sidecar", "src");

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const withUnit = args.includes("--with-unit");
const playwrightArgs = args.filter((a) => a !== "--report-only" && a !== "--with-unit");
let testStatus = 0;

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { cwd: DESKTOP, stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

function ensurePyCoverage() {
  const probe = spawnSync("python3", ["-c", "import coverage"], { env: { ...process.env, PYTHONPATH: PYLIB }, stdio: "ignore" });
  if (probe.status === 0) return true;
  console.log(`[coverage] installing Python coverage into ${path.relative(DESKTOP, PYLIB)} (no system Python changes)`);
  return run("python3", ["-m", "pip", "install", "--quiet", "--target", PYLIB, "coverage"]) === 0;
}

function jsonFilesIn(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

// Copy the raw data of one layer into the merged directory, tagging each file
// with the source it came from: V8 writes coverage-<pid>-<ts>-<n>.json and the
// two collectors can pick the same name.
function copyInto(fromDir, toDir, tag, kind) {
  if (!fs.existsSync(fromDir)) return 0;
  fs.mkdirSync(toDir, { recursive: true });
  let n = 0;
  for (const file of fs.readdirSync(fromDir)) {
    if (!kind.match(file)) continue;
    fs.copyFileSync(path.join(fromDir, file), path.join(toDir, kind.rename(file, tag)));
    n += 1;
  }
  return n;
}
const JSON_DATA = {
  match: (f) => f.endsWith(".json"),
  rename: (f, tag) => `${tag}-${f}`,
};
// A parallel data file, not the combined `.coverage` and not the rcfile. The
// copy has to keep the `.coverage.` prefix or `coverage combine` skips it.
const PY_DATA = {
  match: (f) => f.startsWith(".coverage."),
  rename: (f, tag) => `.coverage.${tag}-${f.slice(".coverage.".length)}`,
};

const sidecarRc = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const rc = path.join(dir, "sidecar.coveragerc");
  // SIGTERM must flush (the resident `serve` process is stopped with SIGTERM),
  // and data files are per-process (parallel).
  fs.writeFileSync(rc, ["[run]", "sigterm = true", "parallel = true", "branch = false", ""].join("\n"));
  return rc;
};

const pyEnv = { ...process.env, PYTHONPATH: [SIDECAR_SRC, PYLIB].join(path.delimiter) };

if (!reportOnly) {
  fs.rmSync(COV, { recursive: true, force: true });
  for (const sub of ["main", "renderer", "sidecar"]) fs.mkdirSync(path.join(COV, sub), { recursive: true });
  sidecarRc(path.join(COV, "sidecar"));
  if (!ensurePyCoverage()) console.warn("[coverage] Python coverage unavailable — sidecar numbers will be missing");

  if (withUnit) {
    for (const sub of ["main", "renderer", "sidecar"]) fs.mkdirSync(path.join(UNIT, sub), { recursive: true });

    // Renderer units. --coverage.all=false keeps the denominator the same as
    // the e2e pass: modules a run actually loaded, not every file under src/.
    console.log("[coverage] unit: renderer (vitest)");
    if (run("npx", ["vitest", "run", "src",
      "--coverage.enabled", "--coverage.provider=istanbul", "--coverage.all=false",
      "--coverage.reporter=json", "--coverage.reportsDirectory", path.join(UNIT, "renderer"),
    ]) !== 0) { testStatus = 1; console.warn("[coverage] renderer unit tests failed — reporting what was collected"); }

    console.log("[coverage] unit: main (node --test)");
    const electronTests = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"))
      .scripts["test:electron"].split(/\s+/).filter((a) => a.endsWith(".test.js"));
    if (run("node", ["--test", ...electronTests], {
      env: { ...process.env, NODE_V8_COVERAGE: path.join(UNIT, "main") },
    }) !== 0) { testStatus = 1; console.warn("[coverage] main unit tests failed — reporting what was collected"); }

    console.log("[coverage] unit: sidecar (unittest)");
    const unitRc = sidecarRc(path.join(UNIT, "sidecar"));
    if (run("python3", ["-m", "coverage", "run", "--parallel-mode",
      "--rcfile", unitRc, "--data-file", path.join(UNIT, "sidecar", ".coverage"),
      "--source", "media_workspace",
      "-m", "unittest", "discover", "-s", "tests",
    ], { cwd: REPO, env: pyEnv }) !== 0) { testStatus = 1; console.warn("[coverage] sidecar unit tests failed — reporting what was collected"); }
  }

  const env = { ...process.env, AFTERFRAME_COVERAGE: "1" };
  console.log("[coverage] building instrumented renderer");
  if (run("npx", ["vite", "build"], { env }) !== 0) process.exit(1);
  console.log("[coverage] running e2e", playwrightArgs.join(" "));
  const e2eStatus = run("npx", ["playwright", "test", ...playwrightArgs], { env });
  if (e2eStatus !== 0) {
    testStatus = e2eStatus;
    console.warn(`[coverage] playwright exited ${e2eStatus} — reporting whatever was collected`);
  }
  // Leave dist/ as a normal build so a later `npm run e2e:only` doesn't run
  // the slower instrumented bundle without knowing.
  console.log("[coverage] restoring the uninstrumented renderer build");
  run("npx", ["vite", "build"], { stdio: "ignore" });
}

fs.rmSync(REPORT, { recursive: true, force: true });

function rendererReport(tempDir, outDir) {
  if (!jsonFilesIn(tempDir).length) return null;
  run("npx", ["nyc", "report",
    "--temp-dir", tempDir, "--report-dir", outDir,
    "--reporter=html", "--reporter=json-summary", "--reporter=text-summary"]);
  return readSummary(path.join(outDir, "coverage-summary.json"));
}

function mainReport(tempDir, outDir) {
  if (!jsonFilesIn(tempDir).length) return null;
  run("npx", ["c8", "report",
    "--temp-directory", tempDir, "--reports-dir", outDir,
    "--all", "--src", "electron",
    // preload.js runs in the renderer's isolated world, which NODE_V8_COVERAGE
    // never sees — counting it here would read as a permanent 0 %.
    "--include", "electron/**/*.js", "--exclude", "electron/**/*.test.js", "--exclude", "electron/preload.js",
    "--reporter=html", "--reporter=json-summary", "--reporter=text-summary"]);
  return readSummary(path.join(outDir, "coverage-summary.json"));
}

// `dirs` hold per-process files (.coverage.<host>.<pid>.<n>), which `combine`
// folds into one data file. It consumes them, so the merged report works off
// its own copies (see stageMerged) rather than reading these twice; a
// --report-only pass then reuses the combined file each dir already has.
function sidecarReport(dirs, dataFile, outDir) {
  const parts = dirs.filter((d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f.startsWith(".coverage.")));
  if (!parts.length && !fs.existsSync(dataFile)) return null;
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (parts.length) run("python3", ["-m", "coverage", "combine", "--quiet", "--data-file", dataFile, ...parts], { env: pyEnv });
  fs.mkdirSync(outDir, { recursive: true });
  run("python3", ["-m", "coverage", "html", "--quiet", "--data-file", dataFile, "-d", outDir], { env: pyEnv });
  run("python3", ["-m", "coverage", "json", "--quiet", "--data-file", dataFile, "-o", path.join(outDir, "coverage.json")], { env: pyEnv });
  const j = JSON.parse(fs.readFileSync(path.join(outDir, "coverage.json"), "utf8"));
  return { lines: { pct: Number(j.totals.percent_covered.toFixed(2)), covered: j.totals.covered_lines, total: j.totals.num_statements } };
}

function readSummary(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8")).total;
  return { lines: j.lines, functions: j.functions, branches: j.branches };
}

const LAYERS = ["renderer (src/**, loaded modules)", "main (electron/**)", "sidecar (media_workspace)"];
const haveUnit = ["renderer", "main", "sidecar"].some((s) => fs.existsSync(path.join(UNIT, s)));

// Stage the merged inputs first: reporting a layer consumes its raw data
// (Python's combine deletes the parts it folds in), so the copies have to be
// taken before the e2e pass runs.
function stageMerged() {
  fs.rmSync(MERGED, { recursive: true, force: true });
  for (const [layer, kind] of [["renderer", JSON_DATA], ["main", JSON_DATA], ["sidecar", PY_DATA]]) {
    copyInto(path.join(COV, layer), path.join(MERGED, layer), "e2e", kind);
    copyInto(path.join(UNIT, layer), path.join(MERGED, layer), "unit", kind);
  }
}
// --report-only reuses what a previous run staged: the sidecar parts it copied
// no longer exist to be copied again.
if (haveUnit && !reportOnly) stageMerged();

const e2eSummary = [
  rendererReport(path.join(COV, "renderer"), path.join(REPORT, "renderer")),
  mainReport(path.join(COV, "main"), path.join(REPORT, "main")),
  sidecarReport([path.join(COV, "sidecar")], path.join(COV, "sidecar", ".coverage"), path.join(REPORT, "sidecar")),
];

let allSummary = null;
if (haveUnit) {
  allSummary = [
    rendererReport(path.join(MERGED, "renderer"), path.join(REPORT, "combined", "renderer")),
    mainReport(path.join(MERGED, "main"), path.join(REPORT, "combined", "main")),
    sidecarReport(
      [path.join(MERGED, "sidecar")],
      path.join(MERGED, "sidecar", ".coverage"),
      path.join(REPORT, "combined", "sidecar"),
    ),
  ];
}

const cell = (s) => (s ? `${String(s.lines.pct).padStart(6)}%  (${s.lines.covered}/${s.lines.total})`.padEnd(24) : "no data".padStart(13).padEnd(24));
console.log(`\n=== Coverage (lines) ===\n${"".padEnd(36)}${"e2e".padEnd(24)}${haveUnit ? "unit + e2e" : ""}`);
LAYERS.forEach((label, i) => {
  console.log(`${label.padEnd(36)}${cell(e2eSummary[i])}${haveUnit ? cell(allSummary[i]) : ""}`.trimEnd());
});
const headline = haveUnit ? allSummary : e2eSummary;
const detail = ["renderer", "main"]
  .map((name, i) => (headline[i] ? `${name} functions ${headline[i].functions.pct}% branches ${headline[i].branches.pct}%` : null))
  .filter(Boolean)
  .join("  |  ");
if (detail) console.log(`\n${haveUnit ? "unit + e2e" : "e2e"}, other metrics: ${detail}`);
console.log(`\nHTML: ${path.relative(DESKTOP, REPORT)}/{renderer,main,sidecar}/index.html`
  + (haveUnit ? `\n      ${path.relative(DESKTOP, REPORT)}/combined/{renderer,main,sidecar}/index.html` : ""));
// The report is informational; a failing spec still fails the run (nightly).
process.exit(testStatus);
