// Pure collage-rendering primitives, shared by the interactive CollageCanvas
// and the agent render bridge (MCP render_collage). Extracted so both paths
// draw with EXACTLY the same code — the UI's export and an agent's export of
// the same inputs are pixel-identical.

function getDrawSize(img, cellW, cellH, zoom) {
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

// Canvas strokes are centred on their path. Drawing a CSS-pixel stroke around
// fractional cell bounds can therefore put each edge on a different device-
// pixel phase, making an otherwise equal-width ring look uneven. Convert the
// bounds to device pixels first, then inset the path by half an integer-width
// stroke so all four outer edges land exactly on device-pixel boundaries.
export function getPixelAlignedStrokeRect(rect, scaleX, scaleY, cssLineWidth) {
  const sx = Math.max(Number.EPSILON, scaleX);
  const sy = Math.max(Number.EPSILON, scaleY);
  const lineWidth = Math.max(1, Math.round(cssLineWidth * Math.min(sx, sy)));
  const left = Math.round(rect.x * sx);
  const top = Math.round(rect.y * sy);
  const right = Math.round((rect.x + rect.w) * sx);
  const bottom = Math.round((rect.y + rect.h) * sy);
  const inset = lineWidth / 2;

  return {
    outer: {
      x: left,
      y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
    },
    stroke: {
      x: left + inset,
      y: top + inset,
      w: Math.max(0, right - left - lineWidth),
      h: Math.max(0, bottom - top - lineWidth),
    },
    lineWidth,
    radiusScale: Math.min(sx, sy),
  };
}

// Where a cell's image lands: cover-fit, centred, then panned. The one
// geometry both drawCellImage and the coverage check use.
export function getImageRect(img, cellRect, pan, zoom) {
  const { x, y, w, h } = cellRect;
  const { drawW, drawH } = getDrawSize(img, w, h, zoom);
  return { x: x + (w - drawW) / 2 + pan.x, y: y + (h - drawH) / 2 + pan.y, w: drawW, h: drawH };
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
  const draw = getImageRect(img, cellRect, pan, zoom);
  ctx.drawImage(img, draw.x, draw.y, draw.w, draw.h);
  ctx.restore();
}

// Which of a template cell's edges meet another cell; the rest are the
// page's own edges.
function interiorEdges(cell) {
  return {
    left: cell.x > 0.001,
    right: cell.x + cell.w < 0.999,
    top: cell.y > 0.001,
    bottom: cell.y + cell.h < 0.999,
  };
}

/**
 * With edge blend, a cell's image reaches past each shared edge to the
 * middle of the gap and half the blend band beyond it, so two neighbours
 * overlap across a band `edgeBlend` wide centred between them. The page's
 * outer edges stay where they are. `ramps` is how far each edge's weight
 * ramps from 0 to 1 into the rect (0 on an outer edge).
 */
export function blendedCellRect(cellRect, cell, gap, edgeBlend) {
  const e = interiorEdges(cell);
  const reach = gap / 2 + edgeBlend / 2;
  const left = e.left ? reach : 0;
  const top = e.top ? reach : 0;
  return {
    x: cellRect.x - left,
    y: cellRect.y - top,
    w: cellRect.w + left + (e.right ? reach : 0),
    h: cellRect.h + top + (e.bottom ? reach : 0),
    ramps: {
      left: e.left ? edgeBlend : 0,
      right: e.right ? edgeBlend : 0,
      top: e.top ? edgeBlend : 0,
      bottom: e.bottom ? edgeBlend : 0,
    },
  };
}

// Where a cell's image lands, blend or not.
export function cellImageRect(img, cellRect, cell, pan, zoom, gap, edgeBlend) {
  const rect = edgeBlend > 0 ? blendedCellRect(cellRect, cell, gap, edgeBlend) : cellRect;
  return getImageRect(img, rect, pan, zoom);
}

// One cell's image, cover-fit to its reach and weighted by a linear ramp
// along each shared edge, as a device-pixel canvas placed at (devX, devY).
// The weight is painted in device pixels over the whole layer, never a
// fractional rect: a mask drawn with partial coverage on its edge column
// leaves that column part-opaque (destination-in keeps what the source does
// not cover), and that showed as a bright line at each end of the band.
function weightedCell(img, reach, state, sx, sy, quality) {
  const devX = Math.floor(reach.x * sx);
  const devY = Math.floor(reach.y * sy);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil((reach.x + reach.w) * sx) - devX);
  canvas.height = Math.max(1, Math.ceil((reach.y + reach.h) * sy) - devY);
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = quality;
  g.setTransform(sx, 0, 0, sy, -devX, -devY);
  const draw = getImageRect(img, reach, state.pan, state.zoom);
  g.drawImage(img, draw.x, draw.y, draw.w, draw.h);
  // The weight: alpha 0 at a shared edge, 1 a ramp in, kept at 1 to an
  // outer edge. Two ramps on one axis that would cross are shortened to
  // meet (a blend wider than the cell). Both neighbours evaluate their ramp
  // at the same device-pixel centres, so the two weights add up to one.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "destination-in";
  for (const axis of ["x", "y"]) {
    const horizontal = axis === "x";
    let r0 = horizontal ? reach.ramps.left : reach.ramps.top;
    let r1 = horizontal ? reach.ramps.right : reach.ramps.bottom;
    if (!r0 && !r1) continue;
    const len = horizontal ? reach.w : reach.h;
    if (r0 + r1 > len) { const k = len / (r0 + r1); r0 *= k; r1 *= k; }
    const from = horizontal ? reach.x * sx - devX : reach.y * sy - devY;
    const to = horizontal ? (reach.x + reach.w) * sx - devX : (reach.y + reach.h) * sy - devY;
    const grad = horizontal ? g.createLinearGradient(from, 0, to, 0) : g.createLinearGradient(0, from, 0, to);
    grad.addColorStop(0, r0 ? "rgba(0,0,0,0)" : "#000");
    if (r0) grad.addColorStop(r0 / len, "#000");
    if (r1) grad.addColorStop(1 - r1 / len, "#000");
    grad.addColorStop(1, r1 ? "rgba(0,0,0,0)" : "#000");
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  return { canvas, devX, devY };
}

/**
 * Every cell's image at once. Without edge blend each cell is drawn on its
 * own (drawCellImage, rounded corners included). With it, each image is
 * cover-fit to its reach (blendedCellRect) and weighted by linear ramps
 * across the shared bands; a neighbour's ramp is the exact complement, so
 * the weights sum to one and the weighted images, added up on a
 * transparent page, cross-fade into each other with nothing showing
 * through. The cells are then one picture, so the corner radius does not
 * apply. `images[i]` may be null (nothing drawn there); `states[i]` is
 * { pan, zoom } in the ctx's user space.
 */
export function drawCollageCells(ctx, { cells, cellRects, images, states, gap, borderRadius, edgeBlend, pageW, pageH }) {
  if (!(edgeBlend > 0)) {
    for (let i = 0; i < cellRects.length; i++) {
      if (images[i]) drawCellImage(ctx, images[i], cellRects[i], states[i].pan, states[i].zoom, borderRadius);
    }
    return;
  }
  const m = ctx.getTransform();
  const sx = Math.abs(m.a) || 1;
  const sy = Math.abs(m.d) || 1;
  const page = document.createElement("canvas");
  page.width = Math.max(1, Math.ceil(pageW * sx));
  page.height = Math.max(1, Math.ceil(pageH * sy));
  const pc = page.getContext("2d");
  pc.globalCompositeOperation = "lighter";
  const quality = ctx.imageSmoothingQuality || "high";
  for (let i = 0; i < cellRects.length; i++) {
    if (!images[i]) continue;
    const reach = blendedCellRect(cellRects[i], cells[i], gap, edgeBlend);
    const layer = weightedCell(images[i], reach, states[i], sx, sy, quality);
    pc.drawImage(layer.canvas, layer.devX, layer.devY);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(page, m.e, m.f);
  ctx.restore();
}

/**
 * The parts of a cell its image does not reach, as non-overlapping strips
 * along the cell's edges (top and bottom bands first, then the side strips
 * between them): empty when the image covers the cell. A cover-fit image at
 * zoom 1 touches two edges exactly and overshoots the other two, so only a
 * zoom below 1 or a pan opens a gap; `tolerance` absorbs float noise. No
 * image at all leaves the whole cell uncovered.
 */
export function uncoveredStrips(cellRect, imageRect, tolerance = 0.5) {
  const { x, y, w, h } = cellRect;
  if (!imageRect) return [{ x, y, w, h }];
  const clampTo = (v, max) => Math.min(Math.max(0, v), max);
  const top = imageRect.y - y;
  const bottom = (y + h) - (imageRect.y + imageRect.h);
  const left = imageRect.x - x;
  const right = (x + w) - (imageRect.x + imageRect.w);
  const strips = [];
  const bandTop = top > tolerance ? clampTo(top, h) : 0;
  const bandBottom = bottom > tolerance ? clampTo(bottom, h - bandTop) : 0;
  if (bandTop > 0) strips.push({ x, y, w, h: bandTop });
  if (bandBottom > 0) strips.push({ x, y: y + h - bandBottom, w, h: bandBottom });
  const midH = h - bandTop - bandBottom;
  if (midH > 0) {
    const sideLeft = left > tolerance ? clampTo(left, w) : 0;
    const sideRight = right > tolerance ? clampTo(right, w - sideLeft) : 0;
    if (sideLeft > 0) strips.push({ x, y: y + bandTop, w: sideLeft, h: midH });
    if (sideRight > 0) strips.push({ x: x + w - sideRight, y: y + bandTop, w: sideRight, h: midH });
  }
  return strips;
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
  gap = 0,
  padding = 0,
  borderRadius = 0,
  edgeBlend = 0,
  bgColor = "#000000",
  states = [],
  width = 4096,
}) {
  if (!template?.cells) throw new Error("template with cells is required");
  const targetH = Math.round(width / (canvasRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = bgColor || "#000000";
  ctx.fillRect(0, 0, width, targetH);
  const cellRects = computeCellRects(template.cells, width, targetH, gap, padding);
  drawCollageCells(ctx, {
    cells: template.cells,
    cellRects,
    images: cellRects.map((_, i) => images[i] || null),
    states: cellRects.map((_, i) => ({ pan: states[i]?.pan || { x: 0, y: 0 }, zoom: states[i]?.zoom || 1 })),
    gap, borderRadius, edgeBlend, pageW: width, pageH: targetH,
  });
  return canvas;
}
