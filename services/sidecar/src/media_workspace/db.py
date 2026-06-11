from __future__ import annotations

import json
import os
import sqlite3
from hashlib import sha1
from pathlib import Path
from uuid import uuid4

from .models import ExportCandidate, MatchDecision, RawMetadata
from .schema import SCHEMA_STATEMENTS

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"
SCHEMA_VERSION = 5


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


# Searchable facet columns derived from assets.metadata_json. VIRTUAL generated
# columns compute on read (no storage, auto-synced with metadata_json) and can
# be indexed — giving fast facet filters without denormalizing or backfilling.
_FACET_COLUMNS = [
    ("meta_capture_time", "TEXT", "$.capture_time"),
    ("meta_camera_model", "TEXT", "$.camera_model"),
    ("meta_lens_model", "TEXT", "$.lens_model"),
    ("meta_iso", "INTEGER", "$.iso"),
    ("meta_aperture", "REAL", "$.aperture"),
    ("meta_shutter", "REAL", "$.shutter_speed"),
    ("meta_focal", "REAL", "$.focal_length"),
    ("meta_width", "INTEGER", "$.width"),
    ("meta_height", "INTEGER", "$.height"),
]
_FACET_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_camera ON assets(meta_camera_model)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_lens ON assets(meta_lens_model)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_iso ON assets(meta_iso)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_aperture ON assets(meta_aperture)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_focal ON assets(meta_focal)",
    "CREATE INDEX IF NOT EXISTS idx_assets_meta_capture_time ON assets(meta_capture_time)",
]


def init_db(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA_STATEMENTS:
        connection.execute(statement)
    _ensure_column(connection, "assets", "app_rating", "INTEGER")
    _ensure_column(connection, "raw_metadata_cache", "metadata_level", "TEXT NOT NULL DEFAULT 'full'")
    _ensure_column(connection, "raw_metadata_cache", "fingerprint_level", "TEXT NOT NULL DEFAULT 'head-tail'")
    _ensure_column(connection, "raw_metadata_cache", "enrichment_status", "TEXT NOT NULL DEFAULT 'done'")
    _ensure_column(connection, "jobs", "result_json", "TEXT NOT NULL DEFAULT '{}'")
    # Cooperative cancellation: runners poll this flag between batches and
    # finish gracefully with status='cancelled'.
    _ensure_column(connection, "jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0")
    # Searchable facet columns + indexes (idempotent; VIRTUAL generated columns).
    for name, sql_type, json_path in _FACET_COLUMNS:
        _ensure_column(
            connection,
            "assets",
            name,
            f"{sql_type} GENERATED ALWAYS AS (json_extract(metadata_json, '{json_path}')) VIRTUAL",
        )
    for index_sql in _FACET_INDEXES:
        connection.execute(index_sql)
    connection.execute(
        """
        INSERT INTO catalog_info (catalog_id, catalog_path, schema_version)
        VALUES (1, '', ?)
        ON CONFLICT(catalog_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            updated_at = CURRENT_TIMESTAMP
        """,
        (SCHEMA_VERSION,),
    )
    connection.commit()


def _ensure_column(connection: sqlite3.Connection, table_name: str, column_name: str, column_spec: str) -> None:
    # table_xinfo (not table_info) lists VIRTUAL generated columns too, so this
    # stays idempotent for generated facet columns across repeated init_db runs.
    columns = {
        row["name"]
        for row in connection.execute(f"PRAGMA table_xinfo({table_name})").fetchall()
    }
    if column_name in columns:
        return
    connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_spec}")


def set_catalog_path(connection: sqlite3.Connection, catalog_path: Path) -> None:
    connection.execute(
        """
        UPDATE catalog_info
        SET catalog_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE catalog_id = 1
        """,
        (str(catalog_path.resolve()),),
    )
    connection.commit()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def get_app_setting(connection: sqlite3.Connection, setting_key: str) -> object | None:
    row = connection.execute(
        "SELECT value_json FROM app_settings WHERE setting_key = ?",
        (setting_key,),
    ).fetchone()
    if row is None:
        return None
    return json.loads(row["value_json"] or "null")


def set_app_setting(connection: sqlite3.Connection, setting_key: str, value: object, commit: bool = True) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (setting_key, value_json)
        VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = CURRENT_TIMESTAMP
        """,
        (setting_key, _json(value)),
    )
    if commit:
        connection.commit()


def delete_app_setting(connection: sqlite3.Connection, setting_key: str, commit: bool = True) -> None:
    connection.execute("DELETE FROM app_settings WHERE setting_key = ?", (setting_key,))
    if commit:
        connection.commit()


def list_repaint_history(connection: sqlite3.Connection, asset_path: str) -> list[dict]:
    """Return all AI repaint records for the resource set that contains *asset_path*."""
    # 1. Find asset_id from path
    row = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?",
        (asset_path,),
    ).fetchone()
    if not row:
        return []
    asset_id = row["asset_id"]

    # 2. Find its resource set
    rs = get_resource_set_for_asset(connection, asset_id)
    if not rs:
        return []
    set_id = rs["set_id"]

    # 3. Get all ai_repaint members in this set
    repaint_members = connection.execute(
        """
        SELECT rsi.asset_id, assets.canonical_path, rsi.parent_asset_id
        FROM resource_set_items rsi
        JOIN assets ON assets.asset_id = rsi.asset_id
        WHERE rsi.set_id = ? AND rsi.version_kind = 'ai_repaint'
        ORDER BY rsi.sort_order
        """,
        (set_id,),
    ).fetchall()

    if not repaint_members:
        return []

    # 4. For each repaint member, find the matching succeeded job
    results = []
    for member in repaint_members:
        output_path = member["canonical_path"]
        job = connection.execute(
            """
            SELECT job_id, payload_json, result_json, created_at
            FROM jobs
            WHERE job_type = 'ai_repaint' AND status = 'succeeded'
              AND json_extract(result_json, '$.output_path') = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (output_path,),
        ).fetchone()
        entry: dict = {
            "asset_id": member["asset_id"],
            "output_path": output_path,
            "parent_asset_id": member["parent_asset_id"],
        }
        if job:
            payload = json.loads(job["payload_json"])
            result = json.loads(job["result_json"])
            entry.update({
                "input_path": payload.get("input_path"),
                "prompt": result.get("prompt") or payload.get("prompt", ""),
                "provider": result.get("provider") or payload.get("provider"),
                "model": result.get("model"),
                "temperature": payload.get("temperature"),
                "aspect_ratio": payload.get("aspect_ratio"),
                "resolution": payload.get("image_size"),
                "created_at": job["created_at"],
            })
        results.append(entry)
    return results


def _file_id(asset_id: str, path: str) -> str:
    digest = sha1(path.encode("utf-8")).hexdigest()[:16]
    return f"file_{asset_id}_{digest}"


def _link_id(parent_asset_id: str, child_asset_id: str, relation_type: str) -> str:
    digest = sha1(f"{parent_asset_id}:{child_asset_id}:{relation_type}".encode("utf-8")).hexdigest()[:20]
    return f"link_{digest}"


def _resource_set_id() -> str:
    return f"set_{uuid4().hex[:20]}"


def get_resource_set(connection: sqlite3.Connection, set_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT set_id, primary_asset_id, raw_asset_id, created_at, updated_at
        FROM resource_sets
        WHERE set_id = ?
        """,
        (set_id,),
    ).fetchone()


def get_resource_set_for_asset(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT rs.set_id, rs.primary_asset_id, rs.raw_asset_id, rsi.role, rsi.version_kind, rsi.parent_asset_id, rsi.sort_order
        FROM resource_set_items AS rsi
        JOIN resource_sets AS rs ON rs.set_id = rsi.set_id
        WHERE rsi.asset_id = ?
        """,
        (asset_id,),
    ).fetchone()


def _next_resource_sort_order(connection: sqlite3.Connection, set_id: str) -> int:
    row = connection.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM resource_set_items WHERE set_id = ?",
        (set_id,),
    ).fetchone()
    return int(row["next_sort_order"]) if row is not None else 0


def add_asset_to_resource_set(
    connection: sqlite3.Connection,
    set_id: str,
    asset_id: str,
    *,
    role: str,
    version_kind: str | None = None,
    parent_asset_id: str | None = None,
    sort_order: int | None = None,
    commit: bool = True,
) -> None:
    if sort_order is None:
        sort_order = _next_resource_sort_order(connection, set_id)
    connection.execute(
        """
        INSERT INTO resource_set_items (set_id, asset_id, role, version_kind, parent_asset_id, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(set_id, asset_id) DO UPDATE SET
            role = excluded.role,
            version_kind = excluded.version_kind,
            parent_asset_id = excluded.parent_asset_id,
            sort_order = excluded.sort_order
        """,
        (set_id, asset_id, role, version_kind, parent_asset_id, sort_order),
    )
    if commit:
        connection.commit()


