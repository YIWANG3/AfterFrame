"""Normalized asset locations for the map: asset_locations + its R*Tree.

The two tables are kept in sync by this module inside the caller's
transaction — no triggers. One effective location per asset; source priority
(manual > exif > ai) is enforced here, not in the schema.
"""
from __future__ import annotations

import sqlite3

from .browse import _base_clause, _search_clause, _status_clause
from .facets import _GEO_PRECISION_RANK, _facet_clauses


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


_PLACE_COLUMNS = ("country_code", "city_key", "city_en", "city_zh")
# Bump when the place data or the lookup changes: every catalog then redoes
# its country/city fields on the next open (init_db), the way the schema 9
# upgrade filled them the first time.
PLACE_DATA_VERSION = "ne50-1+gazetteer-1"
# An AI row placed at a region's or a country's centroid says nothing about
# which city the photo was taken in.
_CITY_PRECISIONS = ("exact", "locality")


def place_fields(latitude: float, longitude: float, precision_level: str | None = "exact") -> dict[str, str | None]:
    """Canonical country + city for a coordinate, from the offline gazetteer.

    These are what the Country and City filters match on: an ISO code and the
    gazetteer's own city (its id, English name, Simplified Chinese name), so
    "NYC" typed by a model and a GPS fix in Manhattan land on the same option.
    All None when the gazetteer is unavailable or nothing is near."""
    from ..discover import load_reverse_geocoder
    from ..geo_resolver import simplified

    empty: dict[str, str | None] = dict.fromkeys(_PLACE_COLUMNS)
    geocoder = load_reverse_geocoder()
    if geocoder is None:
        return empty
    place = geocoder.lookup(latitude, longitude)
    if place is None:
        return empty
    fields = {**empty, "country_code": place.get("country_iso")}
    if place.get("tier") == "locality" and (precision_level or "exact") in _CITY_PRECISIONS:
        fields.update(
            city_key=place["key"],
            city_en=place["en"],
            city_zh=simplified(place["zh"]),
        )
    return fields


def _country_for(row: sqlite3.Row | tuple, fields: dict[str, str | None]) -> str | None:
    """An AI row's country came from what the model said about the picture,
    which is better evidence than its coordinates (a point at a country's
    centroid, or in Rome for Vatican City). Coordinates decide otherwise."""
    source, existing = row[-2], row[-1]
    if source == "ai" and existing:
        return existing
    return fields["country_code"]


def _write_place_fields(connection: sqlite3.Connection, location_id: int) -> None:
    """Fill country/city for one row from its coordinates."""
    row = connection.execute(
        "SELECT latitude, longitude, precision_level, source, country_code FROM asset_locations WHERE location_id = ?",
        (location_id,),
    ).fetchone()
    if row is None:
        return
    fields = place_fields(float(row[0]), float(row[1]), row[2])
    connection.execute(
        "UPDATE asset_locations SET country_code = ?, city_key = ?, city_en = ?, city_zh = ? WHERE location_id = ?",
        (_country_for(row, fields), fields["city_key"], fields["city_en"], fields["city_zh"], location_id),
    )


def backfill_place_fields(connection: sqlite3.Connection) -> int:
    """Redo country/city on every location row from the current place data.
    Returns how many rows were looked at; does nothing when the gazetteer
    is unavailable."""
    from ..discover import load_reverse_geocoder

    if load_reverse_geocoder() is None:
        return 0
    cache: dict[tuple[float, float, str], dict[str, str | None]] = {}
    rows = connection.execute(
        "SELECT location_id, latitude, longitude, precision_level, source, country_code FROM asset_locations"
    ).fetchall()
    for row in rows:
        precision = row[3] or "exact"
        key = (round(float(row[1]), 3), round(float(row[2]), 3), precision)
        fields = cache.get(key)
        if fields is None:
            fields = cache[key] = place_fields(key[0], key[1], precision)
        connection.execute(
            "UPDATE asset_locations SET country_code = ?, city_key = ?, city_en = ?, city_zh = ? WHERE location_id = ?",
            (_country_for(row, fields), fields["city_key"], fields["city_en"], fields["city_zh"], row[0]),
        )
    return len(rows)


