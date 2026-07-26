"""The read side: gallery/collection browse, facets, asset detail.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import sqlite3

# Shared between list_image_assets and browse_collection — the two SELECTs
# went out of sync by hand twice before (annotation columns). Single source.
_BROWSE_SELECT_COLUMNS = """\
            assets.asset_id,
            assets.asset_type,
            assets.stem,
            registry.image_path AS image_path,
            assets.metadata_json AS image_metadata_json,
            assets.app_rating,
            assets.exists_on_disk,
            assets.created_at AS imported_at,
            assets.file_size AS catalog_file_size,
            assets.modified_time,
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
            anno.updated_at AS anno_updated_at,
            EXISTS (SELECT 1 FROM asset_faces AS face WHERE face.asset_id = assets.asset_id) AS has_face"""

_BROWSE_SHARED_JOINS = """\
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
        LEFT JOIN asset_ai_annotations AS anno
            ON anno.asset_id = assets.asset_id"""


def _browse_order_clause(sort: str | None) -> str:
    if sort == "name-desc":
        return "assets.stem DESC, registry.image_path"
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
    return "assets.stem, registry.image_path"


# Precision ranks for filters.geo min_precision: keep everything at least as
# precise as the requested level.
_GEO_PRECISION_RANK = {"exact": 3, "locality": 2, "admin1": 1, "country": 0}


def _geo_filter_clause(geo: object) -> tuple[str, list[object]] | None:
    """WHERE fragment for filters.geo.

    bounds mode filters by the map viewport via the R*Tree; when the viewport
    crosses the antimeridian (west > east) the longitude test is split into two
    ranges on the base table instead. place mode (Phase 2 UI) matches place_id.

    Matches against the asset's EFFECTIVE location: the paired RAW's
    (registry.raw_asset_id) first, or — only when no paired RAW has one — the
    image's own row. RAW is the authoritative capture metadata; same order as
    list_map_points and the Inspector's rawMeta-first GPS display. (Phase 3
    note: a future 'manual' source on the image row must win over RAW exif.)
    """
    if not isinstance(geo, dict):
        return None

    extra_conditions = ""
    extra_params: list[object] = []
    for source, included in (("exif", geo.get("include_exif", True)),
                             ("ai", geo.get("include_ai", True))):
        if not included:
            extra_conditions += " AND loc.source != ?"
            extra_params.append(source)
    min_precision = geo.get("min_precision")
    if min_precision in _GEO_PRECISION_RANK:
        allowed = sorted(
            name for name, rank in _GEO_PRECISION_RANK.items()
            if rank >= _GEO_PRECISION_RANK[min_precision]
        )
        placeholders = ", ".join("?" for _ in allowed)
        extra_conditions += f" AND loc.precision_level IN ({placeholders})"
        extra_params.extend(allowed)

    if geo.get("mode") == "place":
        place_id = geo.get("place_id")
        if not place_id:
            return None
        location_join = ""
        location_conditions = "loc.place_id = ?" + extra_conditions
        location_params: list[object] = [place_id, *extra_params]
    elif geo.get("mode") == "bounds":
        try:
            west = float(geo["west"])
            south = float(geo["south"])
            east = float(geo["east"])
            north = float(geo["north"])
        except (KeyError, TypeError, ValueError):
            return None
        if west <= east:
            location_join = (
                "JOIN asset_location_rtree geo_idx ON geo_idx.location_id = loc.location_id"
            )
            location_conditions = (
                "geo_idx.max_longitude >= ? AND geo_idx.min_longitude <= ? "
                "AND geo_idx.max_latitude >= ? AND geo_idx.min_latitude <= ?"
            ) + extra_conditions
            location_params = [west, east, south, north, *extra_params]
        else:
            # Viewport crosses the antimeridian: split the longitude test in two.
            location_join = ""
            location_conditions = (
                "loc.max_latitude >= ? AND loc.min_latitude <= ? "
                "AND (loc.max_longitude >= ? OR loc.min_longitude <= ?)"
            ) + extra_conditions
            location_params = [south, north, west, east, *extra_params]
    else:
        return None

    clause = f"""(
        EXISTS (
            SELECT 1 FROM image_lookup_registry reg
            JOIN asset_locations loc ON loc.asset_id = reg.raw_asset_id
            {location_join}
            WHERE reg.image_asset_id = assets.asset_id AND {location_conditions}
        )
        OR (
            NOT EXISTS (
                SELECT 1 FROM image_lookup_registry reg2
                JOIN asset_locations raw_loc ON raw_loc.asset_id = reg2.raw_asset_id
                WHERE reg2.image_asset_id = assets.asset_id
            )
            AND EXISTS (
                SELECT 1 FROM asset_locations loc
                {location_join}
                WHERE loc.asset_id = assets.asset_id AND {location_conditions}
            )
        )
    )"""
    return clause, [*location_params, *location_params]


def _facet_clauses(filters: dict | None) -> tuple[str, list[object]]:
    """Build AND-combined WHERE fragments + params from a structured facet dict.

    Recognized keys: camera, lens (exact), iso_min/iso_max, aperture_min/max,
    focal_min/max, shutter_min/max, date_from/date_to (ISO, vs capture time),
    rating_min, orientation ('portrait'|'landscape'|'square'), tag (asset_tags),
    people ('with_faces'|'without_faces'), person_group (group ID),
    annotated ('with'|'without' — AI annotation presence),
    geo (map viewport/place filter — see _geo_filter_clause).
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
    if filters.get("extension"):
        # File-format filter (jpg / png / mp4 / cr2 / 3fr / …); stored extension
        # keeps a leading dot, so trim it both sides for a clean compare.
        add("LOWER(TRIM(assets.extension, '.')) = ?", str(filters["extension"]).lower().lstrip("."))
    if filters.get("people") == "with_faces":
        add("EXISTS (SELECT 1 FROM asset_faces AS face WHERE face.asset_id = assets.asset_id)")
    elif filters.get("people") == "without_faces":
        add("NOT EXISTS (SELECT 1 FROM asset_faces AS face WHERE face.asset_id = assets.asset_id)")
    if filters.get("annotated") == "with":
        add("EXISTS (SELECT 1 FROM asset_ai_annotations AS ann WHERE ann.asset_id = assets.asset_id)")
    elif filters.get("annotated") == "without":
        add("NOT EXISTS (SELECT 1 FROM asset_ai_annotations AS ann WHERE ann.asset_id = assets.asset_id)")
    if filters.get("person_group"):
        add(
            """EXISTS (
                SELECT 1
                FROM asset_faces AS face
                JOIN person_group_faces AS membership ON membership.face_id = face.face_id
                WHERE face.asset_id = assets.asset_id
                  AND membership.group_id = ?
                  AND membership.membership_state != 'rejected'
            )""",
            filters["person_group"],
        )
    geo_clause = _geo_filter_clause(filters.get("geo"))
    if geo_clause is not None:
        add(geo_clause[0], *geo_clause[1])

    if not clauses:
        return "", []
    return "AND " + " AND ".join(clauses), params


