#!/usr/bin/env bash
#
# Build one of the Mac builds other than package.json's own (mac-builds.cjs)
# into release/<name>/, on an Apple silicon Mac:
#
#   bash scripts/dist-mac-build.sh intel|macos12-arm64|macos12-intel [--release]
#
# --release signs and notarizes it, as dist:mac:release does for the arm64
# build (scripts/release.sh builds all four). The Intel builds need Rosetta.

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/desktop
BUILD="${1:?usage: dist-mac-build.sh <name from mac-builds.cjs> [--release]}"
NOTARIZE=0
[[ "${2:-}" == "--release" ]] && NOTARIZE=1
ARCH="$(node -p "require('./mac-builds.cjs').macBuild('$BUILD').arch")"
MACOS14_FEATURES="$(node -p "require('./mac-builds.cjs').macBuild('$BUILD').macos14Features")"

bash scripts/build-native.sh --build "$BUILD"
[[ "$MACOS14_FEATURES" == "true" ]] && npm run fetch:people-model
npm run fetch:exiftool
bash scripts/build-sidecar-mac.sh --build "$BUILD"
[[ "$ARCH" == "x64" ]] && node scripts/install-sharp-x64.mjs
npm run build
AFTERFRAME_MAC_BUILD="$BUILD" AFTERFRAME_NOTARIZE="$NOTARIZE" npx electron-builder --mac "--$ARCH" --config electron-builder.mac.cjs
