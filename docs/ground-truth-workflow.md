# Ground Truth Workflow

Use a small CSV file to define the expected match outcome for a test export set.

## File Location

You can start from:

- `RESOURCES/GROUND_TRUTH_TEMPLATE.csv`
- `data/ground-truth/review-2026-v0.csv`

Or export a reviewed seed file from a catalog:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace export-ground-truth \
  --catalog /path/to/review.afcatalog \
  --status matched \
  --output-csv data/ground-truth/review-seed.csv
```

## Columns

- `export_path`
- `raw_path`
- `notes`

## Rules

- If an export should match a RAW, fill both paths.
- If an export should remain unmatched, leave `raw_path` empty.
- Use absolute paths to avoid path-resolution ambiguity.
- Keep this dataset small and curated.

## Coverage Recommendations

Try to include:

- direct same-name matches
- `-Edit` and `-2` variants
- same-stem but wrong-camera negatives
- same-camera but wrong-stem negatives
- exports with missing EXIF
- exports that should remain unmatched

## Why This Matters

The matcher should be evaluated against known truth, not just eyeballed from a few examples.
