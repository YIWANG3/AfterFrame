# Lens-maker logos: implementation plan

> **Status (2026-10-01): deferred.** Only step 3's data part is done: EXIF
> LensMake is now read at import and stored as `lens_make` in
> `metadata_json`, and kept in framed copies and the web build. Nothing else
> here is built: no lens matching, no lens slot, no Frame tool or Settings
> rows, no presets. The user asked for no manual per-lens override either.
> The logo files (Sigma, Tamron, Tokina, Laowa, Voigtländer) are in
> `frame-logos/`, tagged `lens`.

Branch `feat/brand-logos`, HEAD `1c1e8ce`, working tree clean. Paths are under `apps/desktop/` unless they start with `services/` or `docs/`.

## 0. Corrections to both designs

I checked these against the repo:

- **Both designs' step 0 is already done.** Commit `1c1e8ce` ships:
  - `sigma`, tagged camera and lens, matched on Make after `"sigma_mobile": null`;
  - `tamron`, `tokina`, `laowa` and `voigtlander`, tagged lens, one wordmark each, and not in `match`;
  - the SVGs and TRADEMARKS rows;
  - null needles in `brandIdForMake`;
  - the test "lens makers are not matched on Make".

  This round adds no logo files.
- **Your library.** I read a scratch copy of `~/Desktop/main.afcatalog`. It has 37 make/lens pairs and one third-party lens: SONY with `24-70mm F2.8 DG DN II | Art 024` (1 photo). LensModel alone recognises it, so storing LensMake changes nothing in your library today.
- **Old photos can already re-read EXIF.** 从磁盘刷新 runs `refresh-assets` → `resolve_image(refresh=True)` → `extract_image_candidate` → `upsert_image_asset`. Neither design used this.
- **Settings would list a lens choice as a camera brand.** `BrandLogosGroup.brandRows` turns every `profile.brandLogos` key into a camera row, so a `tamron` choice would show under 相机 logo. Neither design handles this.
- **Wrong e2e stems.** Fixture stems `003-yellow`, `005-teal` and `008-pink` get their EXIF re-read at launch, which wipes the values `prepareCatalog` seeds. Both designs seed 003, and template-first also seeds 005 and 008. Use 002, 004, 006, 007, 009 or 010.
- **Field order in the Python models.** `RawMetadata` and `ImageCandidate` are slots dataclasses, and no field has a default. `lens_make: str | None = None` must therefore be the last field, so the test constructors keep working (`test_geo_resolver.py:78`, `test_locations.py:36/117`).
- **`logoRef.source` is taken.** `source: "personal"` (`isPersonalLogoRef`) says where the pixels come from, so minimal's `source: "lens"` overloads it.
- **New profile keys need validation.** `cleanProfile` (`ipc/frameTemplates.js:52`) keeps only `author`, `brandLogos` and `cameraNames`. A new key such as template-first's `lensBrands` would also need validation there and in settings transfer.

## 1. Decisions

