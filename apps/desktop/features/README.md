# Feature modules

The editing tools (LUT, AI repaint, sticker extraction) live in
self-contained feature modules under this directory, each assembled from its
manifest; the app body under `src/` and `electron/` manages the library. The
plan and the reasons are in `docs/feature-modules-plan.md`; the LUT tool
(`lut/`) is the shape to copy; AI Repaint (`repaint/`) adds a Settings tab
and an MCP tool; the sticker tool (`sticker/`) adds a canvas overlay, a
sidebar view and a layer source, and needs a native helper. The manifest's
shape is frozen as **manifest v1** (`manifestSchema.mjs`, the reference
below).

Layout, one directory per feature:

```
features/
  manifestSchema.mjs       # manifest v1: the fields, their rules, the renderer exports each needs
  manifests.mjs            # the one static list of every manifest, validated at import; both processes import it
  i18n.js                  # the features' locale files, one namespace per manifest id, for src/i18n/index.js
  index.js                 # the renderer's registry: manifest id → renderer/index.js exports,
                           # plus the tool-rail rows, Settings groups and tabs, sidebar views and
                           # layer sources the manifests contribute
  <id>/
    manifest.mjs           # pure data: id, capability, platforms, what it contributes, entry path
    electron/              # main-process code (CommonJS, Node), named by manifest.electron;
                           # its entry exports register(host) like every module in electron/ipc/
    renderer/locales/      # the feature's strings: en.json, zh-CN.json — its own i18n namespace,
                           # named by the manifest id (features/i18n.js registers them)
    renderer/              # React/Vite code; renderer/index.js exports Panel (lazy or not),
                           # useTool, Overlay, icon (editor tool); SettingsGroup, SettingsTab,
                           # settingsTabIcon (Settings); View, Inspector, useView, sidebarIcon
                           # (sidebar view); layerSource — whichever the manifest's
                           # contributions need
```

How the host reads a manifest:

- `shared/ipcChannels.mjs` appends each manifest's `contributes.ipc` rows to
  the core table, so preload, the facade and their parity tests see them
  without a change.
- `electron/features.js` loads each manifest's `electron` entry and registers
  it with the host (`registerFeatures(host)` in main.js), and turns
  `platforms` / `helper` into capability flags (`electron/capabilities.js`):
  a feature whose helper (a `native/bin` name) is missing is off.
