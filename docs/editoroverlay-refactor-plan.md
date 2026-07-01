# EditorOverlay refactor plan

`apps/desktop/src/components/EditorOverlay.jsx` is a **1686-line, 32-hook god component**. It already has *partial* modularization; the goal is to finish the job using the pattern the **frame tool already proves**: each tool = a state hook + a panel + (optional) a viewport surface, with `EditorOverlay` reduced to a thin orchestrator.

This is a **behavior-preserving** refactor. No feature changes. Each phase is independently shippable and verified against the same manual checklist.

---

## The reference pattern (already done, don't touch)

The **frame tool** is the target shape for every tool:

- `state/useFrameTool.js` — all state + logic (load logos, render, export)
- `FramePanel.jsx` — the right-panel UI
- `components/FrameStage.jsx` — the viewport surface

`EditorOverlay` only does: `const frameTool = useFrameTool({...})`, `{tool==="frame" && <FrameStage .../>}`, `<FramePanel frameTool={frameTool}/>`, and a `<ToolTab>`. **That's the whole integration.** Replicate this for the other tools + extract the shared "editor core".

Already extracted and reusable:
- Panels: `TextPanel`, `StickerPanel`, `AiRepaintPanel`, `FramePanel`
- Surfaces: `TextCanvas`, `CropOverlay`, `StickerRegionOverlay`, `FrameStage`
- Hooks: `useFrameTool`, `useStickerImageCache`, `useStickerRegion`, `useDepthModel`, `useLayerHistory`, `useSceneDepth`, `useViewportWheel`
- Pure modules: `cropMath`, `imageMath`, `layerStack`, `textState`, `render/{canvasHelpers,drawLayers,saveImage}`

---

## What still lives in EditorOverlay (the god parts)

| Responsibility | Where (approx) | Notes |
|---|---|---|
| **Image load / source / preview / downscale** | `load()` ~660–778 | full-res `sourceImage` + capped `previewSource`; the `PREVIEW_MAX_EDGE` logic |
| **Editor state machine** | `BASE_STATE`, `cloneState`, `stateEquals` 88–117; `applyState` 541; `editorState`/`editorStateRef`; transform history | crop/rotate/flip live in one state object + its own history |
| **Crop + transform tool** | `handlePointerMove/End` 910–1043; `commitAspect` 813; `commitTransform` 831; `updateAngle` 1070; `symmetricResize` 192; `createCenteredCrop` 174; `AngleRuler` 289; crop panel JSX 1503–1601 | the largest tangle |
| **Text tool** | `handleTextApply` 590–813 (**~220 lines**); `handleMoveLayer`/`handleDeleteLayer`; `commitLayers`; `selectedIds`; clipboard; text keyboard shortcuts 1292–1320 | rendering composite lives inline |
| **Save / export pipeline** | `handleApply` 1219; `executeSave*` 1156; quick-save; `saveEditedImage` wiring | full-res + native-sharp fast-path |
| **Viewport geometry + pointer routing** | `placement`/`imageRect` memos 780–800; `getViewportPoint` 803; pointer dispatch | one pointer handler branches per tool |
| **Shell / render** | tool rail 1650–1657; panel switch 521–535 + 1481–1656; footer; compare | JSX bulk |

---

## Target architecture

```
EditorOverlay (orchestrator, ~300–400 lines)
├── core hooks (tool-agnostic)
│   ├── useEditorImage()      → { sourceImage, previewSource, transformedPreview, loadState }
│   ├── useEditorHistory()    → { editorState, apply, undo, redo, reset, canUndo/Redo }
│   ├── useEditorViewport()   → { viewportRef, viewportSize, placement, imageRect, toViewportPoint }
│   └── useEditorSave()       → { save, quickSave, saving, handleApply }
├── per-tool hooks (one active at a time)
│   ├── useCropTool()   + <CropPanel>   + <CropOverlay>/<AngleRuler>
│   ├── useTextTool()   + <TextPanel>   + <TextCanvas>
│   ├── useStickerTool()+ <StickerPanel>+ <StickerRegionOverlay>
│   ├── useFrameTool()  + <FramePanel>  + <FrameStage>        (done)
│   └── AiRepaintPanel  (mostly self-contained already)
└── shell components
    ├── <ToolRail>      (the ToolTab column)
    ├── <PanelChrome>   (header title/badge + active panel switch)
    └── <EditorFooter>  (apply/save/compare buttons)
```

Pointer + keyboard routing: `EditorOverlay` keeps **one** `onPointerDown/Move/Up` and `onKeyDown` that dispatch to the **active tool hook's** handlers (each tool hook exposes `pointerHandlers`, `keyHandlers`). No per-tool `if` ladders scattered around.

