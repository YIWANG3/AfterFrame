from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

from PIL import Image, ImageCms

from . import raw_decode, video
from .catalog import CatalogPaths
from .color_profiles import adobe_rgb_icc
from .config import DEFAULT_RAW_EXTENSIONS
from .db import list_assets_for_preview, upsert_preview_entry
from .db.colors import analyze_asset_colors
from .source_readiness import SourceNotReadyError, validate_source_ready, validate_source_unchanged

_MAX_WORKERS = max((os.cpu_count() or 4) // 2, 2)

KIND_SIZES = {
    "preview": 512,
    "preview-hd": 2000,
}

# Image I/O can hang on files it can't read (QuickLook on Phase One IIQ).
_IMAGE_IO_TIMEOUT_SECONDS = 90
# A RAW decoded for the HD tier: full size up to 8000 px long, half size
# beyond (raw_decode), so the editor still works at the photo's resolution.
_RAW_DECODE_HD_EDGE = 8000

# The camera's embedded JPEG is a RAW's preview when it is at least this long
# on its long edge; below that (a DJI DNG embeds 960 px, a Capture One DNG
# 160), the RAW is decoded.
_RAW_EMBEDDED_MIN_EDGE = {"preview": 512, "preview-hd": 2000}

_PREVIEW_JPEG_QUALITY = 90  # sips-sized files (~46 KB vs 49 KB for a 512px preview)
_ORIENTATION_TAG = 0x0112

# These are the user's own photos, not untrusted uploads: a 200-megapixel
# stitched panorama is a photo, not a decompression bomb (Pillow refuses past
# ~179 MP by default, before draft() could shrink the decode).
Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, 1_000_000_000)

_heif_registered = False


def _register_heif() -> None:
    """HEIC/HEIF (iPhone) through pillow-heif, once per process."""
    global _heif_registered
    if _heif_registered:
        return
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:  # no wheel for this platform: HEIC then fails to open
        pass
    _heif_registered = True


def _profile_space(icc_profile: bytes) -> str | None:
    """The colour space an ICC profile describes ('RGB ', 'CMYK', 'GRAY'…)."""
    try:
        return ImageCms.ImageCmsProfile(BytesIO(icc_profile)).profile.xcolor_space
    except (ImageCms.PyCMSError, OSError, ValueError):
        return None


def _cmyk_to_srgb(image: Image.Image, icc_profile: bytes) -> Image.Image:
    """CMYK through its own profile into sRGB, as Image I/O does. A plain
    convert("RGB") ignores the profile and oversaturates (print exports)."""
    try:
        source = ImageCms.ImageCmsProfile(BytesIO(icc_profile))
        converted = ImageCms.profileToProfile(image, source, ImageCms.createProfile("sRGB"), outputMode="RGB")
        if converted is not None:
            return converted
    except (ImageCms.PyCMSError, OSError, ValueError):
        pass
    return image.convert("RGB")


def render_pillow_preview(
    source: Path | BinaryIO,
    target: Path,
    size: int,
    orientation: int | None = None,
    icc_profile: bytes | None = None,
    exif: bytes | None = None,
) -> None:
    """A JPEG with the long edge at most `size`, matching what sips -Z gave:

    - pixels stay as stored and the EXIF orientation tag is carried over
      (viewers rotate, exactly as with the sips previews);
    - an RGB ICC profile is kept, so Display P3 photos keep their colour;
      CMYK is converted to sRGB through its profile, and a profile that
      can't describe the RGB preview (CMYK, grey) is dropped;
    - transparency is flattened onto white.

    Unlike sips it never enlarges a small image. JPEG sources decode at a
    reduced scale (draft), which is where most of the time goes.
    `orientation` overrides the source's own tag: a RAW's embedded JPEG
    carries the RAW's (raw_decode.py). `icc_profile` is the source's colour
    space when the source doesn't say (a RAW's Adobe RGB JPEG), and `exif`
    replaces the orientation-only EXIF (it must carry the orientation).
    """
    _register_heif()
    with Image.open(source) as image:
        orientation = orientation or image.getexif().get(_ORIENTATION_TAG)
        icc_profile = image.info.get("icc_profile") or icc_profile
        image.draft("RGB", (size, size))
        if image.mode == "CMYK" and icc_profile:
            frame = _cmyk_to_srgb(image, icc_profile)
            icc_profile = None  # the pixels are sRGB now
        elif image.mode in ("I;16", "I;16B", "I;16L", "I"):
            frame = image.convert("I").point(lambda value: value * (1 / 257)).convert("L").convert("RGB")
        elif image.has_transparency_data:
            rgba = image.convert("RGBA")
            frame = Image.new("RGB", rgba.size, (255, 255, 255))
            frame.paste(rgba, mask=rgba.getchannel("A"))
        else:
            frame = image.convert("RGB")
    frame.thumbnail((size, size), Image.Resampling.LANCZOS)
    options: dict = {"quality": _PREVIEW_JPEG_QUALITY}
    if icc_profile and _profile_space(icc_profile) == "RGB ":
        options["icc_profile"] = icc_profile
    if exif:
        options["exif"] = exif
    elif orientation and orientation != 1:
        tag = Image.Exif()
        tag[_ORIENTATION_TAG] = orientation
        options["exif"] = tag.tobytes()
    frame.save(target, "JPEG", **options)