def _status_clause(status: str) -> str:
    """Status → WHERE clause on registry/assets. Shared between the gallery
    browse and the map-points query so the two scopes can never drift."""
    if status == "matched":
        return "registry.match_status IN ('auto_bound', 'manual_confirmed')"
    if status == "unmatched":
        return "registry.match_status IN ('unmatched', 'pending_confirmation')"
    if status == "rated":
        return "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation') AND assets.app_rating > 0"
    if status == "recent":
        return "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation') AND assets.created_at >= datetime('now', '-7 days')"
    if status == "all":
        return "registry.match_status IN ('auto_bound', 'manual_confirmed', 'unmatched', 'pending_confirmation')"
    raise ValueError(f"unsupported status: {status}")


def _search_clause(search: str | None) -> tuple[str, list[object]]:
    """Full-text-ish search across filename/path, camera/lens, and the AI
    annotation (caption, detected OCR text, tags). LIKE is plenty fast at
    this scale; FTS5 can replace it later if libraries grow very large.
    Requires `registry` and `anno` to be joined. Shared with map points."""
    if not search:
        return "", []
    clause = (
        "AND (assets.stem LIKE ? OR registry.image_path LIKE ? "
        "OR assets.meta_camera_model LIKE ? OR assets.meta_lens_model LIKE ? "
        "OR anno.caption LIKE ? OR anno.detected_text LIKE ? "
        "OR EXISTS (SELECT 1 FROM asset_tags st WHERE st.asset_id = assets.asset_id AND st.tag LIKE ?))"
    )
    like_pattern = f"%{search}%"
    return clause, [like_pattern] * 7


