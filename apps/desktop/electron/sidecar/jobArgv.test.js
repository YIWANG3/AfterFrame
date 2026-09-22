// Pins every flag jobArgv.js can emit to the argparse definition of the same
// subcommand in services/sidecar/src/media_workspace/cli.py. A runner is
// spawned detached with stdio ignored, so an unknown flag would otherwise
// show up only as a job row flipping to "failed" with an argparse message.
// cli.py is parsed as text on purpose — nothing here runs Python.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jobArgv = require("./jobArgv");

const CLI_PY = path.resolve(__dirname, "../../../../services/sidecar/src/media_workspace/cli.py");
const cliSource = fs.readFileSync(CLI_PY, "utf8");

// { "run-import-job": { flags: Set<"--x">, required: Set<"--x"> }, ... }
function argparseSpec(subcommand) {
  const parserVar = new RegExp(`(\\w+) = subparsers\\.add_parser\\("${subcommand}"`).exec(cliSource)?.[1];
  assert.ok(parserVar, `cli.py declares no subparser for ${subcommand}`);
  const flags = new Set();
  const required = new Set();
  const call = new RegExp(`${parserVar}\\.add_argument\\(\\s*"(--[a-z-]+)"([^)]*)\\)`, "g");
  for (const m of cliSource.matchAll(call)) {
    flags.add(m[1]);
    if (/required=True/.test(m[2])) required.add(m[1]);
  }
  assert.ok(flags.has("--job-id"), `${subcommand}: expected a --job-id argument`);
  return { flags, required };
}

function emittedFlags(argv) {
  return new Set(argv.filter((token) => token.startsWith("--")));
}

// One fixture per builder: `full` sets every option (so every flag the
// builder knows is exercised), `minimal` only what the runner requires, and
// `neverSent` lists flags cli.py accepts that the app deliberately never
// passes (CLI-only knobs like --limit / --force).
const CASES = [
  {
    builder: "enrichmentJob",
    minimal: { jobId: "j1" },
    full: { jobId: "j1" },
    neverSent: ["--raw-dir"],
  },
  {
    builder: "importJob",
    minimal: { jobId: "j1", mode: "combined" },
    full: { jobId: "j1", mode: "combined", rawDirs: ["/r"], imageDirs: ["/i"], generateHd: true, respectTombstones: true },
  },
  {
    builder: "previewJob",
    minimal: { jobId: "j1" },
    full: { jobId: "j1", kind: "preview-hd", assetType: "image" },
    neverSent: ["--limit", "--force"],
  },
  {
    builder: "colorsJob",
    minimal: { jobId: "j1" },
    full: { jobId: "j1" },
    neverSent: ["--limit"],
  },
  {
    builder: "aiRepaintJob",
    minimal: { jobId: "j1", provider: "mock", inputPath: "/in.jpg", outputPath: "/out.png", prompt: "p" },
    full: {
      jobId: "j1", provider: "mock", inputPath: "/in.jpg", outputPath: "/out.png", originPath: "/orig.cr3", prompt: "p",
      aspectRatio: "1:1", imageSize: "2K", temperature: 0.5, model: "m", baseUrl: "https://x", apiKey: "k",
    },
  },
  {
    builder: "textImageJob",
    minimal: { jobId: "j1", provider: "mock", outputPath: "/out.png", prompt: "p" },
    full: {
      jobId: "j1", provider: "mock", outputPath: "/out.png", prompt: "p", aspectRatio: "16:9", imageSize: "1K",
      quality: "high", model: "m", baseUrl: "https://x", refImagePath: "/ref.png", apiKey: "k",
    },
  },
  {
    builder: "annotationJob",
    minimal: { jobId: "j1", provider: "anthropic", model: "m" },
    full: {
      jobId: "j1", provider: "anthropic", model: "m", apiKey: "k", baseUrl: "https://x", reannotate: true,
      assetIds: ["a", "b"], collectionId: "c",
      settings: { languages: ["en", "zh"], maxTags: 5, maxCaptionChars: 100, customInstructions: "ci", videoFrameInterval: 2, maxWorkers: 4 },
    },
    neverSent: ["--asset-type", "--limit"],
  },
  {
    builder: "peopleIndexJob",
    minimal: { jobId: "j1", modelId: "id", modelVersion: "v", modelPath: "/m", manifestHash: "h" },
    full: { jobId: "j1", modelId: "id", modelVersion: "v", modelPath: "/m", manifestHash: "h", assetIds: ["a", "b"] },
    neverSent: ["--worker-path", "--limit"],
  },
];

for (const { builder, minimal, full, neverSent = [] } of CASES) {
  test(`${builder}: every flag exists in cli.py and required flags are always present`, () => {
    const build = jobArgv[builder];
    const subcommand = build(minimal)[0];
    const spec = argparseSpec(subcommand);

    for (const argv of [build(minimal), build(full)]) {
      assert.equal(argv[0], subcommand);
      // transport.launchJob finds the job id by scanning for --job-id.
      assert.equal(argv[1], "--job-id");
      for (const flag of emittedFlags(argv)) {
        assert.ok(spec.flags.has(flag), `${subcommand} does not accept ${flag}`);
      }
    }
    for (const flag of spec.required) {
      assert.ok(emittedFlags(build(minimal)).has(flag), `${subcommand} requires ${flag} but the minimal build omits it`);
    }
    // The "full" fixture must reach every flag the runner accepts (minus the
    // declared never-sent ones); otherwise a builder that silently dropped a
    // flag would still pass the subset check above.
    const fullFlags = emittedFlags(build(full));
    for (const flag of spec.flags) {
      if (neverSent.includes(flag)) {
        assert.ok(!fullFlags.has(flag), `${builder} emits ${flag} but lists it as never sent`);
        continue;
      }
      assert.ok(fullFlags.has(flag), `${builder} full fixture never emits ${flag}`);
    }
  });
}

test("cli.py has no run-*-job subcommand this module doesn't cover", () => {
  const declared = [...cliSource.matchAll(/subparsers\.add_parser\("(run-[a-z-]+-job)"/g)].map((m) => m[1]);
  const covered = new Set(CASES.map(({ builder, minimal }) => jobArgv[builder](minimal)[0]));
  assert.deepEqual(declared.filter((name) => !covered.has(name)), []);
});

test("optional values are omitted when empty, kept when set", () => {
  const bare = jobArgv.textImageJob({ jobId: "j", provider: "mock", outputPath: "/o", prompt: "p", apiKey: null, model: "" });
  assert.deepEqual(bare, ["run-text-image-job", "--job-id", "j", "--provider", "mock", "--output", "/o", "--prompt", "p"]);

  const repaint = jobArgv.aiRepaintJob({ jobId: "j", provider: "mock", inputPath: "/i", outputPath: "/o", prompt: "p", temperature: 0 });
  assert.ok(repaint.includes("--temperature"), "temperature 0 is a real value, not 'unset'");
  assert.equal(repaint[repaint.indexOf("--origin-path") + 1], "/i", "origin defaults to the input path");

  const annotation = jobArgv.annotationJob({
    jobId: "j", provider: "openai", model: "m", reannotate: false, assetIds: [], settings: { videoFrameInterval: 0, maxWorkers: 0 },
  });
  assert.deepEqual(annotation, ["run-annotation-job", "--job-id", "j", "--provider", "openai", "--model", "m"]);

  const people = jobArgv.peopleIndexJob({ jobId: "j", modelId: "i", modelVersion: "v", modelPath: "/m", manifestHash: "h", assetIds: [1, 2] });
  assert.deepEqual(people.slice(-4), ["--asset-id", "1", "--asset-id", "2"]);
});
