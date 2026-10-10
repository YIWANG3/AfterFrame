// Feature flags the desktop bridge declares to the renderer (api.can, the
// same mechanism the web build uses). Undeclared means available, so the
// regular macOS build declares nothing.
//
// Off macOS: scene depth (Core ML), subject extraction (Vision) and people
// recognition (Vision + Core ML) have no engine yet (docs/windows-support-plan.md
// 5.5), so their entry points stay visible but locked with a "macOS for now"
// hint instead of failing on click. Video is not locked: it imports, and H.264
// plays in Chromium; only posters and the HEVC proxy need the macOS helper.
// The LUT tool is macOS-only for now (docs/lut-plan.md): a RAW is graded on
// Apple's RAW rendering, and Windows has no engine of that quality yet.
//
// On a Mac the same three need Apple silicon and macOS 14: Core ML models with
// Float16 weights, and Vision's subject request. The arm64 build requires 14,
// so it's the Intel build (x64, macOS 12+: electron-builder.intel.cjs) that
// locks them, on Apple silicon through Rosetta too.
const os = require("node:os");

// os.release() is the Darwin version: 23 = macOS 14.
const APPLE_SILICON_FEATURES_DARWIN = 23;

function desktopCapabilities(platform, { arch = process.arch, osRelease = os.release() } = {}) {
  if (platform === "darwin") {
    if (arch === "arm64" && Number.parseInt(osRelease, 10) >= APPLE_SILICON_FEATURES_DARWIN) return {};
    return { depth: false, stickerExtract: false, people: false };
  }
  return { depth: false, stickerExtract: false, people: false, lut: false };
}

module.exports = { desktopCapabilities };