def _row_metadata(row) -> dict:
    """The asset's catalog metadata, from a preview row that carries it."""
    keys = row.keys() if hasattr(row, "keys") else ()
    raw = row["metadata_json"] if "metadata_json" in keys else None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def _is_adobe_rgb(metadata: dict) -> bool:
    """EXIF ColorSpace "uncalibrated" (0xFFFF): cameras offer only sRGB and
    Adobe RGB, and render their embedded JPEG, untagged, in the one set."""
    return str(metadata.get("color_space")) in ("65535", "Uncalibrated")


def _exif_rational(value) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _exif_from_metadata(metadata: dict, orientation: int | None) -> bytes:
    """EXIF for a RAW's HD preview from the catalog's metadata (camera, lens,
    exposure, capture time, GPS), so an edit saved from it keeps them."""
    exif = Image.Exif()
    for tag, key in ((0x010F, "camera_make"), (0x0110, "camera_model"), (0x0131, "software")):
        if metadata.get(key):
            exif[tag] = str(metadata[key])
    if orientation and orientation != 1:
        exif[_ORIENTATION_TAG] = orientation
    details = exif.get_ifd(0x8769)
    captured = metadata.get("capture_time")
    if isinstance(captured, str) and len(captured) >= 19:
        details[0x9003] = captured[:19].replace("-", ":", 2).replace("T", " ")
    for tag, key in ((0xA434, "lens_model"), (0xA433, "lens_make")):
        if metadata.get(key):
            details[tag] = str(metadata[key])
    for tag, key in ((0x829A, "shutter_speed"), (0x829D, "aperture"), (0x920A, "focal_length")):
        value = _exif_rational(metadata.get(key))
        if value:
            details[tag] = value
    if isinstance(metadata.get("iso"), (int, float)):
        details[0x8827] = int(metadata["iso"])
    if _is_adobe_rgb(metadata):
        details[0xA001] = 0xFFFF
    latitude, longitude = _exif_rational(metadata.get("gps_latitude")), _exif_rational(metadata.get("gps_longitude"))
    if latitude is not None and longitude is not None:
        gps = exif.get_ifd(0x8825)

        def dms(value: float) -> tuple[float, float, float]:
            value = abs(value)
            degrees = int(value)
            minutes = int((value - degrees) * 60)
            return (float(degrees), float(minutes), round((value - degrees - minutes / 60) * 3600, 4))

        gps[1], gps[2] = ("N" if latitude >= 0 else "S"), dms(latitude)
        gps[3], gps[4] = ("E" if longitude >= 0 else "W"), dms(longitude)
    try:
        return exif.tobytes()
    except Exception:
        fallback = Image.Exif()
        if orientation and orientation != 1:
            fallback[_ORIENTATION_TAG] = orientation
        return fallback.tobytes()


class BlackRenderError(ValueError):
    pass


def _reject_black(path: Path) -> None:
    """sips returns success and an all-black image for some RAWs it can't
    really decode (Lightroom's Enhanced-NR DNGs): treat that as failure."""
    with Image.open(path) as image:
        image.draft("L", (64, 64))
        if not any(image.convert("L").resize((32, 32)).histogram()[8:]):
            raise BlackRenderError(f"{path.name}: Image I/O rendered it black")


# JPEG's own limit: a "preview" this large is the image at full size.
_JPEG_MAX_EDGE = 65535


