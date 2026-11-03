# Feature modules

The editing tools (LUT, AI repaint, sticker extraction, …) are moving out of
`src/` and `electron/` into self-contained feature modules under this
directory. The plan and the reasons are in `docs/feature-modules-plan.md`;
the LUT tool (`lut/`) is the first one and the shape to copy; AI Repaint
(`repaint/`) adds a Settings tab and an MCP tool; the sticker tool
(`sticker/`) adds a canvas overlay, a sidebar view and a layer source, and
needs a native helper.

Layout, one directory per feature:

```
features/
  manifests.mjs            # the one static list of every manifest, both processes import it
  index.js                 # the renderer's registry: manifest id → renderer/index.js exports,
                           # plus the tool-rail rows and Settings groups the manifests contribute
  <id>/
    manifest.mjs           # pure data: id, capability, platforms, what it contributes, entry path
    electron/              # main-process code (CommonJS, Node), named by manifest.electron;
                           # its entry exports register(host) like every module in electron/ipc/
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
- ESLint applies the renderer rules (`src/`) to `features/**/renderer/**`, the
  main-process rules (`electron/`) to `features/**/electron/**`, and the
  shared-ESM rules to `features/**/*.mjs`.
- The packaged app ships `features/**` minus the tests (`package.json`
  `build.files`), and dev staleness watches it like `electron/` and `shared/`.