| # | Decision | Rejected, and why |
|---|---|---|
| D1 | **Base: the minimal design.** A lens maker is an ordinary registry brand. A logo element marked as a lens slot resolves against the lens brand instead of the camera brand. Everything after that is unchanged: `pickVariant`, `withBrandLogos`, tinting, the `brand:variant:color` cache key, user templates and apply_frame. | Template-first's row engine (logo inline before `{lens}`, text reflow, `rowWith`/`rowPin` links, delete hooks). It refactors `buildFrameLayers`, which every frame uses, and adds linked layers to an editor whose layers are independent. |
| D2 | **Marker: `role: "lens"`** on template elements and on `logoRef`. Missing means the camera. (From template-first.) | `source: "lens"` collides with `source: "personal"`. |
| D3 | **Two ordered needle tables** in `logos.json`: `lensMatch.model` (LensModel, checked first), then `lensMatch.make` (LensMake). They work like the camera `match` table (first needle wins; `null` means another maker is named, so stop), plus `/regex/` needles. | Minimal's single table over `lens_make + " " + lens_model`: which field wins is hidden in the needle order, and `^…$` anchors cannot work. Template-first's three tiers with "earliest index, then longest word": new matching rules and more code to test. |
| D4 | **Same-brand rule.** A lens of the camera's own brand gets no lens logo (Sigma fp with a Sigma lens). | |
| D5 | **LensMake is read at import from now on** and carried through. No backfill and no read-on-use. Old photos get it through 从磁盘刷新. | Both alternatives only help one case, Voigtländer `E 40mm F1.2` with LensMake `COSINA` on older Sony bodies, and your library has none: a catch-up job (about 120 lines, job UI, auto-start flag), or `asset-detail --lens-make` (a flag through the CLI, IPC and two callers). If old catalogs matter later, read-on-use is the cheaper fallback. |
| D6 | **The 22 built-in presets stay exactly as they are.** Add two presets with a lens slot, `family: "dual"`, so the existing solo rule centres the camera mark when no lens logo resolves. No engine change beyond D1. | Editing 5 existing presets would change frames people already use. Minimal's `template.solo` flag is not needed with `family: "dual"`. Adding no presets means thumbnails and apply_frame never show a lens logo. |
| D7 | **`{lens_model}` stays as EXIF writes it.** No `{lens}` token. "TAMRON 35-150mm…" next to a Tamron wordmark is accepted. | `{lens}` labels (mount letter dropped, brand prefixed, a bare form beside a logo) are a naming system with its own errors, and you asked for simple rules (next-features-plan §E; frame-watermark-plan line 270). |
| D8 | **Your logo for a lens maker** is stored in `watermarkProfile.brandLogos[<brand id>]`, which already passes `BRAND_KEY`. Sigma has one key for both camera and lens. Brand level only. An upload from the lens row is saved as `{kind:"camera", brand:"tamron"}`. | Per-lens-model logos or `lens:` keys need `BRAND_KEY` changes for something nobody asked for. |
| D9 | **No per-lens maker override in v1** (open question 2). | Template-first's `lensBrands` plus maker chips: a new profile key, IPC, validation, transfer and UI, for generic names you don't have. |
| D10 | **The Settings lens group** reads a new `lenses` field added to `camera-makes` output. | A new `lens-models` command and IPC channel. |

## 2. EXIF data

### Sidecar (`services/sidecar/src/media_workspace/`)

- `metadata.py::_extract_tiff_metadata`:
  - add `lens_make = _coerce_ascii(exif_ifd.get(0xA433))` beside 0xA434 (line 453) and put it in the full return dict;
  - add `"lens_make": None` to the matcher dict (431);
  - Tamron's blank or space-only values already become None.
- `_merge_metadata` (510): add the key. `extract_raw_metadata` (598) and `extract_image_candidate` (642): pass `lens_make=`.
- `models.py`: add `lens_make: str | None = None` as the **last** field of `RawMetadata` and `ImageCandidate`.
- `db/assets.py`: add `"lens_make"` to the dicts in `upsert_raw_asset` (25) and `upsert_image_asset` (236). No migration, no facet column, and `raw_metadata_cache` is untouched.

### Renderer

`state/useFrameTool.js::exifFromItem`: take both lens fields from the same side.

```js
const lensMeta = rawMeta.lens_model ? rawMeta : imageMeta;
lens_model: lensMeta.lens_model || "",
lens_make: lensMeta.lens_make
  || (imageMeta.lens_model === lensMeta.lens_model ? imageMeta.lens_make : "") || "",
```

- The fallback covers an old RAW whose JPEG was refreshed.
- `renderBridge.js` imports this function, so apply_frame gets `lens_make` too.
- Web build: `src/api/browser/bridge.js::readExifMetadata` adds `lens_make: exif.LensMake || null`.

### Derived files (so a framed copy re-imports with the value)

