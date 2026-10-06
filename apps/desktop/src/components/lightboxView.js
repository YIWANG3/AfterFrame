// `onDemandHd`: a RAW's HD preview made while it was open (useOnDemandHdPreviews).
// It arrives after the thumbnail is up, so it joins as the detail layer, the way
// an image's original does, rather than replacing the view under the user.
export function buildLightboxSources(item, { onDemandHd = null } = {}) {
  if (!item) return { baseSources: [], detailPath: null };

  const isRaw = item.asset_type === "raw";
  const original = item.exists_on_disk === false
    ? null
    : (isRaw ? onDemandHd : item.image_path) || null;
  const smallPreviews = [
    item.image_preview_path,
    item.preview_path,
    item.raw_preview_path,
  ];
  const hdPreviews = [item.preview_hd_path, item.image_preview_hd_path];
  // Normal images intentionally use the smallest preview while the user is
  // moving the view. RAW has no browser-decodable original, so keep its HD
  // preview first or it would never regain full detail after interaction.
  const previewSources = isRaw
    ? [...hdPreviews, ...smallPreviews]
    : [...smallPreviews, ...hdPreviews];
  const baseSources = [...new Set([...previewSources, original].filter(Boolean))];

  return {
    baseSources,
    // The original loads alongside the small interaction layer and is hidden
    // while the view moves. With no preview it remains the single base layer.
    detailPath: original && baseSources[0] !== original ? original : null,
  };
}

// What Compare shows for one photo. An <img> can't decode a RAW (or a TIFF,
// or a video), and media:// serves those bytes as they are — so the gallery's
// Compare showed two broken images for RAWs. A RAW shows the HD preview made
// on demand once it arrives, a better preview until then; a photo whose
// original is missing shows its preview.
const BROWSER_IMAGE = /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i;
// Whether an <img> can show the photo's original file itself.
export function showsOriginal(item) {
  return Boolean(item) && item.asset_type !== "raw" && item.asset_type !== "video" && BROWSER_IMAGE.test(item.image_path || "");
}
export function compareSource(item, { onDemandHd = null } = {}) {
  if (!item) return null;
  const onDisk = item.exists_on_disk !== false;
  if (onDisk && showsOriginal(item)) return item.image_path;
  if (onDisk && item.asset_type === "raw" && onDemandHd) return onDemandHd;
  return item.preview_hd_path || item.image_preview_hd_path || item.image_preview_path || item.preview_path || item.raw_preview_path || null;
}

export function resolveLightboxLogicalSize(naturalWidth, naturalHeight, metaWidth, metaHeight) {
  const width = Number(naturalWidth) || 0;
  const height = Number(naturalHeight) || 0;
  const sourceWidth = Number(metaWidth) || 0;
  const sourceHeight = Number(metaHeight) || 0;
  if (!width || !height) return null;
  if (!sourceWidth || !sourceHeight) return { width, height };

  // Chromium applies EXIF orientation to an image's intrinsic dimensions, but
  // catalog metadata stores the underlying pixel matrix. Preserve the browser's
  // aspect/orientation while retaining the source's full-resolution long edge.
  const naturalRatio = width / height;
  const sourceRatio = sourceWidth / sourceHeight;
  const ratioDistance = (a, b) => Math.abs(Math.log(a / b));
  if (ratioDistance(naturalRatio, sourceRatio) < 0.01) {
    return { width: sourceWidth, height: sourceHeight };
  }
  if (ratioDistance(naturalRatio, 1 / sourceRatio) < 0.01) {
    return { width: sourceHeight, height: sourceWidth };
  }

  // Damaged/stale metadata can disagree for reasons other than orientation.
  // In that case keep the decoded preview's aspect ratio to avoid stretching.
  const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
  if (naturalRatio >= 1) {
    return { width: sourceLongEdge, height: sourceLongEdge / naturalRatio };
  }
  return { width: sourceLongEdge * naturalRatio, height: sourceLongEdge };
}