- `src/components/editor/editorTools.js` places the `editorTool` rows on the
  rail; EditorOverlay mounts the active tool's `Overlay` over the canvas when
  the row says `overlay: true` (props `{ imageRect, tool }`, `tool` being
  what the feature's `useTool` returned); `SettingsOverlay.jsx` places the
  `settingsTab` rows among its own; `LibrarySettings.jsx` renders the
  `settingsGroup` rows for its tab.
- `Sidebar.jsx` lists the `sidebarView` rows below the browse rows, and
  `App.jsx` hosts the active one: `View` takes the centre pane, `Inspector`
  the right-hand pane, and the state from the feature's `useView({
  lightboxOpen, setLightboxOpen })` must offer `refresh`, `selected`,
  `lightboxItems`, `lightboxIndex`, `onLightboxIndexChange` and `handleKey`.
  The agent's `show_in_app` reaches the view by the same id
  (`electron/mcp/tools/app.js` builds its enum from the manifests).
- `TextPanel.jsx` shows a picker button per `layerSource` row and
  `StickerPickerModal` lists the chosen source's images (`{ icon, list,
  thumbUrl }` from the feature).
- `electron/mcp/tools/index.js` appends each manifest's `mcpTools` group
  (a module exporting `(ctx) => tools[]`, the shape of `mcp/tools/*.js`).
- What two features (or a feature and the core) share stays in the host: the
  AI providers' credentials and preferences (`electron/ipc/ai.js`) serve the
  text tool as well as repaint, and `host.dialogs` remembers picker folders
  for every module.
- A feature's hooks are imported and called by EditorOverlay (`useTool`) and
  App (`useView`) directly, by name (rules of hooks); their results go into
  small tables keyed by rail key / view id that the table-driven parts read.
  Only the panel is a lazy chunk.

Conventions:

- A manifest names its entry files explicitly (`electron: "./electron/xxx.js"`);
  there is no `index.js` naming rule.
- Unit tests live next to the code they test (`*.test.js`), as in `src/` and
  `electron/`: `npm run test:electron` (node:test) picks up
  `features/**/electron/**/*.test.js`, `npm run test:renderer` (vitest, the
  `test.include` in `vite.config.js`) picks up `features/**/renderer/**/*.test.js`.
- e2e specs stay numbered in `e2e/`; a feature does not get its own spec folder.
  Locally a PR runs its acceptance specs and `npm run e2e:ci-skipped` (the
  specs that skip themselves on the GitHub runner); the whole suite runs on
  every PR in `quality.yml`.
- ESLint applies the renderer rules (`src/`) to `features/**/renderer/**`, the
  main-process rules (`electron/`) to `features/**/electron/**`, and the
  shared-ESM rules to `features/**/*.mjs`.
- The packaged app ships `features/**` minus the tests (`package.json`
  `build.files`), and dev staleness watches it like `electron/` and `shared/`.
- A feature's strings live in `renderer/locales/<lng>.json` and form its own
  i18n namespace, named by the manifest id (`useTranslation("lut")`;
  `features/i18n.js` collects them with `import.meta.glob`, `src/i18n/index.js`
  registers them next to the host's). Every `labelKey` in a manifest carries
  the namespace (`"lut:tool"`), so the host's `t()` resolves it whichever
  namespace its hook was given. A feature that needs a host string (the LUT
  group's "Open in Finder", the provider rows AI Repaint shares with the
  text tool) reaches it the same way (`t("settings:library.openFolder")`);
  the host reaches a feature string only through the manifest's labelKeys,
  with one exception noted in EditorOverlay (`lut:base.rendering`).
  `features/index.test.js` keeps en and zh-CN in step per feature.

## Manifest v1 (frozen 2026-11-02)

`features/manifests.mjs` runs every manifest through
`validateManifests()` when it is imported, so a wrong manifest stops the
process that imports it first (main at startup, the renderer at module load,
vitest and node:test alike) with the field named. The rules below are the
contract; `manifestSchema.mjs` is their code. A change to the shape is a
change to the contract: bump `MANIFEST_VERSION`, change the validator, this
table and `docs/feature-modules-plan.md` §12 together, and say why in the PR.
Amended 2026-11-03, before any manifest existed outside this repository:
every `labelKey` is `<namespace>:<key>` in the feature's own namespace, and
`settingsTab` names its label with `labelKey` (it had `key`, a label under
the host's settings namespace).

### Top-level fields

All nine are required except `electron` (and every top-level key must be one
of them).

| Field | Type | Rule | Read by |
|---|---|---|---|
| `manifestVersion` | `1` | The shape this manifest follows. | `manifestSchema.mjs` |
| `id` | string | `^[a-z][a-z0-9-]*$`, unique; the directory name under `features/`. | both: entry paths resolve against `features/<id>/`; `features/index.js` keys `FEATURES` by it |
| `capability` | string | A name in `shared/capabilities.mjs`, unique: the flag `api.can()` checks for every contribution. | `electron/capabilities.js` (declares it false where the feature cannot run), the UI tables |
| `platforms` | `null` or non-empty array of `"darwin"`, `"win32"`, `"linux"` | Where the feature declares itself available; `null` is everywhere. | `electron/features.js` `capabilitiesFromFeatures` |
| `helper` | `null` or string | A `native/bin` name (`^[a-z][a-z0-9-]*$`); the capability is false when the build lacks it (the macOS 12 builds). | same |
| `web` | boolean | Whether the browser build ("Try in browser") has the feature; `false` makes `src/api/browser/bridge.js` declare the capability false. | the web bridge, `src/api/capabilities.test.js` |
| `trust` | `"bundled"` | The trust tier. `bundled` is first-party: in-tree, privileged (Node, helpers, sharp). The sandboxed third-party tier is not accepted yet; it will come with a version bump. | `manifestSchema.mjs` |
| `contributes` | object | At least one of the contributions below; no other keys. | see each |
| `electron` | string, optional | The main-process entry, `./…​.js` relative to the manifest, exporting `register(host)` (the shape of `electron/ipc/*`). Required when there are `ipc` rows. A manifest without one has nothing to run in main. | `electron/features.js` `loadFeatures` / `registerFeatures` |

### Contributions

Each is an object (or, for `ipc`, an array; for `mcpTools`, a path) with
exactly the fields listed; `unavailable` says what the UI does with the
contribution where the capability is false (`"locked"`: shown greyed with the
platform hint, `"hidden"`: not shown).

| Contribution | Fields | Unique across manifests | Placed by | Renderer exports it needs |
|---|---|---|---|---|
| `editorTool` | `key` (`^[a-z][a-z0-9-]*$`), `labelKey` (`<id>:<key>` in the feature's namespace), `unavailable`, optional `overlay` (boolean, default false), optional `mount` (`"active"` default, or `"always"`: the panel stays mounted for the editor's life) | `key` | `src/components/editor/editorTools.js` puts the row where `RAIL_ORDER` says (a key missing there stops the editor); EditorOverlay mounts `Overlay` over the canvas when `overlay` is true, with props `{ imageRect, tool }` (`tool` = what the feature's `useTool` returned) | `Panel`, `icon`; `Overlay` when `overlay`; `useTool` by convention when the tool has state (EditorOverlay imports it by name) |
| `settingsGroup` | `tab` (`"library"`: the only tab that renders groups so far) | — | `LibrarySettings.jsx` renders `settingsGroups("library")`, each gated by the capability | `SettingsGroup` |
| `settingsTab` | `id` (`^[a-z][a-z0-9-]*$`), `labelKey` (`<id>:<key>`) | `id` | `SettingsOverlay.jsx` places it per its `TAB_ORDER` | `SettingsTab`, `settingsTabIcon` |
| `sidebarView` | `id` (`^[a-z][a-z0-9-]*$`), `labelKey` (`<id>:<key>`), `unavailable` | `id` | `Sidebar.jsx` lists it below the browse rows; `App.jsx` hosts the active one (`View` centre pane, `Inspector` right pane) and holds its state from `useView({ lightboxOpen, setLightboxOpen })`, which must offer `refresh`, `selected`, `lightboxItems`, `lightboxIndex`, `onLightboxIndexChange`, `handleKey`; the agent's `show_in_app` reaches it by `id` (`electron/mcp/tools/app.js` builds its enum from the manifests) | `View`, `Inspector`, `useView`, `sidebarIcon` |
| `layerSource` | `id` (`^[a-z][a-z0-9-]*$`), `labelKey`, `hideLabelKey` (`<id>:<key>`) | `id` | `TextPanel.jsx` shows a picker button per source; `StickerPickerModal` lists the chosen one's images | `layerSource`: `{ icon, list(), thumbUrl(entry) }` |
| `ipc` | non-empty array of `[method, channel, arity]`: method `^[a-z][A-Za-z0-9]*$` (becomes `api.<method>`), channel `^[a-z]+:[a-z0-9-]+$`, arity an integer 0–3 | method, channel (and against the core rows: `electron/ipcChannels.test.js`) | `shared/ipcChannels.mjs` appends the rows to `IPC_METHODS`; preload, facade and the parity tests see them without a change; the `electron` entry answers them | — |
| `mcpTools` | path `./…​.js` relative to the manifest, a module exporting `(ctx) => tools[]` (the shape of `electron/mcp/tools/*.js`) | tool names (`electron/mcp/tools` tests) | `electron/mcp/tools/index.js` appends the group | — |

### What is deliberately not in v1

- **A processor contribution** (pixels in, pixels out, the shape a develop
  or film-look tool would use). The LUT tool reaches the save path by hand
  (`gradeContent` in EditorOverlay), on 8-bit canvas pixels; a processor
  chain with a 16-bit or float base is its own plan and will be v2.
- **A sandboxed trust tier** and anything a third-party plugin needs (a
  renderer entry other than an in-tree `renderer/index.js`, a message
  bridge, a permission list). `docs/plugin-architecture-research.md` has the
  direction; the first example plugin decides the fields.
- **Job types, facets, context-menu items**: no feature has needed one.

