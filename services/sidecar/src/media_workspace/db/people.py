"""Persistence primitives for local people recognition.

The native worker owns detection/alignment/embedding inference. This module owns
the catalog representation of those results, including the model-version
boundary that prevents incompatible embeddings from being mixed.
"""
from __future__ import annotations

import json
import math
import sqlite3
import struct
from typing import Any, Callable, Iterable
from uuid import uuid4

import numpy as np

from .core import _json

EMBEDDING_DIMENSIONS = 512
_QUALITY_VALUES = {"standard", "low"}


def upsert_face_model(
    connection: sqlite3.Connection,
    *,
    model_id: str,
    model_version: str,
    kind: str,
    manifest_hash: str,
    status: str = "ready",
    commit: bool = True,
) -> dict[str, object]:
    connection.execute(
        """
        INSERT INTO face_models (model_id, model_version, kind, manifest_hash, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(model_id, model_version) DO UPDATE SET
            kind = excluded.kind,
            manifest_hash = excluded.manifest_hash,
            status = excluded.status
        """,
        (model_id, model_version, kind, manifest_hash, status),
    )
    if commit:
        connection.commit()
    row = connection.execute(
        """
        SELECT model_id, model_version, kind, manifest_hash, status, installed_at
        FROM face_models WHERE model_id = ? AND model_version = ?
        """,
        (model_id, model_version),
    ).fetchone()
    return dict(row or {})


def get_people_asset_index(
    connection: sqlite3.Connection,
    *,
    asset_id: str,
    model_id: str,
    model_version: str,
) -> dict[str, object] | None:
    row = connection.execute(
        """
        SELECT asset_id, model_id, model_version, input_hash, status, face_count,
               error_text, indexed_at, updated_at
        FROM people_asset_index
        WHERE asset_id = ? AND model_id = ? AND model_version = ?
        """,
        (asset_id, model_id, model_version),
    ).fetchone()
    return dict(row) if row is not None else None


def upsert_people_asset_index(
    connection: sqlite3.Connection,
    *,
    asset_id: str,
    model_id: str,
    model_version: str,
    input_hash: str | None,
    status: str,
    face_count: int = 0,
    error_text: str | None = None,
    commit: bool = True,
) -> dict[str, object]:
    connection.execute(
        """
        INSERT INTO people_asset_index (
            asset_id, model_id, model_version, input_hash, status, face_count,
            error_text, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(asset_id, model_id, model_version) DO UPDATE SET
            input_hash = excluded.input_hash,
            status = excluded.status,
            face_count = excluded.face_count,
            error_text = excluded.error_text,
            indexed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        """,
        (asset_id, model_id, model_version, input_hash, status, face_count, error_text),
    )
    if commit:
        connection.commit()
    return get_people_asset_index(
        connection,
        asset_id=asset_id,
        model_id=model_id,
        model_version=model_version,
    ) or {}


