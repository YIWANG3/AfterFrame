"""Folders: the directories on disk the library's photos live in, as a
read-only mirror (docs/collections-and-folders-design.md §5).

Nothing is stored: the tree is derived from the photos' paths every time it
is asked for, so it follows the disk (and relinks) without bookkeeping. The
app never changes a folder; the only writes here are relinks of the photos
under one (`locate_folder`), the folder-level form of db.maintenance's.
"""
from __future__ import annotations

import ntpath
import os
import posixpath
import sqlite3
from pathlib import Path

from .raw_pairs import HIDDEN_RAW_CLAUSE

# The photos the gallery's All Assets shows: a merged pair's RAW is not one
# (it travels with its JPG), as everywhere else in the gallery.
_LIBRARY_WHERE = (
    "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation') "
    f"AND {HIDDEN_RAW_CLAUSE}"
)


def _flavour(path: str):
    """The path module a stored path was written with: a Windows path has a
    drive or backslashes and no forward slash."""
    if "\\" in path and "/" not in path:
        return ntpath
    if len(path) >= 2 and path[1] == ":":
        return ntpath
    return posixpath


def _volume_of(path: str) -> tuple[str, str]:
    """(volume root, volume name) of an absolute path. macOS mounts other
    disks under /Volumes/<name>; Windows names a drive. "" is the startup disk."""
    flavour = _flavour(path)
    if flavour is ntpath:
        drive = ntpath.splitdrive(path)[0]
        return (drive + "\\" if drive else "\\"), drive
    parts = path.split("/")
    if len(parts) > 2 and parts[1] == "Volumes" and parts[2]:
        return f"/Volumes/{parts[2]}", parts[2]
    return "/", ""


def _ancestors(directory: str, root: str) -> list[str]:
    """`directory` and every directory above it up to `root`, deepest first."""
    flavour = _flavour(directory)
    out = []
    current = directory
    while True:
        out.append(current)
        if current == root:
            break
        parent = flavour.dirname(current)
        if parent == current or len(parent) < len(root):
            break
        current = parent
    return out


def list_folders(connection: sqlite3.Connection) -> dict[str, object]:
    """The folder tree as flat rows: {path, name, parent, volume, direct,
    total}. `direct` counts the photos right in that directory, `total` the
    ones in it and below. `parent` is None for a top folder.

    Per volume, each branch's directories above the photos that hold none
    themselves and lead to a single child are folded away: photos all under
    /Users/me/Pictures/2024/… show "2024" at the top, not a chain from /.
    Only directories that hold photos (themselves or below) appear."""
    rows = connection.execute(
        f"""
        SELECT assets.canonical_path AS path
        FROM image_lookup_registry AS registry
        JOIN assets ON assets.asset_id = registry.image_asset_id
        WHERE {_LIBRARY_WHERE}
        """
    ).fetchall()

    direct: dict[str, int] = {}
    total: dict[str, int] = {}
    children: dict[str, set[str]] = {}
    volume_of: dict[str, tuple[str, str]] = {}
    for row in rows:
        path = str(row["path"] or "")
        if not path:
            continue
        flavour = _flavour(path)
        directory = flavour.dirname(path)
        root, name = _volume_of(path)
        direct[directory] = direct.get(directory, 0) + 1
        chain = _ancestors(directory, root)
        for index, node in enumerate(chain):
            total[node] = total.get(node, 0) + 1
            volume_of.setdefault(node, (root, name))
            if index + 1 < len(chain):
                children.setdefault(chain[index + 1], set()).add(node)

    # The tops: from each volume's root, every branch walks down on its own
    # while the directory holds no photo and leads to a single child. Photos
    # under /Users/me/Pictures/2024 and /Volumes/T7/Shoots read "2024" and
    # "Shoots", whatever else the disk holds beside them.
    def fold(node: str) -> str:
        while direct.get(node, 0) == 0 and len(children.get(node, ())) == 1:
            node = next(iter(children[node]))
        return node

    tops: list[str] = []
    for root in sorted({volume for volume, _ in volume_of.values()}):
        if direct.get(root, 0):
            tops.append(root)
        else:
            tops.extend(fold(child) for child in sorted(children.get(root, ())))

    folders: list[dict[str, object]] = []

    def walk(node: str, parent: str | None) -> None:
        root, volume_name = volume_of[node]
        flavour = _flavour(node)
        folders.append({
            "path": node,
            "name": flavour.basename(node.rstrip("/\\")) or node,
            "parent": parent,
            "volume": volume_name,
            "volume_root": root,
            "direct": direct.get(node, 0),
            "total": total.get(node, 0),
            "exists": os.path.isdir(node),
        })
        for child in sorted(children.get(node, ()), key=lambda value: value.lower()):
            walk(child, node)

    for top in sorted(tops, key=lambda value: (volume_of[value][1].lower(), value.lower())):
        walk(top, None)
    return {"folders": folders}