- `electron/imageMetadata.js`, in its Python snippet: `"lens_make": meta.lens_make`.
- `electron/exif.js::buildExifPayload`, in IFD2: `...(metadata.lens_make ? { LensMake: String(metadata.lens_make) } : {})`.
- Add a round-trip case to `exif.test.js`. It also confirms libvips accepts the tag name.

These touch the main process and the sidecar, so **dev must be restarted**.

## 3. Matching

### `logos.json`: new top-level `lensMatch`, beside `match`

```json
"lensMatch": {
  "model": {
    "zeiss": null, "samyang": null, "rokinon": null, "viltrox": null, "ttartisan": null,
    "7artisans": null, "sirui": null, "meike": null, "meke": null, "yongnuo": null,
    "sigma": "sigma", "| art": "sigma", "| contemporary": "sigma", "| sports": "sigma",
    "/\\b(dg|dc) (dn|hsm|os)\\b/": "sigma",
    "tamron": "tamron", "/\\bdi iii?\\b/": "tamron", "/\\s[abf]0\\d{2}[a-z]?$/": "tamron",
    "/^e 28-75mm f2\\.8-2\\.8$/": "tamron",
    "tokina": "tokina", "firin": "tokina", "atx-m": "tokina", "at-x": "tokina",
    "laowa": "laowa", "dreamer": "laowa",
    "voigtlander": "voigtlander", "nokton": "voigtlander", "septon": "voigtlander", "ultron": "voigtlander",
    "heliar": "voigtlander", "skopar": "voigtlander", "lanthar": "voigtlander"
  },
  "make": {
    "sigma": "sigma", "tamron": "tamron", "tokina": "tokina", "laowa": "laowa",
    "venus optics": "laowa", "cosina": "voigtlander", "voigtlander": "voigtlander"
  }
}
```

How it reads:
- Both haystacks are `normalizeMake` plus an NFD accent fold, so `Voigtländer` becomes `voigtlander`.
- Lens model first. No needle found means "try LensMake". A `null` needle stops the search.
- No camera maker is a needle in either table. So LensMake `Canon`, `SONY`, `FUJIFILM` or `Hasselblad`, and Samyang's wrong `Canon`, map to nothing.
- Vetoes come first, so they beat a LensMake that names one of the five. Example: a Cosina-built ZEISS Loxia with LensMake `COSINA`.
- Update `_note` and the frame-logos README "Adding a brand" section.

### Code (`render/frameLogos.js`)

```js
export function buildLogoRegistry(manifest) { … return { byId, match: manifest.match || {}, lensMatch: manifest.lensMatch || {} }; }

const needleRes = new Map();
/** First needle of `table` found in `haystack`: a brand id, null (names no brand), or undefined (none). */
function firstNeedle(haystack, table) {
  for (const [needle, id] of Object.entries(table || {})) {
    const isRe = needle.length > 2 && needle.startsWith("/") && needle.endsWith("/");
    if (isRe && !needleRes.has(needle)) needleRes.set(needle, new RegExp(needle.slice(1, -1)));
    if (isRe ? needleRes.get(needle).test(haystack) : haystack.includes(needle)) return id || null;
  }
  return undefined;
}
// brandIdForMake: return make ? firstNeedle(normalizeMake(make), registry.match) ?? null : null;

const foldLens = (s) => normalizeMake(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** The lens slot's brand: recognised, built in, and not the camera's own brand. */
export function lensBrandIdForExif(exif, registry) {
  const lm = registry?.lensMatch || {};
  const model = foldLens(exif?.lens_model), make = foldLens(exif?.lens_make);
  let id = model ? firstNeedle(model, lm.model) : undefined;
  if (id === undefined && make) id = firstNeedle(make, lm.make);
  if (!id || !registry.byId.has(id)) return null;
  return id === brandIdForExif(exif, registry) ? null : id;
}

export const brandIdForLogo = (el, exif, registry) =>
  (el?.role === "lens" ? lensBrandIdForExif(exif, registry) : brandIdForExif(exif, registry));
```

