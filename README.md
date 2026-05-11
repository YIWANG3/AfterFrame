# AfterFrame

**English** | [简体中文](README.zh-CN.md)

A local-first photo workspace for browsing, editing, and managing large photography libraries.

AfterFrame is built for photographers who work with thousands of exported images and want a fast, visual tool to browse, organize, crop, add text overlays, and experiment with AI-powered style transfer — all without leaving one app.

## Download

Download the latest `.dmg` from [Releases](../../releases).

> macOS only (Apple Silicon). Not code-signed — on first launch, run `sudo xattr -rd com.apple.quarantine /Applications/AfterFrame.app` or open System Settings > Privacy & Security to allow it.

![AfterFrame — Browse & Inspect](docs/assets/browse-grid.png)

## Features

### Browse & Organize
- Grid, tiles, justified, and waterfall layout modes
- Sort by imported time, captured time, rating, or name
- Smart collections and manual folders
- Full metadata inspector: EXIF, camera, lens, exposure, dates
- Star rating system (imports Lightroom XMP ratings)
- Virtual-scroll gallery that handles 10,000+ images smoothly

![Lightbox](docs/assets/lightbox.png)

### Edit
- **Crop** with preset aspect ratios, rotation, and flip

![Crop Editor](docs/assets/editor-crop.png)

- **Text Overlay** with system fonts, solid/gradient fill, stroke, shadow, background, opacity, and snap-to-center guides

![Text Editor](docs/assets/editor-text.png)

- **Depth-aware Text** — on-device CoreML depth inference (Depth Anything V2) lets text sit behind subjects in the scene, iPhone-wallpaper style. Bring your own model via the model picker; preference is persisted

![Depth-aware Text](docs/assets/editor-text-depth.png)

- **Stickers** — extract subjects from any photo with one click (VisionKit on macOS 14+), save to a per-catalog library with optional outline and shadow, then drop them as image layers on any other photo. Stickers share the same depth, opacity, and rotation controls as text layers

![Sticker Library](docs/assets/sticker-library.png)

- **Collage** maker with 8 layout templates, adjustable gap/padding/border-radius, background color, and high-res export

![Collage](docs/assets/collage.png)

### AI Repaint (BYOK)
Bring your own API key. AfterFrame does not bundle or proxy any AI service — you connect your own provider and all requests go directly from your machine to the API.

- Supports Gemini, GPT Image, Jimeng, or any OpenAI-compatible endpoint
- 25 built-in style prompts (oil painting, anime, watercolor, ink, concept art, and more)
- Side-by-side and stacked before/after comparison
- Version history for every repaint

![AI Repaint — Before & After](docs/assets/ai-repaint-compare.png)

### Library Management
- Catalog-based workflow — one `.afcatalog` per project
- Import pipeline with automatic metadata extraction and preview generation
- Optional RAW source indexing and matching by filename
- Local-first: your files stay on your drives, nothing is uploaded

![Browse with Inspector](docs/assets/browse-inspector.png)

## Getting Started

### Requirements
- macOS (Apple Silicon)
- Python 3.10+ (for the sidecar service, development only)
- Node.js 18+ (development only)

### Development

```bash
# Install frontend dependencies
cd apps/desktop
npm install

# Start dev server
npm start
```

### Build

```bash
# Build sidecar binary
cd services/sidecar
pyinstaller media-workspace.spec --distpath dist --noconfirm

# Package desktop app
cd apps/desktop
npm run dist:mac
```

The `.dmg` will be in `apps/desktop/release/`.

## Project Structure

```
apps/desktop/          Electron + React desktop app
services/sidecar/      Python backend (SQLite catalog, metadata, AI repaint)
RESOURCES/             AI style prompt libraries, design assets
docs/                  Screenshots and developer docs
```

## Customization

### AI Style Prompts
Edit `~/Library/Application Support/afterframe/ai-styles.json` to add or modify style prompts. Changes take effect on restart.

```json
[
  { "id": "my-style", "name": "My Style", "prompt": "Transform this photo into..." }
]
```

## Built With

This project was vibe-coded with [Claude Code](https://claude.ai/code).

---

For implementation details, see [docs/developer-setup.md](docs/developer-setup.md).
