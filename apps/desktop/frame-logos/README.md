# frame-logos

Bundled camera/brand logos for the frame & watermark feature. See `TRADEMARKS.md`
for the legal notice (these are trademarks of their owners; deletable any time).

A brand is a **set of variants**, not one file: `symbol` (icon), `wordmark`,
`lockup` (icon+word, horizontal/vertical). Color is mostly a render-time tint
(mono SVG → black / white / brand-color), so one file per variant serves all
colors — except color-locked marks (e.g. a brand-red dot), flagged below.

## Layout — one subdir per brand

```
frame-logos/
  logos.json            registry (all brands + variants + EXIF match table)
  TRADEMARKS.md         legal notice
  hasselblad/  symbol.svg  wordmark.svg  lockup-h.svg
  fujifilm/    …
  canon/  nikon/  sony/  dji/  leica/
```

## How to add a brand

1. Drop the variant files into the brand's subdir `<brand>/<variant>.svg`:
   - `hasselblad/symbol.svg`, `hasselblad/wordmark.svg`, `hasselblad/lockup-h.svg` …
   - **Monochrome SVG, transparent background, single black fill** ideal (gets
     tinted). Normalize the viewBox, small optical padding. PNG `@3x` transparent
     is an acceptable fallback.
2. Fill that brand's `variants` array in `logos.json` (`file` is relative to this
   dir, i.e. `<brand>/<variant>.svg`).
3. (Optional) Map the EXIF `make` to the brand id in the `match` table.

## logos.json schema

```jsonc
{
  "logos": [
    { "id": "hasselblad", "name": "Hasselblad", "accent": "#ff6a00", "tags": ["camera"],
      "variants": [
        { "id": "symbol", "kind": "symbol",   "file": "hasselblad/symbol.svg",   "aspect": 1.0 },
        { "id": "word",   "kind": "wordmark", "file": "hasselblad/wordmark.svg",  "aspect": 5.4 },
        { "id": "lockup", "kind": "lockup", "orientation": "h",
          "file": "hasselblad/lockup-h.svg", "aspect": 3.0 }
      ] }
  ],
  // EXIF `make` (lowercased, substring match) -> brand id, for auto-selection
  "match": { "hasselblad": "hasselblad", "leica": "leica", "sony": "sony" }
}
```

Variant fields: `id`, `kind` (`symbol`|`wordmark`|`lockup`), `orientation`
(`h`|`v`, lockups), `file` (relative to this dir), `aspect` (w/h, for layout),
`colorLocked` (optional `true` → don't tint, keep original colors).

The brand is auto-detected from EXIF and bound to the logo slot. In the UI the
user can switch **variants within that same brand** only — never swap to another
brand (the watermark must reflect the actual camera).

User-imported logos live in a separate user-data dir with the same shape; the
registry is the union of (bundled here) ∪ (user-imported).
