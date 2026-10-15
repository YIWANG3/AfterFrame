"""The one progress hook the long-running sidecar phases share.

scan_raw_directory, enrich_raw_assets, resolve_image_batch and
PreviewService.generate_batch each take a `progress_callback`; job_runner
turns every update into a jobs-table row. The payload is a flat dict of the
phase name plus whatever counters that phase keeps."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

ProgressCallback = Callable[[dict[str, Any]], None]


def report_progress(progress_callback: ProgressCallback | None, **payload: Any) -> None:
    if progress_callback is None:
        return
    progress_callback(payload)
