"""Video support — extension set + a thin wrapper over the `video-tool` binary.

The compiled AVFoundation helper (apps/desktop/native/bin/video-tool) is bundled
with the Electron app; its path reaches the sidecar via the VIDEO_TOOL_PATH env
var. We shell out for metadata probe, poster frame, and multi-frame extraction.
Where there is no such helper (Windows), the same answers come from the
bundled FFmpeg (ffmpeg_video). Every call degrades gracefully (returns
None/[]/False) when neither is there or it fails, so the import pipeline never
hard-crashes on video.
"""
from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from . import ffmpeg_video
from .processes import no_window

T = TypeVar("T")

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTENSIONS


def tool_path() -> str | None:
    candidate = os.environ.get("VIDEO_TOOL_PATH")
    if candidate and Path(candidate).exists():
        return candidate
    return None


def _through_ffmpeg(call: Callable[[], T], failed: T) -> T:
    """call() with FFmpeg when there is one, else `failed`, which a failure
    gives too: as the video-tool calls below."""
    if ffmpeg_video.find_tools() is None:
        return failed
    try:
        return call()
    except (ffmpeg_video.VideoToolError, OSError, ValueError):
        return failed


def probe(path: Path) -> dict | None:
    """Return {duration,width,height,fps,codec,hasAudio,creationDate} or None."""
    tool = tool_path()
    if not tool:
        return _through_ffmpeg(lambda: ffmpeg_video.probe(path), None)
    try:
        result = subprocess.run(
            [tool, "probe", str(path)],
            capture_output=True, text=True, encoding="utf-8", timeout=30, **no_window(),
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def poster(path: Path, out_path: Path, max_edge: int = 1024) -> bool:
    tool = tool_path()
    if not tool:
        def ffmpeg_poster() -> bool:
            ffmpeg_video.poster(path, out_path, max_edge=max_edge)
            return out_path.exists()
        return _through_ffmpeg(ffmpeg_poster, False)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [tool, "poster", str(path), str(out_path), "--max-edge", str(max_edge)],
            capture_output=True, text=True, encoding="utf-8", timeout=60, **no_window(),
        )
        return result.returncode == 0 and out_path.exists()
    except (subprocess.SubprocessError, OSError):
        return False


def frames(path: Path, out_dir: Path, *, interval: float | None = None, max_edge: int = 512) -> list[dict]:
    """Extract sample frames; returns the manifest 'frames' list (index,time,filename)."""
    tool = tool_path()
    if not tool:
        return _through_ffmpeg(
            lambda: ffmpeg_video.frames(path, out_dir, interval=interval, max_edge=max_edge)["frames"], []
        )
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [tool, "frames", str(path), str(out_dir), "--max-edge", str(max_edge)]
        if interval and interval > 0:
            cmd += ["--interval", str(interval)]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120, **no_window())
        if result.returncode != 0:
            return []
        return json.loads(result.stdout).get("frames", [])
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return []
