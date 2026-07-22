"""Normalized asset locations for the map: asset_locations + its R*Tree.

The two tables are kept in sync by this module inside the caller's
transaction — no triggers. One effective location per asset; source priority
(manual > exif > ai) is enforced here, not in the schema.
"""
from __future__ import annotations

import sqlite3

from .browse import _facet_clauses, _search_clause, _status_clause


def _valid_coordinates(latitude: object, longitude: object) -> tuple[float, float] | None:
    try:
        lat = float(latitude)  # type: ignore[arg-type]
        lon = float(longitude)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    if lat == 0.0 and lon == 0.0:
        return None  # EXIF "no fix" junk value
    return lat, lon


def upsert_asset_location_from_metadata(
    connection: sqlite3.Connection,
    asset_id: str,
    metadata: dict,
    *,
    commit: bool = False,
) -> None:
    """Sync the exif-source location with the GPS in an asset's metadata dict.

    Called from the asset upsert paths (import, metadata re-read). A manual
    location (future feature) always wins and is never touched; an ai location
    is upgraded to exif when real GPS appears. When GPS disappears from the
    file, only a stale exif row is dropped — ai rows don't derive from file
    metadata, so they stay.
    """
    coordinates = _valid_coordinates(metadata.get("gps_latitude"), metadata.get("gps_longitude"))
    existing = connection.execute(
        "SELECT location_id, source FROM asset_locations WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if existing is not None and str(existing["source"]) == "manual":
        return

    if coordinates is None:
        if existing is not None and str(existing["source"]) == "exif":
            delete_asset_location(connection, asset_id)
            if commit:
                connection.commit()
        return

    latitude, longitude = coordinates
    if existing is not None:
        location_id = int(existing["location_id"])
        connection.execute(
            """
            UPDATE asset_locations SET
                latitude = ?, longitude = ?,
                min_latitude = ?, max_latitude = ?, min_longitude = ?, max_longitude = ?,
                source = 'exif', accuracy_m = NULL, precision_level = 'exact',
                confidence = NULL, place_id = NULL, country_code = NULL,
                admin1 = NULL, locality = NULL, landmark = NULL, resolver_version = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE location_id = ?
            """,
            (latitude, longitude, latitude, latitude, longitude, longitude, location_id),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO asset_locations (
                asset_id, latitude, longitude,
                min_latitude, max_latitude, min_longitude, max_longitude,
                source, precision_level
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'exif', 'exact')
            """,
            (asset_id, latitude, longitude, latitude, latitude, longitude, longitude),
        )
        location_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT OR REPLACE INTO asset_location_rtree (
            location_id, min_longitude, max_longitude, min_latitude, max_latitude
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (location_id, longitude, longitude, latitude, latitude),
    )
    if commit:
        connection.commit()


def delete_asset_location(connection: sqlite3.Connection, asset_id: str) -> None:
    """Remove an asset's location and its R*Tree entry (same transaction).

    Must run before DELETE FROM assets: the FK cascade would clear
    asset_locations but leave the R*Tree row orphaned.
    """
    connection.execute(
        """
        DELETE FROM asset_location_rtree
        WHERE location_id IN (SELECT location_id FROM asset_locations WHERE asset_id = ?)
        """,
        (asset_id,),
    )
    connection.execute("DELETE FROM asset_locations WHERE asset_id = ?", (asset_id,))


def list_map_points(
    connection: sqlite3.Connection,
    *,
    status: str = "all",
    collection_id: str | None = None,
    search: str | None = None,
    filters: dict | None = None,
    limit: int = 100000,
) -> list[sqlite3.Row]:
    """Lightweight location points for the map, mirroring the gallery scope.

    Applies status/collection, search, and the regular facets, but deliberately
    IGNORES filters.geo: the map must keep showing clusters outside the current
    viewport or the user can't navigate away from their own filter.

    Effective location per asset: the paired RAW's (registry.raw_asset_id)
    first, else the image's own — RAW is the authoritative capture metadata
    (exports may strip or rewrite it), and the Inspector displays GPS in the
    same rawMeta-first order. Whole-ROW selection: every column comes from the
    one chosen location, never mixed across the two. (Phase 3 note: a future
    'manual' source on the image row must win over RAW exif — revisit the
    predicate then.)

    In collection scope, search and facets are ignored to match
    browse_collection (which accepts neither) — the map must never show a
    narrower set than the gallery it mirrors.
    """
    filters = dict(filters) if filters else None
    if filters:
        filters.pop("geo", None)

    params: list[object] = []
    if collection_id is not None:
        # Collection scope mirrors browse_collection: no status clause, and no
        # search/facets either (browse_collection ignores both).
        scope_join = "JOIN collection_items ci ON ci.asset_id = assets.asset_id"
        scope_clause = "ci.collection_id = ?"
        params.append(collection_id)
        search = None
        filters = None
    else:
        scope_join = ""
        scope_clause = _status_clause(status)

    search_clause, search_params = _search_clause(search)
    params.extend(search_params)
    facet_clause, facet_params = _facet_clauses(filters)
    params.extend(facet_params)
    params.append(limit)

    return connection.execute(
        f"""
        SELECT
            assets.asset_id,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.latitude ELSE loc_img.latitude END AS latitude,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.longitude ELSE loc_img.longitude END AS longitude,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.source ELSE loc_img.source END AS source,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.accuracy_m ELSE loc_img.accuracy_m END AS accuracy_m,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.precision_level ELSE loc_img.precision_level END AS precision_level,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.place_id ELSE loc_img.place_id END AS place_id,
            assets.app_rating,
            assets.meta_capture_time AS capture_time,
            preview_entries.relative_path AS preview_relative_path
        FROM image_lookup_registry AS registry
        JOIN assets ON assets.asset_id = registry.image_asset_id
        LEFT JOIN asset_locations loc_img ON loc_img.asset_id = assets.asset_id
        LEFT JOIN asset_locations loc_raw ON loc_raw.asset_id = registry.raw_asset_id
        {scope_join}
        LEFT JOIN asset_ai_annotations AS anno
            ON anno.asset_id = assets.asset_id
        LEFT JOIN preview_entries
            ON preview_entries.asset_id = assets.asset_id
           AND preview_entries.kind = 'preview'
           AND preview_entries.status = 'ready'
        WHERE {scope_clause}
          AND (loc_img.location_id IS NOT NULL OR loc_raw.location_id IS NOT NULL)
          {search_clause}
          {facet_clause}
        GROUP BY assets.asset_id
        LIMIT ?
        """,
        params,
    ).fetchall()
