"""Background job rows: create/update/poll/cancel.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3
from uuid import uuid4

# Sentinel: distinguishes "don't touch error_text" from "clear it" in update_job.
_UNSET = object()

from .core import _json

def _job_id(job_type: str) -> str:
    return f"job_{job_type}_{uuid4().hex[:20]}"


def _decode_job_row(row: sqlite3.Row | None) -> dict[str, object] | None:
    if row is None:
        return None
    keys = row.keys()
    return {
        "job_id": row["job_id"],
        "job_type": row["job_type"],
        "status": row["status"],
        "payload": json.loads(row["payload_json"] or "{}"),
        "result": json.loads(row["result_json"] or "{}"),
        "progress": float(row["progress"] or 0),
        "priority": int(row["priority"] or 50) if "priority" in keys else 50,
        "pause_requested": bool(row["pause_requested"]) if "pause_requested" in keys else False,
        "resume_cursor": json.loads(row["resume_cursor_json"] or "{}") if "resume_cursor_json" in keys else {},
        "attempt_count": int(row["attempt_count"] or 0) if "attempt_count" in keys else 0,
        "error": row["error_text"],
        "cancel_requested": bool(row["cancel_requested"]) if "cancel_requested" in keys else False,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def create_job(
    connection: sqlite3.Connection,
    job_type: str,
    payload: dict[str, object] | None = None,
    *,
    status: str = "queued",
    progress: float = 0.0,
    result: dict[str, object] | None = None,
    priority: int = 50,
    resume_cursor: dict[str, object] | None = None,
    commit: bool = True,
) -> dict[str, object]:
    job_id = _job_id(job_type)
    connection.execute(
        """
        INSERT INTO jobs (job_id, job_type, status, payload_json, result_json, progress, priority, resume_cursor_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (job_id, job_type, status, _json(payload or {}), _json(result or {}), progress, priority, _json(resume_cursor or {})),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id) or {}


def update_job(
    connection: sqlite3.Connection,
    job_id: str,
    *,
    status: str | None = None,
    payload: dict[str, object] | None = None,
    result: dict[str, object] | None = None,
    progress: float | None = None,
    priority: int | None = None,
    pause_requested: bool | None = None,
    resume_cursor: dict[str, object] | None = None,
    increment_attempt: bool = False,
    error_text: object = _UNSET,
    commit: bool = True,
) -> dict[str, object]:
    assignments: list[str] = ["updated_at = CURRENT_TIMESTAMP"]
    params: list[object] = []
    if status is not None:
        assignments.append("status = ?")
        params.append(status)
    if payload is not None:
        assignments.append("payload_json = ?")
        params.append(_json(payload))
    if result is not None:
        assignments.append("result_json = ?")
        params.append(_json(result))
    if progress is not None:
        assignments.append("progress = ?")
        params.append(progress)
    if priority is not None:
        assignments.append("priority = ?")
        params.append(priority)
    if pause_requested is not None:
        assignments.append("pause_requested = ?")
        params.append(1 if pause_requested else 0)
    if resume_cursor is not None:
        assignments.append("resume_cursor_json = ?")
        params.append(_json(resume_cursor))
    if increment_attempt:
        assignments.append("attempt_count = attempt_count + 1")
    if error_text is not _UNSET:
        # None is a meaningful value here: success paths pass error_text=None
        # to CLEAR a stale error from a previous failed run of the same job id.
        assignments.append("error_text = ?")
        params.append(error_text)
    params.append(job_id)
    connection.execute(
        f"UPDATE jobs SET {', '.join(assignments)} WHERE job_id = ?",
        tuple(params),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id) or {}


