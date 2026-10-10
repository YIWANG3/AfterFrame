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
# --intel builds it for the Intel build instead (electron-builder.intel.cjs:
# x64, macOS 12+) into services/sidecar/dist-x64: an x86_64 CPython, run
# through Rosetta on an Apple silicon Mac, and wheels for macOS 12, so numpy is
# its OpenBLAS build there.
#
# Needs uv: curl -LsSf https://astral.sh/uv/install.sh | sh
#
# Usage (from apps/desktop): npm run build:sidecar:mac
#                            bash scripts/build-sidecar-mac.sh --intel

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/desktop
SIDECAR="$(cd ../../services/sidecar && pwd)"

PYTHON="3.12"
PLATFORM="aarch64-apple-darwin"
ARCH="arm64"
CONFIG="./package.json"
SUFFIX=""
if [[ "${1:-}" == "--intel" ]]; then
  PYTHON="cpython-3.12-macos-x86_64"
  PLATFORM="x86_64-apple-darwin"
  ARCH="x86_64"
  CONFIG="./electron-builder.intel.cjs"
  SUFFIX="-x64"
  arch -x86_64 /usr/bin/true 2>/dev/null \
    || { echo "✗ The Intel sidecar needs Rosetta: softwareupdate --install-rosetta" >&2; exit 1; }
fi
MINIMUM="$(node -p "const c = require('$CONFIG'); (c.build || c).mac.minimumSystemVersion")"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-$MINIMUM}"
VENV="$SIDECAR/build/macos-venv$SUFFIX"
DIST="$SIDECAR/dist$SUFFIX"

UV="$(command -v uv || true)"
[[ -n "$UV" ]] || UV="$HOME/.local/bin/uv"
[[ -x "$UV" ]] || { echo "✗ uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2; exit 1; }

echo "▶ Sidecar build environment: CPython 3.12 ($ARCH), wheels for macOS ${MACOSX_DEPLOYMENT_TARGET}"
rm -rf "$VENV"
"$UV" venv --quiet --python "$PYTHON" "$VENV"
OVERRIDES=()
if [[ "$ARCH" == "x86_64" ]]; then
  # rawpy stopped publishing Intel Mac wheels after 0.25.1.
  echo "rawpy==0.25.1" > "$VENV/overrides.txt"
  OVERRIDES=(--override "$VENV/overrides.txt")
fi
"$UV" pip install --quiet --python "$VENV/bin/python" --python-platform "$PLATFORM" \
  ${OVERRIDES[@]+"${OVERRIDES[@]}"} -e "$SIDECAR[jimeng]" "pyinstaller>=6,<7"

echo "▶ PyInstaller…"
(cd "$SIDECAR" && "$VENV/bin/pyinstaller" media-workspace.spec --distpath "$DIST" --workpath "build/pyinstaller$SUFFIX" \
  --noconfirm --log-level WARN)

node scripts/check-macos-minimum.mjs --minimum "$MINIMUM" --arch "$ARCH" "$DIST/media-workspace"
