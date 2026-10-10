#!/usr/bin/env bash
#
# One-shot macOS release: build + sign + notarize the app, then publish a
# GitHub Release with the four Mac DMGs attached (mac-builds.cjs): Apple silicon
# and Intel, each for macOS 14+ and for macOS 12+. Wraps steps ② and ③ of the flow:
#
#   ① version bump + tag   — done manually via a PR (keep it reviewed)
#   ② build/sign/notarize  — `npm run dist:mac:release` (arm64, macOS 14+) and
#                            `scripts/dist-mac-build.sh <name> --release` for
#                            the other three                ← this script runs them
#   ③ publish + upload     — `gh release create … *.dmg`  ← this script runs it
#
# Prerequisites
#   - Developer ID Application cert + key in the login keychain
#     (electron-builder auto-discovers it; hardenedRuntime + entitlements are
#      already configured in package.json → build.mac).
#   - Notarization creds in the environment:
#       APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#     (app-specific password from https://appleid.apple.com → App-Specific
#      Passwords — never commit it or paste it on a command line).
#   - uv, and Rosetta: the Intel sidecars are built with an x86_64 Python
#     (`softwareupdate --install-rosetta` if `arch -x86_64 true` fails).
#   - `gh` authenticated (`gh auth status`).
#   - The `v<version>` tag already pushed (this script publishes that tag; it
#     will NOT invent a tag on an unmerged commit).
#
# Usage:
#   cd apps/desktop
#   APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=… bash scripts/release.sh
#   # dry run (build + verify, skip publishing):
#   PUBLISH=0 bash scripts/release.sh

set -euo pipefail

cd "$(dirname "$0")/.."   # → apps/desktop
PUBLISH="${PUBLISH:-1}"

VERSION="$(node -p "require('./package.json').version")"
# The other builds go to release/<name>/ (electron-builder.mac.cjs), where
# electron-builder leaves an arm64 app in mac-arm64/ and an x64 one in mac/.
DMGS=(
  "release/AfterFrame-${VERSION}-arm64.dmg"
  "release/intel/AfterFrame-${VERSION}-Intel.dmg"
  "release/macos12-arm64/AfterFrame-${VERSION}-macOS12-arm64.dmg"
  "release/macos12-intel/AfterFrame-${VERSION}-macOS12-Intel.dmg"
)
APPS=(
  release/mac-arm64/AfterFrame.app
  release/intel/mac/AfterFrame.app
  release/macos12-arm64/mac-arm64/AfterFrame.app
  release/macos12-intel/mac/AfterFrame.app
)
# People recognition has no download fallback since the model was bundled.
APPS_WITH_PEOPLE=(release/mac-arm64/AfterFrame.app release/intel/mac/AfterFrame.app)
TAG="v${VERSION}"
NOTES="../../docs/releases/${TAG}.md"   # optional; auto-generated if absent

echo "▶ AfterFrame release ${TAG} (Apple silicon + Intel, macOS 14 + macOS 12)"

# ---- 1. credentials + tooling, fail fast -----------------------------------
: "${APPLE_ID:?set APPLE_ID (Apple ID email for notarization)}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?set APPLE_APP_SPECIFIC_PASSWORD (app-specific password)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (developer team id)}"

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No 'Developer ID Application' signing cert in the keychain." >&2
  exit 1
fi

if [[ "$PUBLISH" == "1" ]]; then
  gh auth status >/dev/null 2>&1 || { echo "✗ gh not authenticated — run 'gh auth login'." >&2; exit 1; }
  if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "✗ Tag ${TAG} not found. Bump the version + tag (via PR) before releasing." >&2
    exit 1
  fi
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "✗ Release ${TAG} already exists. Delete it first or bump the version." >&2
    exit 1
  fi
fi

# ---- 2. verify creds with Apple before the long build ----------------------
echo "▶ Verifying notarization credentials…"
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" >/dev/null \
  || { echo "✗ notarytool could not authenticate — check APPLE_ID / password / team id." >&2; exit 1; }

# ---- 3. build + sign + notarize + DMG --------------------------------------
echo "▶ Building (native → sidecar → vite → electron-builder, signed + notarized)…"
export CSC_IDENTITY_AUTO_DISCOVERY=true
rm -f "${DMGS[@]}"
npm run dist:mac:release
for build in intel macos12-arm64 macos12-intel; do
  bash scripts/dist-mac-build.sh "$build" --release
done

for dmg in "${DMGS[@]}"; do
  [[ -f "$dmg" ]] || { echo "✗ Expected DMG not found: $dmg" >&2; exit 1; }
done

# ---- 4. verify the notarized apps ------------------------------------------
for APP in "${APPS[@]}"; do
  [[ -d "$APP" ]] || { echo "✗ Expected app not found: $APP" >&2; exit 1; }
  echo "▶ Verifying signature + notarization: $APP"
  codesign --verify --deep --strict "$APP"
  spctl --assess --type execute --verbose=2 "$APP"   # expect: accepted / Notarized Developer ID
  xcrun stapler validate "$APP"
  # Photo metadata is read with ExifTool, run by the system's Perl.
  /usr/bin/perl "$APP/Contents/Resources/native/exiftool/exiftool" -ver >/dev/null \
    || { echo "✗ ExifTool is missing from $APP (npm run fetch:exiftool)." >&2; exit 1; }
done
for APP in "${APPS_WITH_PEOPLE[@]}"; do
  [[ -f "$APP/Contents/Resources/native/FaceEmbedding.mlpackage/Manifest.json" ]] \
    || { echo "✗ The face model is missing from $APP (npm run fetch:people-model)." >&2; exit 1; }
done

for dmg in "${DMGS[@]}"; do
  echo "✓ DMG ready: $dmg"
  echo "  sha256: $(shasum -a 256 "$dmg" | awk '{print $1}')"
done

# ---- 5. publish -------------------------------------------------------------
if [[ "$PUBLISH" != "1" ]]; then
  echo "ℹ PUBLISH=0 — skipping GitHub release. Upload manually with:"
  echo "  gh release create $TAG --title \"AfterFrame $VERSION\" ${DMGS[*]}"
  exit 0
fi

echo "▶ Publishing GitHub Release ${TAG}…"
NOTES_ARGS=()
if [[ -f "$NOTES" ]]; then NOTES_ARGS=(--notes-file "$NOTES"); else NOTES_ARGS=(--generate-notes); fi
gh release create "$TAG" --title "AfterFrame ${VERSION}" "${NOTES_ARGS[@]}" "${DMGS[@]}"

echo "✅ Released: $(gh release view "$TAG" --json url -q .url)"