def get_job(connection: sqlite3.Connection, job_id: str) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
               resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
        FROM jobs
        WHERE job_id = ?
        """,
        (job_id,),
    ).fetchone()
    return _decode_job_row(row)


def get_latest_job(connection: sqlite3.Connection, job_type: str | None = None) -> dict[str, object] | None:
    if job_type:
        row = connection.execute(
            """
            SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
                   resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
            FROM jobs
            WHERE job_type = ?
            ORDER BY created_at DESC, job_id DESC
            LIMIT 1
            """,
            (job_type,),
        ).fetchone()
    else:
        row = connection.execute(
            """
            SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
                   resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
            FROM jobs
            ORDER BY created_at DESC, job_id DESC
            LIMIT 1
            """
        ).fetchone()
    return _decode_job_row(row)


def list_jobs(connection: sqlite3.Connection, job_type: str | None = None, limit: int = 20) -> list[dict[str, object]]:
    if job_type:
        rows = connection.execute(
            """
            SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
                   resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
            FROM jobs
            WHERE job_type = ?
            ORDER BY created_at DESC, job_id DESC
            LIMIT ?
            """,
            (job_type, limit),
        ).fetchall()
    else:
        rows = connection.execute(
            """
            SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
                   resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
            FROM jobs
            ORDER BY created_at DESC, job_id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_decode_job_row(row) for row in rows if row is not None]


def list_active_jobs(connection: sqlite3.Connection) -> list[dict[str, object]]:
    """All queued/running jobs across every type — drives the activity center.

    Also reconciles orphans: every runner touches updated_at on each progress
    batch, so an 'active' job whose heartbeat is >10 minutes old is a process
    that died (app quit, crash, kill). Mark it failed so it doesn't haunt the
    activity center forever.
    """
    # Only people_index jobs have a durable per-asset cursor today. Recover
    # stalled runs with that cursor instead of marking them irretrievably failed;
    # the dispatcher will launch them again when the app reconnects.
    connection.execute(
        """
        UPDATE jobs
        SET status = 'queued', error_text = NULL, cancel_requested = 0, pause_requested = 0,
            attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE job_type = 'people_index'
          AND status = 'running'
          AND resume_cursor_json != '{}'
          AND updated_at < datetime('now', '-10 minutes')
        """
    )
    connection.execute(
        """
        UPDATE jobs
        SET status = 'failed', error_text = 'stalled — no heartbeat for 10 minutes (process likely terminated)',
            updated_at = CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'running')
          AND updated_at < datetime('now', '-10 minutes')
        """
    )
    connection.commit()
    rows = connection.execute(
        """
            SELECT job_id, job_type, status, payload_json, result_json, progress, priority, pause_requested,
                   resume_cursor_json, attempt_count, error_text, cancel_requested, created_at, updated_at
            FROM jobs
        WHERE status IN ('queued', 'running', 'paused')
        ORDER BY priority DESC, created_at ASC
        """
    ).fetchall()
    return [_decode_job_row(row) for row in rows if row is not None]


def request_job_cancel(connection: sqlite3.Connection, job_id: str, commit: bool = True) -> dict[str, object] | None:
    """Flag a job for cooperative cancellation. The runner notices the flag at
    its next progress checkpoint and exits with status='cancelled'."""
    connection.execute(
        "UPDATE jobs SET cancel_requested = 1, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status IN ('queued', 'running', 'paused')",
        (job_id,),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id)


def is_cancel_requested(connection: sqlite3.Connection, job_id: str) -> bool:
    row = connection.execute("SELECT cancel_requested FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    return bool(row and row["cancel_requested"])


def request_job_pause(connection: sqlite3.Connection, job_id: str, commit: bool = True) -> dict[str, object] | None:
    """Request a safe checkpoint pause. A queued job pauses immediately; a
    running job transitions after its current asset transaction completes."""
    connection.execute(
        """
        UPDATE jobs
        SET pause_requested = 1,
            status = CASE WHEN status = 'queued' THEN 'paused' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND status IN ('queued', 'running', 'paused')
        """,
        (job_id,),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id)


def request_job_resume(connection: sqlite3.Connection, job_id: str, commit: bool = True) -> dict[str, object] | None:
    connection.execute(
        """
        UPDATE jobs
        SET pause_requested = 0, cancel_requested = 0, status = 'queued', updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ? AND status = 'paused'
        """,
        (job_id,),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id)


def is_pause_requested(connection: sqlite3.Connection, job_id: str) -> bool:
    row = connection.execute("SELECT pause_requested FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    return bool(row and row["pause_requested"])