- `withBrandLogos` spreads the registry, so `lensMatch` survives. The user's `make:` needles only go into `match`.
- `loadLogoRegistry`'s fallback base has no `lensMatch`; the `?.` handles it.

### Per maker: what each string should give (all become unit tests)

**Sigma**
- → sigma:
  - `SONY / ILCE-7RM6 / – / 24-70mm F2.8 DG DN II | Art 024` (your photo)
  - `14-24mm F2.8 DG DN | Art 019`
  - `56mm F1.4 DC DN | Contemporary 018`
  - `FUJIFILM / X-T5 / SIGMA / 18-50mm F2.8 DC DN | Contemporary 021`
- → null:
  - `SIGMA / fp L / – / 45mm F2.8 DG DN | Contemporary 019` (same brand)
  - `LEICA DG SUMMILUX 25/F1.4 II` (Panasonic "DG")

**Tamron**
- → tamron:
  - `E 70-180mm F2.8 A056`
  - `E 28-75mm F2.8-2.8` (exact match)
  - LensMake `TAMRON` with any model
- → null: `E 18-200mm F3.5-6.3` (generic, accepted gap)
- The census gives no full Nikon Z or Fujifilm strings. Copy exact ones from the sources before asserting the `tamron` word, `Di III` or a code suffix like `B061X`.

**Voigtländer**
- → voigtlander:
  - `Voigtlander NOKTON 40mm F1.2 Aspherical`
  - `Voigtlander SEPTON 40mm F2 Aspherical`
  - `Voigtländer …` (folded)
  - `COSINA + E 40mm F1.2`
- → null:
  - `– + E 40mm F1.2`
  - `COSINA + ZEISS Loxia 2/35` (veto)

**Tokina**
- → tokina:
  - `Tokina + atx-m 23mm F1.4 X`
  - `Tokina + Tokina AT-X 11-20mm f/2.8 PRO DX`
  - `Tokina FiRIN 20mm F2 FE AF`
  - `Kenko Tokina + …`

**Laowa**
- → laowa:
  - `LAOWA FFII 10mm F2.8 C&D Dreamer`
  - `FF 180mm F4.5 CA-Dreamer Macro 1.5X`
  - `Venus Optics + …`

**Other makers → null**
- `SAMYANG / SAMYANG AF 50mm F1.4`
- `Canon / SAMYANG AF 14mm F2.8`
- `ZEISS Batis 2/25`
- `VILTROX / AF 9/2.8 XF`
- `7ARTISANS / E 27mm F2.8`
- `TTARTISAN / AF 27/2.8`
- `SIRUI / SIRUI 56mm F1.2 E`
- `MEKE / MEKE 85mm F1.8 STM`
- `E 32mm F1.8`

**First-party lenses → all null** (every lens in your catalog):
- Canon: `RF24-70mm F2.8 L IS USM`, `EF70-200mm f/2.8L IS II USM`, `EF70-200mm f/2.8L IS II USM +2x III`, `EF24-105mm f/4L IS II USM`, `EF24-105mm f/4L IS USM`, `RF100-500mm F4.5-7.1 L IS USM`, `EF17-40mm f/4L USM`, `TS-E17mm f/4L`, `EF50mm f/1.2L USM`, `RF85mm F1.4 L VCM`, `RF28-70mm F2 L USM`
- Hasselblad: `XCD 35-75@35`, `XCD 55V`, `XCD 35-100E@35`
- DJI: `24.0 mm f/1.8`, `70.0 mm f/2.8`
- Sony: `FE 20-70mm F4 G`, `FE 14mm F1.8 GM`, `FE 24-70mm F2.8 GM`
- Fujifilm: `XF35mmF1.4 R`, `XF35mmF2 R WR`
- Leica: `Summilux-M 1:1.4/35`, `VARIO-ELMARIT-SL 1:2.8-4/24-90 ASPH.`
- Panasonic: `DC VARIO-SUMMILUX 1:1.7-2.8/10.9-34 ASPH.`
- Nikon: `NIKKOR Z 24-70mm f/2.8 S`
- Apple: `iPhone 18 Pro Max back triple camera 6.93mm f/1.48`

