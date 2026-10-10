#!/usr/bin/env bash
# Compile the native Swift helpers into binaries shipped under native/bin/.
#
# Why precompile: end-user machines (and even this dev machine) can't reliably
# run `swift script.swift` — missing/old Command Line Tools, Swift-version
# syntax skew, or an SDK newer than the CLT compiler. Building binaries with
# Xcode's (consistent) toolchain at build time removes that whole class of
# failures and the Xcode-on-the-user's-Mac requirement.
set -euo pipefail

cd "$(dirname "$0")/.."   # apps/desktop
NATIVE_DIR="native"
ARCH="arm64"
OUT_DIR="$NATIVE_DIR/bin"
# --intel: for the Intel build (x64, macOS 12+: electron-builder.intel.cjs),
# into native/bin-x64 so the Apple silicon binaries stay where dev uses them.
if [ "${1:-}" = "--intel" ]; then
  ARCH="x86_64"
  OUT_DIR="$NATIVE_DIR/bin-x64"
fi
mkdir -p "$OUT_DIR"

# Prefer Xcode's toolchain — the CLT one on some machines has an SDK/compiler
# skew that breaks swiftc. Fall back to the default xcrun where Xcode is absent.
XCODE_DEV="/Applications/Xcode.app/Contents/Developer"
if [ -d "$XCODE_DEV" ]; then
  export DEVELOPER_DIR="$XCODE_DEV"
  echo "build-native: using Xcode toolchain ($XCODE_DEV)"
else
  echo "build-native: Xcode not found, falling back to default xcrun toolchain"
fi

# helpers to compile: name -> source -> oldest macOS it runs on. The target is
# required: without it swiftc builds for the build machine's macOS, and 0.5.5
# shipped video-tool and people-worker that refused to start below macOS 26.
# Each is the oldest the source compiles for; newer APIs inside are behind
# #available (video-tool's HEVC transcode needs 15, extract-sticker's Vision
# request 14).
build() {
  local name="$1" src="$2" min_macos="$3"
  echo "build-native: compiling $src -> $OUT_DIR/$name ($ARCH, macOS $min_macos+)"
  xcrun -sdk macosx swiftc -O -target "$ARCH-apple-macos$min_macos" "$NATIVE_DIR/$src" -o "$OUT_DIR/$name"
}

build video-tool video-tool.swift 12.0
# The Intel build has video only: people and depth run Core ML models that
# need macOS 14 and use Float16, which Swift lacks on Intel Macs; stickers need
# macOS 14's Vision request. electron/capabilities.js locks the three there.
if [ "$ARCH" = "arm64" ]; then
  build people-worker people-worker.swift 12.0
  build compute-depth compute-depth.swift 12.0
  build extract-sticker extract-sticker.swift 14.0
fi

echo "build-native: done"
