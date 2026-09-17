# Developer Setup

Implementation-oriented setup and workflow details for AfterFrame contributors.

## Repository layout

```
apps/desktop/          Electron + React desktop app (Vite, Tailwind)
services/sidecar/      Python backend — catalog, metadata, AI repaint, background jobs
tests/                 Smoke tests and workflow checks
data/                  Sample catalogs and working datasets
RESOURCES/             AI style prompt libraries, design mockups
docs/                  Screenshots and developer docs
```

## Architecture

AfterFrame is an Electron app with a Python sidecar process:

- **Frontend**: React (JSX, no TypeScript), Tailwind CSS, Vite bundler
- **Backend**: Python CLI invoked via `child_process` from Electron main process
- **Storage**: SQLite database inside `.afcatalog` bundles
- **IPC**: Electron main ↔ renderer via `ipcMain.handle` / `ipcRenderer.invoke`
- **Sidecar communication**: JSON over stdout, one CLI invocation per request

The catalog (`.afcatalog` directory) is the primary data object. It contains the SQLite database, preview caches, job logs, and derived artifacts. Source images are never copied — the catalog stores references to files on disk.

## Quick start

### Frontend

```bash
cd apps/desktop
npm install
npm start
```

By default, the app opens the last used catalog. To force a specific catalog:

```bash
MEDIA_WORKSPACE_CATALOG=../../data/default.afcatalog npm start
```

### Quality checks

Run the standard repository gate from the repository root:

```bash
npm run check      # lint + Python/Node/Renderer unit tests + production build
npm test           # all fast unit tests
npm run test:e2e   # full Electron Playwright suite (macOS)
npm run test:e2e:coverage   # same suite, with line coverage for renderer / main / sidecar
```

The root commands set the sidecar `PYTHONPATH` automatically. ESLint has no
suppression file any more (the last entry went in #54): every `no-unused-vars`
and `react-hooks/exhaustive-deps` finding is a hard error locally and in CI.

`test:e2e:coverage` builds an istanbul-instrumented renderer, arms
`NODE_V8_COVERAGE` for the main process and wraps the dev sidecar in Python
`coverage`, then prints one line per process and writes HTML under
`apps/desktop/.coverage/report/`. The nightly workflow runs this variant and
uploads the report; numbers and cold spots as of 2026-09-17 are in
[review/2026-09-17-E2E覆盖率.md](review/2026-09-17-E2E覆盖率.md).

`npm run lint` covers both sides: ESLint for the desktop app and ruff + mypy for
the sidecar (`npm run lint:python`). The Python tools come from the sidecar's
`dev` extra — install it once so the root scripts can find them:

```bash
python3 -m pip install -e "services/sidecar[dev]"
```

mypy runs with a per-module debt list in `services/sidecar/pyproject.toml`
(`[[tool.mypy.overrides]] … ignore_errors = true`). Modules on that list are
excluded until someone cleans them; everything else is checked, and the list
only ever shrinks.

### Sidecar (Python backend)

The desktop app calls the sidecar CLI automatically. For manual testing:

```bash
PYTHONPATH=services/sidecar/src python3 -m media_workspace --catalog data/default.afcatalog browse-exports --limit 10
```

Common commands:

```bash
# Initialize a new catalog
python3 -m media_workspace init-catalog --catalog data/new.afcatalog

# Scan RAW files
python3 -m media_workspace scan-raw --catalog data/default.afcatalog --raw-dir /path/to/raws

# Generate previews
python3 -m media_workspace generate-previews --catalog data/default.afcatalog --kind preview --asset-type export
```

### Building for distribution

```bash
# 1. Build sidecar binary
cd services/sidecar
pyinstaller media-workspace.spec --distpath dist --noconfirm

# 2. Package desktop app
cd apps/desktop
npm run dist:mac
```

Output: `apps/desktop/release/AfterFrame-<version>-arm64.dmg`

## Key subsystems

### Catalog & database (`db.py`)
- SQLite with `assets`, `asset_files`, `collections`, `jobs` tables
- `app_rating` populated from Lightroom XMP ratings on import
- Server-side sorting and pagination for virtual-scroll gallery

### Metadata extraction (`metadata.py`)
- EXIF parsing via Pillow
- XMP rating extraction from embedded XML
- Camera, lens, exposure, GPS metadata

### AI Repaint (`ai_repaint.py`)
- BYOK model — user provides their own API keys
- Supports Gemini, OpenAI, Jimeng, and OpenAI-compatible endpoints
- API keys stored encrypted via Electron safeStorage
- Style prompts stored in `~/Library/Application Support/afterframe/ai-styles.json`

### Background jobs (`job_runner.py`)
- Import pipeline: index images → extract metadata → match RAW sources
- Enrichment: backfill full metadata for scanned assets
- Preview generation: cached thumbnails inside the catalog

## App settings

Global settings (not per-catalog):
- `~/Library/Application Support/afterframe/settings.json` — theme, sidebar width, last catalog path, AI provider config
- `~/Library/Application Support/afterframe/ai-styles.json` — AI repaint style prompts

## Catalog schema changes

`services/sidecar/src/media_workspace/schema.py` is the only source of the
catalog schema version. When changing persistent structure:

1. Increment `SCHEMA_VERSION`.
2. Add the next ordered migration to `db/migrations.py`.
3. Add an old-catalog upgrade case to `tests/test_schema_migrations.py`.

All migrations run in one transaction. Do not update `catalog_info.schema_version`
from feature/domain modules or rely only on `CREATE TABLE IF NOT EXISTS` for an
existing table change.

## Notes

- The app is not code-signed. Users need to bypass Gatekeeper on first launch.
- Only Apple Silicon builds are tested. Intel may work but is not verified.
- The sidecar binary is bundled inside the `.app` via electron-builder `extraResources`.
