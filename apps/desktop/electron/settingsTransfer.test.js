const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildBundle,
  parseBundle,
  summarizeBundle,
  openSecrets,
  mergeBundle,
  collectExport,
} = require("./settingsTransfer");

// Stand-in for safeStorage: "enc:" prefix = decryptable, anything else fails.
const decryptToken = (stored) => (stored.startsWith("enc:") ? stored.slice(4) : null);

const SOURCE = {
  lastCatalogPath: "/Users/a/Desktop/main.afcatalog",
  locale: "zh-CN",
  previews: { generateHd: true },
  integrations: { watchedDirs: ["/Users/a/Pictures"] },
  peopleRecognition: { activeModelKey: "m", models: { m: { modelPath: "/Users/a/model" } } },
  aiPreferences: {
    providers: [{ id: "p_gem", type: "nanobanana", name: "Gemini" }, { id: "p_oai", type: "openai", name: "OpenAI" }],
    activeProvider: "p_oai",
    selectedModels: { p_gem: "gemini-3-pro" },
    modelsCache: { p_gem: [{ id: "x", name: "x" }] },
  },
  aiAnnotation: {
    languages: ["zh-CN"],
    maxTags: 12,
    providers: [{ id: "a_claude", type: "anthropic", name: "Claude", model: "claude-sonnet-5" }],
    activeProviderId: "a_claude",
  },
  aiStyles: [{ id: "legacy", name: "Legacy", prompt: "old" }],
  aiProviders: {
    p_gem: { token: "enc:gem-key" },
    p_oai: { token: "locked" },
    "annotation:a_claude": { token: "enc:claude-key" },
    "annotation:openai_compatible": { token: "enc:orphan" },
    p_deleted: { token: "enc:gone" },
  },
};
const STYLES = [{ id: "s1", name: "Film", prompt: "film look" }];

async function exportAll(overrides = {}) {
  return buildBundle({
    settings: SOURCE,
    styles: STYLES,
    theme: "light",
    sections: ["general", "repaint", "annotation"],
    includeSecrets: true,
    passphrase: "correct horse",
    decryptToken,
    appVersion: "0.5.2",
    ...overrides,
  });
}

test("export carries only whitelisted, machine-independent fields", async () => {
  const { bundle } = await exportAll({ includeSecrets: false });
  const text = JSON.stringify(bundle);
  assert.equal(bundle.secrets, null);
  assert.ok(!text.includes("main.afcatalog"));
  assert.ok(!text.includes("modelPath"));
  assert.ok(!text.includes("watchedDirs"));
  assert.ok(!text.includes("modelsCache"));
  assert.ok(!text.includes("gem-key"));
  assert.deepEqual(bundle.sections.general, { locale: "zh-CN", theme: "light", previews: { generateHd: true } });
  assert.deepEqual(bundle.sections.repaint.styles, STYLES, "ai-styles.json wins over legacy settings.aiStyles");
  assert.equal(bundle.sections.annotation.maxTags, 12);
});

test("secrets round-trip; only referenced namespaces, unreadable ones reported", async () => {
  const { bundle, secretCount, unreadable } = await exportAll();
  assert.equal(secretCount, 2);
  assert.deepEqual(unreadable, ["p_oai"]);
  assert.ok(!JSON.stringify(bundle).includes("gem-key"), "tokens are not in plaintext");
  const parsed = parseBundle(JSON.stringify(bundle));
  const tokens = await openSecrets(parsed, "correct horse");
  assert.deepEqual(tokens, { p_gem: "gem-key", "annotation:a_claude": "claude-key" });
});

test("wrong passphrase and tampered header both fail closed", async () => {
  const { bundle } = await exportAll();
  await assert.rejects(openSecrets(bundle, "wrong horse!"), { code: "bad_passphrase" });
  const tampered = { ...bundle, exportedAt: "2020-01-01T00:00:00.000Z" };
  await assert.rejects(openSecrets(tampered, "correct horse"), { code: "bad_passphrase" });
});

test("export refuses a short passphrase", async () => {
  await assert.rejects(exportAll({ passphrase: "short" }), { code: "weak_passphrase" });
});

test("parseBundle rejects foreign files and newer versions", () => {
  assert.throws(() => parseBundle("not json"), { code: "invalid_file" });
  assert.throws(() => parseBundle(JSON.stringify({ format: "other", version: 1 })), { code: "invalid_file" });
  assert.throws(
    () => parseBundle(JSON.stringify({ format: "afterframe-settings", version: 99, sections: {}, exportedAt: "x" })),
    { code: "newer_version" },
  );
  const parsed = parseBundle(JSON.stringify({
    format: "afterframe-settings", version: 1, exportedAt: "x", secrets: null,
    sections: { general: { locale: "en" }, evil: { x: 1 } },
  }));
  assert.deepEqual(Object.keys(parsed.sections), ["general"]);
});

test("summary flags id conflicts with the local settings", async () => {
  const { bundle } = await exportAll();
  const summary = summarizeBundle(bundle, { aiPreferences: { providers: [{ id: "p_gem", name: "Mine" }] } });
  assert.deepEqual(summary.sections.repaint.providers.map((p) => [p.id, p.conflict]), [["p_gem", true], ["p_oai", false]]);
  assert.equal(summary.sections.repaint.styleCount, 1);
  assert.equal(summary.secretCount, 2);
  assert.ok(!JSON.stringify(summary).includes("data"));
});

