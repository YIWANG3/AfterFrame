"""What an import leaves for the app to do once it ends (docs/import-pipeline-
redesign.md §5.2): analyze its new photos for people, annotate them, as the
settings say. The app's main process asks here which ended imports still
have that to do and records what it did, so an import cancelled, failed, or
still running when the app quit gets its follow-ups too, and gets them once.

"Its new photos" are the ones it added: created while it ran, under the
folders and files it was given. An import's own count (newly_added) is lost
when it is cancelled mid-way; the catalog still has the photos. A photo some
other way wrote into those folders meanwhile (an export next to its
original) counts too, which is fine for what these are for.

Imports from before this module existed have nothing recorded and must stay
that way (annotating them would spend the user's money on photos they never
asked to have annotated): only imports created after the first time the app
asked are considered (`import_followups_since`).
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any

from .jobs import get_job
from .settings import get_app_setting

SINCE_KEY = "import_followups_since"
# Enough for any number of imports between two looks; older ones that never
# got theirs (the app was not run for a long time) are left alone.
PENDING_LIMIT = 50


def followups_since(connection: sqlite3.Connection) -> str:
    """When this catalog first had its imports followed up: set on the first
    call, a SQLite CURRENT_TIMESTAMP like jobs.created_at."""
    since = get_app_setting(connection, SINCE_KEY)
    if isinstance(since, str) and since:
        return since
    now = str(connection.execute("SELECT CURRENT_TIMESTAMP").fetchone()[0])
    connection.execute(
        """
        INSERT INTO app_settings (setting_key, value_json) VALUES (?, ?)
        ON CONFLICT(setting_key) DO NOTHING
        """,
        (SINCE_KEY, json.dumps(now)),
    )
    connection.commit()
    stored = get_app_setting(connection, SINCE_KEY)
    return stored if isinstance(stored, str) and stored else now


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def import_scope(connection: sqlite3.Connection, job_ids: list[str]) -> tuple[str, list[Any]]:
    """An SQL condition on `assets` for the photos these imports added, and
    its parameters. Never matches when none of them is an import."""
    clauses: list[str] = []
    params: list[Any] = []
    for job_id in job_ids:
        job = get_job(connection, job_id)
        if not job or job.get("job_type") != "import":
            continue
        raw_payload = job.get("payload")
        payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
        roots = [str(root) for root in [*(payload.get("image_dirs") or []), *(payload.get("raw_dirs") or [])] if root]
        if not roots:
            continue
        # A root is a folder (its files under it) or a file dropped on its own.
        paths = " OR ".join("assets.canonical_path = ? OR assets.canonical_path LIKE ? ESCAPE '\\'" for _ in roots)
        clauses.append(f"(assets.created_at BETWEEN ? AND ? AND ({paths}))")
        params.extend([job["created_at"], job["updated_at"]])
        for root in roots:
            params.extend([root, _escape_like(root.rstrip("/\\")) + _escape_like(os.sep) + "%"])
    if not clauses:
        return "0", []
    return "(" + " OR ".join(clauses) + ")", params


def new_asset_count(connection: sqlite3.Connection, job_id: str) -> int:
    condition, params = import_scope(connection, [job_id])
    return int(connection.execute(f"SELECT COUNT(*) FROM assets WHERE {condition}", params).fetchone()[0])


def pending_import_followups(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """Ended imports whose follow-ups aren't done, oldest first: their id,
    how they ended, how many photos they added, and what was recorded so far
    (`followups`, see mark_import_followups)."""
    since = followups_since(connection)
    rows = connection.execute(
        """
        SELECT job_id, status, created_at, updated_at, json_extract(result_json, '$.followups') AS followups
        FROM jobs
        WHERE job_type = 'import'
          AND status IN ('succeeded', 'failed', 'cancelled')
          AND created_at >= ?
          AND COALESCE(json_extract(result_json, '$.followups.done'), 0) = 0
        ORDER BY created_at ASC
        LIMIT ?
        """,
        (since, PENDING_LIMIT),
    ).fetchall()
    pending = []
    for row in rows:
        try:
            followups = json.loads(row["followups"]) if row["followups"] else {}
        except ValueError:
            followups = {}
        pending.append({
            "job_id": str(row["job_id"]),
            "status": str(row["status"]),
            "new_assets": new_asset_count(connection, str(row["job_id"])),
            "followups": followups if isinstance(followups, dict) else {},
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        })
    return pending


def mark_import_followups(connection: sqlite3.Connection, job_id: str, followups: dict[str, Any]) -> dict[str, Any] | None:
    """Merge `followups` into the import's result.followups ({"people":
    "started", "annotation": "off", "done": true}…). updated_at is left as
    it is: it ends the window import_scope reads the import's photos in."""
    job = get_job(connection, job_id)
    if not job or job.get("job_type") != "import":
        return None
    raw_result = job.get("result")
    result: dict[str, Any] = raw_result if isinstance(raw_result, dict) else {}
    raw_current = result.get("followups")
    current: dict[str, Any] = raw_current if isinstance(raw_current, dict) else {}
    merged = {**current, **followups}
    connection.execute(
        "UPDATE jobs SET result_json = json_set(result_json, '$.followups', json(?)) WHERE job_id = ?",
        (json.dumps(merged), job_id),
    )
    connection.commit()
    return merged