def list_image_assets(
    connection: sqlite3.Connection,
    status: str,
    limit: int = 120,
    offset: int = 0,
    search: str | None = None,
    sort: str | None = None,
    filters: dict | None = None,
) -> list[sqlite3.Row]:
    status_clause = _status_clause(status)
    search_clause, params = _search_clause(search)
    facet_clause, facet_params = _facet_clauses(filters)
    params.extend(facet_params)
    params.extend([limit, offset])

    return connection.execute(
        f"""
        SELECT
{_BROWSE_SELECT_COLUMNS}
        FROM image_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.image_asset_id
{_BROWSE_SHARED_JOINS}
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
    sliders, and the capture-time span — scoped to *browseable* assets (those
    with a registry image_asset_id row, same universe as the gallery). This
    includes RAW imported via "Import" but excludes RAW added as reverse-lookup
    sources. WHERE 1=1 lets each helper append "AND assets.<col> …".
    """
    base = (
        "FROM image_lookup_registry AS registry "
        "JOIN assets ON assets.asset_id = registry.image_asset_id WHERE 1=1"
    )

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
        JOIN image_lookup_registry AS registry ON registry.image_asset_id = t.asset_id
        GROUP BY t.tag
        ORDER BY c DESC, t.tag
        LIMIT 60
        """
    ).fetchall()

    # File-format facet, scoped to *browseable* assets only — i.e. those with a
    # registry image_asset_id row (same universe as the gallery). This excludes
    # RAW added via "Add RAW source", which are reverse-lookup sources, not tiles.
    # Values are dot-stripped + lowercased (jpg, png, mp4, cr2, 3fr, …).
    ext_rows = connection.execute(
        """
        SELECT LOWER(TRIM(assets.extension, '.')) AS v, COUNT(*) AS c
        FROM image_lookup_registry AS registry
        JOIN assets ON assets.asset_id = registry.image_asset_id
        WHERE assets.extension IS NOT NULL AND assets.extension != ''
        GROUP BY v
        ORDER BY c DESC, v
        """
    ).fetchall()

    return {
        "cameras": value_counts("meta_camera_model"),
        "lenses": value_counts("meta_lens_model"),
        "tags": [{"value": r["v"], "count": r["c"]} for r in tag_rows],
        "extensions": [{"value": r["v"], "count": r["c"]} for r in ext_rows],
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
            JOIN image_lookup_registry AS registry ON registry.image_asset_id = t.asset_id
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
            FROM image_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.image_asset_id
            WHERE assets.{col} IS NOT NULL
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


def get_image_asset_detail(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.asset_type,
            assets.stem,
            assets.canonical_path AS image_path,
            assets.metadata_json AS image_metadata_json,
            assets.app_rating,
            assets.exists_on_disk,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            registry.feature_vector_json,
            registry.candidate_json,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            image_preview.relative_path AS image_preview_relative_path,
            raw_preview.relative_path AS raw_preview_relative_path,
            image_preview_hd.relative_path AS image_preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count
        FROM assets
        LEFT JOIN image_lookup_registry AS registry
            ON registry.rowid = (
                SELECT reg.rowid
                FROM image_lookup_registry AS reg
                WHERE reg.image_asset_id = assets.asset_id
                ORDER BY reg.updated_at DESC, reg.created_at DESC, reg.image_path DESC
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
        LEFT JOIN preview_entries AS image_preview
            ON image_preview.asset_id = assets.asset_id
           AND image_preview.kind = 'preview'
           AND image_preview.status = 'ready'
        LEFT JOIN preview_entries AS raw_preview
            ON raw_preview.asset_id = registry.raw_asset_id
           AND raw_preview.kind = 'preview'
           AND raw_preview.status = 'ready'
        LEFT JOIN preview_entries AS image_preview_hd
            ON image_preview_hd.asset_id = assets.asset_id
           AND image_preview_hd.kind = 'preview-hd'
           AND image_preview_hd.status = 'ready'
        WHERE assets.asset_id = ?
          AND assets.asset_type IN ('image', 'video', 'raw')
        """,
        (asset_id,),
    ).fetchone()


