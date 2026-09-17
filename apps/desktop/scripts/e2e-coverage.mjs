// E2E coverage runner: `npm run e2e:coverage [-- <playwright args>]`.
//
// Builds an instrumented renderer, runs the Playwright suite with all three
// collectors armed (see e2e/helpers/app.js coverageEnv), then prints one
// summary per process and writes HTML reports under .coverage/report/:
//   renderer  src/**            istanbul (vite-plugin-istanbul) → nyc
//   main      electron/**       V8 (NODE_V8_COVERAGE)           → c8
//   sidecar   media_workspace   Python coverage (parallel data)  → coverage
// `--report-only` skips build + tests and re-renders from existing data.
// Not measured: electron/preload.js (renderer isolated world, invisible to
// NODE_V8_COVERAGE), the Swift helpers, and the web build.
//
// Only modules the app actually loads are counted for the renderer (istanbul
// instruments what Vite bundles); main and sidecar use --all / --source, so
// never-imported files count as 0 %.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COV = path.join(DESKTOP, ".coverage");
const REPORT = path.join(COV, "report");
const PYLIB = path.join(DESKTOP, ".coverage-tools", "pylib");
const SIDECAR_SRC = path.resolve(DESKTOP, "..", "..", "services", "sidecar", "src");

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const playwrightArgs = args.filter((a) => a !== "--report-only");
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

if (!reportOnly) {
  fs.rmSync(COV, { recursive: true, force: true });
  for (const sub of ["main", "renderer", "sidecar"]) fs.mkdirSync(path.join(COV, sub), { recursive: true });
  // The sidecar rcfile: SIGTERM must flush (the resident `serve` process is
  // stopped with SIGTERM), and data files are per-process (parallel).
  fs.writeFileSync(path.join(COV, "sidecar", "sidecar.coveragerc"), [
    "[run]",
    "sigterm = true",
    "parallel = true",
    "branch = false",
    "",
  ].join("\n"));
  if (!ensurePyCoverage()) console.warn("[coverage] Python coverage unavailable — sidecar numbers will be missing");

  const env = { ...process.env, AFTERFRAME_COVERAGE: "1" };
  console.log("[coverage] building instrumented renderer");
  if (run("npx", ["vite", "build"], { env }) !== 0) process.exit(1);
  console.log("[coverage] running e2e", playwrightArgs.join(" "));
  testStatus = run("npx", ["playwright", "test", ...playwrightArgs], { env });
  if (testStatus !== 0) console.warn(`[coverage] playwright exited ${testStatus} — reporting whatever was collected`);
  // Leave dist/ as a normal build so a later `npm run e2e:only` doesn't run
  // the slower instrumented bundle without knowing.
  console.log("[coverage] restoring the uninstrumented renderer build");
  run("npx", ["vite", "build"], { stdio: "ignore" });
}

fs.rmSync(REPORT, { recursive: true, force: true });
const summary = [];

// ── renderer ──
const rendererFiles = fs.existsSync(path.join(COV, "renderer")) ? fs.readdirSync(path.join(COV, "renderer")).filter((f) => f.endsWith(".json")) : [];
if (rendererFiles.length) {
  run("npx", ["nyc", "report",
    "--temp-dir", path.join(COV, "renderer"),
    "--report-dir", path.join(REPORT, "renderer"),
    "--reporter=html", "--reporter=json-summary", "--reporter=text-summary"]);
  summary.push(["renderer (src/**, loaded modules)", readSummary(path.join(REPORT, "renderer", "coverage-summary.json"))]);
} else {
  summary.push(["renderer", null]);
}

// ── main process ──
const mainFiles = fs.existsSync(path.join(COV, "main")) ? fs.readdirSync(path.join(COV, "main")).filter((f) => f.endsWith(".json")) : [];
if (mainFiles.length) {
  run("npx", ["c8", "report",
    "--temp-directory", path.join(COV, "main"),
    "--reports-dir", path.join(REPORT, "main"),
    "--all", "--src", "electron",
    // preload.js runs in the renderer's isolated world, which NODE_V8_COVERAGE
    // never sees — counting it here would read as a permanent 0 %.
    "--include", "electron/**/*.js", "--exclude", "electron/**/*.test.js", "--exclude", "electron/preload.js",
    "--reporter=html", "--reporter=json-summary", "--reporter=text-summary"]);
  summary.push(["main (electron/**)", readSummary(path.join(REPORT, "main", "coverage-summary.json"))]);
} else {
  summary.push(["main", null]);
}

// ── sidecar ──
const sidecarDir = path.join(COV, "sidecar");
const dataFile = path.join(sidecarDir, ".coverage");
// Per-process files (.coverage.<host>.<pid>.<n>) from the run; `combine`
// folds them into .coverage, which a --report-only pass reuses as is.
const sidecarParts = fs.existsSync(sidecarDir) ? fs.readdirSync(sidecarDir).filter((f) => f.startsWith(".coverage.")) : [];
if (sidecarParts.length || fs.existsSync(dataFile)) {
  const pyEnv = { ...process.env, PYTHONPATH: [SIDECAR_SRC, PYLIB].join(path.delimiter) };
  if (sidecarParts.length) run("python3", ["-m", "coverage", "combine", "--quiet", "--data-file", dataFile, sidecarDir], { env: pyEnv });
  fs.mkdirSync(path.join(REPORT, "sidecar"), { recursive: true });
  run("python3", ["-m", "coverage", "html", "--quiet", "--data-file", dataFile, "-d", path.join(REPORT, "sidecar")], { env: pyEnv });
  run("python3", ["-m", "coverage", "json", "--quiet", "--data-file", dataFile, "-o", path.join(REPORT, "sidecar", "coverage.json")], { env: pyEnv });
  const j = JSON.parse(fs.readFileSync(path.join(REPORT, "sidecar", "coverage.json"), "utf8"));
  summary.push(["sidecar (media_workspace)", { lines: { pct: Number(j.totals.percent_covered.toFixed(2)), covered: j.totals.covered_lines, total: j.totals.num_statements } }]);
} else {
  summary.push(["sidecar", null]);
}

function readSummary(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8")).total;
  return { lines: j.lines, functions: j.functions, branches: j.branches };
}

console.log("\n=== E2E coverage (lines) ===");
for (const [label, s] of summary) {
  if (!s) { console.log(`${label.padEnd(36)} no data`); continue; }
  const extra = s.functions ? `  functions ${s.functions.pct}%  branches ${s.branches.pct}%` : "";
  console.log(`${label.padEnd(36)} ${String(s.lines.pct).padStart(6)}%  (${s.lines.covered}/${s.lines.total})${extra}`);
}
console.log(`\nHTML: ${path.relative(DESKTOP, REPORT)}/{renderer,main,sidecar}/index.html`);
// The report is informational; a failing spec still fails the run (nightly).
process.exit(testStatus);
