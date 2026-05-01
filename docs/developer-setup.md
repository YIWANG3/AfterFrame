# Developer Setup

This document keeps the implementation-oriented setup and workflow details out of the customer-facing root `README.md`.

## Repository layout

- `apps/desktop` — Electron desktop app for catalog browsing and review
- `apps/lightbox-lab` — focused UI sandbox for image viewing experiments
- `services/sidecar` — Python backend for catalog, scan, matching, registry, and background jobs
- `tests` — smoke tests and workflow checks
- `data` — sample catalogs and working datasets
- `docs/current-plan.md` — current verified product and engineering status
- `docs/ground-truth-workflow.md` — evaluation and review workflow notes
- `docs/image-asset-model.md` — asset model details

## Product architecture at a glance

The project treats the catalog as the primary product object.

Current implementation includes:

- `.afcatalog` bundles with internal state, logs, and derived artifacts
- reference-based handling for source RAW files and processed exports
- RAW scanning and metadata caching
- export matching and reverse lookup
- persistent match confirmation storage
- desktop review UI for browsing matched and unmatched assets

## Backend quick start

Initialize a catalog:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace init-catalog --catalog data/default.afcatalog
```

Scan a RAW directory:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace scan-raw \
  --catalog data/default.afcatalog \
  --raw-dir /path/to/raw-library
```

The review-oriented fast path currently uses:

- `--fingerprint-mode=head-only`
- `--metadata-profile=matcher`

Backfill fuller RAW metadata later:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace enrich-raw \
  --catalog data/default.afcatalog \
  --workers 8
```

Resolve a single export:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace resolve-export \
  --catalog data/default.afcatalog \
  --path /path/to/export.jpg
```

Resolve an export directory in batch:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace resolve-export-batch \
  --catalog data/default.afcatalog \
  --export-dir /path/to/exports
```

Run the polling export watcher:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace watch-export \
  --catalog data/default.afcatalog \
  --export-dir /path/to/exports
```

Generate cached previews or proxies inside the catalog:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace generate-previews \
  --catalog data/default.afcatalog \
  --kind preview \
  --asset-type export \
  --limit 200
```

List pending manual confirmations:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace list-pending \
  --catalog data/default.afcatalog
```

Confirm a match:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace confirm-match \
  --catalog data/default.afcatalog \
  --export-path /path/to/export.jpg \
  --raw-asset-id raw_1234567890abcdef
```

Export reviewed rows into a ground-truth CSV:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace export-ground-truth \
  --catalog data/default.afcatalog \
  --status matched \
  --output-csv data/ground-truth/review-seed.csv
```

Run the repeatable benchmark workflow:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace benchmark-dataset \
  --catalog data/benchmarks/resources-large.afcatalog \
  --raw-dir RESOURCES/RAW \
  --export-dir RESOURCES/Export \
  --report-json data/benchmarks/resources-large.json
```

## Desktop app

Run the desktop shell:

```bash
cd apps/desktop
npm install
MEDIA_WORKSPACE_CATALOG=../../data/default.afcatalog npm start
```

The app is focused on local review, browsing, and inspection rather than cloud sync or multi-user workflow.

## Current implementation assumptions

The backend is intentionally conservative:

- catalogs own cache artifacts, not the source RAW or export files
- RAW identity is fingerprint-based, not path-based
- confirmed matches persist in a registry
- export watching is polling-based in the current phase
- stable filename stems are a major matching signal
- file-level metadata improves matching, but is not the only product assumption

## Notes for contributors

When updating customer-facing messaging, keep `README.md` high-level and product-oriented.

Put deeper implementation, setup, benchmarking, and workflow notes in `docs/` instead.
