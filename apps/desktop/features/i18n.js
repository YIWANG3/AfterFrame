// The feature modules' strings: each feature keeps its own namespace, named
// by its manifest id, in features/<id>/renderer/locales/<lng>.json, and
// src/i18n/index.js registers them next to the host's namespaces. Only JSON
// is imported here, so src/i18n can import this file without pulling in any
// renderer code (which would be a cycle: renderers import the host's
// components, some of which import src/i18n).
//
// A feature's labelKeys in its manifest carry the namespace ("lut:tool"), so
// the host's t() resolves them whichever namespace its hook was given.
import manifests from "./manifests.mjs";
import { SUPPORTED_LOCALES } from "../src/i18n/locales.js";

const files = import.meta.glob("./*/renderer/locales/*.json", { import: "default", eager: true });

// { en: { lut: {...}, repaint: {...}, … }, "zh-CN": { … } }
export const featureResources = Object.fromEntries(SUPPORTED_LOCALES.map((lng) => [lng, {}]));
for (const [file, strings] of Object.entries(files)) {
  const [, id, lng] = file.match(/^\.\/([^/]+)\/renderer\/locales\/([^/]+)\.json$/);
  if (!featureResources[lng]) throw new Error(`features/i18n.js: ${file} is not one of ${SUPPORTED_LOCALES.join(", ")}`);
  featureResources[lng][id] = strings;
}
for (const { id } of manifests) {
  for (const lng of SUPPORTED_LOCALES) {
    if (!featureResources[lng][id]) throw new Error(`features/i18n.js: features/${id}/renderer/locales/${lng}.json is missing`);
  }
}

export const featureNamespaces = manifests.map(({ id }) => id);
