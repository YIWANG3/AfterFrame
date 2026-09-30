// The camera name tables (camera-names/manual.json, hand-kept, and
// generated.json, built from CC0 sources: see camera-names/README.md), read
// once and only when a camera is named: the generated one is large.
// frameLogos.cameraNamer puts them in order with the user's names and rules.

const files = import.meta.glob("/camera-names/*.json", { import: "default" });

let tables = null;

/** @returns {Promise<{ manual: object|null, generated: object|null }>} */
export function loadCameraNameTables() {
  if (!tables) {
    const read = (name) => files[`/camera-names/${name}.json`]?.().catch(() => null) ?? null;
    tables = Promise.all([read("manual"), read("generated")])
      .then(([manual, generated]) => ({ manual, generated }));
  }
  return tables;
}
