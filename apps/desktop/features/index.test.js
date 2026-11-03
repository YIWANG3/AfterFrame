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
