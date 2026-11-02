# Feature modules

The editing tools (LUT, AI repaint, sticker extraction, …) are moving out of
`src/` and `electron/` into self-contained feature modules under this
directory. The plan and the reasons are in `docs/feature-modules-plan.md`.

Layout, one directory per feature:

```
features/
  manifests.mjs            # the one static list of every manifest, both processes import it
  <id>/
    manifest.mjs           # pure data + lazy loaders: id, where it plugs in, ipc, entry paths
    electron/              # main-process code (CommonJS, Node), named by manifest.electron
    renderer/              # React/Vite code, loaded lazily through the manifest
```

Conventions:

- A manifest names its entry files explicitly (`electron: "./electron/xxx.js"`);
  there is no `index.js` naming rule.
- Unit tests live next to the code they test (`*.test.js`), as in `src/` and
  `electron/`: `npm run test:electron` picks up `features/**/electron/**/*.test.js`,
  `npm run test:renderer` picks up tests under `features/`.
- e2e specs stay numbered in `e2e/`; a feature does not get its own spec folder.
- ESLint applies the renderer rules (`src/`) to `features/**/renderer/**`, the
  main-process rules (`electron/`) to `features/**/electron/**`, and the
  shared-ESM rules to `features/**/*.mjs`.
- The packaged app ships `features/**` minus the tests (`package.json`
  `build.files`), and dev staleness watches it like `electron/` and `shared/`.