## 4. Data model

| Where | Change |
|---|---|
| `logos.json` | `lensMatch` (§3). No brand or variant changes. |
| Registry | `{ byId, match, lensMatch }` |
| Template element / `logoRef` | optional `role: "lens"`. Lens refs have no `scope` and no model. Personal refs are unchanged. |
| `frameUserTemplates.js` | `logoRefOf` adds `...(el?.role === "lens" ? { role: "lens" } : {})`. `logoElementOf` passes `role`. `templateFromLayers` already keeps the whole `logoRef`. |
| `watermarkProfile.brandLogos` | Same shape. Lens brands use their plain id. |
| Personal logos, settings transfer, `cleanTemplates`, `BRAND_KEY` | Unchanged. |

## 5. Engine and templates

**`render/frameRender.js`**
- `collectLogoNeeds`: drop the single brand at line 181. For each element:
  - `brandId = brandIdForLogo(el, exif, registry)`; skip the element if there is no brand;
  - `model: el.brandOnly || el.role === "lens" ? undefined : exif?.camera_model`;
  - the cache key format stays the same.
- `buildFrameLayers`: the same per-element lookup inside `resolvedLogoElements`. The solo rule is unchanged. Lens variants declare no `covers`.

**`state/useFrameTool.js`**
- `generatePresetLayers` (451) and `userTemplateLayers` (485) name a layer with `brandLabel(lg, ref.role === "lens" ? "lens" : undefined)`.

**New presets** in `editor/frameTemplates.js`, appended after `dual-bar`. Sizes are tuned in frame-lab.

```js
{ id: "bar-lens", name: "双标 · 镜头信息条", family: "dual",
  canvas: { pad: { bottom: 0.138 }, bg: { type: "solid", color: "#ffffff" } },
  elements: [
    /* {camera_model} and {lens_model} lines exactly as bar-full */
    { type: "logo", variant: "symbol", anchor: { region: "bottom", h: "right", v: "top", inset: 0.05 },
      soloAnchor: { v: "center" }, style: { size: 0.05 } },
    { type: "logo", role: "lens", variant: "wordmark", anchor: { region: "bottom", h: "right", v: "bottom", inset: 0.05 },
      soloAnchor: { v: "center" }, style: { size: 0.05 } },
  ] },
{ id: "dual-lens", name: "双标 · 机身镜头", family: "dual",
  canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.16 }, bg: { type: "solid", color: "#ffffff" } },
  elements: [
    { type: "logo", variant: "wordmark", anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: -0.025 },
      soloAnchor: { dy: 0 }, style: { size: 0.075 } },
    { type: "logo", role: "lens", variant: "wordmark", anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.035 },
      soloAnchor: { dy: 0 }, style: { size: 0.05 } },
  ] },
```

- With no lens logo, or with no camera logo, the one mark that resolves takes `soloAnchor`.
- `src/frame-lab.js` gets lens samples:
  - Sony + A056
  - Sony + Art 024
  - Sony + NOKTON
  - Fujifilm + `Tokina`/`atx-m`
  - Nikon Z + Laowa
  - Sigma fp + Sigma, which must look the same as today
- Check at 3:2, 4:5 and panorama.

## 6. UI

### Frame tool › 加到边框里 › 相机 logo

**`useFrameTool.js`**
- Hoist `toMarks` out of the `cameraLogo` memo.
- Add `lensLogo` (memo on `[logos, exifKey]`):
  ```js
  const id = lensBrandIdForExif(exif, logos.registry); const builtIn = id && logos.base.byId.get(id);
  return builtIn ? { brandKey: id, brandName: builtIn.name, lensModel: exif.lens_model,
    choice: logos.registry.byId.get(id)?.mine?.personal || null, marks: toMarks(builtInBrandMarks(builtIn)) } : null;
  ```
