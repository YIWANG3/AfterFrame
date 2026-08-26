// Pure collage-rendering primitives, shared by the interactive CollageCanvas
// and the agent render bridge (MCP render_collage). Extracted so both paths
// draw with EXACTLY the same code — the UI's export and an agent's export of
// the same inputs are pixel-identical.

export function getDrawSize(img, cellW, cellH, zoom) {
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const cellAspect = cellW / cellH;
  let drawW, drawH;
  if (imgAspect > cellAspect) {
    drawH = cellH * zoom;
    drawW = drawH * imgAspect;
  } else {
    drawW = cellW * zoom;
    drawH = drawW / imgAspect;
  }
  return { drawW, drawH };
}

export function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function drawCellImage(ctx, img, cellRect, pan, zoom, borderRadius) {
  const { x, y, w, h } = cellRect;
  ctx.save();
  if (borderRadius > 0) {
    roundRectPath(ctx, x, y, w, h, borderRadius);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  const { drawW, drawH } = getDrawSize(img, w, h, zoom);
  const drawX = x + (w - drawW) / 2 + pan.x;
  const drawY = y + (h - drawH) / 2 + pan.y;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();
}

function uniqueSortedBreakpoints(values, tol = 0.001) {
  const arr = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of arr) {
    if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  return out;
}

function findBreakIndex(breakpoints, v, tol = 0.001) {
  for (let i = 0; i < breakpoints.length; i++) {
    if (Math.abs(breakpoints[i] - v) < tol) return i;
  }
  return -1;
}

function computeTracks(breakpoints, innerSize, gap) {
  // CSS-Grid style: reserve (N-1)*gap total, distribute remaining space
  // proportionally to each track's ratio. Tracks with equal ratio end up
  // at equal pixel size regardless of position — no shrinkage on inner cells.
  const N = breakpoints.length - 1;
  const totalGap = Math.max(0, (N - 1) * gap);
  const effective = Math.max(0, innerSize - totalGap);
  const tracks = [];
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const ratio = breakpoints[i + 1] - breakpoints[i];
    const size = Math.max(0, ratio * effective);
    tracks.push({ start: cursor, size });
    cursor += size + gap;
  }
  return tracks;
}

export function computeCellRects(cells, canvasW, canvasH, gap, padding = 0) {
  const innerW = Math.max(0, canvasW - padding * 2);
  const innerH = Math.max(0, canvasH - padding * 2);
  const xVals = [0, 1];
  const yVals = [0, 1];
  for (const c of cells) {
    xVals.push(c.x, c.x + c.w);
    yVals.push(c.y, c.y + c.h);
  }
  const xBreaks = uniqueSortedBreakpoints(xVals);
  const yBreaks = uniqueSortedBreakpoints(yVals);
  const xTracks = computeTracks(xBreaks, innerW, gap);
  const yTracks = computeTracks(yBreaks, innerH, gap);
  return cells.map((cell) => {
    const sx = findBreakIndex(xBreaks, cell.x);
    const ex = findBreakIndex(xBreaks, cell.x + cell.w);
    const sy = findBreakIndex(yBreaks, cell.y);
    const ey = findBreakIndex(yBreaks, cell.y + cell.h);
    const xStart = xTracks[sx].start;
    const yStart = yTracks[sy].start;
    const xEnd = xTracks[ex - 1].start + xTracks[ex - 1].size;
    const yEnd = yTracks[ey - 1].start + yTracks[ey - 1].size;
    return {
      x: padding + xStart,
      y: padding + yStart,
      w: xEnd - xStart,
      h: yEnd - yStart,
    };
  });
}

/**
 * Render one collage page to an offscreen canvas. `images` are already-loaded
 * HTMLImageElements (order matches template cells); `states` optionally carries
 * per-cell {pan:{x,y} in OUTPUT pixels, zoom}.
 */
export function renderCollagePage({
  images,
  template,
  canvasRatio = 1,
  gap = 4,
  padding = 0,
  borderRadius = 0,
  bgColor = "#000000",
  states = [],
  width = 3000,
}) {
  if (!template?.cells) throw new Error("template with cells is required");
  const targetH = Math.round(width / (canvasRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = bgColor || "#000000";
  ctx.fillRect(0, 0, width, targetH);
  const cellRects = computeCellRects(template.cells, width, targetH, gap, padding);
  for (let i = 0; i < cellRects.length; i++) {
    const img = images[i];
    if (!img) continue;
    const state = states[i] || {};
    drawCellImage(
      ctx, img, cellRects[i],
      state.pan || { x: 0, y: 0 },
      state.zoom || 1,
      borderRadius,
    );
  }
  return canvas;
}
