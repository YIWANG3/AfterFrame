#!/usr/bin/env bash
#
# One-shot macOS release: build + sign + notarize the app, then publish a
# GitHub Release with the DMG attached. Wraps steps ② and ③ of the flow:
#
#   ① version bump + tag   — done manually via a PR (keep it reviewed)
#   ② build/sign/notarize  — `npm run dist:mac:release`   ← this script runs it
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
DMG="release/AfterFrame-${VERSION}-arm64.dmg"
TAG="v${VERSION}"
NOTES="../../docs/releases/${TAG}.md"   # optional; auto-generated if absent

echo "▶ AfterFrame release ${TAG} (arm64)"

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
npm run dist:mac:release

[[ -f "$DMG" ]] || { echo "✗ Expected DMG not found: $DMG" >&2; exit 1; }

# ---- 4. verify the notarized app -------------------------------------------
APP="$(find release -maxdepth 2 -name 'AfterFrame.app' -print -quit)"
if [[ -n "$APP" ]]; then
  echo "▶ Verifying signature + notarization…"
  codesign --verify --deep --strict "$APP"
  spctl --assess --type execute --verbose=2 "$APP"   # expect: accepted / Notarized Developer ID
  xcrun stapler validate "$APP"
fi

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo "✓ DMG ready: $DMG"
echo "  sha256: $SHA"

# ---- 5. publish -------------------------------------------------------------
if [[ "$PUBLISH" != "1" ]]; then
  echo "ℹ PUBLISH=0 — skipping GitHub release. Upload manually with:"
  echo "  gh release create $TAG --title \"AfterFrame $VERSION\" \"$DMG\""
  exit 0
fi

echo "▶ Publishing GitHub Release ${TAG}…"
NOTES_ARGS=()
if [[ -f "$NOTES" ]]; then NOTES_ARGS=(--notes-file "$NOTES"); else NOTES_ARGS=(--generate-notes); fi
gh release create "$TAG" --title "AfterFrame ${VERSION}" "${NOTES_ARGS[@]}" "$DMG"

echo "✅ Released: $(gh release view "$TAG" --json url -q .url)"
