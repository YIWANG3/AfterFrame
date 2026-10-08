"""Video through FFmpeg, where there is no AVFoundation helper (Windows).

It answers as apps/desktop/native/video-tool.swift does on macOS, so the
import, the AI annotator and Electron (through the `video-tool` subcommand)
don't care which one ran:

- probe: {duration, width, height, fps, codec, hasAudio, creationDate}, the
  size as shown (rotation applied) and the date in UTC;
- poster: a JPEG of the frame at min(1 s, half the clip), its long edge at
  most `max_edge` (never enlarged);
- frames: JPEGs at the times sample_times() picks, and a manifest.json;
- transcode: an H.264 MP4 within 1920×1080 for playback. Chromium on Windows
  can't decode HEVC, the iPhone's default, without the HEVC Video Extensions:
  it plays such a clip black.

HDR clips (HLG, PQ) are tone-mapped to SDR, as AVFoundation does for them.

The FFmpeg is the LGPL build the app ships in Resources/native/ffmpeg
(apps/desktop/scripts/fetch-ffmpeg.mjs puts it there); Electron passes that
folder as FFMPEG_PATH. A developer's ffmpeg on PATH works too.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from functools import cache
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from .processes import end_with_this_process, no_window

POSTER_EDGE = 1024
FRAMES_EDGE = 512
PROBE_TIMEOUT_SECONDS = 30
FRAME_TIMEOUT_SECONDS = 60
# Media Foundation's H.264 encoder comes with Windows, its licence included,
# and uses the graphics card's where there is one. OpenH264 is in the bundled
# build for Windows N, which comes without Media Foundation. libx264 is only
# in a developer's own (GPL) ffmpeg.
H264_ENCODERS = ("h264_mf", "libopenh264", "libx264")
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
# HDR to SDR, the usual zimg chain: to linear light, BT.709 primaries,
# Hable's curve, back to BT.709.
TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)
# Within 1920×1080 the way the clip is shown (1080×1920 for a portrait one),
# never enlarged, with even sides for 4:2:0.
PROXY_SCALE = (
    "scale=w='if(gt(ih,iw),min(iw,1080),min(iw,1920))':h='if(gt(ih,iw),min(ih,1920),min(ih,1080))'"
    ":force_original_aspect_ratio=decrease:force_divisible_by=2"
)


class VideoToolError(RuntimeError):
    pass


def find_tools() -> tuple[str, str] | None:
    """(ffmpeg, ffprobe), or None when there is no FFmpeg."""
    suffix = ".exe" if sys.platform == "win32" else ""
    folder = os.environ.get("FFMPEG_PATH")
    if folder:
        ffmpeg, ffprobe = Path(folder) / f"ffmpeg{suffix}", Path(folder) / f"ffprobe{suffix}"
        if ffmpeg.is_file() and ffprobe.is_file():
            return str(ffmpeg), str(ffprobe)
    on_path = shutil.which("ffmpeg"), shutil.which("ffprobe")
    return (on_path[0], on_path[1]) if on_path[0] and on_path[1] else None


def _tools() -> tuple[str, str]:
    tools = find_tools()
    if tools is None:
        raise VideoToolError("FFmpeg isn't available")
    return tools


def _run(command: Sequence[str], timeout: float | None) -> bytes:
    """stdout of `command`, which ends with the sidecar if the sidecar is
    killed (a timeout in Electron) instead of encoding on for nobody."""
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **no_window(),
    )
    end_with_this_process(process)
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise VideoToolError(f"{Path(command[0]).stem} took over {timeout:.0f} s") from None
    if process.returncode != 0:
        lines = err.decode("utf-8", "replace").strip().splitlines()
        raise VideoToolError(lines[-1] if lines else f"{Path(command[0]).stem} exited with {process.returncode}")
    return out


def _probe_json(ffprobe: str, path: Path) -> dict[str, Any]:
    out = _run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        PROBE_TIMEOUT_SECONDS,
    )
    try:
        info = json.loads(out.decode("utf-8", "replace"))
    except ValueError as error:
        raise VideoToolError(f"ffprobe's answer for {path.name} isn't JSON") from error
    return info if isinstance(info, dict) else {}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _ratio(value: Any) -> float | None:
    """ "30000/1001" or "8:9" as a number; None for "0/0" and the like."""
    text = str(value or "")
    for separator in ("/", ":"):
        if separator in text:
            top, bottom = (_number(part) for part in text.split(separator, 1))
            return top / bottom if top and bottom else None
    return _number(text) or None


def _video_stream(info: dict[str, Any]) -> dict[str, Any]:
    for stream in info.get("streams") or []:
        # A cover image inside the file is a "video" stream too.
        if stream.get("codec_type") == "video" and not (stream.get("disposition") or {}).get("attached_pic"):
            return stream
    raise VideoToolError("no video track")


def _rotation(stream: dict[str, Any]) -> float:
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            return _number(side["rotation"]) or 0.0
    return _number((stream.get("tags") or {}).get("rotate")) or 0.0


def _creation_date(info: dict[str, Any], stream: dict[str, Any]) -> str | None:
    """When the clip was shot, in UTC, as AVFoundation's creationDate gives it:
    Apple's QuickTime key (local time with its offset) first, then the
    container's creation time. A zero time (1904, 1970) is no date."""
    tags = {**(stream.get("tags") or {}), **((info.get("format") or {}).get("tags") or {})}
    lowered = {str(key).lower(): value for key, value in tags.items()}
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        text = str(lowered.get(key) or "").strip()
        if not text:
            continue
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=UTC)
        if moment.year >= 1980:
            return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def describe(info: dict[str, Any]) -> dict[str, Any]:
    """ffprobe's JSON as video-tool's probe answer."""
    stream = _video_stream(info)
    width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
    pixel_aspect = _ratio(stream.get("sample_aspect_ratio"))
    if pixel_aspect and pixel_aspect != 1:
        width = round(width * pixel_aspect)
    if abs(_rotation(stream)) % 180 == 90:
        width, height = height, width
    duration = _number((info.get("format") or {}).get("duration")) or _number(stream.get("duration")) or 0.0
    tag = str(stream.get("codec_tag_string") or "").strip()
    # The four-character code as AVFoundation names it (hvc1, avc1, apcn);
    # ffprobe writes "[0][0][0][0]" for a container without one (MKV).
    codec = tag if tag and tag.isprintable() and not tag.startswith("[") else str(stream.get("codec_name") or "")
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "fps": _ratio(stream.get("avg_frame_rate")) or _ratio(stream.get("r_frame_rate")) or 0.0,
        "codec": codec,
        "hasAudio": any(s.get("codec_type") == "audio" for s in info.get("streams") or []),
        "creationDate": _creation_date(info, stream),
    }