def create_resource_set(
    connection: sqlite3.Connection,
    primary_asset_id: str,
    *,
    commit: bool = True,
) -> str:
    existing = get_resource_set_for_asset(connection, primary_asset_id)
    if existing:
        return str(existing["set_id"])

    set_id = _resource_set_id()
    connection.execute(
        """
        INSERT INTO resource_sets (set_id, primary_asset_id)
        VALUES (?, ?)
        """,
        (set_id, primary_asset_id),
    )
    add_asset_to_resource_set(connection, set_id, primary_asset_id, role="primary", version_kind="main", parent_asset_id=None, sort_order=1, commit=False)
    if commit:
        connection.commit()
    return set_id


def attach_asset_to_resource_set(
    connection: sqlite3.Connection,
    asset_id: str,
    *,
    origin_asset_id: str | None = None,
    version_kind: str = "version",
    commit: bool = True,
) -> str:
    existing = get_resource_set_for_asset(connection, asset_id)
    if existing:
        return str(existing["set_id"])

    # Has explicit origin (e.g. AI repaint, crop) → join origin's set
    if origin_asset_id:
        origin_set = get_resource_set_for_asset(connection, origin_asset_id)
        if origin_set:
            target_set = str(origin_set["set_id"])
        else:
            # Origin has no set yet → create one with origin as primary
            target_set = create_resource_set(
                connection, origin_asset_id, commit=False,
            )
        add_asset_to_resource_set(
            connection, target_set, asset_id,
            role="version", version_kind=version_kind,
            parent_asset_id=origin_asset_id, commit=False,
        )
        if commit:
            connection.commit()
        return target_set

    # Independent import with no origin → create own set
    target_set = create_resource_set(connection, asset_id, commit=False)
    if commit:
        connection.commit()
    return target_set


def list_export_assets_missing_resource_set(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.stem,
            assets.canonical_path,
            registry.raw_asset_id
        FROM assets
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN export_lookup_registry AS registry
            ON registry.export_asset_id = assets.asset_id
        WHERE assets.asset_type = 'export'
          AND rsi.set_id IS NULL
        ORDER BY assets.created_at, assets.canonical_path
        """
    ).fetchall()


def find_export_asset_ids_by_stem(connection: sqlite3.Connection, stem: str) -> list[str]:
    rows = connection.execute(
        """
        SELECT asset_id
        FROM assets
        WHERE asset_type = 'export'
          AND stem = ?
        ORDER BY created_at, canonical_path
        """,
        (stem,),
    ).fetchall()
    return [str(row["asset_id"]) for row in rows]


def list_singleton_primary_resource_sets(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            rs.set_id,
            rs.primary_asset_id,
            a.stem,
            a.canonical_path
        FROM resource_sets AS rs
        JOIN assets AS a
            ON a.asset_id = rs.primary_asset_id
        JOIN (
            SELECT set_id, COUNT(*) AS item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS counts
            ON counts.set_id = rs.set_id
        WHERE counts.item_count = 1
        """
    ).fetchall()


def list_incorrectly_merged_resource_sets(connection: sqlite3.Connection) -> list[dict]:
    """Find resource sets containing multiple independent exports from different directories.

    Returns a list of dicts with set_id, and a list of member info.
    Sets where all members share the same parent directory are NOT returned.
    """
    # Find sets with 2+ export members
    candidate_sets = connection.execute(
        """
        SELECT rsi.set_id, COUNT(*) AS export_count
        FROM resource_set_items AS rsi
        JOIN assets ON assets.asset_id = rsi.asset_id AND assets.asset_type = 'export'
        GROUP BY rsi.set_id
        HAVING export_count > 1
        """
    ).fetchall()

    results = []
    for row in candidate_sets:
        set_id = row["set_id"]
        members = connection.execute(
            """
            SELECT rsi.asset_id, assets.canonical_path, rsi.role, rsi.version_kind, rsi.parent_asset_id
            FROM resource_set_items AS rsi
            JOIN assets ON assets.asset_id = rsi.asset_id AND assets.asset_type = 'export'
            WHERE rsi.set_id = ?
            ORDER BY rsi.sort_order
            """,
            (set_id,),
        ).fetchall()

        # Check: are there members WITHOUT a parent_asset_id (independent imports)
        # from DIFFERENT directories?
        independent_members = [m for m in members if not m["parent_asset_id"]]
        if len(independent_members) < 2:
            continue

        dirs = set()
        for m in independent_members:
            parent_dir = str(Path(m["canonical_path"]).parent)
            dirs.add(parent_dir)

        if len(dirs) < 2:
            continue

        results.append({
            "set_id": set_id,
            "members": [
                {
                    "asset_id": m["asset_id"],
                    "canonical_path": m["canonical_path"],
                    "role": m["role"],
                    "version_kind": m["version_kind"],
                    "parent_asset_id": m["parent_asset_id"],
                }
                for m in members
            ],
        })

    return results


def reassign_asset_to_resource_set(
    connection: sqlite3.Connection,
    asset_id: str,
    *,
    origin_asset_id: str,
    version_kind: str = "derived",
    commit: bool = True,
) -> str:
    current = get_resource_set_for_asset(connection, asset_id)
    if current:
        connection.execute(
            "DELETE FROM resource_set_items WHERE set_id = ? AND asset_id = ?",
            (current["set_id"], asset_id),
        )
        remaining = connection.execute(
            "SELECT COUNT(*) AS item_count FROM resource_set_items WHERE set_id = ?",
            (current["set_id"],),
        ).fetchone()
        if remaining is not None and int(remaining["item_count"]) == 0:
            connection.execute("DELETE FROM resource_sets WHERE set_id = ?", (current["set_id"],))

    target_set = attach_asset_to_resource_set(
        connection,
        asset_id,
        origin_asset_id=origin_asset_id,
        version_kind=version_kind,
        commit=False,
    )
    if commit:
        connection.commit()
    return target_set


def upsert_catalog_root(connection: sqlite3.Connection, root_type: str, path: Path, commit: bool = True) -> None:
    digest = sha1(f"{root_type}:{path.resolve()}".encode("utf-8")).hexdigest()[:20]
    connection.execute(
        """
        INSERT INTO catalog_roots (root_id, root_type, path)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            root_type = excluded.root_type,
            is_active = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (f"root_{digest}", root_type, str(path.resolve())),
    )
    if commit:
        connection.commit()


def list_catalog_roots(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT root_id, root_type, path, is_active, created_at, updated_at
        FROM catalog_roots
        WHERE is_active = 1
        ORDER BY root_type, path
        """
    ).fetchall()


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
    commit: bool = True,
) -> dict[str, object]:
    job_id = _job_id(job_type)
    connection.execute(
        """
        INSERT INTO jobs (job_id, job_type, status, payload_json, result_json, progress)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (job_id, job_type, status, _json(payload or {}), _json(result or {}), progress),
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
    error_text: str | None = None,
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
    if error_text is not None:
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
        SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
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
            SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
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
            SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
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
            SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
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
            SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
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
        SELECT job_id, job_type, status, payload_json, result_json, progress, error_text, cancel_requested, created_at, updated_at
        FROM jobs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC
        """
    ).fetchall()
    return [_decode_job_row(row) for row in rows if row is not None]


def request_job_cancel(connection: sqlite3.Connection, job_id: str, commit: bool = True) -> dict[str, object] | None:
    """Flag a job for cooperative cancellation. The runner notices the flag at
    its next progress checkpoint and exits with status='cancelled'."""
    connection.execute(
        "UPDATE jobs SET cancel_requested = 1, updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status IN ('queued', 'running')",
        (job_id,),
    )
    if commit:
        connection.commit()
    return get_job(connection, job_id)


