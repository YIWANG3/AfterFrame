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

## Notes

- The app is not code-signed. Users need to bypass Gatekeeper on first launch.
- Only Apple Silicon builds are tested. Intel may work but is not verified.
- The sidecar binary is bundled inside the `.app` via electron-builder `extraResources`.