- Add `setLensLogo(id)`: `setBrandLogo(lensLogo.brandKey, id)`, then `loadLogos()`.
- `brandLabel(lg, "lens")` returns the lens brand's `mine?.name || name`.
- Export `lensLogo` and `setLensLogo`.

**`components/CameraLogosBlock.jsx`**
- New prop `lensLogo`. Render when `cameraLogo || lensLogo`, and guard the brand and model rows on `cameraLogo`.
- A third row, `data-camera-level="lens"` with `data-camera-logo-choice={choice||""}`:
  - caption tag 镜头 plus the brand name, with the lens model in its `title`;
  - cells `data-place-camera-logo="lens"`: the built-in marks, or my logo.
- Lens-scope chooser: `LogoPicker` with `defaultMarks={lensLogo.marks}`, `rankOf` on `lensLogo.brandKey`, and `importOptions {kind:"camera", brand: lensLogo.brandKey}`.
- The root gets `data-lens-logo`.
- The row appears only for a recognised lens; there is no "+" cell (D9).

**`TextPanel.jsx:300`**: mount when `(cameraLogo || lensLogo)` and pass `lensLogo`.

**`EditorOverlay.jsx`**
- `placeCameraLogo({level, variant})`:
  - for `level === "lens"`, guard on `tool.lensLogo`;
  - use `ref = { role: "lens", variant: variant || "wordmark", kind: null, strict: false, color: "#141414" }`;
  - label with `cameraLogoLabel("lens")`;
  - `placeLogo` slides from the bar's right end, so the lens mark lands left of the camera's.
- `chooseCameraLogo(logo, scope)`:
  ```js
  if (scope === "lens") await tool.setLensLogo(logoId); else await tool.setCameraLogo(logoId, scope);
  const isBrandLogo = (l) => l.type === "sticker" && l.logoRef && !isPersonalLogoRef(l.logoRef);
  const isLens = (l) => isBrandLogo(l) && l.logoRef.role === "lens";
  const inScope = scope === "lens" ? isLens : (l) => isBrandLogo(l) && !isLens(l);
  if (!layers.some(inScope)) { if (logoId) await placeCameraLogo({ level: scope }); return; }
  // re-resolve only inScope layers with swapLogo; lens layers labelled cameraLogoLabel("lens")
  ```
  Without this, choosing a lens logo while a camera logo is in the frame places nothing, and lens layers get camera labels.
- Wiring at 1616: pass `lensLogo={frameTool.lensLogo}`.

**i18n (editor):** `frame.levelLens` 镜头 / Lens; `frame.lensLogoFor` `{{name}} 的镜头 logo` / `Logo for {{name}} lenses`. The 相机 logo heading stays as it is.

### Settings › 水印

**Sidecar `db/browse.py::camera_makes`**
- Keep the first query.
- Add a second query with the same joins, grouped by `make, lens_make, lens_model`. Lens fields come from the RAW when the RAW has `lens_model`.
- Attach `lenses: [{lens_make, lens_model, count}]` to each make.
- The web `listCameraMakes` fills the same field from `image_metadata`.

**`BrandLogosGroup.jsx`**
- `brandRows`: skip a profile key whose built-in brand is tagged `lens` unless the library already has a camera row for it. This fixes the bug in §0.
- New `lensRows(makes, base, profile, cameraKeys)`:
  - run `lensBrandIdForExif({make, camera_model: models[0], lens_make, lens_model}, base)` for each lens and sum counts per brand;
  - drop ids already in `cameraKeys`, because a Sigma body's row already holds Sigma's single choice;
  - add lens-tagged keys from the profile that are not listed yet.
- A second `<Group title={t("watermark.lensTitle")}>`, shown only when it has rows. Reuse `line()` with no models and no rename.
- i18n: `watermark.lensTitle` 镜头 logo / Lens logos.

