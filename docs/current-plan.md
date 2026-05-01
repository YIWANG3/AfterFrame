# Current Plan

## What We Have Verified

### Matcher and review workflow

- Current matcher can be treated as `v0`.
- A real review catalog has been built against:
  - export: `/Users/yiwang/Desktop/Export`
  - raw: `/Volumes/personal_folder/RAW/2025` and `/Volumes/personal_folder/RAW/2026`
- The major false-positive bug around `IMG_#### -> img` stem collapse was fixed.
- A `ground truth` workflow now exists, including CSV export and evaluation tooling.
- Initial seed truth file exists at `data/ground-truth/review-2026-v0.csv`.
- Manual review confirmed that the current matched samples looked correct after the stem-key fix.

### Catalog and cleanup

- The active review catalog is `data/review-2026.afcatalog`.
- Export asset counting was fixed so the UI and CLI now report active export files instead of stale orphan rows.
- Duplicate historical export assets were cleaned up.
- Export paths now reuse the existing asset identity instead of creating a fresh asset row on refresh.

### UI

- The Electron shell is usable for library review.
- Export grid now supports infinite scroll instead of a manual `Load More` button.
- Grid cards now show only the export filename, using a two-line clamp with truncation.

### Performance

Current measurements with the optimized fast path:

- `scan-raw` on `/Volumes/personal_folder/RAW/2025/250119 SD`
  - `1032` RAW
  - `workers=8`
  - `fingerprint-mode=head-only`
  - `metadata-profile=matcher`
  - `38.15s`
  - about `27.1 RAW/s`

- `resolve-export-batch --refresh` on `/Users/yiwang/Desktop/Export`
  - current large catalog with `66094` RAW already indexed
  - `4343` exports processed
  - `49.82s`
  - about `87.2 exports/s`

- During the large `/Volumes/personal_folder/RAW/2025` cold-ish scan, observed end-to-end throughput was roughly in the `11+ RAW/s` range.

## Current Product State

The project is now in a good validation state:

- reviewable large catalog exists
- matcher behavior is conservative and acceptable for `v0`
- raw scan performance is substantially better than the initial baseline
- raw scan and batch reverse lookup are both in a workable range now
- the next optimization question is whether to keep pushing Python resolve throughput, or shift effort to enrichment / previews / UX

## Recommended Next Steps

### 1. Freeze matcher v0

Do not widen matching aggressiveness yet.

Keep these principles:

- filename recall
- `camera_model` and `capture_time` as important constraints
- do not use `width` or `height` as a veto
- stay conservative on auto-bind

### 2. Expand ground truth gradually

Build a stronger regression set without blocking product work.

- keep the small sample dataset for fast regression
- keep the current review seed CSV as the first real baseline
- add more reviewed positives and negatives from the large catalog over time
- use the truth CSV before and after matcher changes

### 3. Split import into fast path and enrichment path

The current fast-path knobs work, but the pipeline is still mostly single-stage from the product point of view.

Goal:

- fast import for review readiness
- background enrichment for slower metadata
- optional later preview and stronger fingerprint enrichment

Concretely:

- keep `head-only` and `matcher` profile for review-oriented indexing
- move heavier metadata extraction into a later pass
- keep preview generation independent from core catalog readiness

### 4. Keep improving the review UI

Stay focused on inspection speed, not workflow complexity.

Near-term UI work:

- density switching
- faster filtering
- better matched/unmatched browsing
- maybe lightweight badges or chips if review confidence needs to be surfaced again

Avoid for now:

- review workflow state machine
- complex editing tools
- content authoring features

## Suggested Execution Order

1. Freeze matcher `v0` and stop changing match logic unless a concrete error appears.
2. Keep the new reverse-lookup benchmark as a standing regression check.
3. Formalize fast import vs enrichment as explicit pipeline stages.
4. Continue UI usability improvements for review.
5. Only revisit Rust after the remaining bottleneck is clearly isolated by benchmark data.

## Rust Priority

Rust should still be driven by measured hotspots, not by intuition.

Based on what we have verified so far:

- do **not** prioritize Rust for matcher logic first
- if Rust becomes necessary, it is more likely to help in:
  - metadata extraction
  - preview extraction/generation
  - possibly candidate scoring if resolve remains the hottest path after Python-side pruning
