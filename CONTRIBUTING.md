# Contributing to AfterFrame

Thanks for helping. Setting up the repository, the architecture and the test
tooling are in [docs/developer-setup.md](docs/developer-setup.md); this page is
what a pull request needs before it can be merged.

## Before you open a pull request

1. **One change per pull request, branched from `main`.** Don't branch from
   another open pull request; if yours needs it, wait until it lands.
2. **Run the checks locally.**
   - `npm run check` at the repository root: lint, unit tests and the build.
   - The end-to-end specs for the area you touched. They launch the built
     app, so build first:

     ```bash
     cd apps/desktop
     npm run build
     npx playwright test e2e/22-lightbox-zoom.spec.js e2e/84-lightbox-details.spec.js
     ```

     To find them, search the specs for the component, test id or label you
     changed (`grep -l "lightbox" apps/desktop/e2e/*.spec.js`). The whole
     suite is `npm run test:e2e` (about half an hour on macOS).
   - CI runs everything on macOS (`electron-e2e`) and Windows (`windows-e2e`).
     A pull request with a red `electron-e2e` is not merged.
3. **New behaviour comes with an end-to-end test.** Add tests to the spec of
   that feature, or a new `apps/desktop/e2e/NN-name.spec.js` with the next free
   number. Test what a user does and sees (clicks, keys, the pointer, what is
   on screen), not internal state. The comment at the top of a spec says what
   the feature is meant to do; write one for a new spec.
4. **Say when you change a default or an existing behaviour.** Existing specs
   record decisions that were made on purpose. If your change makes one fail
   because the behaviour is meant to change, update the spec, keep its intent
   where it still applies, and explain the change in the pull request. Don't
   delete assertions just to make CI pass.
5. **Every UI string goes in both languages**:
   `apps/desktop/src/i18n/locales/en/` and `zh-CN/`. In Chinese copy, don't
   use `——`, and an `.afcatalog` is a 文件夹 (folder), not a 文件 (file).
6. **Show visible changes.** Add a screenshot or a short recording for UI
   changes, in the dark and light themes if colours or glass are involved.

## The pull request description

- What changes, from the user's point of view.
- What changes for existing users: defaults, layouts, shortcuts, anything
  they would notice after updating.
- The checks you ran, as commands, and their results. "Tests were not run"
  means the pull request is not ready yet.

## Commit messages

Follow the style in the history: `feat(lightbox): …`, `fix(import): …`,
`test(folders): …`, `docs: …`. The subject says what the user gets, in plain
words.

## Easy to break

- **Catalog schema.** Follow
  [Catalog schema changes](docs/developer-setup.md#catalog-schema-changes):
  one version bump, one migration, one upgrade test.
- **E2E fixtures** under `apps/desktop/e2e/fixtures/` are committed, and
  re-seeding one changes every file in it. Extend a private copy from the spec
  (`prepareCatalog`) instead; see
  [E2E fixtures](docs/developer-setup.md#e2e-fixtures-what-rebuilds-where).
- **The lightbox's layout** comes from `apps/desktop/src/index.css` selectors
  on the root's direct children (header, zoom row, filmstrip, stage). Changing
  those children's classes or nesting moves things around.
- **Controls that appear on hover** take no clicks while hidden, and
  Playwright checks what is under the point before it moves the mouse. In a
  spec, move the pointer onto such a control before clicking it.
- **Dev restarts.** `npm run dev` hot-reloads the renderer only. Changes in
  `apps/desktop/electron/` (main process) or `services/sidecar/` need the dev
  app restarted.
- **Native helpers** (`apps/desktop/native/*.swift`) are built by
  `npm run build:native` with Xcode's toolchain. Their binaries, the face model
  and ExifTool are fetched or built, never committed.
