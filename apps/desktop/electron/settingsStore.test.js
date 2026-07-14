const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSettingsStore } = require("./settingsStore");

async function withStore(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "afterframe-settings-"));
  const appSettingsPath = path.join(root, "app", "settings.json");
  const errors = [];
  const store = createSettingsStore({
    getAppSettingsPath: () => appSettingsPath,
    logger: { error: (...args) => errors.push(args) },
  });
  try {
    await run({ root, appSettingsPath, store, errors });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test("concurrent app updates are serialized without losing fields", async () => {
  await withStore(async ({ store }) => {
    const first = store.updateAppSettings((current) => ({ ...current, locale: "zh-CN" }));
    const second = store.updateAppSettings((current) => ({ ...current, previews: { generateHd: true } }));
    const third = store.updateAppSettings((current) => ({ ...current, lastCatalogPath: "/library" }));
    await Promise.all([first, second, third]);

    assert.deepEqual(store.readAppSettings(), {
      locale: "zh-CN",
      previews: { generateHd: true },
      lastCatalogPath: "/library",
    });
  });
});

test("a rejected update does not poison later writes", async () => {
  await withStore(async ({ store, errors }) => {
    await assert.rejects(
      store.updateAppSettings(() => { throw new Error("broken mutation"); }),
      /broken mutation/,
    );
    await store.updateAppSettings((current) => ({ ...current, locale: "en" }));

    assert.equal(store.readAppSettings().locale, "en");
    assert.equal(errors.length, 1);
  });
});

test("catalog writes are isolated by catalog and preserve the version envelope", async () => {
  await withStore(async ({ root, store }) => {
    const firstCatalog = path.join(root, "one.afcatalog");
    const secondCatalog = path.join(root, "two.afcatalog");
    await Promise.all([
      store.updateCatalogSettings(firstCatalog, (current) => ({
        integrations: { ...(current.integrations || {}), watchedDirs: ["/one"] },
      })),
      store.updateCatalogSettings(secondCatalog, () => ({ integrations: { watchedDirs: ["/two"] } })),
    ]);

    assert.deepEqual(store.readCatalogSettings(firstCatalog), {
      version: 1,
      integrations: { watchedDirs: ["/one"] },
    });
    assert.deepEqual(store.readCatalogSettings(secondCatalog), {
      version: 1,
      integrations: { watchedDirs: ["/two"] },
    });
  });
});

test("successful writes leave no temporary files behind", async () => {
  await withStore(async ({ appSettingsPath, store }) => {
    await store.updateAppSettings(() => ({ locale: "en" }));
    const entries = await fs.promises.readdir(path.dirname(appSettingsPath));
    assert.deepEqual(entries, ["settings.json"]);
  });
});
