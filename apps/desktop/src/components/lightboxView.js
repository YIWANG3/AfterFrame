export function buildLightboxSources(item) {
  if (!item) return { baseSources: [], detailPath: null };

  const isRaw = item.asset_type === "raw";
  const original = item.exists_on_disk === false || isRaw ? null : item.image_path || null;
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
