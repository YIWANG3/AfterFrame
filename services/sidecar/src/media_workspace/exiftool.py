"""Photo metadata through ExifTool, which reads every format the app imports
(CR3 and its CMT boxes, maker notes, HEIF, XMP) where the parsers it replaces
met a new corner with every camera.

ExifTool is a Perl program. It ships with the app in Resources/native/exiftool
(apps/desktop/scripts/fetch-exiftool.mjs puts it there): on Windows as the
official build with its own Perl, on macOS as the Perl code, run by the
system's /usr/bin/perl. Electron passes that folder as EXIFTOOL_PATH.

Each process is started once and kept (`-stay_open`): a read is then 10-60 ms
instead of 100-200 ms of Perl start-up. A small pool serves threads; a read
that hangs or fails restarts its process, and a process is renewed after a
few hundred files (one IIQ leaves it at 600 MB). A process exits by itself
when the sidecar is gone, killed or crashed (see _end_with_this_process).
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from .processes import no_window

# The tags metadata.py maps, with `#` for numbers instead of their printed
# form. Lens names stay printed: an old Nikon lens is only named by
# Composite:LensID's lookup.
TAGS = [
    "FileType",
    "DateTimeOriginal",
    "CreateDate",
    "ModifyDate",
    "DateCreated",
    "Make",
    "Model",
    "Software",
    "LensModel",
    "LensMake",
    "LensID",
    "Lens",
    "LensInfo#",
    "ISO#",
    "ExposureTime#",
    "FNumber#",
    "ApertureValue#",
    "FocalLength#",
    "Flash#",
    "WhiteBalance#",
    "ColorSpace#",
    "InteropIndex",
    "GPSLatitude#",
    "GPSLongitude#",
    "Rating#",
    "ImageSize#",
    "CleanAperture#",
]
_COMMON_ARGS = [
    "-json",
    "-G1",  # keys are "Group:Tag": the same tag in EXIF, a maker note and XMP
    "-a",
    "-m",
    # Stop at the image data: a CR3's metadata is 3.8 MB read, not 23. Not
    # -fast2, which drops maker notes (Nikon lens names, Canon colour space).
    "-fast",
    "-charset",
    "filename=utf8",  # Windows: non-ASCII paths
    "-api",
    "LargeFileSupport=1",
    *(f"-{tag}" for tag in TAGS),
]
REQUEST_TIMEOUT_SECONDS = 60
_FILES_PER_PROCESS = 400
POOL_SIZE = 2


def _bundled_dir() -> Path | None:
    configured = os.environ.get("EXIFTOOL_PATH")
    if configured:
        return Path(configured)
    if getattr(sys, "frozen", False):
        return None
    # Development: where fetch-exiftool.mjs puts it in the checkout.
    return Path(__file__).resolve().parents[4] / "apps" / "desktop" / "native" / "exiftool"


def find_command() -> list[str] | None:
    """How to run ExifTool here, or None when it isn't available."""
    folder = _bundled_dir()
    if folder is not None:
        if (folder / "exiftool.exe").is_file():
            return [str(folder / "exiftool.exe")]
        script = folder / "exiftool"
        perl = "/usr/bin/perl" if sys.platform == "darwin" else shutil.which("perl")
        if script.is_file() and perl and Path(perl).exists():
            return [perl, str(script)]
    installed = shutil.which("exiftool")
    return [installed] if installed else None


class ExifToolError(RuntimeError):
    pass


# At the end of its input a -stay_open ExifTool keeps polling for more, so one
# whose sidecar was killed or crashed would run for good. On macOS and Linux
# a config watches for the sidecar (Perl's alarm doesn't fire there on
# Windows); on Windows the process is put in a job that ends with the sidecar.
_WATCHDOG = Path(__file__).with_name("data") / "exiftool_watchdog.config"
_job = None


