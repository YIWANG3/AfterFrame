"""Asset/registry upserts, raw-candidate loaders, preview entries, roots.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import os
import sqlite3
from hashlib import sha1
from pathlib import Path
from uuid import uuid4

from ..models import ExportCandidate, MatchDecision, RawMetadata

# Sentinel: distinguishes "don't touch error_text" from "clear it" in update_job.
_UNSET = object()
from ..schema import SCHEMA_STATEMENTS

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"
SCHEMA_VERSION = 5

from .core import _json
from .core import _file_id
from .resource_sets import get_resource_set_for_asset, link_assets




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


def list_pending(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT export_path, export_asset_id, score, candidate_json
        FROM export_lookup_registry
        WHERE match_status = 'pending_confirmation'
        ORDER BY updated_at DESC
        """
    ).fetchall()


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


def list_collage_sources(connection: sqlite3.Connection, asset_id: str) -> list[sqlite3.Row]:
    """Source assets composing this collage, in recipe order."""
    return connection.execute(
        """
        SELECT al.child_asset_id AS source_asset_id,
               json_extract(al.recipe_json, '$.sort_order') AS sort_order,
               a.stem, a.canonical_path,
               af.path AS export_path,
               pe.relative_path AS preview_relative_path
        FROM asset_links al
        JOIN assets a ON a.asset_id = al.child_asset_id
        LEFT JOIN asset_files af ON af.asset_id = al.child_asset_id AND af.role = 'canonical'
        LEFT JOIN preview_entries pe ON pe.asset_id = al.child_asset_id AND pe.kind = 'preview'
        WHERE al.parent_asset_id = ? AND al.relation_type = 'collage_source'
        ORDER BY json_extract(al.recipe_json, '$.sort_order')
        """,
        (asset_id,),
    ).fetchall()


def list_collages_using_asset(connection: sqlite3.Connection, asset_id: str) -> list[sqlite3.Row]:
    """Collages that include this asset as a source."""
    return connection.execute(
        """
        SELECT al.parent_asset_id AS collage_asset_id,
               a.stem, a.canonical_path,
               af.path AS export_path,
               pe.relative_path AS preview_relative_path
        FROM asset_links al
        JOIN assets a ON a.asset_id = al.parent_asset_id
        LEFT JOIN asset_files af ON af.asset_id = al.parent_asset_id AND af.role = 'canonical'
        LEFT JOIN preview_entries pe ON pe.asset_id = al.parent_asset_id AND pe.kind = 'preview'
        WHERE al.child_asset_id = ? AND al.relation_type = 'collage_source'
        """,
        (asset_id,),
    ).fetchall()
