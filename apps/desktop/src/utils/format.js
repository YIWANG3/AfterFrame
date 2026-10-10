import justifiedLayout from "justified-layout";
import api from "../api";

export function localFileUrl(filePath) {
  if (!filePath) return "";
  // Already browser-servable (web build hands out blob:/data: URLs) — pass
  // through; media:// is the desktop-only privileged scheme.
  if (/^(blob:|data:|https?:)/.test(filePath)) return filePath;
  if (filePath.startsWith("media://")) return filePath;
  const encoded = filePath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `media://${encoded}`;
}

// Source URL for a sticker layer's `stickerPath`: a data: URL (e.g. a tinted
// frame logo instantiated as a sticker layer) is used as-is; otherwise it's a
// file path served over media://.
export function stickerSrc(path) {
  return typeof path === "string" && path.startsWith("data:") ? path : localFileUrl(path);
}

// Video must be served over HTTP — Chromium's <video> media loader rejects the
// custom media:// scheme. The localhost media server (main process) streams with
// Range support. Port is fetched once and memoized.
let _mediaPort = 0;
export function httpMediaUrl(filePath) {
  if (!filePath) return "";
  if (!_mediaPort) _mediaPort = api.getMediaServerPort() || 0;
  if (!_mediaPort) return "";
  return `http://127.0.0.1:${_mediaPort}/media?path=${encodeURIComponent(filePath)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Display label for a sticker — user-given name first, then source filename,
// then internal filename. Used by all sticker UI surfaces so they stay in sync.
export function stickerLabel(sticker) {
  if (!sticker) return "";
  return sticker.name || sticker.sourceLabel || sticker.filename || "";
}

// The last path segment, for "/" and "\\" paths alike (Windows paths reach
// the UI as-is); a trailing separator (a folder) is ignored.
export function fileName(value) {
  if (!value) return "";
  const normalized = String(value).replaceAll("\\", "/").replace(/\/+$/, "");
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

// The separator a path uses: "\\" for a Windows path, "/" otherwise. Paths
// built from one should keep it.
export function pathSeparator(value) {
  const text = String(value || "");
  return text.includes("\\") && !text.includes("/") ? "\\" : "/";
}

export function escapePathLabel(value) {
  if (!value) return "Not linked";
  const text = String(value);
  // Keep the path's own separator: C:\\Users\\… shortens to ...\\a\\b\\c.jpg
  const separator = pathSeparator(text);
  const segments = text.split(/[\\/]/);
  if (segments.length <= 4) return value;
  return `...${separator}${segments.slice(-3).join(separator)}`;
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!bytes || Number.isNaN(bytes) || bytes < 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// A date and time with no zone written on it ("2026-10-05 03:37:05").
const ZONELESS_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// `zoneless` says what a time without a zone means. Capture times are the
// camera's own clock (#147): shown as written, in any zone ("local"). Times the
// catalog stamps itself — an import, a record's update — come from SQLite's
// CURRENT_TIMESTAMP, which is UTC without saying so ("utc"); read as local
// they were off by the viewer's offset, 7 hours in California.
export function formatTimestamp(value, { zoneless = "local" } = {}) {
  if (!value) return "Unknown";
  const text = String(value);
  const date = new Date(zoneless === "utc" && ZONELESS_TIME.test(text) ? `${text.replace(" ", "T")}Z` : text);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A run of capture days ("2024-01-02" … "2024-01-06") as one label: the year
// only when it isn't this year, and what both ends share said once —
// "Jan 2 – 6, 2024", "2024年1月2日–6日". Chromium's formatRange falls back to
// "2024/1/2 – 2024/1/6" for Chinese, so CJK dates (largest unit first) are
// joined here: the end drops the year and month it shares with the start.
export function formatDayRange(from, to, locale, currentYear = new Date().getFullYear()) {
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  const withYear = start.getFullYear() !== currentYear || end.getFullYear() !== currentYear;
  const format = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
  if (from === to) return format.format(start);
  if (!/^(zh|ja|ko)\b/i.test(format.resolvedOptions().locale)) return format.formatRange(start, end);
  const shared = new Set();
  if (start.getFullYear() === end.getFullYear()) {
    shared.add("year");
    if (start.getMonth() === end.getMonth()) shared.add("month");
  }
  // Drop each shared unit together with the literal after it ("2024" + "年").
  const parts = format.formatToParts(end);
  const kept = parts.filter((part, index) => !shared.has(part.type)
    && !(part.type === "literal" && shared.has(parts[index - 1]?.type)));
  return `${format.format(start)}–${kept.map((part) => part.value).join("")}`;
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
  return Number(summary?.image_assets ?? 0) > 0;
}

export function determineImportMode(summary, { rawDirs = [], imageDirs = [] }) {
  const hasRawInput = rawDirs.length > 0;
  const hasImageInput = imageDirs.length > 0;
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

// How many photos All Assets shows: exports, and the RAW files and videos
// imported as photos. `image_assets` counts exports only (what RAW matching
// needs); an older sidecar has only that.
export function browseCount(summary) {
  return Number(summary?.browse_assets ?? summary?.image_assets ?? 0);
}

export function navItems(summary) {
  const items = [
    { key: "all", label: "All Assets", count: browseCount(summary), icon: "Archive" },
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
  const imageMeta = item.image_metadata || {};
  // As the photo shows, like Lightroom: an upright shot reads 4000 × 6000.
  const { width, height } = displaySize(item);
  const dimensions = width && height ? `${width} × ${height}` : null;
  const sizeLabel = formatBytes(imageMeta.file_size || imageMeta.size_bytes);
  return [dimensions, sizeLabel].filter(Boolean).join(" · ");
}

// A photo's width and height as it shows. The stored size is the pixels as
// kept in the file, so a camera's upright shot (landscape pixels with a
// "rotate 90°" tag) is landscape there; display_shape, read off the
// thumbnail, says how it really shows, and turns the size round to match.
export function displaySize(item) {
  const meta = item?.image_metadata || {};
  let width = Number(meta.width || 0);
  let height = Number(meta.height || 0);
  const shape = item?.display_shape;
  if ((shape === "portrait" && width > height) || (shape === "landscape" && height > width)) {
    [width, height] = [height, width];
  }
  return { width, height };
}

export function buildJustifiedLayout(items, containerWidth, targetHeight, gap, captionHeight = 52) {
  if (!containerWidth) {
    return { rows: [], containerHeight: 0 };
  }
  const geometry = justifiedLayout(
    items.map((item) => {
      const { width, height } = displaySize(item);
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