test("merge into an empty profile restores everything", async () => {
  const { bundle } = await exportAll();
  const merged = mergeBundle({ settings: {}, styles: null, bundle, sections: ["general", "repaint", "annotation"] });
  assert.equal(merged.locale, "zh-CN");
  assert.equal(merged.theme, "light");
  assert.deepEqual(merged.settings.previews, { generateHd: true });
  assert.equal(merged.settings.aiPreferences.activeProvider, "p_oai");
  assert.equal(merged.settings.aiAnnotation.activeProviderId, "a_claude");
  assert.equal(merged.settings.aiAnnotation.maxTags, 12);
  assert.deepEqual(merged.styles, STYLES);
  assert.deepEqual(merged.tokenNamespaces, ["p_gem", "p_oai", "annotation:a_claude"]);
});

test("merge keeps local-only entries and a valid local active provider", async () => {
  const { bundle } = await exportAll();
  const local = {
    lastCatalogPath: "/Users/b/lib.afcatalog",
    aiPreferences: {
      providers: [{ id: "p_local", type: "ark", name: "Ark" }, { id: "p_gem", type: "nanobanana", name: "Old name" }],
      activeProvider: "p_local",
      modelsCache: { p_local: [] },
    },
    aiAnnotation: { maxTags: 5, providers: [] },
  };
  const merged = mergeBundle({
    settings: local,
    styles: [{ id: "mine", name: "Mine", prompt: "p" }],
    bundle,
    sections: ["repaint", "annotation"],
  });
  assert.equal(merged.settings.lastCatalogPath, "/Users/b/lib.afcatalog");
  assert.deepEqual(merged.settings.aiPreferences.providers.map((p) => [p.id, p.name]), [
    ["p_local", "Ark"], ["p_gem", "Gemini"], ["p_oai", "OpenAI"],
  ]);
  assert.equal(merged.settings.aiPreferences.activeProvider, "p_local");
  assert.deepEqual(merged.settings.aiPreferences.modelsCache, { p_local: [] });
  // Local maxTags had no active provider → imported one becomes active, scalars overwrite.
  assert.equal(merged.settings.aiAnnotation.activeProviderId, "a_claude");
  assert.equal(merged.settings.aiAnnotation.maxTags, 12);
  assert.deepEqual(merged.styles.map((s) => s.id), ["mine", "s1"]);
  assert.equal(merged.locale, null, "general not selected");
});

test("unselected sections neither merge nor unlock their tokens", async () => {
  const { bundle } = await exportAll();
  const merged = mergeBundle({ settings: {}, styles: null, bundle, sections: ["annotation"] });
  assert.equal(merged.settings.aiPreferences, undefined);
  assert.equal(merged.styles, null);
  assert.deepEqual(merged.tokenNamespaces, ["annotation:a_claude"]);
});

test("collectExport without secrets never calls decrypt", () => {
  const result = collectExport({
    settings: SOURCE, sections: ["repaint"], includeSecrets: false,
    decryptToken: () => { throw new Error("should not decrypt"); },
  });
  assert.deepEqual(result.tokens, {});
});

test("watermark: the author and the frame templates travel; templates merge by id", async () => {
  const mine = { id: "user:a", kind: "layers", name: "Bar", canvas: { pad: { bottom: 0.12 } }, layers: [] };
  const { bundle } = await buildBundle({
    settings: { ...SOURCE, watermarkProfile: { author: "Yi" } },
    frameTemplates: [mine, { id: "bar-id", kind: "layers" }, { id: "user:b", kind: "anchors" }],
    sections: ["watermark"], includeSecrets: false, decryptToken, appVersion: "0.5.3",
  });
  // Only user templates of the layers kind; nothing else from settings.
  assert.deepEqual(bundle.sections, { watermark: { profile: { author: "Yi" }, templates: [mine] } });
  assert.deepEqual(summarizeBundle(bundle).sections.watermark, { author: "Yi", templateCount: 1 });

  const local = [{ ...mine, name: "Old name" }, { id: "user:local", kind: "layers", name: "Mine", layers: [] }];
  const merged = mergeBundle({ settings: { watermarkProfile: { author: "" } }, frameTemplates: local, bundle, sections: ["watermark"] });
  assert.equal(merged.settings.watermarkProfile.author, "Yi");
  assert.deepEqual(merged.frameTemplates.map((t) => [t.id, t.name]), [["user:a", "Bar"], ["user:local", "Mine"]]);

  // An empty name in the file never erases the local one; no templates → file untouched.
  const { bundle: empty } = await buildBundle({ settings: {}, frameTemplates: [], sections: ["watermark"], includeSecrets: false, decryptToken });
  const kept = mergeBundle({ settings: { watermarkProfile: { author: "Local" } }, frameTemplates: local, bundle: empty, sections: ["watermark"] });
  assert.equal(kept.settings.watermarkProfile.author, "Local");
  assert.equal(kept.frameTemplates, null);
});
