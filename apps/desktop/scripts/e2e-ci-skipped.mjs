// The Electron specs a developer's Mac must run itself: the ones that skip
// themselves under CI (`test.skip(process.env.CI, …)`: fs-watch delivery and
// map tiles are too uneven on the GitHub runner). quality.yml runs the whole
// suite on every PR, so locally a PR needs its acceptance specs plus these;
// the full `npm run e2e` is for a change to the harness itself.
//
//   npm run e2e:ci-skipped            # build, then run them
//   npm run e2e:ci-skipped -- --list  # only list them (no app launches)
//
// 70-native-video is not among them: it needs a local ProRes clip
// (AFTERFRAME_TEST_PRORES), see its header.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e");
const specs = readdirSync(e2eDir)
  .filter((name) => name.endsWith(".spec.js"))
  .filter((name) => readFileSync(path.join(e2eDir, name), "utf8").includes("process.env.CI"))
  .map((name) => path.join("e2e", name));

if (specs.length === 0) {
  console.error("no spec skips itself under CI");
  process.exit(1);
}
console.log(`CI-skipped specs:\n  ${specs.join("\n  ")}`);
const result = spawnSync("npx", ["playwright", "test", ...specs, ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