---

## Phases (ordered; each = one PR, behavior-preserving)

### Phase 0 — safety net (before touching anything)
There is already a **Playwright + Electron e2e suite** (`apps/desktop/e2e/`, `npm run e2e`) driven by the `window.__afterframeTest` backdoor. It is a strong foundation but only partially covers the refactor's risk surface — **close the gap first** (see "E2E coverage" below). Deliverables:
- Extend the `__afterframeTest` backdoor with the missing verbs + a `getState()` snapshot.
- Add specs that assert **output/state before & after** for the interaction paths the refactor touches.
- These specs become the behavior-preservation harness re-run after **every** phase (`npm run e2e`).

---

## E2E coverage assessment (is the refactor covered?)

> **Phase 0 status: DONE.** The safety net now exists. Backdoor extended with
> `getState`, `setAspect`, `deleteLayer`, `moveLayer`, `selectLayers`, `undo`,
> `redo`, `exportFrame` (+ `useFrameTool.exportTo` to skip the save dialog).
> Golden specs added — `18-editor-transform` (baseline dims, rotate dims+undo/redo,
> flip, 1:1 crop), `19-editor-layers` (add/reorder/delete/select), `20-frame`
> (full-res export on a >2200px fixture). **13 golden tests, all green + stable
> under `npm run e2e`** (75 pass / 8 Xcode-skipped; the lone `02-navigation`
> flake is pre-existing and unrelated). Each refactor phase must keep these green.


**Infra:** `@playwright/test` launches the built Electron app; specs drive the editor through `window.__afterframeTest` (a backdoor merged in `App.jsx` + `EditorOverlay.jsx`). Today it exposes: `openEditor(path)`, `closeEditor()`, `setTool(t)`, `getTool()`, `addTextLayer(text)`, `getLayerCount()`, `saveAs(path)`, `getPreviewReady()`, `getSaving()`.

**Verdict: partial. The two lowest-risk phases are well covered; the highest-risk interaction/state paths are not.**

