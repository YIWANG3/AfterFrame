// The gallery's four layouts as pure functions of the items, the scroller's
// width and the thumbnail size: grid (fixed columns with captions), tiles
// (edge to edge, no captions), justified rows and the waterfall. Each
// returns positions in content pixels and the total height; Gallery keeps
// only the scrolling, the virtualisation and the DOM.

import { buildJustifiedLayout, displaySize } from "../utils/format";

export const GAP = 12;
export const TILE_GAP = 2;
export const CAPTION_HEIGHT = 42;
export const GRID_ASPECT_RATIO = 4 / 3;
export const TILE_ASPECT_RATIO = 3 / 4;
export const VIEW_PADDING = 8;

export function buildGridLayout(items, containerWidth, thumbSize, gap, aspectRatio, captionHeight, horizontalPadding) {
  if (!containerWidth) return null;
  const availableWidth = Math.max(containerWidth - horizontalPadding * 2, thumbSize);
  const columnCount = Math.max(1, Math.floor((availableWidth + gap) / (thumbSize + gap)));
  const cellWidth = (availableWidth - gap * (columnCount - 1)) / columnCount;
  const imgHeight = cellWidth / aspectRatio;
  const cardHeight = imgHeight + captionHeight;
  const rowStride = cardHeight + gap;
  const totalRows = Math.ceil(items.length / columnCount);
  const positions = [];
  for (let idx = 0; idx < items.length; idx += 1) {
    const row = Math.floor(idx / columnCount);
    const col = idx % columnCount;
    positions.push({
      item: items[idx],
      left: col * (cellWidth + gap),
      top: row * rowStride,
      width: cellWidth,
      imgHeight,
      captionHeight,
    });
  }
  return {
    totalHeight: Math.max(0, totalRows * rowStride - gap),
    positions,
  };
}

export function buildGalleryGridLayout(items, containerWidth, thumbSize) {
  return buildGridLayout(items, containerWidth, thumbSize, GAP, GRID_ASPECT_RATIO, CAPTION_HEIGHT, VIEW_PADDING);
}

// Tile mode keeps an 8px gutter (index.css pads the scroller) so a selected
// tile can pop out without being clipped at the pane edge.
export function buildTileLayout(items, containerWidth, thumbSize) {
  return buildGridLayout(items, containerWidth, thumbSize, TILE_GAP, TILE_ASPECT_RATIO, 0, VIEW_PADDING);
}

// Justified rows (utils/format.buildJustifiedLayout) flattened to positions,
// with each row's top and bottom for the virtualiser.
export function buildJustifiedGalleryLayout(items, containerWidth, thumbSize) {
  if (!containerWidth) return null;
  const rowHeight = Math.round(thumbSize * 0.66);
  const layout = buildJustifiedLayout(items, Math.max(containerWidth - VIEW_PADDING * 2, 0), rowHeight, GAP, CAPTION_HEIGHT);
  if (!layout.rows.length) return null;
  const positions = layout.rows.flat();
  const rowTops = layout.rows.map((row) => row[0]?.top ?? 0);
  const rowBottoms = layout.rows.map((row) => {
    const maxH = Math.max(...row.map((b) => b.height));
    return (row[0]?.top ?? 0) + maxH + CAPTION_HEIGHT;
  });
  return {
    containerHeight: layout.containerHeight,
    positions,
    rowTops,
    rowBottoms,
  };
}

// Each photo goes to the shortest column, at its own aspect.
export function buildWaterfallLayout(items, containerWidth, thumbSize) {
  if (!containerWidth) return null;
  const availableWidth = Math.max(containerWidth - VIEW_PADDING * 2, thumbSize);
  const columnCount = Math.max(1, Math.floor((availableWidth + GAP) / (thumbSize + GAP)));
  const colWidth = (availableWidth - GAP * (columnCount - 1)) / columnCount;
  const colHeights = new Array(columnCount).fill(0);
  const positions = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { width: w, height: h } = displaySize(item);
    const aspect = w > 0 && h > 0 ? w / h : 1;
    const imgHeight = colWidth / aspect;
    // Pick shortest column
    let minCol = 0;
    for (let c = 1; c < columnCount; c++) {
      if (colHeights[c] < colHeights[minCol]) minCol = c;
    }
    const top = colHeights[minCol];
    const left = minCol * (colWidth + GAP);
    positions.push({ item, left, top, width: colWidth, imgHeight });
    colHeights[minCol] = top + imgHeight + CAPTION_HEIGHT + GAP;
  }
  const totalHeight = Math.max(0, Math.max(...colHeights) - GAP);
  return { totalHeight, positions };
}
