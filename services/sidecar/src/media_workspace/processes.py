"""The programs the sidecar starts, started without a window on Windows.

Windows gives a console program a console of its own when the process that
starts it has none, and shows that console in a terminal window. The
background jobs have none: the app starts them detached, so that they outlive
it. The ExifTool processes, RAW decoders and video tools a job started each
opened a terminal window on the user's screen; the resident sidecar's didn't,
since it has a console (a hidden one) for them to share.

On Windows a program also outlives the sidecar that started it, unless
end_with_this_process() ties it to the sidecar.
"""

from __future__ import annotations

import subprocess
import sys
from typing import TypedDict

# subprocess.CREATE_NO_WINDOW, which only Python for Windows defines: the
# program gets a console that has no window.
CREATE_NO_WINDOW = 0x08000000


class NoWindow(TypedDict, total=False):
    creationflags: int


def no_window() -> NoWindow:
    """Keywords for subprocess.run() and Popen() that start a console program
    without a window on Windows; none elsewhere."""
    return {"creationflags": CREATE_NO_WINDOW} if sys.platform == "win32" else {}


_job = None


def end_with_this_process(process: subprocess.Popen) -> None:
    """Windows: put `process` in a job that the system closes, killing what is
    in it, when this process ends, however it ends: a sidecar killed for a
    timeout doesn't leave its ExifTool polling or its FFmpeg encoding. Nothing
    elsewhere. Programs `process` starts are in the job too."""
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
