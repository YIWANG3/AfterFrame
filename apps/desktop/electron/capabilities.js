// Feature flags the desktop bridge declares to the renderer (api.can, the
// same mechanism the web build uses). Undeclared means available, so the
// macOS 14 builds declare nothing.
//
// Off macOS: scene depth (Core ML), subject extraction (Vision) and people
// recognition (Vision + Core ML) have no engine yet (docs/windows-support-plan.md
// 5.5), so their entry points stay visible but locked with a "macOS for now"
// hint instead of failing on click. Video is not locked: it imports, and H.264
// plays in Chromium; only posters and the HEVC proxy need the macOS helper.
// The LUT tool is macOS-only for now (docs/lut-plan.md): a RAW is graded on
// Apple's RAW rendering, and Windows has no engine of that quality yet.
//
// On a Mac the same three need macOS 14 (Core ML models, Vision's subject
// request), so the macOS 12 builds (mac-builds.cjs) leave their helpers out:
// a feature whose helper isn't in native/bin is locked.
const MAC_HELPERS = { depth: "compute-depth", stickerExtract: "extract-sticker", people: "people-worker" };

function desktopCapabilities(platform, { hasHelper = () => true } = {}) {
  if (platform === "darwin") {
    return Object.fromEntries(Object.entries(MAC_HELPERS).filter(([, helper]) => !hasHelper(helper)).map(([flag]) => [flag, false]));
  }
  return { depth: false, stickerExtract: false, people: false, lut: false };
}

module.exports = { desktopCapabilities };
