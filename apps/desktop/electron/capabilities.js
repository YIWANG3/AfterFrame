// Feature flags the desktop bridge declares to the renderer (api.can, the
// same mechanism the web build uses). Undeclared means available, so macOS
// declares nothing and behaves exactly as before.
//
// Off macOS: scene depth (Core ML), subject extraction (Vision) and people
// recognition (Vision + Core ML) have no engine yet (docs/windows-support-plan.md
// 5.5), so their entry points stay visible but locked with a "macOS for now"
// hint instead of failing on click. Video is not locked: posters, durations,
// the filmstrip and the HEVC playback proxy come from FFmpeg there.
// The LUT tool is macOS-only for now (docs/lut-plan.md): a RAW is graded on
// Apple's RAW rendering, and Windows has no engine of that quality yet.
function desktopCapabilities(platform) {
  if (platform === "darwin") return {};
  return { depth: false, stickerExtract: false, people: false, lut: false };
}

module.exports = { desktopCapabilities };