def refresh_place_fields(connection: sqlite3.Connection) -> bool:
    """Part of opening a catalog: when the place data is newer than what the
    catalog was filled with, redo every row. Returns True when it did."""
    from ..discover import load_reverse_geocoder

    row = connection.execute("SELECT place_data_version FROM catalog_info WHERE catalog_id = 1").fetchone()
    if row is not None and row[0] == PLACE_DATA_VERSION:
        return False
    if load_reverse_geocoder() is None:
        return False  # keep the old fields; try again when the data is there
    backfill_place_fields(connection)
    connection.execute("UPDATE catalog_info SET place_data_version = ? WHERE catalog_id = 1", (PLACE_DATA_VERSION,))
    return True


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
        location_id = int(cursor.lastrowid or 0)
    connection.execute(
        """
        INSERT OR REPLACE INTO asset_location_rtree (
            location_id, min_longitude, max_longitude, min_latitude, max_latitude
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (location_id, longitude, longitude, latitude, latitude),
    )
    _write_place_fields(connection, location_id)
    if commit:
        connection.commit()


def upsert_ai_asset_location(
    connection: sqlite3.Connection,
    asset_id: str,
    resolved,  # geo_resolver.ResolvedLocation
    *,
    location: dict | None = None,
    resolver_version: str,
    commit: bool = False,
) -> bool:
    """Write an AI-resolved location. Never overwrites manual or exif rows —
    priority manual > exif > ai lives here, not in the schema. Returns True
    when a row was written."""
    existing = connection.execute(
        "SELECT location_id, source FROM asset_locations WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if existing is not None and str(existing["source"]) in ("manual", "exif"):
        return False

    location = location or {}
    values = (
        resolved.latitude, resolved.longitude,
        resolved.min_latitude, resolved.max_latitude,
        resolved.min_longitude, resolved.max_longitude,
        resolved.precision_level, resolved.confidence, resolved.place_id,
        resolved.country_code,
        location.get("admin1"), location.get("locality") or location.get("region"),
        location.get("landmark"), resolver_version,
    )
    if existing is not None:
        location_id = int(existing["location_id"])
        connection.execute(
            """
            UPDATE asset_locations SET
                latitude = ?, longitude = ?,
                min_latitude = ?, max_latitude = ?, min_longitude = ?, max_longitude = ?,
                source = 'ai', accuracy_m = NULL, precision_level = ?,
                confidence = ?, place_id = ?, country_code = ?,
                admin1 = ?, locality = ?, landmark = ?, resolver_version = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE location_id = ?
            """,
            (*values, location_id),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO asset_locations (
                asset_id, latitude, longitude,
                min_latitude, max_latitude, min_longitude, max_longitude,
                source, accuracy_m, precision_level, confidence, place_id,
                country_code, admin1, locality, landmark, resolver_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (asset_id, *values),
        )
        location_id = int(cursor.lastrowid or 0)
    connection.execute(
        """
        INSERT OR REPLACE INTO asset_location_rtree (
            location_id, min_longitude, max_longitude, min_latitude, max_latitude
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (location_id, resolved.min_longitude, resolved.max_longitude,
         resolved.min_latitude, resolved.max_latitude),
    )
    _write_place_fields(connection, location_id)
    if commit:
        connection.commit()
    return True


def set_manual_asset_location(
    connection: sqlite3.Connection,
    asset_id: str,
    latitude: float,
    longitude: float,
    *,
    commit: bool = False,
) -> None:
    """Write a user/agent-provided location. Manual is the top of the source
    priority (manual > exif > ai) so it plainly replaces whatever row exists."""
    coordinates = _valid_coordinates(latitude, longitude)
    if coordinates is None:
        raise ValueError(f"invalid coordinates: {latitude}, {longitude}")
    lat, lon = coordinates
    existing = connection.execute(
        "SELECT location_id FROM asset_locations WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()
    if existing is not None:
        location_id = int(existing["location_id"])
        connection.execute(
            """
            UPDATE asset_locations SET
                latitude = ?, longitude = ?,
                min_latitude = ?, max_latitude = ?, min_longitude = ?, max_longitude = ?,
                source = 'manual', accuracy_m = NULL, precision_level = 'exact',
                confidence = NULL, place_id = NULL, country_code = NULL,
                admin1 = NULL, locality = NULL, landmark = NULL, resolver_version = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE location_id = ?
            """,
            (lat, lon, lat, lat, lon, lon, location_id),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO asset_locations (
                asset_id, latitude, longitude,
                min_latitude, max_latitude, min_longitude, max_longitude,
                source, precision_level
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'exact')
            """,
            (asset_id, lat, lon, lat, lat, lon, lon),
        )
        location_id = int(cursor.lastrowid or 0)
    connection.execute(
        """
        INSERT OR REPLACE INTO asset_location_rtree (
            location_id, min_longitude, max_longitude, min_latitude, max_latitude
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (location_id, lon, lon, lat, lat),
    )
    _write_place_fields(connection, location_id)
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


def get_asset_location(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    """Effective location for one image asset — RAW-first, the same rule as
    list_map_points. No precision floor: the Inspector's jump-to-map wants
    coarse (admin1/country) points too — they fly to a low zoom instead of
    being hidden the way the map markers are."""
    return connection.execute(
        """
        SELECT
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.latitude ELSE loc_img.latitude END AS latitude,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.longitude ELSE loc_img.longitude END AS longitude,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.source ELSE loc_img.source END AS source,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.precision_level ELSE loc_img.precision_level END AS precision_level,
            CASE WHEN loc_raw.location_id IS NOT NULL THEN loc_raw.place_id ELSE loc_img.place_id END AS place_id
        FROM assets
        LEFT JOIN image_lookup_registry AS registry ON registry.image_asset_id = assets.asset_id
        LEFT JOIN asset_locations loc_img ON loc_img.asset_id = assets.asset_id
        LEFT JOIN asset_locations loc_raw ON loc_raw.asset_id = registry.raw_asset_id
        WHERE assets.asset_id = ?
          AND (loc_img.location_id IS NOT NULL OR loc_raw.location_id IS NOT NULL)
        LIMIT 1
        """,
        (asset_id,),
    ).fetchone()


def list_map_points(
    connection: sqlite3.Connection,
    *,
    status: str = "all",
    collection_id: str | None = None,
    search: str | None = None,
    filters: dict | None = None,
    base: dict | None = None,
    min_precision: str = "locality",
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

    Collection scope swaps the status clause for folder membership and then
    applies the same search and facets browse_collection does — the map must
    show exactly the set the gallery it mirrors shows (minus the viewport).

    min_precision (default 'locality') drops coarser points: an admin1- or
    country-level AI guess rendered as a precise-looking marker at the state
    centroid reads as "this photo was taken in the middle of California" —
    better absent than wrong. GPS points are 'exact' and never affected.
    """
    filters = dict(filters) if filters else None
    if filters:
        filters.pop("geo", None)

    params: list[object] = []
    if collection_id is not None:
        # Collection scope mirrors browse_collection: membership instead of a
        # status clause, then the same search and facets.
        scope_join = "JOIN collection_items ci ON ci.asset_id = assets.asset_id"
        scope_clause = "ci.collection_id = ?"
        params.append(collection_id)
    else:
        scope_join = ""
        # A smart collection's rules carry their own status.
        scope_clause = _status_clause("all" if base else status)

    # Parameter order must mirror the SQL text: scope → precision IN (…) →
    # search → facets → limit.
    rank = _GEO_PRECISION_RANK.get(min_precision, _GEO_PRECISION_RANK["locality"])
    allowed_precision = sorted(name for name, r in _GEO_PRECISION_RANK.items() if r >= rank)
    precision_placeholders = ", ".join("?" for _ in allowed_precision)
    params.extend(allowed_precision)

    # The base set (a smart collection's rules) sits right before the search
    # text in the SQL, so its params go right before the search params.
    base_clause, base_params = _base_clause(None if collection_id is not None else base)
    search_clause, search_params = _search_clause(search)
    search_clause = f"{base_clause} {search_clause}"
    params.extend([*base_params, *search_params])
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
          AND (CASE WHEN loc_raw.location_id IS NOT NULL
                    THEN loc_raw.precision_level ELSE loc_img.precision_level END)
              IN ({precision_placeholders})
          {search_clause}
          {facet_clause}
        GROUP BY assets.asset_id
        LIMIT ?
        """,
        params,
    ).fetchall()
