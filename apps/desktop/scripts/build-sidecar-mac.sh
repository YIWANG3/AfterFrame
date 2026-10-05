#!/usr/bin/env bash
#
# Build the macOS sidecar (PyInstaller) for the macOS the app supports:
# build.mac.minimumSystemVersion in package.json (14.0: every Apple Silicon Mac
# can update to it, and numpy's fast Accelerate build needs it).
#
# Whatever Python is on PATH won't do. Homebrew's is built for the Mac it was
# installed on, and so is anything pip compiles against it: once that Mac is
# on a newer macOS, so is the sidecar, and on anything older nothing can be
# imported. So the build uses
#   - uv's standalone CPython 3.12 (runs on macOS 11+), the Python CI tests;
#   - wheels picked for the app's minimum, so numpy is its Accelerate build
#     (macOS 14+, about twice as fast as its OpenBLAS one here);
#   - scripts/check-macos-minimum.mjs, which fails the build on anything newer.
#
# Needs uv: curl -LsSf https://astral.sh/uv/install.sh | sh
#
# Usage (from apps/desktop): npm run build:sidecar:mac

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/desktop
SIDECAR="$(cd ../../services/sidecar && pwd)"
VENV="$SIDECAR/build/macos-venv"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-$(node -p "require('./package.json').build.mac.minimumSystemVersion")}"

UV="$(command -v uv || true)"
[[ -n "$UV" ]] || UV="$HOME/.local/bin/uv"
[[ -x "$UV" ]] || { echo "✗ uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }

echo "▶ Sidecar build environment: CPython 3.12, wheels for macOS ${MACOSX_DEPLOYMENT_TARGET}"
rm -rf "$VENV"
"$UV" venv --quiet --python 3.12 "$VENV"
"$UV" pip install --quiet --python "$VENV/bin/python" --python-platform aarch64-apple-darwin \
  -e "$SIDECAR[jimeng]" "pyinstaller>=6,<7"

echo "▶ PyInstaller…"
(cd "$SIDECAR" && "$VENV/bin/pyinstaller" media-workspace.spec --distpath dist --noconfirm --log-level WARN)

node scripts/check-macos-minimum.mjs "$SIDECAR/dist/media-workspace"
