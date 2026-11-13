// Arrow keys in the waterfall (masonry) layout. Each photo goes into the
// shortest column, so the next photo in list order can sit in any column;
// moving by list order would make Right jump left. Instead Left/Right step to
// the neighbouring column and Up/Down walk the current column.
//
// Left/Right keep to a line: the height where the run of Left/Right presses
// started (like a text editor keeps the goal column for Up/Down). Each step
// takes the photo in the next column nearest that line, so a run does not
// drift up or down as the columns' photos differ in height.
//
// At the edges Left/Right wrap the way a line of text does: Right in the last
// column goes to the photo below the first column's photo on this line, and
// the line moves down to it; Left in the first column goes to the photo above
// the last column's photo on this line. Every wrap moves the line strictly
// down (or up), so holding a key never loops. Up/Down stop at the ends of a
// column.
//
// layoutItems: [{ assetId, left, top, width, height }], as Gallery reports
// them. lineY: the line from the previous Left/Right press, or null to start a
// new one at the current photo. Returns { assetId, lineY } (lineY null after
// Up/Down), or null to stay put.

const COLUMN_TOLERANCE = 4;

function groupColumns(layoutItems) {
  const columns = [];
  for (const item of layoutItems) {
    const column = columns.find((c) => Math.abs(c.left - item.left) < COLUMN_TOLERANCE);
    if (column) column.items.push(item);
    else columns.push({ left: item.left, items: [item] });
  }
  columns.sort((a, b) => a.left - b.left);
  for (const column of columns) column.items.sort((a, b) => a.top - b.top);
  return columns.map((column) => column.items);
}

const centerY = (item) => item.top + item.height / 2;

function nearest(items, y) {
  let best = items[0];
  let bestDist = Infinity;
  for (const item of items) {
    const dist = Math.abs(centerY(item) - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

export function waterfallTarget(layoutItems, currentId, direction, lineY = null) {
  const current = layoutItems.find((item) => item.assetId === currentId);
  if (!current) return null;
  const columns = groupColumns(layoutItems);
  const columnIndex = columns.findIndex((column) => column.includes(current));
  const column = columns[columnIndex];

  if (direction === "up" || direction === "down") {
    const next = column[column.indexOf(current) + (direction === "down" ? 1 : -1)];
    return next ? { assetId: next.assetId, lineY: null } : null;
  }

  const line = lineY ?? centerY(current);
  const forward = direction === "right";
  const neighbour = columns[columnIndex + (forward ? 1 : -1)];
  if (neighbour) return { assetId: nearest(neighbour, line).assetId, lineY: line };

  const edge = forward ? columns[0] : columns[columns.length - 1];
  const onLine = edge.indexOf(nearest(edge, line));
  const wrapped = edge[onLine + (forward ? 1 : -1)];
  return wrapped ? { assetId: wrapped.assetId, lineY: centerY(wrapped) } : null;
}
