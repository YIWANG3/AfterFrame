// Interactive recorder: launches the real app under Playwright and opens the
// Inspector paused. Click "Record" in the Inspector toolbar, then drive the
// app by hand — every action is generated as Playwright code you can paste
// into a spec (curate it: swap brittle selectors for data-testid, add
// assertions — raw recordings click, but they don't VERIFY).
//
//   npm run e2e:record              # seeded 10-image fixture catalog
//   RECORD_REAL_CATALOG=~/Desktop/general.afcatalog npm run e2e:record
//                                   # …or against a COPY of a real catalog
//
// The app runs with isolated userData and its own MCP port, so your dev /
// installed instances are untouched. Real-catalog mode copies the catalog
// into a temp dir first — recording actions never mutate your library.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launchApp } = require("./helpers/app");

async function main() {
  let opts = { testName: "record" };
  const realCatalog = process.env.RECORD_REAL_CATALOG;
  if (realCatalog) {
    const src = realCatalog.replace(/^~(?=\/)/, os.homedir());
    const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-record-")), path.basename(src));
    console.log(`Copying ${src} → ${work} (your original stays untouched)…`);
    fs.cpSync(src, work, { recursive: true });
    opts = { testName: "record", withCatalog: false };
    process.env.MEDIA_WORKSPACE_CATALOG = work;
  }

  const { app, window, mcpPort } = await launchApp(opts);
  console.log(`App up (MCP on :${mcpPort}). Opening the Inspector — hit ▶ Record and go.`);
  await window.pause(); // opens Playwright Inspector with the recorder
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