def is_cancel_requested(connection: sqlite3.Connection, job_id: str) -> bool:
    row = connection.execute("SELECT cancel_requested FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
    return bool(row and row["cancel_requested"])


def upsert_raw_asset(connection: sqlite3.Connection, metadata: RawMetadata, commit: bool = True) -> None:
    asset_metadata = {
        "capture_time": metadata.capture_time,
        "rating": metadata.rating,
        "camera_make": metadata.camera_make,
        "camera_model": metadata.camera_model,
        "lens_model": metadata.lens_model,
        "software": metadata.software,
        "iso": metadata.iso,
        "aperture": metadata.aperture,
        "shutter_speed": metadata.shutter_speed,
        "focal_length": metadata.focal_length,
        "flash": metadata.flash,
        "white_balance": metadata.white_balance,
        "color_space": metadata.color_space,
        "lens_specification": metadata.lens_specification,
        "gps_latitude": metadata.gps_latitude,
        "gps_longitude": metadata.gps_longitude,
        "width": metadata.width,
        "height": metadata.height,
        "normalized_stem": metadata.normalized_stem,
        "stem_key": metadata.stem_key,
        "file_size": metadata.file_size,
        "modified_time": metadata.modified_time,
        "metadata_level": metadata.metadata_level,
        "fingerprint_level": metadata.fingerprint_level,
        "enrichment_status": metadata.enrichment_status,
    }
    connection.execute(
        """
        INSERT INTO assets (
            asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, extension,
            fingerprint, file_size, modified_time, metadata_json, app_rating
        ) VALUES (?, 'raw', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            canonical_path = excluded.canonical_path,
            stem = excluded.stem,
            normalized_stem = excluded.normalized_stem,
            stem_key = excluded.stem_key,
            extension = excluded.extension,
            fingerprint = excluded.fingerprint,
            file_size = excluded.file_size,
            modified_time = excluded.modified_time,
            metadata_json = excluded.metadata_json,
            app_rating = COALESCE(assets.app_rating, excluded.app_rating),
            exists_on_disk = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            metadata.asset_id,
            str(metadata.path),
            metadata.stem,
            metadata.normalized_stem,
            metadata.stem_key,
            metadata.extension,
            metadata.fingerprint,
            metadata.file_size,
            metadata.modified_time,
            _json(asset_metadata),
            metadata.rating,
        ),
    )
    connection.execute(
        """
        INSERT INTO asset_files (file_id, asset_id, path, role)
        VALUES (?, ?, ?, 'primary')
        ON CONFLICT(path) DO UPDATE SET
            asset_id = excluded.asset_id,
            role = excluded.role
        """,
        (_file_id(metadata.asset_id, str(metadata.path)), metadata.asset_id, str(metadata.path)),
    )
    connection.execute(
        """
        INSERT INTO raw_metadata_cache (
            raw_asset_id, path, stem, normalized_stem, stem_key, capture_time, camera_model,
            lens_model, width, height, aspect_ratio, file_size, modified_time, fingerprint,
            metadata_level, fingerprint_level, enrichment_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(raw_asset_id) DO UPDATE SET
            path = excluded.path,
            stem = excluded.stem,
            normalized_stem = excluded.normalized_stem,
            stem_key = excluded.stem_key,
            capture_time = excluded.capture_time,
            camera_model = excluded.camera_model,
            lens_model = excluded.lens_model,
            width = excluded.width,
            height = excluded.height,
            aspect_ratio = excluded.aspect_ratio,
            file_size = excluded.file_size,
            modified_time = excluded.modified_time,
            fingerprint = excluded.fingerprint,
            metadata_level = excluded.metadata_level,
            fingerprint_level = excluded.fingerprint_level,
            enrichment_status = excluded.enrichment_status,
            cached_at = CURRENT_TIMESTAMP
        """,
        (
            metadata.asset_id,
            str(metadata.path),
            metadata.stem,
            metadata.normalized_stem,
            metadata.stem_key,
            metadata.capture_time,
            metadata.camera_model,
            metadata.lens_model,
            metadata.width,
            metadata.height,
            metadata.aspect_ratio,
            metadata.file_size,
            metadata.modified_time,
            metadata.fingerprint,
            metadata.metadata_level,
            metadata.fingerprint_level,
            metadata.enrichment_status,
        ),
    )
    if commit:
        connection.commit()


def upsert_export_asset(connection: sqlite3.Connection, export: ExportCandidate, commit: bool = True) -> str:
    existing = connection.execute(
        "SELECT asset_id FROM asset_files WHERE path = ?",
        (str(export.path),),
    ).fetchone()
    asset_id = str(existing["asset_id"]) if existing else export.asset_id
    asset_metadata = {
        "capture_time": export.capture_time,
        "rating": export.rating,
        "camera_make": export.camera_make,
        "camera_model": export.camera_model,
        "lens_model": export.lens_model,
        "software": export.software,
        "iso": export.iso,
        "aperture": export.aperture,
        "shutter_speed": export.shutter_speed,
        "focal_length": export.focal_length,
        "flash": export.flash,
        "white_balance": export.white_balance,
        "color_space": export.color_space,
        "lens_specification": export.lens_specification,
        "gps_latitude": export.gps_latitude,
        "gps_longitude": export.gps_longitude,
        "width": export.width,
        "height": export.height,
        "normalized_stem": export.normalized_stem,
        "stem_key": export.stem_key,
        "file_size": export.file_size,
        "modified_time": export.modified_time,
    }
    connection.execute(
        """
        INSERT INTO assets (
            asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, extension,
            fingerprint, file_size, modified_time, metadata_json, app_rating
        ) VALUES (?, 'export', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            canonical_path = excluded.canonical_path,
            stem = excluded.stem,
            normalized_stem = excluded.normalized_stem,
            stem_key = excluded.stem_key,
            extension = excluded.extension,
            fingerprint = excluded.fingerprint,
            file_size = excluded.file_size,
            modified_time = excluded.modified_time,
            metadata_json = excluded.metadata_json,
            app_rating = COALESCE(assets.app_rating, excluded.app_rating),
            exists_on_disk = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            asset_id,
            str(export.path),
            export.stem,
            export.normalized_stem,
            export.stem_key,
            export.extension,
            export.fingerprint,
            export.file_size,
            export.modified_time,
            _json(asset_metadata),
            export.rating,
        ),
    )
    connection.execute(
        """
        INSERT INTO asset_files (file_id, asset_id, path, role)
        VALUES (?, ?, ?, 'primary')
        ON CONFLICT(path) DO UPDATE SET
            asset_id = excluded.asset_id,
            role = excluded.role
        """,
        (_file_id(asset_id, str(export.path)), asset_id, str(export.path)),
    )
    if commit:
        connection.commit()
    return asset_id


def upsert_registry(connection: sqlite3.Connection, decision: MatchDecision, commit: bool = True) -> None:
    connection.execute(
        """
        INSERT INTO export_lookup_registry (
            export_path, export_asset_id, raw_asset_id, match_status, score, resolver_version,
            feature_vector_json, candidate_json, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('auto_bound', 'manual_confirmed') THEN CURRENT_TIMESTAMP END)
        ON CONFLICT(export_path) DO UPDATE SET
            export_asset_id = excluded.export_asset_id,
            raw_asset_id = excluded.raw_asset_id,
            match_status = excluded.match_status,
            score = excluded.score,
            resolver_version = excluded.resolver_version,
            feature_vector_json = excluded.feature_vector_json,
            candidate_json = excluded.candidate_json,
            confirmed_at = CASE
                WHEN excluded.match_status IN ('auto_bound', 'manual_confirmed') THEN CURRENT_TIMESTAMP
                ELSE export_lookup_registry.confirmed_at
            END,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            str(decision.export_path),
            decision.export_asset_id,
            decision.raw_asset_id,
            decision.status,
            decision.score,
            RESOLVER_VERSION,
            _json(decision.feature_vector),
            _json(decision.ranked_candidates),
            decision.status,
        ),
    )
    if decision.raw_asset_id and decision.status in {"auto_bound", "manual_confirmed"}:
        link_assets(
            connection,
            parent_asset_id=decision.raw_asset_id,
            child_asset_id=decision.export_asset_id,
            relation_type="source_of",
            confidence=decision.score,
            confirmed_by="system" if decision.status == "auto_bound" else "user",
        )
    if commit:
        connection.commit()


def link_assets(
    connection: sqlite3.Connection,
    parent_asset_id: str,
    child_asset_id: str,
    relation_type: str,
    confidence: float,
    confirmed_by: str,
    recipe_json: dict[str, object] | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO asset_links (
            link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
            confidence, confirmed_by, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(parent_asset_id, child_asset_id, relation_type) DO UPDATE SET
            recipe_json = excluded.recipe_json,
            confidence = excluded.confidence,
            confirmed_by = excluded.confirmed_by,
            confirmed_at = CURRENT_TIMESTAMP
        """,
        (
            _link_id(parent_asset_id, child_asset_id, relation_type),
            parent_asset_id,
            child_asset_id,
            relation_type,
            _json(recipe_json or {}),
            confidence,
            confirmed_by,
        ),
    )


def get_registry(connection: sqlite3.Connection, export_path: Path) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM export_lookup_registry WHERE export_path = ?",
        (str(export_path.resolve()),),
    ).fetchone()


def load_raw_cache(connection: sqlite3.Connection, limit: int = 200) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def load_raw_candidates(connection: sqlite3.Connection, stem_key: str, limit: int = 200) -> list[sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE stem_key = ?
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (stem_key, limit),
    ).fetchall()
    if rows:
        return rows
    return connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE normalized_stem LIKE ?
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (f"{stem_key}%", limit),
    ).fetchall()