def _is_hdr(info: dict[str, Any]) -> bool:
    return _video_stream(info).get("color_transfer") in HDR_TRANSFERS


def sample_times(duration: float, interval: float | None = None, count: int | None = None, max_frames: int = 20) -> list[float]:
    """The times video-tool's sampleTimes picks: `count` evenly spaced (3 when
    not given), or one every `interval` seconds plus the first, middle and
    last; none within 0.25 s of another, and at most `max_frames`."""
    eps = min(0.1, duration * 0.02)
    last = max(0.0, duration - eps)

    def inset(t: float) -> float:
        return min(max(t, 0.0), last)

    if interval and interval > 0:
        grid: list[float] = []
        t = 0.0
        while t < duration:
            grid.append(inset(t))
            t += interval
        times = [eps, duration / 2.0, last, *grid]
    else:
        n = max(3, count or 3)
        times = [inset(duration * i / (n - 1)) for i in range(n)]
    picked: list[float] = []
    for t in sorted(times):
        if picked and abs(picked[-1] - t) < 0.25:
            continue
        picked.append(t)
    if len(picked) > max_frames >= 2:
        step = (len(picked) - 1) / (max_frames - 1)
        picked = [picked[math.floor(i * step + 0.5)] for i in range(max_frames)]  # Swift's .rounded()
    return picked


