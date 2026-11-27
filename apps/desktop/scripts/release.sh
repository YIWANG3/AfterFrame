#!/usr/bin/env bash
#
# One-shot macOS release: build + sign + notarize the app, then publish a
# GitHub Release with the three Mac DMGs attached (mac-builds.cjs): Apple silicon
# for macOS 14+ and for macOS 12+, and Intel for macOS 12+. There is no Intel
# build for macOS 14+: macOS 26 is the last macOS for Intel Macs, so an Intel
# Mac takes the macOS 12 build (no People, Scene Depth or Stickers).
# Each build also brings what installed apps update themselves from
# (electron/updater.js): a zip of the app, its blockmap, and its channel's
# <channel>-mac.yml.
# `scripts/dist-mac-build.sh intel` still builds one by hand.
# Wraps steps ② and ③ of the flow:
#
#   ① version bump + tag   — done manually via a PR (keep it reviewed)
#   ② build/sign/notarize  — `npm run dist:mac:release` (arm64, macOS 14+) and
#                            `scripts/dist-mac-build.sh <name> --release` for
#                            the other two                  ← this script runs them
#   ③ publish + upload     — `gh release create … *.dmg *.zip *.yml`  ← this script runs it
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
  "release/macos12-arm64/AfterFrame-${VERSION}-macOS12-arm64.dmg"
  "release/macos12-intel/AfterFrame-${VERSION}-macOS12-Intel.dmg"
)
# In-app updates: each build's zip and the channel file that names it. The
# channel is the build's (electron-builder.mac.cjs); the Apple-silicon macOS 14
# app's is "latest".
ZIPS=(
  "release/AfterFrame-${VERSION}-arm64-mac.zip"
  "release/macos12-arm64/AfterFrame-${VERSION}-macOS12-arm64-mac.zip"
  "release/macos12-intel/AfterFrame-${VERSION}-macOS12-Intel-mac.zip"
)
CHANNELS=(latest macos12-arm64 macos12-intel)
UPDATE_INFO=(
  "release/latest-mac.yml"
  "release/macos12-arm64/macos12-arm64-mac.yml"
  "release/macos12-intel/macos12-intel-mac.yml"
)
BLOCKMAPS=()
for zip in "${ZIPS[@]}"; do BLOCKMAPS+=("${zip}.blockmap"); done
APPS=(
  release/mac-arm64/AfterFrame.app
  release/macos12-arm64/mac-arm64/AfterFrame.app
  release/macos12-intel/mac/AfterFrame.app
)
# The builds that ship the Core ML models (scripts/bundled-models.mjs): people
# recognition and scene depth have no download fallback, the app only has
# what is bundled. The macOS 12 builds leave them out (mac-builds.cjs).
APPS_WITH_MODELS=(release/mac-arm64/AfterFrame.app)
TAG="v${VERSION}"
NOTES="../../docs/releases/${TAG}.md"   # optional; auto-generated if absent

echo "▶ AfterFrame release ${TAG} (Apple silicon for macOS 14 and 12, Intel for macOS 12)"

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
rm -f "${DMGS[@]}" "${ZIPS[@]}" "${BLOCKMAPS[@]}" "${UPDATE_INFO[@]}"
npm run dist:mac:release
for build in macos12-arm64 macos12-intel; do
  bash scripts/dist-mac-build.sh "$build" --release
done

for file in "${DMGS[@]}" "${ZIPS[@]}" "${BLOCKMAPS[@]}" "${UPDATE_INFO[@]}"; do
  [[ -f "$file" ]] || { echo "✗ Expected file not found: $file" >&2; exit 1; }
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
for APP in "${APPS_WITH_MODELS[@]}"; do
  # Every model, checked against the directory hash it was fetched with.
  node scripts/fetch-models.mjs --verify "$APP/Contents/Resources/native" \
    || { echo "✗ A Core ML model is missing from $APP or altered (npm run fetch:models)." >&2; exit 1; }
done

# ---- 4b. verify what the apps update themselves from -----------------------
# Each channel file names this version and its own zip; the zip holds a
# signed app that reads that channel. A wrong channel would hand one build's
# users another build's app.
for i in "${!ZIPS[@]}"; do
  zip="${ZIPS[$i]}"; info="${UPDATE_INFO[$i]}"; channel="${CHANNELS[$i]}"
  echo "▶ Verifying update files: $info → $zip"
  grep -qx "version: ${VERSION}" "$info" || { echo "✗ $info is not for ${VERSION}." >&2; exit 1; }
  grep -qxF "  - url: $(basename "$zip")" "$info" || { echo "✗ $info does not name $(basename "$zip")." >&2; exit 1; }
  unpacked="$(mktemp -d)"
  ditto -x -k "$zip" "$unpacked"
  codesign --verify --deep --strict "$unpacked/AfterFrame.app"
  baked="$(sed -n 's/^channel: //p' "$unpacked/AfterFrame.app/Contents/Resources/app-update.yml")"
  [[ "${baked:-latest}" == "$channel" ]] || { echo "✗ The app in $zip reads channel '${baked:-latest}', not '$channel'." >&2; exit 1; }
  rm -rf "$unpacked"
done

for dmg in "${DMGS[@]}"; do
  echo "✓ DMG ready: $dmg"
  echo "  sha256: $(shasum -a 256 "$dmg" | awk '{print $1}')"
done

# ---- 5. publish -------------------------------------------------------------
if [[ "$PUBLISH" != "1" ]]; then
  echo "ℹ PUBLISH=0 — skipping GitHub release. Upload manually with:"
  echo "  gh release create $TAG --title \"AfterFrame $VERSION\" ${DMGS[*]} ${ZIPS[*]} ${BLOCKMAPS[*]} ${UPDATE_INFO[*]}"
  exit 0
fi

echo "▶ Publishing GitHub Release ${TAG}…"
NOTES_ARGS=()
if [[ -f "$NOTES" ]]; then NOTES_ARGS=(--notes-file "$NOTES"); else NOTES_ARGS=(--generate-notes); fi
# A draft until every file is up: installed apps read the latest published
# release, and one that found its channel file before the zip it names had
# finished uploading would fail its download.
gh release create "$TAG" --draft --title "AfterFrame ${VERSION}" "${NOTES_ARGS[@]}" \
  "${DMGS[@]}" "${ZIPS[@]}" "${BLOCKMAPS[@]}" "${UPDATE_INFO[@]}"
gh release edit "$TAG" --draft=false --latest

echo "✅ Released: $(gh release view "$TAG" --json url -q .url)"