## 7. MCP

- No schema change. apply_frame already uses `exifFromItem`, `collectLogoNeeds` and `logoElementOf`, so `bar-lens`, `dual-lens` and user templates with a placed lens logo just work.
- `apply_frame` description (`server.js:1526`), add: "templates with a lens slot (bar-lens, dual-lens, or a user template with a lens logo) also show the lens maker's logo (Sigma, Tamron, Tokina, Laowa, Voigtländer) when the lens is recognised and is not the camera's own brand."
- `renderBridge.handleCapabilities`: add `lens_logo: true` for:
  - built-in templates with an element where `role === "lens"`;
  - user templates with a layer where `logoRef.role === "lens"`.
- Update `docs/agent-native-mcp.md`.

## 8. Tests

**Unit**
- `render/frameLogos.test.js`, in the bundled-logos block:
  - the §3 table, run through `lensBrandIdForExif` against the shipped manifest;
  - structure checks: every `lensMatch` target exists and is tagged `lens`; every lens-tagged brand has a needle; every `/…/` key compiles; keep "not matched on Make";
  - `withBrandLogos({tamron: id})` changes the lens slot only; `{sigma: id}` covers a Sigma fp camera slot and a Sigma lens on Sony.
- `render/frameRender.test.js`:
  - `bar-lens` on Sony + Art 024 needs `sony` symbol and `sigma` wordmark; on Sony + FE GM only `sony`, at the solo position;
  - `dual-lens` solo when the lens is unrecognised;
  - **regression guard:** every existing preset gives the same needs and layers on Sony + A056 as on Sony + FE GM.
- `editor/frameUserTemplates.test.js`: `role` survives `logoRefOf`, `logoElementOf` and `templateFromLayers`; `layersFromTemplate` drops a lens layer when `logoFor` returns null.

**Python**
- `tests/test_metadata.py`:
  - `_build_tiff` with 0xA433 `TAMRON` gives `"TAMRON"`;
  - a space-only value gives None;
  - the matcher profile gives None;
  - both candidates carry the field.
- `tests/test_camera_makes.py`: `lenses` come from the RAW side when the RAW has the lens.

**Electron:** `exif.test.js` checks that `LensMake` is written.

**e2e: new `57-lens-logos.spec.js`**, with its own catalog copy. Seeds use `prepareCatalog` + `sqlite3 json_set`, as spec 56 does:

| Stem | Make / Model | lens_make | lens_model | Expect |
|---|---|---|---|---|
| 006-blue | SONY / ILCE-7RM6 | null | `24-70mm F2.8 DG DN II \| Art 024` | Sigma |
| 007-purple | SONY / ILCE-7M4 | null | `E 70-180mm F2.8 A056` | Tamron |
| 010-black | SONY / ILCE-7CM2 | `COSINA` | `E 40mm F1.2` | Voigtländer, through `lens_make` |
| 009-gray | SONY / ILCE-6400 | null | `E 32mm F1.8` | none |
| 002-orange | SIGMA / fp L | `SIGMA` | `45mm F2.8 DG DN \| Contemporary 019` | none (same brand) |

1. **Which photos get a lens row.**
   - Lens row on 006 (Sigma) and 010 (Voigtländer).
   - None on 009, 002 or Canon `0Y1A6707-9`.
   - `bar-id` on 007 leaves one brand-logo layer (presets unchanged).
2. **Placing.** On 006, place α, then a lens cell. The new layer has `role: "lens"`, aspect ≈ 4.24 and label "Sigma", and sits left of α without overlapping it.
3. **Choosing.**
   - On 007, with only α in the frame, an uploaded logo picked in the lens chooser places a lens layer.
   - `brandLogos.tamron` is set and α is untouched.
   - 默认 restores the Tamron wordmark (aspect ≈ 6.5) and removes the key.
   - In Settings, Tamron is under 镜头 logo, not 相机 logo.