def load_raw_candidates_by_camera_token(
    connection: sqlite3.Connection,
    token: str,
    limit: int = 200,
) -> list[sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE stem_key = ?
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (token, limit),
    ).fetchall()
    if rows:
        return rows
    return connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE normalized_stem LIKE ?
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (f"{token}%", limit),
    ).fetchall()


def load_raw_candidates_by_capture_window(
    connection: sqlite3.Connection,
    capture_time: str,
    *,
    camera_model: str | None = None,
    limit: int = 200,
) -> list[sqlite3.Row]:
    if camera_model:
        rows = connection.execute(
            """
            SELECT *
            FROM raw_metadata_cache
            WHERE camera_model = ?
              AND capture_time IS NOT NULL
            ORDER BY ABS(julianday(capture_time) - julianday(?)) ASC, cached_at DESC
            LIMIT ?
            """,
            (camera_model, capture_time, limit),
        ).fetchall()
        if rows:
            return rows
    return connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE capture_time IS NOT NULL
        ORDER BY ABS(julianday(capture_time) - julianday(?)) ASC, cached_at DESC
        LIMIT ?
        """,
        (capture_time, limit),
    ).fetchall()


def load_raw_candidates_by_camera(connection: sqlite3.Connection, camera_model: str, limit: int = 200) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE camera_model = ?
        ORDER BY cached_at DESC
        LIMIT ?
        """,
        (camera_model, limit),
    ).fetchall()


def load_raw_cache_index(connection: sqlite3.Connection, root: Path | None = None) -> dict[str, tuple[int, str]]:
    if root is None:
        rows = connection.execute(
            "SELECT path, file_size, modified_time FROM raw_metadata_cache"
        ).fetchall()
    else:
        rows = connection.execute(
            """
            SELECT path, file_size, modified_time
            FROM raw_metadata_cache
            WHERE path LIKE ?
            """,
            (f"{str(root.resolve())}%",),
        ).fetchall()
    return {row["path"]: (int(row["file_size"]), str(row["modified_time"])) for row in rows}


