// The import summary's account of the files it skipped: the sidecar's
// `skipped_unsupported.by_extension` ({".docx": 3, ".zip": 1, "": 2}) as one
// line, most frequent first — "DOCX ×3 · ZIP ×1 · no extension ×2".
export function describeSkippedExtensions(byExtension, noExtensionLabel = "?") {
  return Object.entries(byExtension || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext, count]) => `${ext ? ext.replace(/^\./, "").toUpperCase() : noExtensionLabel} ×${count}`)
    .join(" · ");
}
