"""Video support — extension set + a thin wrapper over the `video-tool` binary.

The compiled AVFoundation helper (apps/desktop/native/bin/video-tool) is bundled
with the Electron app; its path reaches the sidecar via the VIDEO_TOOL_PATH env
var. We shell out for metadata probe, poster frame, and multi-frame extraction —
no ffmpeg dependency. Every call degrades gracefully (returns None/[]/False) when
the tool is missing or fails, so the import pipeline never hard-crashes on video.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTENSIONS


def tool_path() -> str | None:
    candidate = os.environ.get("VIDEO_TOOL_PATH")
    if candidate and Path(candidate).exists():
        return candidate
    return None


def probe(path: Path) -> dict | None:
    """Return {duration,width,height,fps,codec,hasAudio,creationDate} or None."""
    tool = tool_path()
    if not tool:
        return None
    try:
        result = subprocess.run(
            [tool, "probe", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return None


def poster(path: Path, out_path: Path, max_edge: int = 1024) -> bool:
    tool = tool_path()
    if not tool:
        return False
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [tool, "poster", str(path), str(out_path), "--max-edge", str(max_edge)],
            capture_output=True, text=True, timeout=60,
        )
        return result.returncode == 0 and out_path.exists()
    except (subprocess.SubprocessError, OSError):
        return False


def frames(path: Path, out_dir: Path, *, interval: float | None = None, max_edge: int = 512) -> list[dict]:
    """Extract sample frames; returns the manifest 'frames' list (index,time,filename)."""
    tool = tool_path()
    if not tool:
        return []
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [tool, "frames", str(path), str(out_dir), "--max-edge", str(max_edge)]
        if interval and interval > 0:
            cmd += ["--interval", str(interval)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            return []
        return json.loads(result.stdout).get("frames", [])
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return []
