"""The programs the sidecar starts, started without a window on Windows.

Windows gives a console program a console of its own when the process that
starts it has none, and shows that console in a terminal window. The
background jobs have none: the app starts them detached, so that they outlive
it. The ExifTool processes, RAW decoders and video tools a job started each
opened a terminal window on the user's screen; the resident sidecar's didn't,
since it has a console (a hidden one) for them to share.
"""

from __future__ import annotations

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
