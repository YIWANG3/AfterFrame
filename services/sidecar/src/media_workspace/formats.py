"""The format registry: the one list of what the catalog imports.

Every question about a file type is answered here, by extension, and the
answers reach the Electron and renderer sides through a generated module
(apps/desktop/shared/formats.generated.mjs, written by `--emit-js`; the test
in tests/test_formats.py keeps it fresh). Before this module the same sets
lived in four hand-kept copies that disagreed (docs/format-support-plan.md
§2): the sidecar's import whitelist, the watcher's regex, the lightbox's
"an <img> can show this" regex and the Dock's document types.

A row is one format family (JPEG, with .jpg/.jpeg/...), with:

- `kind`: how the import indexes it (image / raw / video), which is what
  `assets.asset_type` stores;
- `browser_native`: Chromium decodes the original itself, so the lightbox and
  the editor can load it over media://;
- `transcode_for_browser`: Chromium can't, but media:// renders it to a JPEG
  first (HEIC); the lightbox treats these as showable too;
- `export_source`: Pillow reads it well enough to be the source of a crop,
  a text overlay or a transcoded export (derived.py);
- `mime`: the type the video range server answers with.

RAW rows are one per extension, because LibRaw, the Inspector and the format
facet all speak in those names ("cr3", "arw"); their `family` is the extension.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

RAW_SIGNATURE_SAMPLE_BYTES = 4096


@dataclass(frozen=True, slots=True)
class MediaFormat:
    family: str
    kind: str
    label: str
    extensions: tuple[str, ...]
    browser_native: bool = False
    transcode_for_browser: bool = False
    export_source: bool = False
    mime: str | None = None


def _raw(extension: str, label: str) -> MediaFormat:
    return MediaFormat(family=extension, kind="raw", label=label, extensions=(f".{extension}",))


# RAW extensions vary by manufacturer; cover the full common set so files are
# recognized on import regardless of camera brand. Whether a given format also
# *renders* depends on LibRaw (and on macOS, Image I/O): unsupported ones still
# import but may lack a preview. Video-RAW like .braw/.r3d is intentionally
# excluded.
_RAW_FORMATS: tuple[MediaFormat, ...] = (
    _raw("3fr", "Hasselblad 3FR"),
    _raw("ari", "ARRIRAW"),
    _raw("arw", "Sony ARW"),
    _raw("srf", "Sony SRF"),
    _raw("sr2", "Sony SR2"),
    _raw("bay", "Casio BAY"),
    _raw("cap", "Phase One CAP"),
    _raw("iiq", "Phase One IIQ"),
    _raw("eip", "Phase One EIP"),
    _raw("cr2", "Canon CR2"),
    _raw("cr3", "Canon CR3"),
    _raw("crw", "Canon CRW"),
    _raw("dcs", "Kodak DCS"),
    _raw("dcr", "Kodak DCR"),
    _raw("drf", "Kodak DRF"),
    _raw("k25", "Kodak K25"),
    _raw("kdc", "Kodak KDC"),
    _raw("dng", "DNG"),
    _raw("erf", "Epson ERF"),
    _raw("fff", "Hasselblad FFF"),
    _raw("gpr", "GoPro GPR"),
    _raw("mef", "Mamiya MEF"),
    _raw("mdc", "Minolta MDC"),
    _raw("mos", "Leaf MOS"),
    _raw("mrw", "Minolta MRW"),
    _raw("nef", "Nikon NEF"),
    _raw("nrw", "Nikon NRW"),
    _raw("orf", "Olympus ORF"),
    _raw("pef", "Pentax PEF"),
    _raw("ptx", "Pentax PTX"),
    _raw("pxn", "Logitech PXN"),
    _raw("raf", "Fujifilm RAF"),
    _raw("raw", "RAW"),
    _raw("rw2", "Panasonic RW2"),
    _raw("rwl", "Leica RWL"),
    _raw("rwz", "Rawzor RWZ"),
    _raw("srw", "Samsung SRW"),
    _raw("x3f", "Sigma X3F"),
)

_IMAGE_FORMATS: tuple[MediaFormat, ...] = (
    MediaFormat("jpeg", "image", "JPEG", (".jpg", ".jpeg"), browser_native=True, export_source=True),
    MediaFormat("png", "image", "PNG", (".png",), browser_native=True, export_source=True),
    MediaFormat("webp", "image", "WebP", (".webp",), browser_native=True, export_source=True),
    MediaFormat("avif", "image", "AVIF", (".avif",), browser_native=True),
    # Chromium can't decode HEIC; media:// hands it a JPEG made by sips or the
    # sidecar (electron/media/protocol.js).
    MediaFormat("heic", "image", "HEIC", (".heic",), transcode_for_browser=True),
    # No browser decodes TIFF, so a TIFF's lightbox ceiling is its HD preview.
    MediaFormat("tiff", "image", "TIFF", (".tif", ".tiff"), export_source=True),
)

_VIDEO_FORMATS: tuple[MediaFormat, ...] = (
    MediaFormat("mp4", "video", "MP4", (".mp4", ".m4v"), mime="video/mp4"),
    MediaFormat("mov", "video", "QuickTime", (".mov",), mime="video/quicktime"),
    MediaFormat("webm", "video", "WebM", (".webm",), mime="video/webm"),
    MediaFormat("mkv", "video", "Matroska", (".mkv",), mime="video/x-matroska"),
    MediaFormat("avi", "video", "AVI", (".avi",), mime="video/x-msvideo"),
)

REGISTRY: tuple[MediaFormat, ...] = _IMAGE_FORMATS + _RAW_FORMATS + _VIDEO_FORMATS

@dataclass(frozen=True, slots=True)
class ExportFormat:
    """What an edited photo, a crop or an export can be written as."""

    extension: str              # the extension written
    extensions: tuple[str, ...] # the extensions that already are this format
    pillow: str
    mime: str
    label: str


# Keyed by the name the tools, the CLI's --format and MCP's export_assets accept.
EXPORT_FORMATS: dict[str, ExportFormat] = {
    "jpeg": ExportFormat(".jpg", (".jpg", ".jpeg"), "JPEG", "image/jpeg", "JPEG"),
    "png": ExportFormat(".png", (".png",), "PNG", "image/png", "PNG"),
    "webp": ExportFormat(".webp", (".webp",), "WEBP", "image/webp", "WebP"),
}

_BY_EXTENSION: dict[str, MediaFormat] = {ext: fmt for fmt in REGISTRY for ext in fmt.extensions}


def format_for(path: Path | str) -> MediaFormat | None:
    """The registry row for a path's extension, or None when the catalog
    doesn't import that type."""
    return _BY_EXTENSION.get(Path(path).suffix.lower())


