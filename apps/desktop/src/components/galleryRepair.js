// Which loaded cards the gallery should repair from disk because the source
// changed under the catalog (or an image never got its dimensions), and which
// assets are healthy again and get their repair budget back.
//
// Grouped by asset: an asset is healthy only when every card showing it is.
// Two cards sharing an asset (byte-identical RAW copies, before the sidecar
// split them) used to hand the stale one its budget back on every pass, so it
// was repaired, and re-rendered, forever.
export function staleSourceRepairs(items) {
  const stale = new Map(); // asset_id -> its first stale card
  const healthy = new Set();
  for (const item of items || []) {
    if (!item?.asset_id) continue;
    const metadata = item.image_metadata || {};
    const missingImageMetadata = item.asset_type === "image" && (
      Number(metadata.width || 0) <= 0
      || Number(metadata.height || 0) <= 0
      || Number(metadata.file_size || metadata.size_bytes || 0) <= 0
    );
    if (item.source_changed || missingImageMetadata) {
      if (!stale.has(item.asset_id)) stale.set(item.asset_id, item);
    } else {
      healthy.add(item.asset_id);
    }
  }
  return {
    stale: [...stale.values()],
    healthyIds: [...healthy].filter((id) => !stale.has(id)),
  };
}
