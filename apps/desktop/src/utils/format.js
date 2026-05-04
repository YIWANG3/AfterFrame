import justifiedLayout from "justified-layout";

export function localFileUrl(filePath) {
  if (!filePath) return "";
  if (filePath.startsWith("media://")) return filePath;
  const encoded = filePath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `media://${encoded}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function fileName(value) {
  if (!value) return "";
  const normalized = String(value).replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}

export function baseName(value) {
  return fileName(value) || String(value || "");
}

export function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "");
}

export function collapseRootPaths(paths) {
  const unique = [...new Set((paths || []).map((value) => normalizePath(value)).filter(Boolean))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  const collapsed = [];
  for (const entry of unique) {
    const nested = collapsed.some((root) => entry === root || entry.startsWith(`${root}/`));
    if (!nested) collapsed.push(entry);
  }
  return collapsed;
}

export function mergeRoots(existing, added) {
  return collapseRootPaths([...(existing || []), ...(added || [])]);
}

export function escapePathLabel(value) {
  if (!value) return "Not linked";
  const segments = String(value).split("/");
  if (segments.length <= 4) return value;
  return `.../${segments.slice(-3).join("/")}`;
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!bytes || Number.isNaN(bytes) || bytes < 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatTimestamp(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

export function statusLabel(status) {
  if (status === "auto_bound" || status === "manual_confirmed") return "With Raw";
  if (status === "unmatched") return "Standalone";
  return "Unknown";
}

export function scoreLabel(score) {
  if (score == null) return null;
  return Number(score).toFixed(2);
}

export function formatShutterSpeed(value) {
  const v = Number(value);
  if (!v || Number.isNaN(v)) return null;
  if (v >= 1) return `${v}s`;
  const denom = Math.round(1 / v);
  return `1/${denom}s`;
}

export function formatAperture(value) {
  const v = Number(value);
  if (!v || Number.isNaN(v)) return null;
  return `f/${v % 1 === 0 ? v : v.toFixed(1)}`;
}

export function formatFocalLength(value) {
  const v = Number(value);
  if (!v || Number.isNaN(v)) return null;
  return `${v % 1 === 0 ? v : v.toFixed(1)} mm`;
}

export function formatISO(value) {
  const v = Number(value);
  if (!v || Number.isNaN(v)) return null;
  return `ISO ${v}`;
}

export function filterTitle(status) {
  if (status === "matched") return "With Raw";
  if (status === "recent") return "Recently Added";
  if (status === "rated") return "Rated";
  return "All Assets";
}

export function hasIndexedSources(summary) {
  return Number(summary?.raw_assets ?? 0) > 0;
}

export function hasIndexedImages(summary) {
  return Number(summary?.export_assets ?? 0) > 0;
}

export function determineImportMode(summary, { rawDirs = [], exportDirs = [] }) {
  const hasRawInput = rawDirs.length > 0;
  const hasImageInput = exportDirs.length > 0;
  if (hasRawInput && hasImageInput) {
    if (hasIndexedSources(summary) && !hasIndexedImages(summary)) return "processed_with_sources";
    if (!hasIndexedSources(summary) && hasIndexedImages(summary)) return "source_with_media";
    return "combined";
  }
  if (hasRawInput) return hasIndexedImages(summary) ? "source_with_media" : "source_only";
  if (hasImageInput) return hasIndexedSources(summary) ? "processed_with_sources" : "processed_only";
  return "combined";
}

export function progressNote(task) {
  const currentPhase = task?.result?.current_phase;
  if (!currentPhase?.result) return "";
  const result = currentPhase.result;
  const processed = Number(result.processed ?? 0);
  const total = Number(result.total ?? 0);
  const discovered = Number(result.discovered ?? 0);
  if (total > 0) {
    return `${currentPhase.label}: ${processed} / ${total} (${formatPercent(processed / total)})`;
  }
  if (discovered > 0) {
    return `${currentPhase.label}: processed ${processed}, discovered ${discovered}`;
  }
  return `${currentPhase.label}: starting...`;
}

export function navItems(summary) {
  const items = [
    { key: "all", label: "All Assets", count: summary?.export_assets ?? 0, icon: "Archive" },
    { key: "recent", label: "Recently Added", count: summary?.recently_added_count ?? 0, icon: "Clock" },
  ];
  if (Number(summary?.rated_count ?? 0) > 0) {
    items.push({ key: "rated", label: "Rated", count: summary?.rated_count ?? 0, icon: "Star" });
  }
  if (Number(summary?.raw_assets ?? 0) > 0) {
    items.push({ key: "matched", label: "With Raw", count: summary?.confirmed_matches ?? 0, icon: "Link" });
  }
  return items;
}

export function galleryInfoLabel(item) {
  const exportMeta = item.export_metadata || {};
  const dimensions = exportMeta.width && exportMeta.height ? `${exportMeta.width} × ${exportMeta.height}` : null;
  const sizeLabel = formatBytes(exportMeta.file_size || exportMeta.size_bytes);
  return [dimensions, sizeLabel].filter(Boolean).join(" · ");
}

export function buildJustifiedLayout(items, containerWidth, targetHeight, gap, captionHeight = 52) {
  if (!containerWidth) {
    return { rows: [], containerHeight: 0 };
  }
  const geometry = justifiedLayout(
    items.map((item) => {
      const exportMeta = item.export_metadata || {};
      const width = Number(exportMeta.width || 0);
      const height = Number(exportMeta.height || 0);
      return {
        width: width > 0 ? width : 1,
        height: height > 0 ? height : 1,
      };
    }),
    {
      containerWidth,
      targetRowHeight: targetHeight,
      targetRowHeightTolerance: 0.35,
      boxSpacing: { horizontal: gap, vertical: gap },
      containerPadding: 0,
      showWidows: true,
    },
  );

  const rows = [];
  let currentTop = null;
  let currentRow = [];

  geometry.boxes.forEach((box, index) => {
    if (currentTop === null || Math.abs(box.top - currentTop) < 1) {
      currentTop = box.top;
      currentRow.push({ item: items[index], left: box.left, width: box.width, height: box.height, top: box.top });
      return;
    }
    rows.push(currentRow);
    currentTop = box.top;
    currentRow = [{ item: items[index], left: box.left, width: box.width, height: box.height, top: box.top }];
  });

  if (currentRow.length) rows.push(currentRow);

  let cursorTop = 0;
  const normalizedRows = rows.map((row) => {
    const rowHeight = Math.max(...row.map((box) => box.height), targetHeight);
    const normalized = row.map((box) => ({
      ...box,
      top: cursorTop,
    }));
    cursorTop += rowHeight + captionHeight + gap;
    return normalized;
  });

  return {
    rows: normalizedRows,
    containerHeight: Math.max(0, cursorTop - gap),
  };
}
