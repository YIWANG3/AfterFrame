// Geometry shared by BOTH processes. The renderer previews the seamless split
// (SplitOverlay, the canvas export path) and the main process cuts the real
// pixels (ipc/saveFile.js processAndSavePanels); if the two ever disagree on
// where a panel edge falls, the export shows a seam or an overlap that no
// unit test on either side alone would catch. So there is exactly one copy.
//
// Plain ESM with no imports: Vite bundles it into the renderer, and the main
// process loads it with require() (Node ≥ 22.12 / Electron ≥ 28 resolve ESM
// synchronously, including from inside the packaged asar). Keep it
// dependency-free so that stays true.

// Cumulative rounding, so adjacent panels share an edge pixel-exactly (no
// gap, no overlap); widths differ by at most 1px.
export function panelBoundaries(width, count) {
  const bounds = [];
  for (let i = 0; i <= count; i++) bounds.push(Math.round((i * width) / count));
  return bounds;
}
