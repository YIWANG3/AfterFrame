"""What the app asks about a watched folder.

The folder watcher and the startup catch-up report files; before importing
anything the app asks which of them are new to the catalog (scan_new_media),
which reported changes an import would act on (changed_media), and has the
ones a user re-exported in place re-read (refresh_paths). None of this reads
EXIF or matches RAWs: a normal start over an unchanged library does nothing
visible.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .catalog import CatalogPaths
from .db import list_assets_for_preview
from .metadata import iso_mtime
from .preview_service import PreviewService
from .reverse_lookup import iter_image_files, resolve_image_batch


def scan_new_media(connection: sqlite3.Connection, directories: list[Path]) -> dict[str, Any]:
    """Which media files under these folders are not yet in the catalog (and
    not user-deleted). A directory walk plus indexed lookups; the caller
    imports only `new_files`."""
    known = {row["path"] for row in connection.execute("SELECT path FROM asset_files")}
    tombstoned = {row["path"] for row in connection.execute("SELECT path FROM deleted_files")}
    new_files: list[str] = []
    seen: set[str] = set()  # nested watched dirs (a dir inside another) yield dupes
    scanned = known_hit = tombstoned_hit = 0
    for path in iter_image_files(directories):
        scanned += 1
        key = str(path)
        if key in tombstoned:
            tombstoned_hit += 1
        elif key in known:
            known_hit += 1
        elif key not in seen:
            seen.add(key)
            new_files.append(key)
    return {"new_files": new_files, "scanned": scanned, "known": known_hit, "tombstoned": tombstoned_hit}


def changed_media(connection: sqlite3.Connection, paths: list[str]) -> dict[str, Any]:
    """Which of these files, reported by a watched folder, would an import
    change? The folder reports more than new and rewritten files: AirDrop, a
    Finder tag or opening the photo in another app only writes its extended
    attributes. Dropped: a file the catalog holds as it is on disk (present,
    same size and mtime: what the importer itself compares), and one the
    user removed that hasn't been rewritten since (the auto import skips it
    the same way). The rest, unreadable paths included, are the import's to
    decide.

    `present_asset_ids` are the dropped files the catalog holds. Browsing
    stats files live and leaves exists_on_disk alone, so a photo moved out
    and put back unchanged reads here as never gone, while a card browsed in
    between still shows it missing: the app re-checks those."""
    changed: list[str] = []
    unchanged = 0
    present_asset_ids: list[str] = []
    for given in paths:
        try:
            path = Path(given).resolve()
            stat = path.stat()
        except OSError:
            changed.append(given)
            continue
        known = connection.execute(
            """
            SELECT assets.asset_id, assets.file_size, assets.modified_time, assets.exists_on_disk
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE asset_files.path = ?
            LIMIT 1
            """,
            (str(path),),
        ).fetchone()
        removed = connection.execute("SELECT file_size, mtime FROM deleted_files WHERE path = ?", (str(path),)).fetchone()
        if known is not None and (
            int(known["exists_on_disk"]) == 1
            and int(stat.st_size) == int(known["file_size"] or 0)
            and iso_mtime(path, stat) == str(known["modified_time"] or "")
        ):
            unchanged += 1
            present_asset_ids.append(str(known["asset_id"]))
        elif known is None and removed is not None and (
            int(stat.st_size) == int(removed["file_size"]) and abs(stat.st_mtime - float(removed["mtime"])) < 2
        ):
            unchanged += 1
        else:
            changed.append(given)
    return {"changed": changed, "unchanged": unchanged, "present_asset_ids": present_asset_ids}


_NO_PREVIEWS = {"generated": 0, "skipped": 0, "failed": 0, "deferred": 0, "total": 0}


def refresh_paths(connection: sqlite3.Connection, catalog: CatalogPaths, paths: list[Path]) -> dict[str, Any]:
    """Re-read these files (rewritten in place by an editor): resolve them
    again and remake their thumbnails. HD previews are remade only where one
    exists — a disk refresh must not create HD previews for a library that
    has HD generation off."""
    paths = list(dict.fromkeys(path.resolve() for path in paths))
    resolve_result = resolve_image_batch(connection, paths, refresh=True, validate_sources=True, persist_roots=False)
    service = PreviewService(catalog)
    preview_result = service.generate_batch(connection, kind="preview", force=True, paths=paths)
    hd_paths = [
        Path(row["canonical_path"])
        for row in list_assets_for_preview(connection, kind="preview-hd", paths=paths)
        if row["existing_relative_path"] and row["existing_status"] == "ready"
    ]
    preview_hd_result = (
        service.generate_batch(connection, kind="preview-hd", force=True, paths=hd_paths) if hd_paths else dict(_NO_PREVIEWS)
    )
    return {
        "requested": len(paths),
        "refreshed": int(resolve_result.get("processed", 0)) - int(resolve_result.get("deferred_files", 0)),
        "deferred": max(
            int(resolve_result.get("deferred_files", 0)),
            int(preview_result.get("deferred", 0)),
            int(preview_hd_result.get("deferred", 0)),
        ),
        "failed": int(preview_result.get("failed", 0)) + int(preview_hd_result.get("failed", 0)),
        "preview": preview_result,
        "preview_hd": preview_hd_result,
    }