def kind_of(path: Path | str) -> str | None:
    fmt = format_for(path)
    return fmt.kind if fmt else None


def extensions(kind: str | None = None) -> frozenset[str]:
    """Lower-case extensions with their dot; all importable ones, or one kind's."""
    return frozenset(ext for fmt in REGISTRY if kind is None or fmt.kind == kind for ext in fmt.extensions)


IMPORTABLE_EXTENSIONS = extensions()
IMAGE_EXTENSIONS = extensions("image")
RAW_EXTENSIONS = extensions("raw")
VIDEO_EXTENSIONS = extensions("video")
EXPORT_SOURCE_EXTENSIONS = frozenset(ext for fmt in REGISTRY if fmt.export_source for ext in fmt.extensions)


def export_format_for(path: Path | str) -> str | None:
    """Which EXPORT_FORMATS entry a file already is ("jpeg" for .JPG), or None."""
    suffix = Path(path).suffix.lower()
    for name, spec in EXPORT_FORMATS.items():
        if suffix in spec.extensions:
            return name
    return None


# --- RAW by content ----------------------------------------------------------
# A file without an extension, or with one the registry doesn't know, can still
# be a RAW: a CR3 is an ISO BMFF with a `crx ` brand, and most other RAWs are
# TIFF containers that name their maker near the start. The RAW-source scan
# uses this; the import goes by extension only.


def _is_iso_bmff_raw(data: bytes) -> str | None:
    if len(data) < 16 or data[4:8] != b"ftyp":
        return None
    brands = {data[8:12], data[16:20], data[20:24], data[24:28]}
    if {b"crx ", b"cr3 ", b"crx\x00"} & brands:
        return "cr3"
    return None


def _is_tiff_header(data: bytes) -> bool:
    return data.startswith(b"II*\x00") or data.startswith(b"MM\x00*")


_TIFF_MAKER_MARKERS = (
    (b"DNGVersion", "dng"),
    (b"FUJIFILM", "raf"),
    (b"NIKON", "nef"),
    (b"Nikon", "nef"),
    (b"SONY", "arw"),
    (b"Panasonic", "rw2"),
    (b"OLYMPUS", "orf"),
    (b"Hasselblad", "3fr"),
    (b"Canon", "cr2"),
    (b"PENTAX", "pef"),
    (b"EPSON", "erf"),
)


def _detect_tiff_raw_format(data: bytes) -> str | None:
    if not _is_tiff_header(data):
        return None
    for marker, detected in _TIFF_MAKER_MARKERS:
        if marker in data:
            return detected
    # Generic TIFF-like RAW fallback. For no-extension files we prefer a weak
    # positive over dropping a real RAW, but we still reject obviously unrelated
    # non-TIFF files elsewhere.
    return "tiff-raw"