| Refactor area | Phase | Current e2e | Covered? |
|---|---|---|---|
| Save pipeline (native no-layer / canvas w/ text / rotate dim-swap) | 2 | `06-save.spec.js` | ✅ good |
| Tool switch + each panel renders | 4 | `03-editor.spec.js` | ✅ shallow but enough |
| Sticker create/detect | 3c | `04-sticker.spec.js` | ✅ (real path Xcode-gated) |
| Scene depth | — | `07-depth.spec.js` | ✅ (Xcode-gated) |
| **Crop drag / handles / aspect apply / free-angle** | 3a | — | ❌ none |
| **Transform combos: flip, quarter-turn, angle (beyond one rotate-save)** | 1/3a | partial (rotate dim only) | ⚠️ thin |
| **Text move / resize / delete / multi-select / copy-paste / z-order** | 3b | only `addTextLayer`+save | ❌ none |
| **Undo / redo (transform stack + layer stack)** | 1 | — | ❌ none |
| **Frame tool: preset / sliders / logo color / export size** | (extracted) | — | ❌ none |
| **Pointer routing** (the dispatch we're restructuring) | 1–3 | bypassed by backdoor | ❌ none |

**Gap = exactly the interaction + history + pointer logic that Phases 1–3 restructure.** So the suite as-is would catch a broken *save* or a missing *panel*, but NOT a broken crop-drag, a lost undo entry, or mis-routed pointers.

**Phase 0 work to make e2e cover the refactor** (cheap — the backdoor pattern already exists; add verbs, not new infra):
- Backdoor verbs: `applyCrop(rect)`, `setRotation(deg)`/`quarterTurn()`, `flipX()`/`flipY()`, `undo()`/`redo()`, `deleteLayer(id)`/`moveLayer(id,dir)`, `selectLayers(ids)`, `exportFrame(presetId)`, and a `getState()` returning `{ crop, rotationDeg, flipX/Y, layers:[{id,x,y,scale}], historyIndex, tool }`.
- Specs (assert **byte/dimension/state stable** across the refactor):
  - crop a known rect + apply → saved dimensions match expected.
  - rotate 90 + flipX + apply → dimensions + a corner-pixel probe match.
  - add 2 text layers, move/delete one, reorder → `getState().layers` matches; save → canvas path pixel probe.
  - undo×N / redo×N → `getState()` returns to expected snapshots.
  - frame: pick preset + set logo color + export → output long-edge == source long-edge (guards the full-res export fix) + file exists.
- These are **golden/characterization tests**: capture current behavior on `main`, then every refactor phase must keep them green.

> Rule for this refactor: **no phase merges unless `npm run e2e` is green**, and any intentional output change is a separate, reviewed commit — never a silent side effect of a "refactor".

### Phase 1 — extract the shared, tool-agnostic core (lowest risk, unblocks the rest)
1. **`useEditorImage`** — move `load()`, source/preview state, `PREVIEW_MAX_EDGE` downscale, `transformedPreview` memo, cleanup. Pure I/O; no tool logic. *(biggest single win, isolates a self-contained concern)*
2. **`useEditorHistory`** — move `BASE_STATE`/`cloneState`/`stateEquals` to `editor/editorStateModel.js`; wrap `editorState` + `editorStateRef` + `applyState` + undo/redo/reset into a hook. Keep the ref-vs-state duality (needed for pointer handlers reading latest state synchronously).
3. **`useEditorViewport`** — `placement`, `imageRect`, `getViewportPoint`, `viewportSize` observer; fold in `useViewportWheel`. Returns geometry + a `toViewportPoint(e)` helper.

### Phase 2 — extract the save/export pipeline
- **`useEditorSave`** — `handleApply`, `executeSave*`, quick-save, the `saveEditedImage` call assembly (native-sharp fast-path vs canvas fallback). Depends on core hooks + the active layer set. This is the highest-fidelity path — extract as a unit and verify pixel output is byte-stable.

### Phase 3 — per-tool extraction (the bulk; one tool per PR)
3a. **Crop/Transform → `useCropTool`** — `handlePointerMove/End`, `commitAspect`, `commitTransform`, `updateAngle`; move `symmetricResize`/`createCenteredCrop` into `cropMath`; extract the crop panel JSX → `<CropPanel>`. Reuse `CropOverlay` + `AngleRuler`. Expose `pointerHandlers`.
3b. **Text → `useTextTool`** — layer CRUD (`handleMoveLayer/Delete`, `commitLayers`), `selectedIds`, clipboard, text keyboard shortcuts; move the `handleTextApply` compositing into `render/` (it duplicates `saveImage` logic — dedupe). `TextPanel`/`TextCanvas` already exist. Expose `pointerHandlers` + `keyHandlers`.
3c. **Sticker → `useStickerTool`** — thin: `useStickerRegion` + `useStickerImageCache` already exist; gather the remaining sticker glue.
3d. **AI repaint** — already a panel; pull any residual state (`compareState`) into a small hook if needed.

### Phase 4 — slim the shell
- Extract `<ToolRail>`, `<PanelChrome>`, `<EditorFooter>`. `EditorOverlay` becomes: mount core hooks → mount active tool hook → route pointer/keys → render rail + panel + surface. Target ≤ ~400 lines.

---

## Invariants to preserve (the risk list)

1. **Pointer routing** — crop resize, text drag, sticker region must keep exact hit-testing. Route through the active tool's handlers; don't regress the ref-based "read latest state synchronously" trick (`editorStateRef`, `pointerStateRef`).
2. **History semantics** — transform history (crop/rotate) and `useLayerHistory` are separate; don't merge their undo stacks. `applyState` equality checks (`stateEquals`) prevent dup history entries — preserve.
3. **Save fidelity** — full-res `sourceImage`, native-sharp fast-path when `layers.length === 0`, canvas fallback otherwise. Output must be byte-identical after refactor (Phase 2 acceptance test).
4. **`transformedPreview` memo identity** — it feeds many children; keep its `useMemo` deps exact to avoid re-render storms.
5. **Keyboard scoping** — copy/paste/delete only fire in the text tool with a selection.
6. **No behavior change per phase** — every phase re-runs the checklist; a phase that alters output is a bug, not a feature.

## Verification checklist (run each phase)
- Crop: drag handles, aspect presets, free-angle rotate, quarter-turn, flip X/Y → Apply → image correct.
- Text: add/move/resize/delete layers, multi-select, copy/paste, z-order → Apply → composite correct.
- Sticker: place region, pick sticker, depth masking.
- Frame: pick preset, sliders, logo color, export at original resolution.
- AI repaint: run, before/after compare.
- Save: quick-save + export; native fast-path (no layers) and canvas path (with layers).
- Undo/redo across transform + layers; reset.

---

## Sequencing rationale & payoff
- **Core first** (Phase 1): every tool depends on image/state/viewport; extracting them first makes each tool extraction mechanical.
- **Save second** (Phase 2): isolates the one path where correctness is pixel-critical.
- **Tools by size** (Phase 3): crop (biggest tangle) → text (biggest function) → sticker/ai (already thin).
- **Payoff**: EditorOverlay `1686 → ~350` lines; each tool becomes independently testable/editable; new tools follow the frame-tool recipe. The frame tool already demonstrates the end state.
