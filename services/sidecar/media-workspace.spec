# PyInstaller build of the sidecar, for macOS and Windows:
#
#   cd services/sidecar
#   pyinstaller media-workspace.spec --distpath dist --noconfirm
#
# It writes dist/media-workspace/ (one folder, not one file: a one-file build
# unpacks itself on every start). electron-builder ships that folder as
# Resources/sidecar/media-workspace, and the app runs media-workspace(.exe)
# inside it (electron/sidecar/transport.js). Build on the platform you ship:
# PyInstaller does not cross-compile.
#
# Install the sidecar with the extras the release should carry first, e.g.
# `pip install -e ".[jimeng]" pyinstaller`: modules imported lazily (Pillow's
# HEIF plugin, the Volcengine SDK) are bundled only when they are installed.

import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# pathex below only reaches Analysis. The collect_* calls run first, and unless
# media_workspace is pip-installed they can't import it and collect nothing,
# with only a warning.
sys.path.insert(0, os.path.join(SPECPATH, "src"))

hiddenimports = collect_submodules("media_workspace")
# media_workspace/data: the offline gazetteer, country borders and names, and
# the simplified/traditional Chinese table.
datas = collect_data_files("media_workspace")
if not datas:
    raise SystemExit("media-workspace.spec: no media_workspace/data files found")

a = Analysis(
    ["entry.py"],
    pathex=["src"],
    datas=datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="media-workspace",
    console=True,
    upx=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="media-workspace",
    upx=False,
)