def folder_clause(path: str, descendants: bool = True) -> tuple[str, list[object]]:
    """WHERE fragment on `assets` for the photos in a folder (and below)."""
    flavour = _flavour(path)
    sep = "\\" if flavour is ntpath else "/"
    prefix = path.rstrip("/\\") + sep
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    clause = "assets.canonical_path LIKE ? ESCAPE '\\'"
    params: list[object] = [escaped + "%"]
    if not descendants:
        clause += f" AND instr(substr(assets.canonical_path, {len(prefix) + 1}), ?) = 0"
        params.append(sep)
    return clause, params


def locate_folder(
    connection: sqlite3.Connection,
    old_dir: Path | str,
    new_dir: Path | str,
    *,
    commit: bool = True,
) -> dict[str, object]:
    """A folder moved on disk: point every photo under `old_dir` at the same
    place under `new_dir`, each one checked by its fingerprint the way a
    single relink is (db.maintenance.relink_asset, never forced). RAWs paired
    with those photos are under it too and come along.

    Returns {relinked, not_found, mismatch, in_use, present}: the counts of
    the photos as the gallery shows them (a merged pair's RAW is not
    counted), and `items` per asset."""
    from .maintenance import relink_asset

    old = str(old_dir).rstrip("/\\")
    new = Path(new_dir)
    if not new.is_dir():
        raise ValueError(f"not a folder: {new}")
    new_root = str(new.resolve())
    clause, params = folder_clause(old)
    rows = connection.execute(
        f"SELECT asset_id, canonical_path, exists_on_disk FROM assets WHERE {clause}",
        params,
    ).fetchall()
    hidden = {
        str(row[0])
        for row in connection.execute(f"SELECT asset_id FROM assets WHERE NOT ({HIDDEN_RAW_CLAUSE})")
    }

    counts = {"relinked": 0, "not_found": 0, "mismatch": 0, "in_use": 0, "present": 0}
    items: list[dict[str, object]] = []
    for row in rows:
        asset_id = str(row["asset_id"])
        old_path = str(row["canonical_path"])
        counted = asset_id not in hidden
        if os.path.exists(old_path):
            if not int(row["exists_on_disk"]):
                connection.execute(
                    "UPDATE assets SET exists_on_disk = 1, updated_at = CURRENT_TIMESTAMP WHERE asset_id = ?",
                    (asset_id,),
                )
            status, new_path = "present", None
        else:
            relative = old_path[len(old) + 1:]
            target = Path(new_root, *relative.replace("\\", "/").split("/"))
            if not target.exists():
                status, new_path = "not_found", None
            else:
                outcome = relink_asset(connection, asset_id, target, commit=False)
                status = {"relinked": "relinked", "fingerprint_mismatch": "mismatch", "path_in_use": "in_use"}[str(outcome["status"])]
                new_path = str(outcome["new_path"]) if status == "relinked" else None
        if counted:
            counts[status] += 1
        items.append({"asset_id": asset_id, "status": status, **({"new_path": new_path} if new_path else {})})

    if commit:
        connection.commit()
    return {**counts, "items": items}
