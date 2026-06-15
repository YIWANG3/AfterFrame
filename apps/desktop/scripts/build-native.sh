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
OUT_DIR="$NATIVE_DIR/bin"
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

# helpers to compile: name -> source. (depth/sticker still run via interpreter
# today; add them here when migrating those to precompiled binaries.)
build() {
  local name="$1" src="$2"
  echo "build-native: compiling $src -> $OUT_DIR/$name"
  xcrun -sdk macosx swiftc -O "$NATIVE_DIR/$src" -o "$OUT_DIR/$name"
}

build video-tool video-tool.swift

echo "build-native: done"
