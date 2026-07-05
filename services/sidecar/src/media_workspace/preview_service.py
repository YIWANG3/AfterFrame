from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from . import video
from .catalog import CatalogPaths
from .config import DEFAULT_RAW_EXTENSIONS
from .db import list_assets_for_preview, upsert_preview_entry

_MAX_WORKERS = max((os.cpu_count() or 4) // 2, 2)

KIND_SIZES = {
    "preview": 512,
    "preview-hd": 2000,
}


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

    def _atomic(self, output_path: Path, render) -> Path:
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

        if video.is_video(source_path):
            # Videos: a poster frame via the AVFoundation helper (sips can't do
            # video); fall back to QuickLook if the tool is unavailable.
            def _poster(tmp: Path) -> None:
                if not video.poster(source_path, tmp, max_edge=KIND_SIZES[kind]):
                    raise RuntimeError("video poster unavailable")
            try:
                rendered = self._atomic(output_path, _poster)
            except Exception:
                rendered = self._render_with_quicklook(source_path, output_path, KIND_SIZES[kind])
        elif source_path.suffix.lower() in DEFAULT_RAW_EXTENSIONS:
            # RAW has no displayable original (the renderer can't decode .cr3/.arw),
            # so its preview IS the ceiling. The HD tier is rendered at full native
            # resolution via sips (Image I/O demosaic) so the lightbox can show real
            # detail / focus; the thumbnail tier stays a small QuickLook render.
            if kind == "preview-hd":
                rendered = self._render_raw_fullres(source_path, output_path)
            else:
                rendered = self._render_with_quicklook(source_path, output_path, KIND_SIZES[kind])
        else:
            rendered = self._render_with_sips(source_path, output_path, KIND_SIZES[kind])

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
    ) -> dict[str, int]:
        rows = list_assets_for_preview(connection, asset_type=asset_type, kind=kind, limit=limit, paths=paths)
        generated = 0
        skipped = 0
        failed = 0
        processed = 0
        total = len(rows)
        batch_size = 50
        report_progress(progress_callback, phase="generate_previews", processed=0, total=total, generated=0, skipped=0, failed=0)

        # Split rows into skip vs work
        to_render = []
        for row in rows:
            if row["existing_relative_path"] and row["existing_status"] == "ready" and not force and self._preview_on_disk(row["asset_id"], kind):
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
                )
            else:
                to_render.append(row)

        # Parallel render. All futures are submitted upfront, so if the
        # progress callback raises (cooperative job cancellation) we cancel the
        # queued futures before unwinding — otherwise the executor's exit
        # handler would block until every queued render finished anyway.
        with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
            futures = {
                pool.submit(self.generate_for_row, row, kind=kind, force=force): row
                for row in to_render
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
                        generated += 1
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
                    )
            except BaseException:
                pool.shutdown(wait=False, cancel_futures=True)
                connection.commit()  # keep previews finished before the cancel
                raise
        connection.commit()
        return {"generated": generated, "skipped": skipped, "failed": failed, "total": total}

    def _render_with_sips(self, source_path: Path, output_path: Path, size: int) -> Path:
        return self._atomic(output_path, lambda tmp: subprocess.run(
            ["sips", "-s", "format", "jpeg", "-Z", str(size), "--out", str(tmp), str(source_path)],
            check=True,
            capture_output=True,
            text=True,
        ))

    def _render_with_quicklook(self, source_path: Path, output_path: Path, size: int) -> Path:
        with tempfile.TemporaryDirectory(prefix="media-workspace-ql-") as temp_dir:
            subprocess.run(
                ["qlmanage", "-t", "-s", str(size), "-o", temp_dir, str(source_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            generated = Path(temp_dir) / f"{source_path.name}.png"
            if not generated.exists():
                raise FileNotFoundError(f"Quick Look did not render {source_path}")
            return self._atomic(output_path, lambda tmp: subprocess.run(
                ["sips", "-s", "format", "jpeg", "--out", str(tmp), str(generated)],
                check=True,
                capture_output=True,
                text=True,
            ))

    def _render_raw_fullres(self, source_path: Path, output_path: Path) -> Path:
        # Full native-resolution JPEG straight from the RAW (Image I/O decodes
        # CR2/CR3/ARW/NEF/DNG). No --resampleHeightWidthMax, so the long edge is
        # the sensor's native size — the displayable stand-in for the RAW.
        return self._atomic(output_path, lambda tmp: subprocess.run(
            ["sips", "-s", "format", "jpeg", "--out", str(tmp), str(source_path)],
            check=True,
            capture_output=True,
            text=True,
        ))


def report_progress(progress_callback, **payload) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
