// Feature flags the desktop bridge declares to the renderer (api.can, the
// same mechanism the web build uses; shared/capabilities.mjs lists them).
// Undeclared means available, so the macOS 14 builds declare nothing.
//
// Off macOS: scene depth (Core ML), subject extraction (Vision) and people
// recognition (Vision + Core ML) have no engine yet (docs/windows-support-plan.md
// 5.5), so their entry points stay visible but locked with a "macOS for now"
// hint instead of failing on click. Video is not locked: it imports, and H.264
// plays in Chromium; only posters and the HEVC proxy need the macOS helper.
//
// On a Mac the same three need macOS 14 (Core ML models, Vision's subject
// request), so the macOS 12 builds (mac-builds.cjs) leave their helpers out:
// a feature whose helper isn't in native/bin is locked.
//
// A feature that has moved into a feature module says the same in its
// manifest (`platforms`, `helper`; features/<id>/manifest.mjs), and
// electron/features.js turns that into flags: the LUT tool is macOS-only for
// now, see its manifest. The table below is for the features that have not
// moved yet; the two must not overlap (capabilities.test.js).
const { capabilitiesFromFeatures } = require("./features");

const MAC_HELPERS = { depth: "compute-depth", stickerExtract: "extract-sticker", people: "people-worker" };

function handWrittenCapabilities(platform, hasHelper) {
  if (platform === "darwin") {
    return Object.fromEntries(Object.entries(MAC_HELPERS).filter(([, helper]) => !hasHelper(helper)).map(([flag]) => [flag, false]));
  }
  return { depth: false, stickerExtract: false, people: false };
}

function desktopCapabilities(platform, { hasHelper = () => true } = {}) {
  return { ...capabilitiesFromFeatures(platform, { hasHelper }), ...handWrittenCapabilities(platform, hasHelper) };
}

module.exports = { desktopCapabilities, MAC_HELPERS };
