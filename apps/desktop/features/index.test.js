// The renderer registry against manifest v1: each feature's renderer/index.js
// exports what its manifest's contributions need (features/index.js throws
// at import otherwise, which is what this test would show), and the tables
// the host UI reads carry one row per contribution.
import { describe, expect, it } from "vitest";
import manifests from "./manifests.mjs";
import { rendererExportsFor } from "./manifestSchema.mjs";
import { FEATURES, editorToolFeatures, settingsTabs, settingsGroups, sidebarViews, layerSources } from "./index.js";

describe("features/index.js", () => {
  it("registers a renderer for every manifest, with the exports its contributions need", () => {
    expect(Object.keys(FEATURES).sort()).toEqual(manifests.map((m) => m.id).sort());
    for (const manifest of manifests) {
      for (const name of rendererExportsFor(manifest)) {
        expect(FEATURES[manifest.id][name], `${manifest.id}/renderer/index.js exports ${name}`).toBeDefined();
      }
    }
  });

  it("builds one row per contribution, in manifest order", () => {
    const by = (key) => manifests.filter((m) => m.contributes[key]);
    expect(editorToolFeatures.map((r) => r.key)).toEqual(by("editorTool").map((m) => m.contributes.editorTool.key));
    expect(settingsTabs.map((r) => r.id)).toEqual(by("settingsTab").map((m) => m.contributes.settingsTab.id));
    expect(settingsGroups("library").map((r) => r.id)).toEqual(by("settingsGroup").map((m) => m.id));
    expect(sidebarViews.map((r) => r.id)).toEqual(by("sidebarView").map((m) => m.contributes.sidebarView.id));
    expect(layerSources.map((r) => r.id)).toEqual(by("layerSource").map((m) => m.contributes.layerSource.id));
    for (const row of editorToolFeatures) expect(typeof row.Overlay === "function" || row.Overlay === null).toBe(true);
    for (const row of layerSources) expect(typeof row.list).toBe("function");
  });
});

// The features' strings (features/i18n.js): one namespace per feature, both
// languages with the same keys, and every label the manifests name resolves.
// (The resources are checked directly: src/i18n/index.js needs the preload
// and a window, which this node test has not.)
import { featureResources, featureNamespaces } from "./i18n.js";

const flatKeys = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([key, value]) => (value && typeof value === "object" ? flatKeys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
// i18next plural forms: zh-CN has one form, so "_one" exists in en alone.
const singular = (key) => key.replace(/_(one|other|zero|few|many)$/, "");

describe("features/i18n.js", () => {
  it("has a namespace per manifest, named by its id, in every language", () => {
    expect(featureNamespaces).toEqual(manifests.map((m) => m.id));
    for (const lng of ["en", "zh-CN"]) {
      expect(Object.keys(featureResources[lng]).sort()).toEqual(featureNamespaces.slice().sort());
    }
  });

  it("keeps en and zh-CN in step for every feature", () => {
    for (const id of featureNamespaces) {
      const en = new Set(flatKeys(featureResources.en[id]).map(singular));
      const zh = new Set(flatKeys(featureResources["zh-CN"][id]).map(singular));
      expect([...zh].filter((k) => !en.has(k)), `${id}: zh-CN keys missing from en`).toEqual([]);
      expect([...en].filter((k) => !zh.has(k)), `${id}: en keys missing from zh-CN`).toEqual([]);
    }
  });

  it("resolves every label the manifests name, in its own namespace", () => {
    const labels = manifests.flatMap(({ id, contributes }) =>
      [contributes.editorTool?.labelKey, contributes.settingsTab?.labelKey, contributes.sidebarView?.labelKey, contributes.layerSource?.labelKey, contributes.layerSource?.hideLabelKey]
        .filter(Boolean)
        .map((key) => ({ id, key })));
    expect(labels.length).toBeGreaterThan(0);
    for (const { id, key } of labels) {
      expect(key.startsWith(`${id}:`), `${id}: ${key} is in the feature's namespace`).toBe(true);
      const [ns, path] = key.split(":");
      for (const lng of ["en", "zh-CN"]) {
        const value = path.split(".").reduce((node, part) => node?.[part], featureResources[lng][ns]);
        expect(typeof value, `${lng}: ${key}`).toBe("string");
      }
    }
  });
});
