# Feature modules

The editing tools (LUT, AI repaint, sticker extraction, …) are moving out of
`src/` and `electron/` into self-contained feature modules under this
directory. The plan and the reasons are in `docs/feature-modules-plan.md`;
the LUT tool (`lut/`) is the first one and the shape to copy.

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
    renderer/              # React/Vite code; renderer/index.js exports Panel (lazy), useTool,
                           # SettingsGroup, icon — whichever the manifest's contributions need
```

How the host reads a manifest:

- `shared/ipcChannels.mjs` appends each manifest's `contributes.ipc` rows to
  the core table, so preload, the facade and their parity tests see them
  without a change.
- `electron/features.js` loads each manifest's `electron` entry and registers
  it with the host (`registerFeatures(host)` in main.js), and turns
  `platforms` / `helper` into capability flags (`electron/capabilities.js`).
- `src/components/editor/editorTools.js` places the `editorTool` rows on the
  rail; `LibrarySettings.jsx` renders the `settingsGroup` rows for its tab.
- A feature's hooks are imported and called by EditorOverlay directly (rules
  of hooks); only the panel is a lazy chunk.

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