def get_image_asset_detail_by_path(connection: sqlite3.Connection, image_path: str) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT
            assets.asset_id,
            assets.asset_type,
            assets.stem,
            registry.image_path AS image_path,
            assets.metadata_json AS image_metadata_json,
            assets.app_rating,
            assets.exists_on_disk,
            assets.created_at AS imported_at,
            registry.match_status,
            registry.score,
            registry.raw_asset_id,
            registry.feature_vector_json,
            registry.candidate_json,
            raw_assets.canonical_path AS raw_path,
            raw_assets.metadata_json AS raw_metadata_json,
            image_preview.relative_path AS image_preview_relative_path,
            raw_preview.relative_path AS raw_preview_relative_path,
            image_preview_hd.relative_path AS image_preview_hd_relative_path,
            rsi.set_id AS resource_set_id,
            rsi.role AS resource_role,
            rsi.version_kind AS version_kind,
            rsi.sort_order AS resource_sort_order,
            rs.primary_asset_id AS set_primary_asset_id,
            rs.raw_asset_id AS set_raw_asset_id,
            primary_assets.stem AS primary_stem,
            set_counts.set_item_count AS set_item_count
        FROM image_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.image_asset_id
           AND assets.asset_type IN ('image', 'video', 'raw')
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
        LEFT JOIN preview_entries AS image_preview
            ON image_preview.asset_id = assets.asset_id
           AND image_preview.kind = 'preview'
           AND image_preview.status = 'ready'
        LEFT JOIN preview_entries AS raw_preview
            ON raw_preview.asset_id = registry.raw_asset_id
           AND raw_preview.kind = 'preview'
           AND raw_preview.status = 'ready'
        LEFT JOIN preview_entries AS image_preview_hd
            ON image_preview_hd.asset_id = assets.asset_id
           AND image_preview_hd.kind = 'preview-hd'
           AND image_preview_hd.status = 'ready'
        WHERE registry.image_path = ?
        """,
        (image_path,),
    ).fetchone()


def browse_collection(
    connection: sqlite3.Connection,
    collection_id: str,
    limit: int = 120,
    offset: int = 0,
) -> list[sqlite3.Row]:
    return connection.execute(
        f"""
        SELECT
{_BROWSE_SELECT_COLUMNS}
        FROM collection_items ci
        JOIN assets ON assets.asset_id = ci.asset_id
        JOIN image_lookup_registry AS registry
            ON registry.image_asset_id = assets.asset_id
{_BROWSE_SHARED_JOINS}
        WHERE ci.collection_id = ?
          AND assets.asset_type IN ('image', 'video', 'raw')
        ORDER BY ci.added_at DESC, assets.stem
        LIMIT ? OFFSET ?
        """,
        (collection_id, limit, offset),
    ).fetchall()


def list_version_siblings(connection: sqlite3.Connection, set_id: str, exclude_asset_id: str) -> list[sqlite3.Row]:
    """Other members of an asset's resource set (the version stack)."""
    return connection.execute(
        """
        SELECT rsi.asset_id, rsi.role, rsi.version_kind, rsi.sort_order,
               a.stem, a.canonical_path,
               af.path AS image_path,
               pe.relative_path AS preview_relative_path
        FROM resource_set_items rsi
        JOIN assets a ON a.asset_id = rsi.asset_id
        LEFT JOIN asset_files af ON af.asset_id = rsi.asset_id AND af.role = 'canonical'
        LEFT JOIN preview_entries pe ON pe.asset_id = rsi.asset_id AND pe.kind = 'preview'
        WHERE rsi.set_id = ? AND rsi.asset_id != ?
        ORDER BY rsi.sort_order
        """,
        (set_id, exclude_asset_id),
    ).fetchall()
