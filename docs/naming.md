# Naming: why this product has four names

A 30-second orientation for new contributors (and future us) before grepping
for the wrong identifier.

| Name | Where | What it is |
| --- | --- | --- |
| **AfterFrame** | product, README, `package.json` productName, `.afcatalog`, window title | The public product name |
| **`afterframe`** | npm package name, userData subdir (`~/Library/Application Support/afterframe/afterframe/`), MCP server name | Lowercase technical id of the desktop app |
| **`media_workspace`** | the Python sidecar package (`services/sidecar/src/media_workspace`), its CLI (`python3 -m media_workspace`), env vars (`MEDIA_WORKSPACE_CATALOG`, `MEDIA_WORKSPACE_API_KEY`) | The backend predates the AfterFrame branding and was never renamed — renaming would churn every import, env var, and packaged-binary path for zero user value |
| **`workspace:*`** | Electron IPC channel prefix, `window.mediaWorkspace` preload global | Same vintage as the sidecar name; the renderer-side `src/api` facade hides it from components |
| `media-resource-management` | the repo directory | Original working title of the project |

Practical grep guidance:

- Product/UI strings → search `AfterFrame`
- Electron/renderer plumbing → `workspace:` (channels) or `api.` (components)
- Backend/CLI/catalog → `media_workspace`
- Catalog dirs on disk → `.afcatalog` (the `.mwcatalog` → `.afcatalog` rename
  is shimmed in `electron/main.js` and `media_workspace/catalog.py`)

Decision (2026-06): we deliberately do **not** unify these. The split is
stable, each layer is internally consistent, and the migration cost lands on
packaged-app users' settings/catalog paths.
