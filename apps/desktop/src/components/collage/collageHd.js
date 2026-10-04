// HD previews for collage cells, made a few at a time. Each call runs on the
// resident sidecar with a 30 s timeout, so asking for every cell of a large
// batch at once ends in one timeout and a whole export from 512px thumbnails;
// small chunks finish in time, and each lands in the canvas as it is made.
export const HD_CHUNK_SIZE = 8;

// A cell that would draw from its thumbnail until an HD preview is made.
export function needsCollageHd(item) {
  return Boolean(item?.asset_id && item.image_path && !item.image_preview_hd_path && !item.preview_hd_path);
}

// `ensureBatch(chunk)` resolves to asset_id → HD path (null where none was
// made). `onChunk(made, missed)` runs after each chunk, in order, and is
// awaited, so a patch can finish before the next chunk is asked for. Stops
// early once `isCancelled()` (the collage closed or reopened on other photos).
export async function ensureHdInChunks(items, { ensureBatch, onChunk, isCancelled = () => false, chunkSize = HD_CHUNK_SIZE }) {
  for (let i = 0; i < items.length; i += chunkSize) {
    if (isCancelled()) return;
    const chunk = items.slice(i, i + chunkSize);
    let found;
    try {
      found = await ensureBatch(chunk);
    } catch (err) {
      console.warn("[Collage] HD preview generation failed:", err);
      found = new Map();
    }
    if (isCancelled()) return;
    const made = new Map();
    const missed = [];
    for (const item of chunk) {
      const hd = found?.get?.(item.asset_id);
      if (hd) made.set(item.asset_id, hd);
      else missed.push(item);
    }
    await onChunk(made, missed);
  }
}