def load_raw_enrichment_candidates(
    connection: sqlite3.Connection,
    roots: list[Path] | None = None,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    query = [
        """
        SELECT *
        FROM raw_metadata_cache
        WHERE (metadata_level != 'full' OR enrichment_status != 'done')
        """
    ]
    params: list[object] = []
    if roots:
        predicates = []
        for root in roots:
            predicates.append("path LIKE ?")
            params.append(f"{str(root.resolve())}%")
        query.append(f"AND ({' OR '.join(predicates)})")
    query.append("ORDER BY cached_at ASC")
    if limit is not None:
        query.append("LIMIT ?")
        params.append(limit)
    return connection.execute("\n".join(query), params).fetchall()


def list_assets_for_preview(
    connection: sqlite3.Connection,
    asset_type: str | None = None,
    kind: str = "preview",
    limit: int | None = None,
    paths: list[Path] | None = None,
):
    query = [
        """
        SELECT
            assets.asset_id,
            assets.asset_type,
            assets.canonical_path,
            assets.extension,
            json_extract(assets.metadata_json, '$.width') AS width,
            json_extract(assets.metadata_json, '$.height') AS height,
            preview_entries.relative_path AS existing_relative_path,
            preview_entries.status AS existing_status
        FROM assets
        LEFT JOIN preview_entries
            ON preview_entries.asset_id = assets.asset_id
           AND preview_entries.kind = ?
        WHERE assets.exists_on_disk = 1
        """
    ]
    params: list[object] = [kind]
    if asset_type:
        query.append("AND assets.asset_type = ?")
        params.append(asset_type)
    if paths:
        path_clauses: list[str] = []
        for target_path in paths:
            resolved = target_path.resolve()
            if resolved.is_dir():
                path_clauses.append("(assets.canonical_path = ? OR assets.canonical_path LIKE ?)")
                params.append(str(resolved))
                params.append(f"{resolved}{os.sep}%")
            else:
                path_clauses.append("assets.canonical_path = ?")
                params.append(str(resolved))
        if path_clauses:
            query.append(f"AND ({' OR '.join(path_clauses)})")
    query.append(
        """
        ORDER BY
            CASE WHEN preview_entries.relative_path IS NULL OR preview_entries.status != 'ready' THEN 0 ELSE 1 END,
            assets.asset_type,
            assets.stem
        """
    )
    if limit is not None:
        query.append("LIMIT ?")
        params.append(limit)
    return connection.execute("\n".join(query), params).fetchall()


def list_assets_for_annotation(
    connection: sqlite3.Connection,
    *,
    asset_type: str | None = "export",
    only_missing: bool = True,
    asset_ids: list[str] | None = None,
    collection_id: str | None = None,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    """Assets eligible for AI annotation, with their best preview path.

    - only_missing=True restricts to assets that have NO annotation row yet
      (the default for "annotate all" / "annotate un-annotated").
    - asset_ids scopes to an explicit selection (multi-select right-click).
    - collection_id scopes to a folder/collection.
    Returns rows with asset_id, canonical_path, extension, and ready preview
    relative paths (preview-hd preferred) for the batch encoder.
    """
    joins = [
        "LEFT JOIN preview_entries AS hd ON hd.asset_id = assets.asset_id AND hd.kind = 'preview-hd' AND hd.status = 'ready'",
        "LEFT JOIN preview_entries AS sd ON sd.asset_id = assets.asset_id AND sd.kind = 'preview' AND sd.status = 'ready'",
        "LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id",
    ]
    where = ["assets.exists_on_disk = 1"]
    params: list[object] = []

    if collection_id:
        joins.append("JOIN collection_items AS ci ON ci.asset_id = assets.asset_id")
        where.append("ci.collection_id = ?")
        params.append(collection_id)
    if asset_type:
        where.append("assets.asset_type = ?")
        params.append(asset_type)
    if only_missing:
        where.append("anno.asset_id IS NULL")
    if asset_ids:
        placeholders = ",".join("?" for _ in asset_ids)
        where.append(f"assets.asset_id IN ({placeholders})")
        params.extend(asset_ids)

    sql = f"""
        SELECT
            assets.asset_id,
            assets.canonical_path,
            assets.extension,
            hd.relative_path AS preview_hd_relative_path,
            sd.relative_path AS preview_relative_path
        FROM assets
        {' '.join(joins)}
        WHERE {' AND '.join(where)}
        ORDER BY assets.asset_type, assets.stem
    """
    if limit is not None:
        sql += "\n        LIMIT ?"
        params.append(limit)
    return connection.execute(sql, params).fetchall()


def count_assets_for_annotation(
    connection: sqlite3.Connection,
    *,
    asset_type: str | None = "export",
    only_missing: bool = True,
    asset_ids: list[str] | None = None,
    collection_id: str | None = None,
) -> int:
    """How many assets a batch-annotation job would process (for UI counts)."""
    rows = list_assets_for_annotation(
        connection,
        asset_type=asset_type,
        only_missing=only_missing,
        asset_ids=asset_ids,
        collection_id=collection_id,
    )
    return len(rows)


def upsert_preview_entry(
    connection: sqlite3.Connection,
    asset_id: str,
    kind: str,
    relative_path: str,
    width: int | None,
    height: int | None,
    status: str,
    commit: bool = True,
) -> None:
    cache_key = sha1(f"{asset_id}:{kind}".encode("utf-8")).hexdigest()[:20]
    connection.execute(
        """
        INSERT INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
            relative_path = excluded.relative_path,
            width = excluded.width,
            height = excluded.height,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP
        """,
        (f"preview_{cache_key}", asset_id, kind, relative_path, width, height, status),
    )
    if commit:
        connection.commit()


def _browse_order_clause(sort: str | None) -> str:
    if sort == "name-desc":
        return "assets.stem DESC, registry.export_path"
    if sort == "imported-desc":
        return "assets.created_at DESC, assets.stem"
    if sort == "imported-asc":
        return "assets.created_at ASC, assets.stem"
    if sort == "captured-desc":
        return "json_extract(assets.metadata_json, '$.capture_time') DESC, assets.stem"
    if sort == "captured-asc":
        return "json_extract(assets.metadata_json, '$.capture_time') ASC, assets.stem"
    if sort == "rating-desc":
        return "CASE WHEN assets.app_rating IS NULL OR assets.app_rating = 0 THEN 1 ELSE 0 END, assets.app_rating DESC, assets.stem"
    # default: name-asc
    return "assets.stem, registry.export_path"


def _facet_clauses(filters: dict | None) -> tuple[str, list[object]]:
    """Build AND-combined WHERE fragments + params from a structured facet dict.

    Recognized keys: camera, lens (exact), iso_min/iso_max, aperture_min/max,
    focal_min/max, shutter_min/max, date_from/date_to (ISO, vs capture time),
    rating_min, orientation ('portrait'|'landscape'|'square'), tag (asset_tags).
    Unknown/empty keys are ignored.
    """
    if not filters:
        return "", []
    clauses: list[str] = []
    params: list[object] = []

    def add(clause: str, *vals: object) -> None:
        clauses.append(clause)
        params.extend(vals)

    if filters.get("camera"):
        add("assets.meta_camera_model = ?", filters["camera"])
    if filters.get("lens"):
        add("assets.meta_lens_model = ?", filters["lens"])
    for key, col in (("iso", "meta_iso"), ("aperture", "meta_aperture"),
                     ("focal", "meta_focal"), ("shutter", "meta_shutter")):
        lo, hi = filters.get(f"{key}_min"), filters.get(f"{key}_max")
        if lo is not None:
            add(f"assets.{col} >= ?", lo)
        if hi is not None:
            add(f"assets.{col} <= ?", hi)
    if filters.get("date_from"):
        add("date(assets.meta_capture_time) >= date(?)", filters["date_from"])
    if filters.get("date_to"):
        add("date(assets.meta_capture_time) <= date(?)", filters["date_to"])
    if filters.get("rating_min") is not None:
        add("assets.app_rating >= ?", filters["rating_min"])
    orientation = filters.get("orientation")
    if orientation == "portrait":
        add("assets.meta_height > assets.meta_width")
    elif orientation == "landscape":
        add("assets.meta_width > assets.meta_height")
    elif orientation == "square":
        add("assets.meta_width = assets.meta_height AND assets.meta_width IS NOT NULL")
    if filters.get("tag"):
        add("EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = assets.asset_id AND t.tag = ?)", filters["tag"])

    if not clauses:
        return "", []
    return "AND " + " AND ".join(clauses), params


def list_export_assets(
    connection: sqlite3.Connection,
    status: str,
    limit: int = 120,
    offset: int = 0,
    search: str | None = None,
    sort: str | None = None,
    filters: dict | None = None,
) -> list[sqlite3.Row]:
    if status == "matched":
        status_clause = "registry.match_status IN ('auto_bound', 'manual_confirmed')"
    elif status == "unmatched":
        status_clause = "registry.match_status IN ('unmatched', 'pending_confirmation')"
    elif status == "rated":
        status_clause = "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation') AND assets.app_rating > 0"
    elif status == "recent":
        status_clause = "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation') AND assets.created_at >= datetime('now', '-7 days')"
    elif status == "all":
        status_clause = "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation')"
    else:
        raise ValueError(f"unsupported status: {status}")

    params: list[object] = []
    search_clause = ""
    if search:
        # Full-text-ish search across filename/path, camera/lens, and the AI
        # annotation (caption, detected OCR text, tags). LIKE is plenty fast at
        # this scale; FTS5 can replace it later if libraries grow very large.
        search_clause = (
            "AND (assets.stem LIKE ? OR registry.export_path LIKE ? "
            "OR assets.meta_camera_model LIKE ? OR assets.meta_lens_model LIKE ? "
            "OR anno.caption LIKE ? OR anno.detected_text LIKE ? "
            "OR EXISTS (SELECT 1 FROM asset_tags st WHERE st.asset_id = assets.asset_id AND st.tag LIKE ?))"
        )
        like_pattern = f"%{search}%"
        params.extend([like_pattern] * 7)

    facet_clause, facet_params = _facet_clauses(filters)
    params.extend(facet_params)
    params.extend([limit, offset])

    return connection.execute(
        f"""
        SELECT
            assets.asset_id,
            assets.stem,
            registry.export_path AS export_path,
            assets.metadata_json AS export_metadata_json,
            assets.app_rating,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            preview_entries.relative_path AS preview_relative_path,
            preview_hd_entries.relative_path AS preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count,
            anno.provider AS anno_provider,
            anno.model AS anno_model,
            anno.schema_version AS anno_schema_version,
            anno.caption AS anno_caption,
            anno.tags_json AS anno_tags_json,
            anno.location_json AS anno_location_json,
            anno.detected_text AS anno_detected_text,
            anno.created_at AS anno_created_at,
            anno.updated_at AS anno_updated_at
        FROM export_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.export_asset_id
        LEFT JOIN asset_ai_annotations AS anno
            ON anno.asset_id = assets.asset_id
        LEFT JOIN assets AS raw_assets
            ON raw_assets.asset_id = registry.raw_asset_id
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN resource_sets AS rs
            ON rs.set_id = rsi.set_id
        LEFT JOIN assets AS primary_assets
            ON primary_assets.asset_id = rs.primary_asset_id
        LEFT JOIN (
            SELECT set_id, COUNT(*) AS set_item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS set_counts
            ON set_counts.set_id = rs.set_id
        LEFT JOIN preview_entries
            ON preview_entries.asset_id = assets.asset_id
           AND preview_entries.kind = 'preview'
           AND preview_entries.status = 'ready'
        LEFT JOIN preview_entries AS preview_hd_entries
            ON preview_hd_entries.asset_id = assets.asset_id
           AND preview_hd_entries.kind = 'preview-hd'
           AND preview_hd_entries.status = 'ready'
        WHERE {status_clause}
          {search_clause}
          {facet_clause}
        ORDER BY {_browse_order_clause(sort)}
        LIMIT ? OFFSET ?
        """,
        params,
    ).fetchall()


def get_facet_values(connection: sqlite3.Connection) -> dict[str, object]:
    """Available facet options for building the filter bar.

    Returns distinct cameras/lenses with counts, numeric min/max for the range
    sliders, and the capture-time span — all scoped to export assets.
    """
    base = "FROM assets WHERE asset_type = 'export'"

    def value_counts(col: str) -> list[dict[str, object]]:
        rows = connection.execute(
            f"SELECT assets.{col} AS v, COUNT(*) AS c {base} AND assets.{col} IS NOT NULL "
            f"AND assets.{col} != '' GROUP BY assets.{col} ORDER BY c DESC"
        ).fetchall()
        return [{"value": r["v"], "count": r["c"]} for r in rows]

    def min_max(col: str) -> dict[str, object]:
        r = connection.execute(
            f"SELECT MIN(assets.{col}) AS lo, MAX(assets.{col}) AS hi {base} AND assets.{col} IS NOT NULL"
        ).fetchone()
        return {"min": r["lo"], "max": r["hi"]}

    # Only the most-used tags for the default dropdown; the rest are reachable
    # via server-side search (search_facet_values) so this stays bounded even
    # with thousands of tags.
    tag_rows = connection.execute(
        """
        SELECT t.tag AS v, COUNT(*) AS c
        FROM asset_tags AS t
        JOIN assets AS a ON a.asset_id = t.asset_id AND a.asset_type = 'export'
        GROUP BY t.tag
        ORDER BY c DESC, t.tag
        LIMIT 60
        """
    ).fetchall()

    return {
        "cameras": value_counts("meta_camera_model"),
        "lenses": value_counts("meta_lens_model"),
        "tags": [{"value": r["v"], "count": r["c"]} for r in tag_rows],
        "iso": min_max("meta_iso"),
        "aperture": min_max("meta_aperture"),
        "focal": min_max("meta_focal"),
        "shutter": min_max("meta_shutter"),
        "capture_time": min_max("meta_capture_time"),
    }


def search_facet_values(
    connection: sqlite3.Connection,
    field: str,
    q: str = "",
    limit: int = 50,
) -> list[dict[str, object]]:
    """Server-side facet search, so a dropdown never loads more than `limit`
    rows regardless of how many distinct values exist. Matches substring,
    ordered by frequency."""
    like = f"%{q}%" if q else "%"
    if field == "tag":
        rows = connection.execute(
            """
            SELECT t.tag AS v, COUNT(*) AS c
            FROM asset_tags AS t
            JOIN assets AS a ON a.asset_id = t.asset_id AND a.asset_type = 'export'
            WHERE t.tag LIKE ?
            GROUP BY t.tag
            ORDER BY c DESC, t.tag
            LIMIT ?
            """,
            (like, limit),
        ).fetchall()
    elif field in ("camera", "lens"):
        col = "meta_camera_model" if field == "camera" else "meta_lens_model"
        rows = connection.execute(
            f"""
            SELECT assets.{col} AS v, COUNT(*) AS c
            FROM assets
            WHERE asset_type = 'export' AND assets.{col} IS NOT NULL
              AND assets.{col} != '' AND assets.{col} LIKE ?
            GROUP BY assets.{col}
            ORDER BY c DESC
            LIMIT ?
            """,
            (like, limit),
        ).fetchall()
    else:
        return []
    return [{"value": r["v"], "count": r["c"]} for r in rows]


def get_duplicate_assets(connection: sqlite3.Connection, asset_id: str) -> list[sqlite3.Row]:
    """Find other export assets with the same fingerprint (content duplicates)."""
    row = connection.execute(
        "SELECT fingerprint FROM assets WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    if not row or not row["fingerprint"]:
        return []
    return connection.execute(
        """
        SELECT asset_id, canonical_path AS export_path, stem
        FROM assets
        WHERE fingerprint = ? AND asset_id != ? AND asset_type = 'export'
        ORDER BY canonical_path
        """,
        (row["fingerprint"], asset_id),
    ).fetchall()


def split_shared_asset_ids(connection: sqlite3.Connection, commit: bool = True) -> int:
    """Fix assets where multiple registry entries share one asset_id (old format without path).

    For each duplicate group, the first entry keeps the original asset record;
    additional entries get a new asset record with a path-aware stable ID.
    """
    from .metadata import stable_asset_id

    dupes = connection.execute("""
        SELECT export_asset_id, COUNT(*) AS cnt
        FROM export_lookup_registry
        GROUP BY export_asset_id
        HAVING cnt > 1
    """).fetchall()

    split_count = 0
    for dupe in dupes:
        old_id = str(dupe["export_asset_id"])
        entries = connection.execute("""
            SELECT export_path, raw_asset_id, match_status, score,
                   resolver_version, feature_vector_json, candidate_json, confirmed_at
            FROM export_lookup_registry
            WHERE export_asset_id = ?
            ORDER BY export_path
        """, (old_id,)).fetchall()

        asset_row = connection.execute("""
            SELECT * FROM assets WHERE asset_id = ?
        """, (old_id,)).fetchone()
        if not asset_row:
            continue

        # Keep first entry on original asset, split the rest
        canonical_path = str(asset_row["canonical_path"])
        for entry in entries:
            entry_path = str(entry["export_path"])
            if entry_path == canonical_path:
                continue  # Keep original

            new_id = stable_asset_id("export", str(asset_row["fingerprint"]), entry_path)
            if new_id == old_id:
                continue  # Would collide, skip

            # Create new asset record
            connection.execute("""
                INSERT INTO assets (
                    asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key,
                    extension, fingerprint, file_size, modified_time, metadata_json, app_rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id) DO NOTHING
            """, (
                new_id,
                asset_row["asset_type"],
                entry_path,
                asset_row["stem"],
                asset_row["normalized_stem"],
                asset_row["stem_key"],
                asset_row["extension"],
                asset_row["fingerprint"],
                asset_row["file_size"],
                asset_row["modified_time"],
                asset_row["metadata_json"],
                asset_row["app_rating"],
            ))

            # Update registry to point to new asset
            connection.execute("""
                UPDATE export_lookup_registry
                SET export_asset_id = ?
                WHERE export_path = ? AND export_asset_id = ?
            """, (new_id, entry_path, old_id))

            # Update asset_files
            connection.execute("""
                UPDATE asset_files SET asset_id = ?, file_id = ?
                WHERE asset_id = ? AND path = ?
            """, (new_id, _file_id(new_id, entry_path), old_id, entry_path))

            # Update resource_set_items: create new membership for the split asset
            rsi = connection.execute("""
                SELECT set_id, role, version_kind, parent_asset_id, sort_order
                FROM resource_set_items WHERE asset_id = ?
            """, (old_id,)).fetchone()
            if rsi:
                parent = str(rsi["parent_asset_id"]) if rsi["parent_asset_id"] else None
                attach_asset_to_resource_set(
                    connection, new_id,
                    origin_asset_id=parent,
                    version_kind=str(rsi["version_kind"]),
                    commit=False,
                )

            # Update collection_items
            connection.execute("""
                INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at)
                SELECT collection_id, ?, added_at
                FROM collection_items WHERE asset_id = ?
            """, (new_id, old_id))

            # Share preview_entries (same preview file, different asset_id)
            connection.execute("""
                INSERT OR IGNORE INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status)
                SELECT ? || '_' || kind, ?, kind, relative_path, width, height, status
                FROM preview_entries WHERE asset_id = ?
            """, (new_id, new_id, old_id))

            split_count += 1

    if commit and split_count:
        connection.commit()
    return split_count


def remove_raw_from_resource_sets(connection: sqlite3.Connection, commit: bool = True) -> int:
    """Remove raw assets from resource sets — raw linkage is via registry, not sets."""
    removed = connection.execute("""
        DELETE FROM resource_set_items
        WHERE asset_id IN (SELECT asset_id FROM assets WHERE asset_type = 'raw')
    """).rowcount
    if removed:
        connection.execute("UPDATE resource_sets SET raw_asset_id = NULL WHERE raw_asset_id IS NOT NULL")
        # Clean up empty sets
        connection.execute("""
            DELETE FROM resource_sets WHERE set_id NOT IN (
                SELECT DISTINCT set_id FROM resource_set_items
            )
        """)
    if commit and removed:
        connection.commit()
    return removed


def get_export_asset_detail(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.stem,
            assets.canonical_path AS export_path,
            assets.metadata_json AS export_metadata_json,
            assets.app_rating,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            registry.feature_vector_json,
            registry.candidate_json,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            export_preview.relative_path AS export_preview_relative_path,
            raw_preview.relative_path AS raw_preview_relative_path,
            export_preview_hd.relative_path AS export_preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count
        FROM assets
        LEFT JOIN export_lookup_registry AS registry
            ON registry.rowid = (
                SELECT reg.rowid
                FROM export_lookup_registry AS reg
                WHERE reg.export_asset_id = assets.asset_id
                ORDER BY reg.updated_at DESC, reg.created_at DESC, reg.export_path DESC
                LIMIT 1
            )
        LEFT JOIN assets AS raw_assets
            ON raw_assets.asset_id = registry.raw_asset_id
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN resource_sets AS rs
            ON rs.set_id = rsi.set_id
        LEFT JOIN assets AS primary_assets
            ON primary_assets.asset_id = rs.primary_asset_id
        LEFT JOIN (
            SELECT set_id, COUNT(*) AS set_item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS set_counts
            ON set_counts.set_id = rs.set_id
        LEFT JOIN preview_entries AS export_preview
            ON export_preview.asset_id = assets.asset_id
           AND export_preview.kind = 'preview'
           AND export_preview.status = 'ready'
        LEFT JOIN preview_entries AS raw_preview
            ON raw_preview.asset_id = registry.raw_asset_id
           AND raw_preview.kind = 'preview'
           AND raw_preview.status = 'ready'
        LEFT JOIN preview_entries AS export_preview_hd
            ON export_preview_hd.asset_id = assets.asset_id
           AND export_preview_hd.kind = 'preview-hd'
           AND export_preview_hd.status = 'ready'
        WHERE assets.asset_id = ?
          AND assets.asset_type = 'export'
        """,
        (asset_id,),
    ).fetchone()


def get_export_asset_detail_by_path(connection: sqlite3.Connection, export_path: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.stem,
            registry.export_path AS export_path,
            assets.metadata_json AS export_metadata_json,
            assets.app_rating,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            registry.feature_vector_json,
            registry.candidate_json,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            export_preview.relative_path AS export_preview_relative_path,
            raw_preview.relative_path AS raw_preview_relative_path,
            export_preview_hd.relative_path AS export_preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count
        FROM export_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.export_asset_id
           AND assets.asset_type = 'export'
        LEFT JOIN assets AS raw_assets
            ON raw_assets.asset_id = registry.raw_asset_id
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN resource_sets AS rs
            ON rs.set_id = rsi.set_id
        LEFT JOIN assets AS primary_assets
            ON primary_assets.asset_id = rs.primary_asset_id
        LEFT JOIN (
            SELECT set_id, COUNT(*) AS set_item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS set_counts
            ON set_counts.set_id = rs.set_id
        LEFT JOIN preview_entries AS export_preview
            ON export_preview.asset_id = assets.asset_id
           AND export_preview.kind = 'preview'
           AND export_preview.status = 'ready'
        LEFT JOIN preview_entries AS raw_preview
            ON raw_preview.asset_id = registry.raw_asset_id
           AND raw_preview.kind = 'preview'
           AND raw_preview.status = 'ready'
        LEFT JOIN preview_entries AS export_preview_hd
            ON export_preview_hd.asset_id = assets.asset_id
           AND export_preview_hd.kind = 'preview-hd'
           AND export_preview_hd.status = 'ready'
        WHERE registry.export_path = ?
        """,
        (export_path,),
    ).fetchone()


def list_pending(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT export_path, export_asset_id, score, candidate_json
        FROM export_lookup_registry
        WHERE match_status = 'pending_confirmation'
        ORDER BY updated_at DESC
        """
    ).fetchall()


def confirm_match(connection: sqlite3.Connection, export_path: Path, raw_asset_id: str) -> None:
    registry = get_registry(connection, export_path)
    if registry is None:
        raise ValueError(f"no registry entry for {export_path}")

    connection.execute(
        """
        UPDATE export_lookup_registry
        SET raw_asset_id = ?, match_status = 'manual_confirmed', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE export_path = ?
        """,
        (raw_asset_id, str(export_path.resolve())),
    )
    link_assets(
        connection,
        parent_asset_id=raw_asset_id,
        child_asset_id=registry["export_asset_id"],
        relation_type="source_of",
        confidence=max(float(registry["score"]), 0.7),
        confirmed_by="user",
    )
    connection.commit()


def cleanup_orphan_export_assets(connection: sqlite3.Connection, commit: bool = True) -> dict[str, int]:
    orphan_rows = connection.execute(
        """
        SELECT orphan.asset_id AS orphan_asset_id, active.asset_id AS active_asset_id
        FROM assets AS orphan
        JOIN assets AS active
            ON active.asset_type = 'export'
           AND active.canonical_path = orphan.canonical_path
        JOIN asset_files AS active_files
            ON active_files.asset_id = active.asset_id
           AND active_files.path = active.canonical_path
        LEFT JOIN asset_files AS orphan_files
            ON orphan_files.asset_id = orphan.asset_id
        WHERE orphan.asset_type = 'export'
          AND orphan.asset_id != active.asset_id
          AND orphan_files.asset_id IS NULL
        ORDER BY orphan.canonical_path, orphan.asset_id
        """
    ).fetchall()
    metrics = {
        "found": len(orphan_rows),
        "deleted": 0,
        "previews_migrated": 0,
        "registry_relinked": 0,
        "links_relinked": 0,
    }

    for row in orphan_rows:
        orphan_asset_id = str(row["orphan_asset_id"])
        active_asset_id = str(row["active_asset_id"])

        preview_rows = connection.execute(
            """
            SELECT kind, relative_path, width, height, status
            FROM preview_entries
            WHERE asset_id = ?
            """,
            (orphan_asset_id,),
        ).fetchall()
        for preview in preview_rows:
            upsert_preview_entry(
                connection,
                active_asset_id,
                kind=str(preview["kind"]),
                relative_path=str(preview["relative_path"]),
                width=preview["width"],
                height=preview["height"],
                status=str(preview["status"]),
                commit=False,
            )
            metrics["previews_migrated"] += 1
        connection.execute("DELETE FROM preview_entries WHERE asset_id = ?", (orphan_asset_id,))

        metrics["registry_relinked"] += connection.execute(
            """
            UPDATE export_lookup_registry
            SET export_asset_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE export_asset_id = ?
            """,
            (active_asset_id, orphan_asset_id),
        ).rowcount

        link_rows = connection.execute(
            """
            SELECT link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
                   confidence, confirmed_by, confirmed_at
            FROM asset_links
            WHERE parent_asset_id = ? OR child_asset_id = ?
            """,
            (orphan_asset_id, orphan_asset_id),
        ).fetchall()
        for link in link_rows:
            parent_asset_id = active_asset_id if link["parent_asset_id"] == orphan_asset_id else str(link["parent_asset_id"])
            child_asset_id = active_asset_id if link["child_asset_id"] == orphan_asset_id else str(link["child_asset_id"])
            if parent_asset_id == child_asset_id:
                continue
            connection.execute(
                """
                INSERT INTO asset_links (
                    link_id, parent_asset_id, child_asset_id, relation_type, recipe_json,
                    confidence, confirmed_by, confirmed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(parent_asset_id, child_asset_id, relation_type) DO UPDATE SET
                    recipe_json = excluded.recipe_json,
                    confidence = excluded.confidence,
                    confirmed_by = excluded.confirmed_by,
                    confirmed_at = COALESCE(asset_links.confirmed_at, excluded.confirmed_at)
                """,
                (
                    _link_id(parent_asset_id, child_asset_id, str(link["relation_type"])),
                    parent_asset_id,
                    child_asset_id,
                    str(link["relation_type"]),
                    str(link["recipe_json"]),
                    float(link["confidence"]),
                    link["confirmed_by"],
                    link["confirmed_at"],
                ),
            )
            metrics["links_relinked"] += 1
        connection.execute(
            "DELETE FROM asset_links WHERE parent_asset_id = ? OR child_asset_id = ?",
            (orphan_asset_id, orphan_asset_id),
        )

        connection.execute("DELETE FROM assets WHERE asset_id = ?", (orphan_asset_id,))
        metrics["deleted"] += 1

    if commit:
        connection.commit()
    return metrics


def summary(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        "assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "raw_assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.asset_type = 'raw' AND assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "export_assets": connection.execute(
            """
            SELECT COUNT(DISTINCT asset_files.asset_id)
            FROM asset_files
            JOIN assets ON assets.asset_id = asset_files.asset_id
            WHERE assets.asset_type = 'export' AND assets.exists_on_disk = 1
            """
        ).fetchone()[0],
        "roots": connection.execute("SELECT COUNT(*) FROM catalog_roots WHERE is_active = 1").fetchone()[0],
        "preview_ready": connection.execute(
            "SELECT COUNT(*) FROM preview_entries WHERE kind = 'preview' AND status = 'ready'"
        ).fetchone()[0],
        "preview_hd_ready": connection.execute(
            "SELECT COUNT(*) FROM preview_entries WHERE kind = 'preview-hd' AND status = 'ready'"
        ).fetchone()[0],
        "pending_matches": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status = 'pending_confirmation'"
        ).fetchone()[0],
        "confirmed_matches": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status IN ('auto_bound', 'manual_confirmed')"
        ).fetchone()[0],
        "unmatched_exports": connection.execute(
            "SELECT COUNT(*) FROM export_lookup_registry WHERE match_status = 'unmatched'"
        ).fetchone()[0],
        "raw_fast_only": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level != 'full' OR enrichment_status != 'done'"
        ).fetchone()[0],
        "raw_enriched": connection.execute(
            "SELECT COUNT(*) FROM raw_metadata_cache WHERE metadata_level = 'full' AND enrichment_status = 'done'"
        ).fetchone()[0],
        "rated_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.export_asset_id)
            FROM export_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.export_asset_id
            WHERE assets.app_rating > 0
            """
        ).fetchone()[0],
        "recently_added_count": connection.execute(
            """
            SELECT COUNT(DISTINCT registry.export_asset_id)
            FROM export_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.export_asset_id
            WHERE assets.created_at >= datetime('now', '-7 days')
            """
        ).fetchone()[0],
    }


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

def _collection_id() -> str:
    return f"col_{uuid4().hex[:16]}"


def list_collections(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """
        SELECT c.*, COALESCE(counts.cnt, 0) AS item_count
        FROM collections c
        LEFT JOIN (
            SELECT collection_id, COUNT(*) AS cnt FROM collection_items GROUP BY collection_id
        ) counts ON counts.collection_id = c.collection_id
        ORDER BY c.sort_order, c.name
        """
    ).fetchall()
    return [dict(r) for r in rows]


def create_collection(
    connection: sqlite3.Connection,
    name: str,
    kind: str = "manual",
    rules_json: str = "[]",
    commit: bool = True,
) -> dict:
    collection_id = _collection_id()
    connection.execute(
        """
        INSERT INTO collections (collection_id, name, kind, rules_json)
        VALUES (?, ?, ?, ?)
        """,
        (collection_id, name, kind, rules_json),
    )
    if commit:
        connection.commit()
    return {"collection_id": collection_id, "name": name, "kind": kind}


def update_collection(
    connection: sqlite3.Connection,
    collection_id: str,
    name: str | None = None,
    rules_json: str | None = None,
    sort_order: int | None = None,
    commit: bool = True,
) -> None:
    parts: list[str] = []
    params: list[object] = []
    if name is not None:
        parts.append("name = ?")
        params.append(name)
    if rules_json is not None:
        parts.append("rules_json = ?")
        params.append(rules_json)
    if sort_order is not None:
        parts.append("sort_order = ?")
        params.append(sort_order)
    if not parts:
        return
    parts.append("updated_at = CURRENT_TIMESTAMP")
    params.append(collection_id)
    connection.execute(
        f"UPDATE collections SET {', '.join(parts)} WHERE collection_id = ?",
        params,
    )
    if commit:
        connection.commit()


def delete_collection(connection: sqlite3.Connection, collection_id: str, commit: bool = True) -> None:
    connection.execute("DELETE FROM collections WHERE collection_id = ?", (collection_id,))
    if commit:
        connection.commit()


def add_collection_items(
    connection: sqlite3.Connection,
    collection_id: str,
    asset_ids: list[str],
    commit: bool = True,
) -> int:
    added = 0
    for asset_id in asset_ids:
        added += connection.execute(
            "INSERT OR IGNORE INTO collection_items (collection_id, asset_id) VALUES (?, ?)",
            (collection_id, asset_id),
        ).rowcount
    if commit:
        connection.commit()
    return added


def remove_collection_items(
    connection: sqlite3.Connection,
    collection_id: str,
    asset_ids: list[str],
    commit: bool = True,
) -> int:
    removed = 0
    for asset_id in asset_ids:
        removed += connection.execute(
            "DELETE FROM collection_items WHERE collection_id = ? AND asset_id = ?",
            (collection_id, asset_id),
        ).rowcount
    if commit:
        connection.commit()
    return removed


def browse_collection(
    connection: sqlite3.Connection,
    collection_id: str,
    limit: int = 120,
    offset: int = 0,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.stem,
            registry.export_path AS export_path,
            assets.metadata_json AS export_metadata_json,
            assets.app_rating,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            preview_entries.relative_path AS preview_relative_path,
            preview_hd_entries.relative_path AS preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count,
            anno.provider AS anno_provider,
            anno.model AS anno_model,
            anno.schema_version AS anno_schema_version,
            anno.caption AS anno_caption,
            anno.tags_json AS anno_tags_json,
            anno.location_json AS anno_location_json,
            anno.detected_text AS anno_detected_text,
            anno.created_at AS anno_created_at,
            anno.updated_at AS anno_updated_at
        FROM collection_items ci
        JOIN assets ON assets.asset_id = ci.asset_id
        LEFT JOIN asset_ai_annotations AS anno
            ON anno.asset_id = assets.asset_id
        JOIN export_lookup_registry AS registry
            ON registry.export_asset_id = assets.asset_id
        LEFT JOIN assets AS raw_assets
            ON raw_assets.asset_id = registry.raw_asset_id
        LEFT JOIN resource_set_items AS rsi
            ON rsi.asset_id = assets.asset_id
        LEFT JOIN resource_sets AS rs
            ON rs.set_id = rsi.set_id
        LEFT JOIN assets AS primary_assets
            ON primary_assets.asset_id = rs.primary_asset_id
        LEFT JOIN (
            SELECT set_id, COUNT(*) AS set_item_count
            FROM resource_set_items
            GROUP BY set_id
        ) AS set_counts
            ON set_counts.set_id = rs.set_id
        LEFT JOIN preview_entries
            ON preview_entries.asset_id = assets.asset_id
           AND preview_entries.kind = 'preview'
           AND preview_entries.status = 'ready'
        LEFT JOIN preview_entries AS preview_hd_entries
            ON preview_hd_entries.asset_id = assets.asset_id
           AND preview_hd_entries.kind = 'preview-hd'
           AND preview_hd_entries.status = 'ready'
        WHERE ci.collection_id = ?
          AND assets.asset_type = 'export'
        ORDER BY ci.added_at DESC, assets.stem
        LIMIT ? OFFSET ?
        """,
        (collection_id, limit, offset),
    ).fetchall()


def delete_export_asset_from_catalog(
    connection: sqlite3.Connection,
    catalog_root: Path,
    asset_id: str,
    *,
    commit: bool = True,
) -> dict[str, object]:
    asset_row = connection.execute(
        """
        SELECT asset_id, asset_type, canonical_path
        FROM assets
        WHERE asset_id = ?
        """,
        (asset_id,),
    ).fetchone()
    if asset_row is None or str(asset_row["asset_type"]) != "export":
        raise ValueError(f"unknown export asset: {asset_id}")

    deleted_preview_paths: list[str] = []
    preview_rows = connection.execute(
        "SELECT relative_path FROM preview_entries WHERE asset_id = ?",
        (asset_id,),
    ).fetchall()
    for row in preview_rows:
        relative_path = str(row["relative_path"] or "")
        if not relative_path:
            continue
        preview_path = (catalog_root / relative_path).resolve()
        try:
            preview_path.unlink(missing_ok=True)
        except Exception:
            pass
        deleted_preview_paths.append(str(preview_path))
    connection.execute("DELETE FROM preview_entries WHERE asset_id = ?", (asset_id,))

    set_row = get_resource_set_for_asset(connection, asset_id)
    if set_row is not None:
        set_id = str(set_row["set_id"])
        connection.execute(
            "DELETE FROM resource_set_items WHERE set_id = ? AND asset_id = ?",
            (set_id, asset_id),
        )
        next_primary_row = connection.execute(
            """
            SELECT asset_id
            FROM resource_set_items
            WHERE set_id = ?
            ORDER BY sort_order, created_at, asset_id
            LIMIT 1
            """,
            (set_id,),
        ).fetchone()
        if next_primary_row is not None:
            next_primary_asset_id = str(next_primary_row["asset_id"])
            connection.execute(
                "UPDATE resource_sets SET primary_asset_id = ?, updated_at = CURRENT_TIMESTAMP WHERE set_id = ?",
                (next_primary_asset_id, set_id),
            )
            connection.execute(
                "UPDATE resource_set_items SET role = 'version' WHERE set_id = ? AND role = 'primary'",
                (set_id,),
            )
            connection.execute(
                "UPDATE resource_set_items SET role = 'primary' WHERE set_id = ? AND asset_id = ?",
                (set_id, next_primary_asset_id),
            )
        else:
            connection.execute("DELETE FROM resource_sets WHERE set_id = ?", (set_id,))

    # Any remaining resource_set_items rows that point at this asset as their
    # version parent would otherwise leave a dangling FK once the asset row is
    # gone, so detach them before the final delete.
    connection.execute(
        "UPDATE resource_set_items SET parent_asset_id = NULL WHERE parent_asset_id = ?",
        (asset_id,),
    )
    connection.execute("DELETE FROM collection_items WHERE asset_id = ?", (asset_id,))
    connection.execute(
        "DELETE FROM export_lookup_registry WHERE export_asset_id = ? OR raw_asset_id = ?",
        (asset_id, asset_id),
    )
    connection.execute(
        "DELETE FROM asset_links WHERE parent_asset_id = ? OR child_asset_id = ?",
        (asset_id, asset_id),
    )
    # Defensive: clear any other tables keyed by this asset_id (raw cache should
    # not hold an export asset, but stale rows must not block deletion).
    connection.execute("DELETE FROM raw_metadata_cache WHERE raw_asset_id = ?", (asset_id,))
    connection.execute("DELETE FROM asset_files WHERE asset_id = ?", (asset_id,))
    connection.execute("DELETE FROM assets WHERE asset_id = ?", (asset_id,))

    if commit:
        connection.commit()

    return {
        "asset_id": asset_id,
        "export_path": str(asset_row["canonical_path"]),
        "preview_files_deleted": deleted_preview_paths,
    }


def set_asset_rating(
    connection: sqlite3.Connection,
    asset_ids: list[str],
    rating: int | None,
    commit: bool = True,
) -> int:
    normalized = None if rating is None else max(0, min(5, int(rating)))
    updated = 0
    for asset_id in asset_ids:
        updated += connection.execute(
            """
            UPDATE assets
            SET app_rating = ?, updated_at = CURRENT_TIMESTAMP
            WHERE asset_id = ?
            """,
            (normalized, asset_id),
        ).rowcount
    if commit:
        connection.commit()
    return updated