def sniff_raw(data: bytes) -> str | None:
    """The RAW family the first bytes of a file identify, or None."""
    return _is_iso_bmff_raw(data) or _detect_tiff_raw_format(data)


def raw_format_of(path: Path, *, sniff: bool = True) -> str | None:
    """The RAW family of a file: by its extension, else (with `sniff`) by its
    first bytes. None for anything that is not a RAW."""
    fmt = format_for(path)
    if fmt is not None:
        return fmt.family if fmt.kind == "raw" else None
    if not sniff:
        return None
    with path.open("rb") as handle:
        return sniff_raw(handle.read(RAW_SIGNATURE_SAMPLE_BYTES))


# --- the generated JS module --------------------------------------------------


def _regex_alternatives(exts: frozenset[str] | set[str]) -> str:
    return "|".join(sorted(ext.lstrip(".") for ext in exts))


def emit_js() -> str:
    """The text of apps/desktop/shared/formats.generated.mjs."""
    rows = [
        {
            "family": fmt.family,
            "kind": fmt.kind,
            "label": fmt.label,
            "extensions": list(fmt.extensions),
            "browserNative": fmt.browser_native,
            "transcodeForBrowser": fmt.transcode_for_browser,
            "exportSource": fmt.export_source,
            "mime": fmt.mime,
        }
        for fmt in REGISTRY
    ]
    showable = frozenset(ext for fmt in REGISTRY if fmt.browser_native or fmt.transcode_for_browser for ext in fmt.extensions)
    transcode = frozenset(ext for fmt in REGISTRY if fmt.transcode_for_browser for ext in fmt.extensions)
    video_mime = {ext: fmt.mime for fmt in REGISTRY if fmt.kind == "video" for ext in fmt.extensions}
    export_formats = {
        name: {"extension": spec.extension, "extensions": list(spec.extensions), "mime": spec.mime, "label": spec.label}
        for name, spec in EXPORT_FORMATS.items()
    }

    def js(value: object) -> str:
        """JSON, one entry per line, so a format is one diff line."""
        if isinstance(value, list):
            return "[\n" + "".join(f"  {json.dumps(item, ensure_ascii=False)},\n" for item in value) + "]"
        if isinstance(value, dict):
            return "{\n" + "".join(f"  {json.dumps(key)}: {json.dumps(item, ensure_ascii=False)},\n" for key, item in value.items()) + "}"
        return json.dumps(value, ensure_ascii=False)

    return (
        "// GENERATED from services/sidecar/src/media_workspace/formats.py — do not edit.\n"
        "// Regenerate with `npm run gen:formats`; tests/test_formats.py fails when this is stale.\n"
        "//\n"
        "// The format registry as the Electron main process and the renderer see it:\n"
        "// which files the catalog imports (and the watcher and Dock accept), which\n"
        "// originals an <img> can show, which the video range server serves, and\n"
        "// what an edited photo can be saved as. shared/formats.mjs has the helpers.\n"
        "\n"
        f"export const FORMATS = Object.freeze({js(rows)});\n"
        "\n"
        "// Lower-case, with the dot.\n"
        f"export const IMPORTABLE_EXTENSIONS = new Set({js(sorted(IMPORTABLE_EXTENSIONS))});\n"
        "\n"
        "// Anything the import would take: the watcher's pre-filter.\n"
        f"export const MEDIA_RE = /\\.({_regex_alternatives(IMPORTABLE_EXTENSIONS)})$/i;\n"
        "\n"
        "// An original an <img> can show over media://, directly or transcoded.\n"
        f"export const BROWSER_IMAGE_RE = /\\.({_regex_alternatives(showable)})$/i;\n"
        "\n"
        "// Originals media:// renders to a JPEG before Chromium sees them.\n"
        f"export const TRANSCODE_RE = /\\.({_regex_alternatives(transcode)})$/i;\n"
        "\n"
        f"export const VIDEO_MIME = Object.freeze({js(dict(sorted(video_mime.items())))});\n"
        "\n"
        "// What the editor, Split, the collage and MCP exports write; keys are the\n"
        "// names tools and `export_assets.format` accept.\n"
        f"export const EXPORT_FORMATS = Object.freeze({js(export_formats)});\n"
    )


def main(argv: list[str]) -> int:
    """`python -m media_workspace.formats --emit-js [PATH]`: write (or print) the
    generated module."""
    if not argv or argv[0] != "--emit-js":
        print("usage: python -m media_workspace.formats --emit-js [PATH]", file=sys.stderr)
        return 2
    text = emit_js()
    if len(argv) > 1:
        Path(argv[1]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
