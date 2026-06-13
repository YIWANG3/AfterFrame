# Desktop Mockups

These mockups are intended for direct import into Figma as editable SVG frames.

Files:

- `library-asset-workbench.svg`
- `reverse-lookup-review.svg`
- `eagle-inspired-library.svg`
- `eagle-inspired-review.svg`
- `eagle-refined-library.svg`

Design direction:

- Productivity-first desktop shell, not a landing page
- Dense media browser inspired by Eagle, Apple Photos, and Lightroom Library
- One variant deliberately follows Eagle's panel rhythm more closely
- Neutral black/graphite base, not blue-tinted dark UI
- Gold is reserved for primary emphasis, selection, and irreversible actions
- Navigation and metadata stay visible without stealing canvas space
- Grid is the default center of gravity
- Stats move into compact utility strips instead of oversized cards
- Right inspector is persistent and task-oriented

Primary layout decisions:

- Left sidebar for catalog, smart collections, shoots, and drafts
- Thin top bar for search, filters, density, and sort
- Main canvas for a dense asset grid
- Persistent right inspector for lineage, metadata, content state, and quick actions
- Dedicated review screen for export-to-RAW confirmation instead of hiding it in generic detail UI

Suggested Figma workflow:

1. Import both SVGs into a single Figma page.
2. Use `library-asset-workbench.svg` as the base shell.
3. Reuse the right inspector, top bar, and sidebar as components.
4. Branch variants for matched, unmatched, and content-editing states.
5. If you want the closest Eagle-like baseline, start from `eagle-inspired-library.svg`.
6. If you want the cleaner Lightroom-dark direction with fewer visible frames, start from `eagle-refined-library.svg`.