def transcode_to_jpeg(source: Path, target: Path) -> None:
    """The full-size JPEG Electron shows in place of an original the renderer
    can't decode: HEIC/HEIF where there is no sips (Windows). Same handling as
    previews (orientation tag, ICC profile, transparency), and written beside
    the target then renamed in, so a concurrent reader never sees half a file."""
    partial = target.with_name(f".{target.name}.{os.getpid()}.partial")
    try:
        render_pillow_preview(source, partial, _JPEG_MAX_EDGE)
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)


@dataclass(slots=True)
class PreviewResult:
    asset_id: str
    kind: str
    relative_path: str
    width: int | None
    height: int | None
    status: str


class PreviewService:
    def __init__(self, catalog: CatalogPaths) -> None:
        self.catalog = catalog

    def output_path(self, asset_id: str, kind: str) -> Path:
        directory = self.catalog.previews_dir if kind == "preview" else self.catalog.previews_hd_dir
        shard = asset_id[:2]
        target_dir = directory / shard
        target_dir.mkdir(parents=True, exist_ok=True)
        return target_dir / f"{asset_id}.jpg"

    def relative_output_path(self, path: Path) -> str:
        return str(path.relative_to(self.catalog.root))

    def _atomic(self, output_path: Path, render, validate=None) -> Path:
        """Render into a temp file in the same directory, then atomically replace
        the final path. Concurrent renders of the same asset — the editor's
        quick-register (resident process) and the watched-import batch (a
        separate detached job process) can overlap — otherwise both wrote the
        final JPEG IN PLACE and corrupted/truncated each other. With temp+replace
        each writes its own temp and the last os.replace wins, so the preview file
        is never observed half-written or interleaved.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(output_path.parent), prefix=f".{output_path.stem}.", suffix=".tmp.jpg")
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            render(tmp)
            if validate is not None:
                validate()
            os.replace(tmp, output_path)  # atomic within the same filesystem
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        return output_path

    def _preview_on_disk(self, asset_id: str, kind: str) -> bool:
        """A previously-'ready' preview is only usable if its file is still on
        disk and non-empty. Guards against a preview left missing or truncated so
        the batch re-renders it instead of trusting a stale DB status — with
        atomic writes this lets broken previews self-heal on the next pass."""
        directory = self.catalog.previews_dir if kind == "preview" else self.catalog.previews_hd_dir
        path = directory / asset_id[:2] / f"{asset_id}.jpg"
        try:
            return path.exists() and path.stat().st_size > 0
        except OSError:
            return False

    def generate_for_row(self, row, kind: str, force: bool = False) -> PreviewResult:
        if kind not in KIND_SIZES:
            raise ValueError(f"unsupported preview kind: {kind}")

        source_path = Path(row["canonical_path"])
        output_path = self.output_path(row["asset_id"], kind)
        if output_path.exists() and not force:
            width = row["width"] if "width" in row.keys() else None
            height = row["height"] if "height" in row.keys() else None
            return PreviewResult(
                asset_id=row["asset_id"],
                kind=kind,
                relative_path=self.relative_output_path(output_path),
                width=width,
                height=height,
                status="ready",
            )

        source_marker = validate_source_ready(source_path)

        def validate() -> None:
            validate_source_unchanged(source_path, source_marker)

        if video.is_video(source_path):
            # Videos: a poster frame via the AVFoundation helper (sips can't do
            # video); fall back to QuickLook if the tool is unavailable.
            def _poster(tmp: Path) -> None:
                if not video.poster(source_path, tmp, max_edge=KIND_SIZES[kind]):
                    raise RuntimeError("video poster unavailable")
            try:
                rendered = self._atomic(output_path, _poster, validate=validate)
            except SourceNotReadyError:
                raise
            except Exception:
                rendered = self._render_with_quicklook(
                    source_path, output_path, KIND_SIZES[kind], validate=validate
                )
        elif source_path.suffix.lower() in DEFAULT_RAW_EXTENSIONS:
            rendered = self._render_raw(source_path, output_path, kind, _row_metadata(row), validate=validate)
        else:
            rendered = self._render_image(
                source_path, output_path, KIND_SIZES[kind], validate=validate
            )

        return PreviewResult(
            asset_id=row["asset_id"],
            kind=kind,
            relative_path=self.relative_output_path(rendered),
            width=row["width"] if "width" in row.keys() else None,
            height=row["height"] if "height" in row.keys() else None,
            status="ready",
        )

    def generate_batch(
        self,
        connection,
        kind: str,
        asset_type: str | None = None,
        limit: int | None = None,
        force: bool = False,
        progress_callback=None,
        paths: list[Path] | None = None,
        force_paths: list[Path] | None = None,
        analyze_colors: bool = True,
    ) -> dict[str, int]:
        rows = list_assets_for_preview(connection, asset_type=asset_type, kind=kind, limit=limit, paths=paths)
        forced = {str(path.resolve()) for path in (force_paths or [])}
        generated = 0
        skipped = 0
        failed = 0
        deferred = 0
        processed = 0
        total = len(rows)
        batch_size = 50
        report_progress(progress_callback, phase="generate_previews", processed=0, total=total, generated=0, skipped=0, failed=0, deferred=0)

        # Split rows into skip vs work
        to_render = []
        for row in rows:
            row_force = force or str(Path(row["canonical_path"]).resolve()) in forced
            if row["existing_relative_path"] and row["existing_status"] == "ready" and not row_force and self._preview_on_disk(row["asset_id"], kind):
                # A preview from before colours existed: read its colours now.
                if analyze_colors and kind == "preview" and row["asset_type"] == "image" and not row["has_colors"]:
                    analyze_asset_colors(connection, row["asset_id"], self.catalog.root / row["existing_relative_path"])
                skipped += 1
                processed += 1
                report_progress(
                    progress_callback,
                    phase="generate_previews",
                    processed=processed,
                    total=total,
                    generated=generated,
                    skipped=skipped,
                    failed=failed,
                    deferred=deferred,
                )
            else:
                to_render.append((row, row_force))

        # Parallel render. All futures are submitted upfront, so if the
        # progress callback raises (cooperative job cancellation) we cancel the
        # queued futures before unwinding — otherwise the executor's exit
        # handler would block until every queued render finished anyway.
        with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
            futures = {
                pool.submit(self.generate_for_row, row, kind=kind, force=row_force): row
                for row, row_force in to_render
            }
            try:
                for future in as_completed(futures):
                    row = futures[future]
                    try:
                        result = future.result()
                        upsert_preview_entry(
                            connection,
                            asset_id=result.asset_id,
                            kind=result.kind,
                            relative_path=result.relative_path,
                            width=result.width,
                            height=result.height,
                            status=result.status,
                            commit=False,
                        )
                        # The thumbnail is the colour sample too: same file,
                        # already decoded once, a few ms more.
                        if analyze_colors and kind == "preview" and row["asset_type"] == "image":
                            analyze_asset_colors(connection, result.asset_id, self.catalog.root / result.relative_path)
                        generated += 1
                    except SourceNotReadyError:
                        # Keep an existing good preview/DB entry. A later watcher
                        # change event retries after the editor finishes writing.
                        deferred += 1
                    except Exception:
                        upsert_preview_entry(
                            connection,
                            asset_id=row["asset_id"],
                            kind=kind,
                            relative_path="",
                            width=None,
                            height=None,
                            status="failed",
                            commit=False,
                        )
                        failed += 1
                    processed += 1
                    if processed % batch_size == 0:
                        connection.commit()
                    report_progress(
                        progress_callback,
                        phase="generate_previews",
                        processed=processed,
                        total=total,
                        generated=generated,
                        skipped=skipped,
                        failed=failed,
                        deferred=deferred,
                    )
            except BaseException:
                pool.shutdown(wait=False, cancel_futures=True)
                connection.commit()  # keep previews finished before the cancel
                raise
        connection.commit()
        return {"generated": generated, "skipped": skipped, "failed": failed, "deferred": deferred, "total": total}

    def _render_image(self, source_path: Path, output_path: Path, size: int, validate=None) -> Path:
        """Processed images (JPEG, PNG, HEIC, TIFF, WebP, AVIF) render with
        Pillow on every platform; Windows has no sips. A file Pillow can't
        read falls back to sips where it exists (macOS's Image I/O reads a
        few formats Pillow doesn't), so nothing that rendered before fails."""
        try:
            return self._render_with_pillow(source_path, output_path, size, validate=validate)
        except SourceNotReadyError:
            raise
        except Exception:
            if shutil.which("sips") is None:
                raise
            return self._render_with_sips(source_path, output_path, size, validate=validate)

    def _render_with_pillow(self, source_path: Path, output_path: Path, size: int, validate=None) -> Path:
        return self._atomic(output_path, lambda tmp: render_pillow_preview(source_path, tmp, size), validate=validate)

    def _render_with_sips(self, source_path: Path, output_path: Path, size: int, validate=None) -> Path:
        return self._atomic(output_path, lambda tmp: subprocess.run(
            ["sips", "-s", "format", "jpeg", "-Z", str(size), "--out", str(tmp), str(source_path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=_IMAGE_IO_TIMEOUT_SECONDS,
        ), validate=validate)

    def _render_with_quicklook(self, source_path: Path, output_path: Path, size: int, validate=None) -> Path:
        with tempfile.TemporaryDirectory(prefix="media-workspace-ql-") as temp_dir:
            # QuickLook can hang on files it can't read (Phase One IIQ).
            subprocess.run(
                ["qlmanage", "-t", "-s", str(size), "-o", temp_dir, str(source_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=_IMAGE_IO_TIMEOUT_SECONDS,
            )
            generated = Path(temp_dir) / f"{source_path.name}.png"
            if not generated.exists():
                raise FileNotFoundError(f"Quick Look did not render {source_path}")
            _reject_black(generated)
            return self._atomic(output_path, lambda tmp: subprocess.run(
                ["sips", "-s", "format", "jpeg", "--out", str(tmp), str(generated)],
                check=True,
                capture_output=True,
                text=True,
            ), validate=validate)

    def _render_raw(self, source_path: Path, output_path: Path, kind: str, metadata: dict, validate=None) -> Path:
        """RAW has no displayable original (the renderer can't decode .cr3/.arw),
        so its preview IS the ceiling. In order:

        1. the JPEG the camera embedded, through LibRaw, when it is big enough
           for the tier: most cameras embed it at full size, so the lightbox
           still zooms to real detail, at a few hundred ms and no demosaic;
        2. on macOS, Image I/O: Quick Look for the thumbnail, sips at full
           size for HD (Quick Look when sips comes out black), with timeouts;
        3. a LibRaw decode in a child process (the only decoder on Windows,
           and the one for files Image I/O can't open, such as IIQ);
        4. whatever the camera embedded, whatever its size.

        The camera's colour space (Adobe RGB) and, for the HD tier, its EXIF
        come from the metadata already in the catalog."""
        hd = kind == "preview-hd"
        size = _JPEG_MAX_EDGE if hd else KIND_SIZES[kind]
        icc = adobe_rgb_icc() if _is_adobe_rgb(metadata) else None
        embedded = raw_decode.embedded_preview(source_path)

        def from_embedded(tmp: Path) -> None:
            assert embedded is not None
            exif = _exif_from_metadata(metadata, embedded.orientation) if hd else None
            render_pillow_preview(BytesIO(embedded.data), tmp, size, orientation=embedded.orientation, icc_profile=icc, exif=exif)

        if embedded and max(embedded.width, embedded.height) >= _RAW_EMBEDDED_MIN_EDGE[kind]:
            return self._atomic(output_path, from_embedded, validate=validate)
        if shutil.which("sips") is not None:
            try:
                if not hd:
                    return self._render_with_quicklook(source_path, output_path, KIND_SIZES[kind], validate=validate)
                try:
                    return self._render_raw_fullres(source_path, output_path, validate=validate)
                except BlackRenderError:
                    # Quick Look renders what sips turns black; only then, as
                    # it hangs on what sips can't open at all (IIQ).
                    return self._render_with_quicklook(source_path, output_path, _RAW_DECODE_HD_EDGE, validate=validate)
            except SourceNotReadyError:
                raise
            except Exception:
                pass  # failed, hung or came out black: LibRaw next
        if raw_decode.available():
            try:
                decode_edge = _RAW_DECODE_HD_EDGE if hd else KIND_SIZES[kind]
                return self._atomic(output_path, lambda tmp: raw_decode.decode_in_child(source_path, tmp, decode_edge), validate=validate)
            except SourceNotReadyError:
                raise
            except Exception:
                pass
        if embedded:
            return self._atomic(output_path, from_embedded, validate=validate)
        raise ValueError(f"no preview for {source_path.name}: nothing embedded and no decoder could read it")

    def _render_raw_fullres(self, source_path: Path, output_path: Path, validate=None) -> Path:
        # Full native-resolution JPEG straight from the RAW (Image I/O decodes
        # CR2/CR3/ARW/NEF/DNG). No --resampleHeightWidthMax, so the long edge is
        # the sensor's native size — the displayable stand-in for the RAW.
        def render(tmp: Path) -> None:
            subprocess.run(
                ["sips", "-s", "format", "jpeg", "--out", str(tmp), str(source_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=_IMAGE_IO_TIMEOUT_SECONDS,
            )
            _reject_black(tmp)

        return self._atomic(output_path, render, validate=validate)


def report_progress(progress_callback, **payload) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
