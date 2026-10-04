"""PyInstaller entry point for the packaged sidecar (media-workspace.spec).

The packaged app runs this binary with the same arguments `python -m
media_workspace` takes in development (electron/sidecar/transport.js)."""

import sys

from media_workspace.cli import main

if __name__ == "__main__":
    sys.exit(main())
