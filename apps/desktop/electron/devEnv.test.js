const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadDevEnv } = require("./devEnv");

test("reads KEY=value lines, never overrides what is already set, and fills the provider aliases", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-devenv-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, [
    "# comment",
    "OPENAI_API_KEY=sk-from-file ",
    "GEMINI_API_KEY=g-from-file",
    "JIMENG_API_KEY=jk",
    "JIMENG_API_SECRET=js",
    "SEEDREAM_API_KEY=sd",
    "lowercase=ignored",
    "",
  ].join("\n"));
  const env = loadDevEnv(file, { OPENAI_API_KEY: "sk-already" });
  assert.equal(env.OPENAI_API_KEY, "sk-already");
  assert.equal(env.GEMINI_API_KEY, "g-from-file");
  assert.equal(env.lowercase, undefined);
  assert.deepEqual([env.VOLC_ACCESSKEY, env.VOLC_SECRETKEY, env.ARK_API_KEY], ["jk", "js", "sd"]);
});

test("a missing .env is fine; an alias never overrides an explicit value", () => {
  const env = loadDevEnv("/nowhere/.env", { VOLC_ACCESSKEY: "explicit", JIMENG_API_KEY: "alias" });
  assert.equal(env.VOLC_ACCESSKEY, "explicit");
  assert.equal(env.ARK_API_KEY, undefined);
});