def _end_with_this_process(process: subprocess.Popen) -> None:
    """Windows: put `process` in a job that the system closes, killing what is
    in it, when this process ends, however it ends. ExifTool for Windows runs
    Perl inside its own process, so there is no child to miss."""
    global _job
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class _Basic(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _Extended(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _Basic),
            ("IoInfo", ctypes.c_uint64 * 6),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    if _job is None:
        job = kernel32.CreateJobObjectW(None, None)
        limits = _Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not job or not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            return  # JobObjectExtendedLimitInformation; without it, no watchdog
        _job = job
    kernel32.AssignProcessToJobObject(_job, int(process._handle))  # type: ignore[attr-defined,unused-ignore]


class _Process:
    def __init__(self, command: list[str]) -> None:
        # -config has to come first.
        watchdog = ["-config", str(_WATCHDOG)] if sys.platform != "win32" else []
        try:
            self._process = subprocess.Popen(
                [*command, *watchdog, "-stay_open", "True", "-@", "-", "-common_args", *_COMMON_ARGS],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env={
                    **os.environ,
                    # CR3 and QuickTime dates are UTC that ExifTool shows in
                    # local time; the same answer on every machine.
                    "TZ": "UTC",
                    "AFTERFRAME_EXIFTOOL_PARENT": str(os.getpid()),
                },
                **no_window(),
            )
        except OSError as error:
            raise ExifToolError(f"ExifTool can't start: {error}") from error
        _end_with_this_process(self._process)
        self._lines: queue.Queue[bytes | None] = queue.Queue()
        self._sequence = 0
        self.files = 0
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        assert self._process.stdout is not None
        for line in iter(self._process.stdout.readline, b""):
            self._lines.put(line)
        self._process.stdout.close()
        self._lines.put(None)

    def read(self, path: Path, timeout: float) -> list[dict[str, Any]]:
        assert self._process.stdin is not None
        self._sequence += 1
        ready = f"{{ready{self._sequence}}}".encode()
        try:
            self._process.stdin.write(f"{path}\n-execute{self._sequence}\n".encode())
            self._process.stdin.flush()
        except OSError as error:  # it exited
            raise ExifToolError(f"ExifTool isn't running: {error}") from error
        self.files += 1
        deadline = time.monotonic() + timeout
        output = []
        while True:
            try:
                line = self._lines.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                raise ExifToolError(f"ExifTool took over {timeout:.0f} s on {path.name}") from None
            if line is None:
                raise ExifToolError("ExifTool exited")
            if line.rstrip(b"\r\n") == ready:
                break
            output.append(line)
        text = b"".join(output).decode("utf-8", "replace").strip()
        try:
            return json.loads(text) if text else []  # nothing for a file it can't open
        except ValueError as error:
            raise ExifToolError(f"ExifTool's answer for {path.name} isn't JSON") from error

    def close(self) -> None:
        assert self._process.stdin is not None
        try:
            self._process.stdin.write(b"-stay_open\nFalse\n")
            self._process.stdin.close()
            self._process.wait(timeout=2)
        except Exception:
            self._process.kill()
            self._process.wait()
            with contextlib.suppress(OSError):
                self._process.stdin.close()


class ExifTool:
    """A few ExifTool processes shared by the threads that read metadata."""

    def __init__(self, command: list[str], size: int = POOL_SIZE) -> None:
        self._command = command
        self._idle: queue.LifoQueue[_Process | None] = queue.LifoQueue()
        for _ in range(size):
            self._idle.put(None)  # started on first use

    def read(self, path: Path, timeout: float = REQUEST_TIMEOUT_SECONDS) -> dict[str, Any]:
        """The file's tags as {"Group:Tag": value}; {} for a file ExifTool
        can't read. Raises ExifToolError when ExifTool itself fails."""
        if "\n" in str(path) or "\r" in str(path):  # one argument per line
            return {}
        process = self._idle.get()
        try:
            if process is None or process.files >= _FILES_PER_PROCESS:
                if process is not None:
                    process.close()
                process = _Process(self._command)
            records = process.read(path.resolve(), timeout)
        except Exception:
            if process is not None:
                process.close()
            process = None
            raise
        finally:
            self._idle.put(process)
        return records[0] if records else {}

    def close(self) -> None:
        while not self._idle.empty():
            process = self._idle.get()
            if process is not None:
                process.close()


_shared: ExifTool | None = None
_shared_checked = False
_shared_lock = threading.Lock()


def shared() -> ExifTool | None:
    """The process-wide pool, or None when ExifTool isn't available."""
    global _shared, _shared_checked
    with _shared_lock:
        if not _shared_checked:
            _shared_checked = True
            command = find_command()
            if command:
                _shared = ExifTool(command)
                atexit.register(_shared.close)
        return _shared


# Reads started ahead of their turn by read_ahead(), by resolved path.
_ahead: dict[str, Future[dict[str, Any]]] = {}
_ahead_lock = threading.Lock()


def read(path: Path) -> dict[str, Any] | None:
    """`path`'s tags, or None when ExifTool isn't available."""
    pool = shared()
    if pool is None:
        return None
    with _ahead_lock:
        started = _ahead.pop(str(path.resolve()), None)
    return started.result() if started is not None else pool.read(path)


def read_ahead(paths: Iterable[Path], depth: int = 4, wanted: Callable[[Path], bool] | None = None) -> Iterator[Path]:
    """Yields `paths`, having started reading the next `depth` of them on the
    pool's other processes: a loop that reads metadata one file at a time (an
    import) then overlaps ExifTool's work with its own. `wanted` picks the
    files whose metadata will be read."""
    pool = shared()
    if pool is None:
        yield from paths
        return
    window: deque[tuple[Path, str | None]] = deque()
    current: str | None = None
    with ThreadPoolExecutor(max_workers=POOL_SIZE, thread_name_prefix="exiftool-ahead") as executor:

        def start(path: Path) -> str | None:
            if wanted is not None and not wanted(path):
                return None
            key = str(path.resolve())
            with _ahead_lock:
                _ahead[key] = executor.submit(pool.read, path)
            return key

        def forget(key: str | None) -> None:
            # A file the loop skipped (deleted, not ready) leaves its read.
            if key is not None:
                with _ahead_lock:
                    future = _ahead.pop(key, None)
                if future is not None:
                    future.cancel()

        try:
            for path in paths:
                window.append((path, start(path)))
                if len(window) > depth:
                    path, current = window.popleft()
                    yield path
                    forget(current)
            while window:
                path, current = window.popleft()
                yield path
                forget(current)
            current = None
        finally:
            forget(current)
            for _, key in window:
                forget(key)