4. **Presets.** `bar-lens` on 007 gives a camera layer and a lens layer. On 009 it gives one centred layer.
5. **User template.** Saved on 006, then applied to 007: the lens layer is Tamron's. Applied to 009: camera logo only.
6. **MCP.**
   - `apply_frame bar-lens` on 010 puts a dark pixel at the lens spot. On 009 that spot is white.
   - In capabilities, `bar-lens.lens_logo` is true.
7. **Settings.** The lens group lists Sigma, Tamron and Voigtländer, but not the generic lens, and not Sigma for 002.

Specs 20, 54, 55 and 56 should pass unchanged, because the fixture lenses are first-party. Also check the lens row by hand in dev (StrictMode).

## 9. Build order

One commit per step, files added by path, commit messages written with `-F`. All on `feat/brand-logos`.

| # | Step | Files | Gate |
|---|---|---|---|
| 1 | Matching | logos.json, frameLogos.js, frame-logos README | §3 unit table, including your first-party list |
| 2 | Per-element `role`; `logoRefOf`/`logoElementOf`; layer labels | frameRender.js, frameUserTemplates.js, useFrameTool.js | renderer and template unit tests; nothing visible changes |
| 3 | `lens_make` extraction and plumbing | metadata.py, models.py, db/assets.py, useFrameTool.js, bridge.js, imageMetadata.js, exif.js | pytest, exif.test. **Restart dev (sidecar and main).** |
| 4 | Frame tool lens row; place/choose fixes; i18n | useFrameTool.js, CameraLogosBlock.jsx, TextPanel.jsx, EditorOverlay.jsx, locales | e2e 57 tests 1-3. Your dev window hot-reloads `src/`, so do this in one pass. |
| 5 | `bar-lens` and `dual-lens`; frame-lab samples | frameTemplates.js, frame-lab.js | §8 regression guard; frame-lab check |
| 6 | Settings: `lenses` field, web, `brandRows` fix, lens group | db/browse.py, bridge.js, BrandLogosGroup.jsx, settings locales | test_camera_makes; e2e 57 test 7. **Restart the sidecar.** |
| 7 | MCP description, `lens_logo`, MCP docs | mcp/server.js, renderBridge.js, docs/agent-native-mcp.md | e2e 57 test 6 |
| 8 | e2e 57; rerun 20, 54, 55, 56; dev StrictMode check | e2e/ | all green |
| 9 | Docs | next-features-plan §E entry, census "Lens makers" status, frame-logos README `lensMatch` and `/…/` syntax | |

## 10. Risks

- **False positives on first-party lenses**, mainly from the Tamron code regex and the `di iii` needle. Guards: the first-party table from your catalog, anchored regexes, and adding each new real string to the tests.
- **Mixing up camera and lens layers** in `chooseCameraLogo`, and a lens choice showing as a camera brand in Settings. Both are covered by e2e 57 test 3.
- **Trademarks.** Tamron's terms forbid using its logo, and the Voigtländer SVG has no licence. The stance is the same as for camera logos: descriptive use, listed in `TRADEMARKS.md`, in a folder that can be removed. The SVGs are already committed.
- **Old photos** have no `lens_make` until 从磁盘刷新. Only recognitions that rely on LensMake alone are affected.
- **Restarts:** steps 3 and 6 need dev restarted. Step 4 goes live in your window through HMR.

## 11. Open questions for you

1. **Existing presets.** Keep the 22 as they are and add `bar-lens` / `dual-lens` (default)? Or also put the lens logo into bar-id, bar-dark, bar-full, border-stack and gallery-split? The second option changes frames people already use and needs the text-row layout, a much larger engine change.
2. **Unrecognised or wrong lenses.** No override in v1 (default)? Or a per-lens "which maker" choice in the lens row (默认 / Sigma / Tamron / Tokina / Laowa / Voigtländer / 不显示), saved in your profile? It matters for generic Sony-style names such as `E 18-200mm F3.5-6.3`, and for a rare wrong match.