// The format registry's helpers for the main process and the renderer. The
// data is ./formats.generated.mjs, written from the sidecar's
// media_workspace/formats.py (the one list of what the catalog imports); this
// file only reads it. Ask here, never with a regex of your own: which files
// the import takes, which originals an <img> can show, what an edited photo
// is saved as.

import {
  BROWSER_IMAGE_RE,
  EXPORT_FORMATS,
  FORMATS,
  IMPORTABLE_EXTENSIONS,
  MEDIA_RE,
  TRANSCODE_RE,
  VIDEO_MIME,
} from "./formats.generated.mjs";

export { BROWSER_IMAGE_RE, EXPORT_FORMATS, FORMATS, IMPORTABLE_EXTENSIONS, MEDIA_RE, TRANSCODE_RE, VIDEO_MIME };

// The names a save or export format goes by ("jpeg", "png", "webp"): what
// `export_assets.format` and the sidecar's --format accept.
export const EXPORT_FORMAT_NAMES = Object.freeze(Object.keys(EXPORT_FORMATS));

const BY_EXTENSION = new Map(FORMATS.flatMap((format) => format.extensions.map((ext) => [ext, format])));
const BY_FAMILY = new Map(FORMATS.map((format) => [format.family, format]));

// "jpg" for ".JPG", "jpg" or "JPG": the form a Format filter compares in.
const bare = (value) => String(value ?? "").trim().toLowerCase().replace(/^\./, "");

// The format family a photo belongs to ("jpeg" for IMG_0001.JPG, "heif" for
// a .HIF, "cr3"), or its bare extension when the registry doesn't know it.
export function familyOf(filePath) {
  return formatFor(filePath)?.family || extensionOf(filePath).slice(1) || null;
}

// What the Format facet shows for a value: the family's label ("JPEG",
// "Canon CR3") or, for an extension that is not a family name (a rule an
// agent saved as "jpg"), the extension upper-cased.
export function formatLabel(value) {
  const name = bare(value);
  return BY_FAMILY.get(name)?.label || name.toUpperCase();
}

// The bare, lower-case extensions a Format filter value stands for: all of a
// family's ("jpeg" → jpg, jpeg, jfif, jpe, insp), or the one extension named.
export function filterExtensions(value) {
  const name = bare(value);
  const format = BY_FAMILY.get(name);
  return format ? format.extensions.map((ext) => ext.slice(1)) : [name];
}

// ".jpg" (lower-case, with the dot) for "/a/IMG_0001.JPG"; "" when there is none.
export function extensionOf(filePath) {
  const name = String(filePath || "");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

// The registry row for a file, or null when the catalog doesn't import its type.
export function formatFor(filePath) {
  return BY_EXTENSION.get(extensionOf(filePath)) || null;
}

// "image" | "raw" | "video" | null.
export function kindOf(filePath) {
  return formatFor(filePath)?.kind || null;
}

export function isImportable(filePath) {
  return IMPORTABLE_EXTENSIONS.has(extensionOf(filePath));
}

// Whether an <img> can show this original over media://, either because
// Chromium decodes it or because media:// transcodes it first (HEIC).
export function browserShowsOriginal(filePath) {
  return BROWSER_IMAGE_RE.test(String(filePath || ""));
}

export function needsBrowserTranscode(filePath) {
  return TRANSCODE_RE.test(String(filePath || ""));
}

// What the video range server answers with.
export function videoMime(filePath) {
  return VIDEO_MIME[extensionOf(filePath)] || "application/octet-stream";
}

// The export format a file already is ("jpeg" for .JPG and .jpeg), or null.
export function exportFormatOf(filePath) {
  const ext = extensionOf(filePath);
  return EXPORT_FORMAT_NAMES.find((name) => EXPORT_FORMATS[name].extensions.includes(ext)) || null;
}

// The encoder a save path calls for: its own format when it is one we write,
// else JPEG (an edited HEIC or TIFF is saved as a JPEG).
export function exportFormatForTarget(filePath) {
  return exportFormatOf(filePath) || "jpeg";
}

// The extension an edited copy keeps, without the dot: the original's when it
// is a format we write ("png", and "jpeg" stays "jpeg"), else "jpg".
export function exportExtension(filePath) {
  return exportFormatOf(filePath) ? extensionOf(filePath).slice(1) : "jpg";
}

// "image/png" for a .png target and so on; JPEG for everything else.
export function mimeForExport(filePath) {
  return EXPORT_FORMATS[exportFormatForTarget(filePath)].mime;
}

// Save-dialog filters, in the order given: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }, …].
export function saveFilters(names = EXPORT_FORMAT_NAMES) {
  return names.map((name) => ({
    name: EXPORT_FORMATS[name].label,
    extensions: EXPORT_FORMATS[name].extensions.map((ext) => ext.slice(1)),
  }));
}