def _frame(ffmpeg: str, path: Path, seconds: float, target: Path, max_edge: int, hdr: bool) -> None:
    """The frame at `seconds` (rotation applied) as a JPEG, as video-tool
    writes them: long edge at most `max_edge`, quality 85."""
    chain = [TONEMAP] if hdr else []
    if max_edge > 0:
        chain.append(
            f"scale=w='if(gte(iw,ih),min(iw,{max_edge}),-1)':h='if(gte(iw,ih),-1,min(ih,{max_edge}))':flags=lanczos"
        )
    command = [ffmpeg, "-v", "error", "-nostdin", "-ss", f"{seconds:.3f}", "-i", str(path), "-frames:v", "1", "-an", "-sn", "-dn"]
    if chain:
        command += ["-vf", ",".join(chain)]
    data = _run([*command, "-f", "image2pipe", "-c:v", "bmp", "-"], FRAME_TIMEOUT_SECONDS)
    if not data:
        raise VideoToolError(f"no frame at {seconds:.2f} s")
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(BytesIO(data)) as image:
        image.convert("RGB").save(target, "JPEG", quality=85)


def probe(path: Path) -> dict[str, Any]:
    _ffmpeg, ffprobe = _tools()
    return describe(_probe_json(ffprobe, path))


def poster(path: Path, target: Path, max_edge: int = POSTER_EDGE) -> None:
    ffmpeg, ffprobe = _tools()
    info = _probe_json(ffprobe, path)
    duration = describe(info)["duration"]
    seconds = min(1.0, duration / 2.0) if duration > 0 else 0.0
    _frame(ffmpeg, path, seconds, target, max_edge, _is_hdr(info))


def frames(
    path: Path,
    out_dir: Path,
    *,
    interval: float | None = None,
    count: int | None = None,
    max_frames: int = 20,
    max_edge: int = FRAMES_EDGE,
) -> dict[str, Any]:
    """Frames across the clip in `out_dir` (frame_0.jpg, …) and the manifest
    that goes with them, which it also returns. A frame that can't be read
    is left out; its index isn't reused."""
    ffmpeg, ffprobe = _tools()
    info = _probe_json(ffprobe, path)
    duration = describe(info)["duration"]
    if not duration > 0:
        raise VideoToolError("invalid duration")
    hdr = _is_hdr(info)
    out_dir.mkdir(parents=True, exist_ok=True)
    listed = []
    for index, seconds in enumerate(sample_times(duration, interval, count, max_frames)):
        name = f"frame_{index}.jpg"
        try:
            _frame(ffmpeg, path, seconds, out_dir / name, max_edge, hdr)
        except VideoToolError as error:
            print(f"frame {index} @{seconds:.2f}s failed: {error}", file=sys.stderr)
            continue
        listed.append({"index": index, "time": seconds, "filename": name})
    manifest = {"duration": duration, "count": len(listed), "frames": listed}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


@cache
def _h264_encoders(ffmpeg: str) -> tuple[str, ...]:
    listed = _run([ffmpeg, "-hide_banner", "-encoders"], PROBE_TIMEOUT_SECONDS).decode("utf-8", "replace")
    names = {line.split()[1] for line in listed.splitlines() if len(line.split()) > 1}
    return tuple(encoder for encoder in H264_ENCODERS if encoder in names)


def transcode(path: Path, target: Path, timeout: float | None = None) -> None:
    """An H.264 MP4 of `path` that Chromium plays, within 1920×1080, with the
    first audio track as AAC. Written beside `target`, then renamed in."""
    ffmpeg, ffprobe = _tools()
    info = _probe_json(ffprobe, path)
    _video_stream(info)  # a file with no picture has no proxy
    chain = ",".join([*([TONEMAP] if _is_hdr(info) else []), PROXY_SCALE, "format=yuv420p"])
    audio = next((s for s in info.get("streams") or [] if s.get("codec_type") == "audio"), None)
    audio_args = ["-c:a", "copy"] if audio and audio.get("codec_name") == "aac" else ["-c:a", "aac", "-b:a", "160k"]
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.stem}.{os.getpid()}.partial{target.suffix}")
    failure: VideoToolError | None = None
    for encoder in _h264_encoders(ffmpeg):
        # An audio track FFmpeg can't decode (Apple's spatial audio) still
        # leaves a picture to play.
        for audio_part in (["-map", "0:a:0?", *audio_args], ["-an"]):
            try:
                _run(
                    [ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(path), "-map", "0:v:0", *audio_part,
                     "-vf", chain, "-c:v", encoder, "-b:v", "8M", "-movflags", "+faststart", str(partial)],
                    timeout,
                )
            except VideoToolError as error:
                failure = error
                partial.unlink(missing_ok=True)
                continue
            os.replace(partial, target)
            return
    raise failure or VideoToolError("this FFmpeg has no H.264 encoder")
