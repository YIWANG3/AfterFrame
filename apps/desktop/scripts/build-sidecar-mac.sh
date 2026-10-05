#!/usr/bin/env bash
#
# Build the macOS sidecar (PyInstaller) so it runs on every macOS the app
# does: 12 and later, as Electron's Info.plist says.
#
# Whatever Python is on PATH won't do. Homebrew's is built for the Mac it was
# installed on, and so is anything pip compiles against it: 0.5.8 shipped a
# sidecar that needed macOS 15, and on macOS 12–14 nothing could be imported.
# So the build uses
#   - uv's standalone CPython 3.12, which runs on macOS 11 and later;
#   - wheels picked for macOS 12 (numpy's Accelerate build needs 14, its
#     OpenBLAS build doesn't), anything compiled targeting 12 too;
#   - scripts/check-macos-minimum.mjs, which fails the build on anything newer.
#
# Needs uv: curl -LsSf https://astral.sh/uv/install.sh | sh
#
# Usage (from apps/desktop): npm run build:sidecar:mac

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/desktop
SIDECAR="$(cd ../../services/sidecar && pwd)"
VENV="$SIDECAR/build/macos-venv"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

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