def replace_asset_faces(
    connection: sqlite3.Connection,
    *,
    asset_id: str,
    model_id: str,
    model_version: str,
    input_hash: str,
    faces: Iterable[dict[str, Any]],
    commit: bool = True,
) -> list[dict[str, object]]:
    """Atomically replace one asset's automatic face records for a model.

    Re-analysis invalidates automatic membership for the replaced faces through
    foreign-key cascades. Confirmed group policy is handled by the future
    clustering/correction layer; this low-level writer only persists model output.
    """
    prepared = [_validate_face(face) for face in faces]
    savepoint = "people_replace_faces"
    nested = connection.in_transaction
    if nested:
        connection.execute(f"SAVEPOINT {savepoint}")
    else:
        connection.execute("BEGIN")
    try:
        connection.execute(
            """
            DELETE FROM asset_faces
            WHERE asset_id = ? AND model_id = ? AND model_version = ?
            """,
            (asset_id, model_id, model_version),
        )
        inserted: list[dict[str, object]] = []
        for face in prepared:
            face_id = f"face_{uuid4().hex}"
            connection.execute(
                """
                INSERT INTO asset_faces (
                    face_id, asset_id, model_id, model_version, bbox_json,
                    landmarks_json, quality, detection_confidence, embedding_blob,
                    thumbnail_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    face_id,
                    asset_id,
                    model_id,
                    model_version,
                    _json(face["bounding_box"]),
                    _json(face["landmarks"]),
                    face["quality"],
                    face["confidence"],
                    sqlite3.Binary(face["embedding_blob"]),
                    face.get("thumbnail_key"),
                ),
            )
            inserted.append({"face_id": face_id, **_public_face(face)})
        # Empty candidate groups are an implementation artefact after an asset
        # refresh. Confirmed groups stay intact so a later correction layer can
        # surface the missing members instead of silently deleting the person.
        connection.execute(
            """
            DELETE FROM person_groups
            WHERE state = 'candidate'
              AND NOT EXISTS (
                  SELECT 1 FROM person_group_faces pgf
                  WHERE pgf.group_id = person_groups.group_id
              )
            """
        )
        upsert_people_asset_index(
            connection,
            asset_id=asset_id,
            model_id=model_id,
            model_version=model_version,
            input_hash=input_hash,
            status="indexed",
            face_count=len(inserted),
            error_text=None,
            commit=False,
        )
        if nested:
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        elif commit:
            connection.commit()
        return inserted
    except Exception:
        if nested:
            connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            connection.rollback()
        raise


def list_asset_faces(
    connection: sqlite3.Connection,
    *,
    asset_id: str,
    model_id: str,
    model_version: str,
    include_embedding: bool = False,
) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT face_id, bbox_json, landmarks_json, quality, detection_confidence,
               embedding_blob, thumbnail_key, created_at
        FROM asset_faces
        WHERE asset_id = ? AND model_id = ? AND model_version = ?
        ORDER BY created_at ASC, face_id ASC
        """,
        (asset_id, model_id, model_version),
    ).fetchall()
    result: list[dict[str, object]] = []
    for row in rows:
        payload: dict[str, object] = {
            "face_id": row["face_id"],
            "bounding_box": json.loads(row["bbox_json"]),
            "landmarks": json.loads(row["landmarks_json"]),
            "quality": row["quality"],
            "confidence": float(row["detection_confidence"]),
            "thumbnail_key": row["thumbnail_key"],
            "created_at": row["created_at"],
        }
        if include_embedding:
            payload["embedding"] = _decode_embedding(row["embedding_blob"])
        result.append(payload)
    return result


def list_people_index_candidates(
    connection: sqlite3.Connection,
    *,
    model_id: str,
    model_version: str,
    asset_ids: Iterable[str] | None = None,
    limit: int | None = None,
) -> list[dict[str, object]]:
    """Return deterministic image assets and their current model-specific hash.

    The worker still decodes an asset to calculate people_input_hash, but a
    matching value lets it skip Vision/Core ML inference entirely.
    """
    params: list[object] = [model_id, model_version]
    asset_clause = ""
    ids = list(asset_ids or [])
    if ids:
        placeholders = ", ".join("?" for _ in ids)
        asset_clause = f"AND assets.asset_id IN ({placeholders})"
        params.extend(ids)
    limit_clause = ""
    if limit is not None:
        limit_clause = "LIMIT ?"
        params.append(limit)
    rows = connection.execute(
        f"""
        SELECT assets.asset_id, assets.canonical_path,
               people_asset_index.input_hash, people_asset_index.status AS index_status
        FROM assets
        LEFT JOIN people_asset_index
          ON people_asset_index.asset_id = assets.asset_id
         AND people_asset_index.model_id = ?
         AND people_asset_index.model_version = ?
        WHERE assets.asset_type = 'image'
          AND assets.exists_on_disk = 1
          {asset_clause}
        ORDER BY assets.asset_id ASC
        {limit_clause}
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def rebuild_candidate_groups(
    connection: sqlite3.Connection,
    *,
    model_id: str,
    model_version: str,
    threshold: float = 0.48,
    chain_slack: float = 0.10,
    low_quality_margin: float = 0.06,
    max_neighbors: int = 64,
    checkpoint: Callable[[], None] | None = None,
    commit: bool = True,
) -> dict[str, int]:
    """Rebuild automatic candidate groups for one exact embedding space.

    Greedy average-link agglomeration over above-threshold pairs. Two clusters
    merge only while their mean cross-similarity stays above ``threshold`` and
    their weakest cross pair stays above ``threshold - chain_slack``, which
    blocks the transitive chains that single-link merging produces. Faces that
    appear in the same photo are different people by default (a cannot-link),
    so clusters sharing an asset never merge automatically. Named and confirmed
    groups are deliberately left untouched.
    """
    if not 0.0 < threshold < 1.0:
        raise ValueError("candidate group threshold must be between 0 and 1")
    if chain_slack < 0:
        raise ValueError("chain_slack must not be negative")
    if low_quality_margin < 0:
        raise ValueError("low_quality_margin must not be negative")
    if max_neighbors < 1:
        raise ValueError("max_neighbors must be positive")
    checkpoint = checkpoint or (lambda: None)
    savepoint = "people_rebuild_candidates"
    nested = connection.in_transaction
    if nested:
        connection.execute(f"SAVEPOINT {savepoint}")
    else:
        connection.execute("BEGIN")
    try:
        checkpoint()
        # Explicit membership delete first: relying on the FK cascade would
        # leave orphan rows on any connection without PRAGMA foreign_keys, and
        # a stale row later fails the UNIQUE(face_id) insert mid-rebuild.
        # Rejected rows are user corrections — they must survive the rebuild,
        # so their candidate group stays behind as an invisible tombstone that
        # keeps those faces out of automatic clustering forever.
        connection.execute(
            """
            DELETE FROM person_group_faces
            WHERE membership_state != 'rejected'
              AND group_id IN (
                  SELECT group_id FROM person_groups
                  WHERE model_id = ? AND model_version = ? AND state = 'candidate'
              )
            """,
            (model_id, model_version),
        )
        connection.execute(
            """
            DELETE FROM person_groups
            WHERE model_id = ? AND model_version = ? AND state = 'candidate'
              AND NOT EXISTS (
                  SELECT 1 FROM person_group_faces
                  WHERE person_group_faces.group_id = person_groups.group_id
              )
            """,
            (model_id, model_version),
        )
        # Surviving groups can lose their cover when the cover face's asset is
        # re-analyzed (FK sets cover_face_id NULL). Re-point them at their most
        # confident remaining member so the wall never shows an empty tile.
        connection.execute(
            """
            UPDATE person_groups
            SET cover_face_id = (
                SELECT pgf.face_id
                FROM person_group_faces AS pgf
                JOIN asset_faces AS af ON af.face_id = pgf.face_id
                WHERE pgf.group_id = person_groups.group_id
                  AND pgf.membership_state != 'rejected'
                ORDER BY af.detection_confidence DESC, pgf.face_id ASC
                LIMIT 1
            ), updated_at = CURRENT_TIMESTAMP
            WHERE model_id = ? AND model_version = ?
              AND cover_face_id IS NULL
              AND EXISTS (
                  SELECT 1 FROM person_group_faces AS pgf
                  WHERE pgf.group_id = person_groups.group_id
              )
            """,
            (model_id, model_version),
        )
        # Every face still holding a membership belongs to a surviving group
        # (confirmed or ignored) — both are user decisions the automatic pass
        # must not reshuffle into new candidates.
        rows = connection.execute(
            """
            SELECT f.face_id, f.asset_id, f.embedding_blob, f.quality
            FROM asset_faces AS f
            WHERE f.model_id = ? AND f.model_version = ?
              AND NOT EXISTS (
                  SELECT 1 FROM person_group_faces AS pgf
                  WHERE pgf.face_id = f.face_id
              )
            ORDER BY f.face_id ASC
            """,
            (model_id, model_version),
        ).fetchall()
        if len(rows) < 2:
            if nested:
                connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            elif commit:
                connection.commit()
            return {"faces": len(rows), "groups": 0, "members": 0}

        vectors = np.vstack([
            np.frombuffer(row["embedding_blob"], dtype="<f4", count=EMBEDDING_DIMENSIONS)
            for row in rows
        ]).astype(np.float32, copy=False)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), np.finfo(np.float32).eps)
        low_quality = np.asarray([row["quality"] == "low" for row in rows], dtype=bool)
        asset_ids = [row["asset_id"] for row in rows]

        # Collect above-threshold candidate edges blockwise: at 10k faces a
        # 512-row block occupies ~20 MB, and capping neighbors per face keeps
        # the edge list linear in the number of faces. Low-quality faces need
        # a stricter similarity before they may pull clusters together.
        edges: list[tuple[float, int, int]] = []
        for start in range(0, len(rows), 512):
            checkpoint()
            end = min(len(rows), start + 512)
            similarities = vectors[start:end] @ vectors[:end].T
            required = np.full(similarities.shape, threshold, dtype=np.float32)
            required[np.logical_or(low_quality[start:end, None], low_quality[None, :end])] += low_quality_margin
            for local_index in range(end - start):
                global_index = start + local_index
                candidates = np.flatnonzero(
                    similarities[local_index, :global_index] >= required[local_index, :global_index]
                )
                if len(candidates) > max_neighbors:
                    strongest = np.argsort(similarities[local_index, candidates])[-max_neighbors:]
                    candidates = candidates[strongest]
                for candidate in candidates.tolist():
                    if asset_ids[global_index] == asset_ids[candidate]:
                        continue
                    edges.append((float(similarities[local_index, candidate]), int(candidate), global_index))

        # Strongest pairs merge first; index tie-breaks keep runs deterministic.
        edges.sort(key=lambda edge: (-edge[0], edge[1], edge[2]))
        min_link = threshold - chain_slack
        parent = list(range(len(rows)))
        cluster_members: dict[int, list[int]] = {index: [index] for index in range(len(rows))}
        cluster_assets: dict[int, set[str]] = {index: {asset_ids[index]} for index in range(len(rows))}
        cluster_sums: dict[int, np.ndarray] = {index: vectors[index].astype(np.float64) for index in range(len(rows))}

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        for edge_index, (similarity, left, right) in enumerate(edges):
            if edge_index % 256 == 0:
                checkpoint()
            root_left, root_right = find(left), find(right)
            if root_left == root_right:
                continue
            if cluster_assets[root_left] & cluster_assets[root_right]:
                continue
            members_left = cluster_members[root_left]
            members_right = cluster_members[root_right]
            pair_count = len(members_left) * len(members_right)
            mean_cross = float(cluster_sums[root_left] @ cluster_sums[root_right]) / pair_count
            if mean_cross < threshold:
                continue
            if pair_count > 1:
                cross = vectors[members_left] @ vectors[members_right].T
                if float(cross.min()) < min_link:
                    continue
            keep, drop = (root_left, root_right) if root_left < root_right else (root_right, root_left)
            parent[drop] = keep
            cluster_members[keep] = cluster_members[keep] + cluster_members.pop(drop)
            cluster_assets[keep] |= cluster_assets.pop(drop)
            cluster_sums[keep] = cluster_sums[keep] + cluster_sums.pop(drop)

        groups = 0
        members_total = 0
        for members in sorted(cluster_members.values(), key=lambda values: (values[0], len(values))):
            if len(members) < 2:
                continue
            # The medoid face is the most representative cover; standard quality
            # beats low quality regardless of centrality.
            member_vectors = vectors[members]
            centrality = member_vectors @ member_vectors.sum(axis=0)
            cover_index = max(
                range(len(members)),
                key=lambda position: (
                    not low_quality[members[position]],
                    float(centrality[position]),
                    rows[members[position]]["face_id"],
                ),
            )
            cover_index = members[cover_index]
            group_id = f"person_{uuid4().hex}"
            connection.execute(
                """
                INSERT INTO person_groups (group_id, model_id, model_version, cover_face_id, state)
                VALUES (?, ?, ?, ?, 'candidate')
                """,
                (group_id, model_id, model_version, rows[cover_index]["face_id"]),
            )
            connection.executemany(
                """
                INSERT INTO person_group_faces (group_id, face_id, membership_state, source)
                VALUES (?, ?, 'automatic', 'automatic')
                """,
                [(group_id, rows[index]["face_id"]) for index in members],
            )
            groups += 1
            members_total += len(members)
        if nested:
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        elif commit:
            connection.commit()
        return {"faces": len(rows), "groups": groups, "members": members_total}
    except Exception:
        if nested:
            connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            connection.rollback()
        raise


def list_person_groups(
    connection: sqlite3.Connection,
    *,
    state: str | None = None,
) -> list[dict[str, object]]:
    """Return people candidates with a stable cover image for the people view.

    The renderer receives groups rather than raw embeddings. Opening a group is
    then an ordinary asset browse filtered by ``group_id``, which also leaves a
    clean boundary for future correction actions.
    """
    states = {"candidate", "confirmed", "ignored"}
    if state is not None and state not in states:
        raise ValueError(f"unsupported person group state: {state!r}")

    params: list[object] = []
    state_clause = "pg.state != 'ignored'"
    if state is not None:
        state_clause = "pg.state = ?"
        params.append(state)
    rows = connection.execute(
        f"""
        SELECT
            pg.group_id,
            pg.name,
            pg.state,
            pg.model_id,
            pg.model_version,
            pg.created_at,
            COUNT(DISTINCT pgf.face_id) AS face_count,
            cover.face_id AS cover_face_id,
            cover.asset_id AS cover_asset_id,
            cover.bbox_json AS cover_bbox_json,
            cover_asset.canonical_path AS cover_image_path,
            preview.relative_path AS cover_preview_relative_path
        FROM person_groups AS pg
        LEFT JOIN person_group_faces AS pgf
            ON pgf.group_id = pg.group_id
           AND pgf.membership_state != 'rejected'
        -- Deleting the cover's photo nulls cover_face_id (FK). Fall back to the
        -- most confident member at read time so the wall never shows a blank
        -- tile while waiting for the next rebuild.
        LEFT JOIN asset_faces AS cover
            ON cover.face_id = COALESCE(
                pg.cover_face_id,
                (
                    SELECT pgf2.face_id
                    FROM person_group_faces AS pgf2
                    JOIN asset_faces AS af2 ON af2.face_id = pgf2.face_id
                    WHERE pgf2.group_id = pg.group_id
                      AND pgf2.membership_state != 'rejected'
                    ORDER BY af2.detection_confidence DESC, pgf2.face_id ASC
                    LIMIT 1
                )
            )
        LEFT JOIN assets AS cover_asset
            ON cover_asset.asset_id = cover.asset_id
        LEFT JOIN preview_entries AS preview
            ON preview.asset_id = cover.asset_id
           AND preview.kind = 'preview'
           AND preview.status = 'ready'
        WHERE {state_clause}
        GROUP BY pg.group_id
        -- Unnamed groups whose members were all rejected are correction
        -- tombstones, not people — hide them. Named people stay even at zero.
        HAVING COUNT(DISTINCT pgf.face_id) > 0 OR pg.name IS NOT NULL
        ORDER BY (pg.name IS NULL) ASC, face_count DESC, pg.created_at ASC, pg.group_id ASC
        """,
        params,
    ).fetchall()
    result: list[dict[str, object]] = []
    for row in rows:
        payload = dict(row)
        bbox_json = payload.pop("cover_bbox_json", None)
        payload["cover_bbox"] = json.loads(bbox_json) if bbox_json else None
        result.append(payload)
    return result


def _person_group_row(connection: sqlite3.Connection, group_id: str) -> dict[str, object]:
    row = connection.execute(
        """
        SELECT pg.group_id, pg.name, pg.state, pg.model_id, pg.model_version,
               pg.cover_face_id, pg.created_at, pg.updated_at,
               COUNT(pgf.face_id) AS face_count
        FROM person_groups AS pg
        LEFT JOIN person_group_faces AS pgf
            ON pgf.group_id = pg.group_id AND pgf.membership_state != 'rejected'
        WHERE pg.group_id = ?
        GROUP BY pg.group_id
        """,
        (group_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"unknown person group: {group_id!r}")
    return dict(row)


def list_similar_person_groups(
    connection: sqlite3.Connection,
    *,
    group_id: str,
    limit: int = 10,
) -> list[dict[str, object]]:
    """Named people ranked by centroid cosine similarity to one group.

    Backs the naming popover's merge suggestions: the most likely "same
    person" targets surface first instead of a face-count phone book. Only
    groups in the same embedding space are comparable (and mergeable).
    """
    if limit < 1:
        raise ValueError("limit must be positive")
    source = _person_group_row(connection, group_id)
    rows = connection.execute(
        """
        SELECT pg.group_id, f.embedding_blob
        FROM person_groups AS pg
        JOIN person_group_faces AS pgf
            ON pgf.group_id = pg.group_id AND pgf.membership_state != 'rejected'
        JOIN asset_faces AS f ON f.face_id = pgf.face_id
        WHERE pg.model_id = ? AND pg.model_version = ?
          AND (
              pg.group_id = ?
              OR (pg.name IS NOT NULL AND TRIM(pg.name) != '' AND pg.state != 'ignored')
          )
        """,
        (source["model_id"], source["model_version"], group_id),
    ).fetchall()
    sums: dict[str, np.ndarray] = {}
    for row in rows:
        vector = np.frombuffer(row["embedding_blob"], dtype="<f4", count=EMBEDDING_DIMENSIONS).astype(np.float64)
        norm = float(np.linalg.norm(vector))
        if norm <= 0:
            continue
        key = row["group_id"]
        sums[key] = sums.get(key, 0) + vector / norm
    source_sum = sums.pop(group_id, None)
    if source_sum is None or not sums:
        return []
    source_centroid = source_sum / np.linalg.norm(source_sum)
    scores: dict[str, float] = {}
    for key, total in sums.items():
        scores[key] = float(source_centroid @ (total / np.linalg.norm(total)))
    payload_by_id = {group["group_id"]: group for group in list_person_groups(connection)}
    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    result: list[dict[str, object]] = []
    for key, score in ranked[:limit]:
        group = payload_by_id.get(key)
        if group is None:
            continue
        result.append({**group, "similarity": round(score, 4)})
    return result


def get_person_group_detail(
    connection: sqlite3.Connection,
    *,
    group_id: str,
    face_limit: int = 40,
    face_offset: int = 0,
) -> dict[str, object]:
    """Group summary plus one page of member faces for the inspector.

    Faces are ordered by detection confidence; page through with
    ``face_offset`` — ``face_count`` in the summary tells the caller when
    everything has been fetched.
    """
    if face_limit < 1:
        raise ValueError("face_limit must be positive")
    if face_offset < 0:
        raise ValueError("face_offset must not be negative")
    summary = _person_group_row(connection, group_id)
    photo_count = connection.execute(
        """
        SELECT COUNT(DISTINCT f.asset_id) AS n
        FROM person_group_faces AS pgf
        JOIN asset_faces AS f ON f.face_id = pgf.face_id
        WHERE pgf.group_id = ? AND pgf.membership_state != 'rejected'
        """,
        (group_id,),
    ).fetchone()["n"]
    rows = connection.execute(
        """
        SELECT f.face_id, f.asset_id, f.bbox_json, f.quality,
               assets.canonical_path AS image_path,
               preview.relative_path AS preview_relative_path
        FROM person_group_faces AS pgf
        JOIN asset_faces AS f ON f.face_id = pgf.face_id
        JOIN assets ON assets.asset_id = f.asset_id
        LEFT JOIN preview_entries AS preview
            ON preview.asset_id = f.asset_id
           AND preview.kind = 'preview'
           AND preview.status = 'ready'
        WHERE pgf.group_id = ? AND pgf.membership_state != 'rejected'
        ORDER BY f.detection_confidence DESC, f.face_id ASC
        LIMIT ? OFFSET ?
        """,
        (group_id, face_limit, face_offset),
    ).fetchall()
    faces = [{
        "face_id": row["face_id"],
        "asset_id": row["asset_id"],
        "bounding_box": json.loads(row["bbox_json"]),
        "quality": row["quality"],
        "image_path": row["image_path"],
        "preview_relative_path": row["preview_relative_path"],
    } for row in rows]
    return {**summary, "photo_count": photo_count, "faces": faces, "face_offset": face_offset}


def set_person_group_name(
    connection: sqlite3.Connection,
    *,
    group_id: str,
    name: str,
    commit: bool = True,
) -> dict[str, object]:
    """Name a person group. Naming is the confirmation gesture, so a candidate
    becomes a confirmed person the moment the user names it."""
    cleaned = str(name or "").strip()
    if not cleaned:
        raise ValueError("person name must not be empty")
    _person_group_row(connection, group_id)
    connection.execute(
        """
        UPDATE person_groups
        SET name = ?, state = 'confirmed', updated_at = CURRENT_TIMESTAMP
        WHERE group_id = ?
        """,
        (cleaned, group_id),
    )
    if commit:
        connection.commit()
    return _person_group_row(connection, group_id)


def set_person_group_state(
    connection: sqlite3.Connection,
    *,
    group_id: str,
    state: str,
    commit: bool = True,
) -> dict[str, object]:
    if state not in {"candidate", "confirmed", "ignored"}:
        raise ValueError(f"unsupported person group state: {state!r}")
    _person_group_row(connection, group_id)
    connection.execute(
        "UPDATE person_groups SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE group_id = ?",
        (state, group_id),
    )
    if commit:
        connection.commit()
    return _person_group_row(connection, group_id)


def _cleanup_group_after_departure(connection: sqlite3.Connection, group_id: str, face_id: str) -> None:
    """Shared tail for corrections that take a face away from a group."""
    connection.execute(
        "UPDATE person_groups SET cover_face_id = NULL, updated_at = CURRENT_TIMESTAMP "
        "WHERE group_id = ? AND cover_face_id = ?",
        (group_id, face_id),
    )
    # An unnamed candidate that lost its last member is an artefact; a named
    # person stays even when empty so the user's identity record survives.
    # Groups still holding rejected rows also stay (hidden tombstones) —
    # deleting them would cascade away the very audit that keeps those faces
    # out of automatic clustering.
    connection.execute(
        """
        DELETE FROM person_groups
        WHERE group_id = ? AND state = 'candidate' AND name IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM person_group_faces WHERE group_id = ?
          )
        """,
        (group_id, group_id),
    )


def remove_face_from_group(
    connection: sqlite3.Connection,
    *,
    face_id: str,
    commit: bool = True,
) -> dict[str, object]:
    """User correction: this face is not that person.

    The membership row is kept as 'rejected' (source='user_split') — an audit
    trail that also stops the automatic rebuild from putting the face straight
    back into a candidate group.
    """
    row = connection.execute(
        """
        SELECT pgf.group_id FROM person_group_faces AS pgf
        WHERE pgf.face_id = ? AND pgf.membership_state != 'rejected'
        """,
        (face_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"face is not in any person group: {face_id!r}")
    group_id = row["group_id"]
    connection.execute(
        """
        UPDATE person_group_faces
        SET membership_state = 'rejected', source = 'user_split', reviewed_at = CURRENT_TIMESTAMP
        WHERE face_id = ?
        """,
        (face_id,),
    )
    _cleanup_group_after_departure(connection, group_id, face_id)
    if commit:
        connection.commit()
    try:
        return _person_group_row(connection, group_id)
    except ValueError:
        return {"group_id": group_id, "deleted": True}


def assign_face_to_group(
    connection: sqlite3.Connection,
    *,
    face_id: str,
    group_id: str,
    commit: bool = True,
) -> dict[str, object]:
    """User correction: move one face into a specific person group."""
    face = connection.execute(
        "SELECT model_id, model_version FROM asset_faces WHERE face_id = ?",
        (face_id,),
    ).fetchone()
    if face is None:
        raise ValueError(f"unknown face: {face_id!r}")
    target = _person_group_row(connection, group_id)
    if (face["model_id"], face["model_version"]) != (target["model_id"], target["model_version"]):
        raise ValueError("face and person group belong to different model versions")
    existing = connection.execute(
        "SELECT group_id FROM person_group_faces WHERE face_id = ?",
        (face_id,),
    ).fetchone()
    if existing is not None:
        previous_group = existing["group_id"]
        connection.execute(
            """
            UPDATE person_group_faces
            SET group_id = ?, membership_state = 'confirmed', source = 'user_confirmed',
                reviewed_at = CURRENT_TIMESTAMP
            WHERE face_id = ?
            """,
            (group_id, face_id),
        )
        if previous_group != group_id:
            _cleanup_group_after_departure(connection, previous_group, face_id)
    else:
        connection.execute(
            """
            INSERT INTO person_group_faces (group_id, face_id, membership_state, source, reviewed_at)
            VALUES (?, ?, 'confirmed', 'user_confirmed', CURRENT_TIMESTAMP)
            """,
            (group_id, face_id),
        )
    connection.execute(
        "UPDATE person_groups SET updated_at = CURRENT_TIMESTAMP WHERE group_id = ?",
        (group_id,),
    )
    if commit:
        connection.commit()
    return _person_group_row(connection, group_id)


def _run_batch_correction(
    connection: sqlite3.Connection,
    face_ids: list[str],
    apply_one,
    *,
    savepoint: str,
    commit: bool,
) -> dict[str, object]:
    """All-or-nothing wrapper for per-face corrections: one face failing rolls
    back every earlier update, so the batch is atomic for any caller — not
    just ones whose connection happens to be discarded afterwards."""
    if not face_ids:
        raise ValueError("face_ids must not be empty")
    nested = connection.in_transaction
    if nested:
        connection.execute(f"SAVEPOINT {savepoint}")
    else:
        connection.execute("BEGIN")
    try:
        result: dict[str, object] = {}
        for face_id in face_ids:
            result = apply_one(face_id)
        if nested:
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        elif commit:
            connection.commit()
        return result
    except Exception:
        if nested:
            connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            connection.rollback()
        raise


def remove_faces_from_group(
    connection: sqlite3.Connection,
    *,
    face_ids: list[str],
    commit: bool = True,
) -> dict[str, object]:
    """Batch form of remove_face_from_group — atomic, one commit."""
    result = _run_batch_correction(
        connection,
        face_ids,
        lambda face_id: remove_face_from_group(connection, face_id=face_id, commit=False),
        savepoint="people_remove_faces",
        commit=commit,
    )
    return {**result, "removed": len(face_ids)}


def assign_faces_to_group(
    connection: sqlite3.Connection,
    *,
    face_ids: list[str],
    group_id: str,
    commit: bool = True,
) -> dict[str, object]:
    """Batch form of assign_face_to_group — atomic, one commit."""
    result = _run_batch_correction(
        connection,
        face_ids,
        lambda face_id: assign_face_to_group(connection, face_id=face_id, group_id=group_id, commit=False),
        savepoint="people_assign_faces",
        commit=commit,
    )
    return {**result, "assigned": len(face_ids)}


def merge_person_groups(
    connection: sqlite3.Connection,
    *,
    source_group_id: str,
    target_group_id: str,
    commit: bool = True,
) -> dict[str, object]:
    """Move every face of one group into another and drop the empty source.

    The moved memberships keep an audit trail (source='user_merged'), and the
    target keeps its own name, state and cover. Groups from different embedding
    spaces never merge — that would mix incompatible vectors downstream.
    """
    if source_group_id == target_group_id:
        raise ValueError("cannot merge a person group into itself")
    source = _person_group_row(connection, source_group_id)
    target = _person_group_row(connection, target_group_id)
    if (source["model_id"], source["model_version"]) != (target["model_id"], target["model_version"]):
        raise ValueError("person groups from different model versions cannot be merged")
    savepoint = "people_merge_groups"
    nested = connection.in_transaction
    if nested:
        connection.execute(f"SAVEPOINT {savepoint}")
    else:
        connection.execute("BEGIN")
    try:
        connection.execute(
            """
            UPDATE person_group_faces
            SET group_id = ?, source = 'user_merged', reviewed_at = CURRENT_TIMESTAMP
            WHERE group_id = ?
            """,
            (target_group_id, source_group_id),
        )
        connection.execute("DELETE FROM person_groups WHERE group_id = ?", (source_group_id,))
        connection.execute(
            "UPDATE person_groups SET updated_at = CURRENT_TIMESTAMP WHERE group_id = ?",
            (target_group_id,),
        )
        if nested:
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        elif commit:
            connection.commit()
    except Exception:
        if nested:
            connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            connection.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            connection.rollback()
        raise
    return _person_group_row(connection, target_group_id)


def get_asset_people(connection: sqlite3.Connection, *, asset_id: str) -> dict[str, object]:
    """Compact Inspector payload; the gallery only needs the has_face boolean."""
    rows = connection.execute(
        """
        SELECT f.face_id, f.quality, f.detection_confidence, f.bbox_json,
               pg.group_id, pg.name, pg.state, pg.model_id, pg.model_version
        FROM asset_faces AS f
        LEFT JOIN person_group_faces AS pgf
            ON pgf.face_id = f.face_id AND pgf.membership_state != 'rejected'
        LEFT JOIN person_groups AS pg ON pg.group_id = pgf.group_id
        WHERE f.asset_id = ?
        ORDER BY f.created_at ASC, f.face_id ASC
        """,
        (asset_id,),
    ).fetchall()
    faces = [{
        "face_id": row["face_id"],
        "quality": row["quality"],
        "confidence": float(row["detection_confidence"]),
        "bounding_box": json.loads(row["bbox_json"]),
        "group_id": row["group_id"],
        "name": row["name"],
        "group_state": row["state"],
        "model_id": row["model_id"],
        "model_version": row["model_version"],
    } for row in rows]
    return {"has_face": bool(faces), "face_count": len(faces), "faces": faces}


def _validate_face(face: dict[str, Any]) -> dict[str, Any]:
    bbox = _numbers(face.get("bounding_box"), expected=4, label="bounding_box")
    landmarks = _numbers(face.get("landmarks"), expected=10, label="landmarks")
    embedding = _numbers(face.get("embedding"), expected=EMBEDDING_DIMENSIONS, label="embedding")
    quality = str(face.get("quality") or "")
    if quality not in _QUALITY_VALUES:
        raise ValueError(f"unsupported face quality: {quality!r}")
    confidence = float(face.get("confidence"))
    if not math.isfinite(confidence) or confidence < 0 or confidence > 1:
        raise ValueError("face confidence must be finite and between 0 and 1")
    length = math.sqrt(sum(value * value for value in embedding))
    if not math.isfinite(length) or length < 0.99 or length > 1.01:
        raise ValueError("face embedding must be L2-normalized")
    return {
        "bounding_box": bbox,
        "landmarks": landmarks,
        "quality": quality,
        "confidence": confidence,
        "embedding_blob": struct.pack(f"<{EMBEDDING_DIMENSIONS}f", *embedding),
        "thumbnail_key": face.get("thumbnail_key"),
    }


def _numbers(value: Any, *, expected: int, label: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != expected:
        raise ValueError(f"{label} must contain {expected} numeric values")
    numbers = [float(item) for item in value]
    if not all(math.isfinite(item) for item in numbers):
        raise ValueError(f"{label} contains a non-finite value")
    return numbers


def _decode_embedding(blob: bytes) -> list[float]:
    if len(blob) != EMBEDDING_DIMENSIONS * 4:
        raise ValueError("stored embedding has an unexpected byte length")
    return list(struct.unpack(f"<{EMBEDDING_DIMENSIONS}f", blob))


def _public_face(face: dict[str, Any]) -> dict[str, object]:
    return {
        "bounding_box": face["bounding_box"],
        "landmarks": face["landmarks"],
        "quality": face["quality"],
        "confidence": face["confidence"],
        "thumbnail_key": face.get("thumbnail_key"),
    }
