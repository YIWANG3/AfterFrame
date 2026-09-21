"""The read side: gallery/collection browse, facets, asset detail.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import sqlite3

# The facet filters (what the filter bar sends) live in facets.py: one registry
# that the WHERE builder, the rules validation and the option counts all read.
from .facets import _LOCATION_OWNER, LOCATION_SOURCES, _facet_clauses
from .facets import FACET_OWN_KEYS as _FACET_OWN_KEYS

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
    # Stable ties matter when locating a version and then fetching its page.
    return _browse_sort_clause(sort) + ", assets.asset_id"


# Inside a folder the toolbar's sort applies like anywhere else, plus one order
# only a folder has: when each photo was added to it (requires the `ci` join).
COLLECTION_SORTS = ("added-desc", "added-asc")


def _collection_order_clause(sort: str | None) -> str:
    if sort == "added-asc":
        return "ci.added_at ASC, assets.stem, assets.asset_id"
    if sort is None or sort == "added-desc":
        return "ci.added_at DESC, assets.stem, assets.asset_id"
    return _browse_order_clause(sort)


def _browse_sort_clause(sort: str | None) -> str:
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


# ── two layers ──────────────────────────────────────────────────────────────
# WHERE the user is (a status view, a folder, a smart collection) defines the
# base set; the filter bar and the search box only ever REFINE inside it. A
# smart collection's rules are its base: {status, search, filters, base?}.
# `base` nests — "inside collection X, refined by Y", saved as a new
# collection, keeps X's rules intact instead of merging keys that may collide
# (X wants tag=urban, Y wants tag=night: both must hold).
_MAX_BASE_DEPTH = 4


def _base_clause(base: dict | None, depth: int = 0) -> tuple[str, list[object]]:
    """"AND …" fragment + params for a smart collection's rules. Requires the
    `registry`, `assets` and `anno` aliases, like _search_clause."""
    if not base:
        return "", []
    if depth >= _MAX_BASE_DEPTH:
        raise ValueError("Smart collection rules are nested too deeply")
    search_clause, params = _search_clause(base.get("search") or None)
    facet_clause, facet_params = _facet_clauses(base.get("filters"))
    nested_clause, nested_params = _base_clause(base.get("base"), depth + 1)
    clause = f"AND ({_status_clause(base.get('status') or 'all')}) {search_clause} {facet_clause} {nested_clause}"
    return clause, [*params, *facet_params, *nested_params]


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


def _view_where(
    status: str, search: str | None, filters: dict | None, base: dict | None,
) -> tuple[str, list[object]]:
    """WHERE (without the keyword) + params for a non-folder view: the base
    set — a status, or a smart collection's rules, which carry their own
    status — refined by the search text and the facet filters."""
    base_clause, base_params = _base_clause(base)
    search_clause, search_params = _search_clause(search)
    facet_clause, facet_params = _facet_clauses(filters)
    where = f"{_status_clause('all' if base else status)} {base_clause} {search_clause} {facet_clause}"
    return where, [*base_params, *search_params, *facet_params]


def list_image_assets(
    connection: sqlite3.Connection,
    status: str,
    limit: int = 120,
    offset: int = 0,
    search: str | None = None,
    sort: str | None = None,
    filters: dict | None = None,
    base: dict | None = None,
) -> list[sqlite3.Row]:
    where, params = _view_where(status, search, filters, base)
    params.extend([limit, offset])

    return connection.execute(
        f"""
        SELECT
{_BROWSE_SELECT_COLUMNS}
        FROM image_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.image_asset_id
{_BROWSE_SHARED_JOINS}
        WHERE {where}
        ORDER BY {_browse_order_clause(sort)}
        LIMIT ? OFFSET ?
        """,
        params,
    ).fetchall()


def count_image_assets(
    connection: sqlite3.Connection,
    status: str,
    search: str | None = None,
    filters: dict | None = None,
    base: dict | None = None,
) -> int:
    """How many rows list_image_assets would page through. Same WHERE, none of
    the preview / version-stack joins — the sidebar asks this per smart
    collection."""
    where, params = _view_where(status, search, filters, base)
    row = connection.execute(
        f"""
        SELECT COUNT(*)
        FROM image_lookup_registry AS registry
        JOIN assets
            ON assets.asset_id = registry.image_asset_id
        LEFT JOIN asset_ai_annotations AS anno
            ON anno.asset_id = assets.asset_id
        WHERE {where}
        """,
        params,
    ).fetchone()
    return int(row[0])


def locate_image_asset(connection: sqlite3.Connection, asset_id: str, *,
                       status: str = "all", search: str | None = None,
                       sort: str | None = None, filters: dict | None = None,
                       collection_id: str | None = None, base: dict | None = None) -> int | None:
    """Zero-based gallery position, without hydrating metadata or statting files."""
    if collection_id:
        # A folder narrows by membership; search and facets narrow it further,
        # exactly as browse_collection does, in the same order.
        joins = (
            "JOIN collection_items ci ON ci.asset_id = assets.asset_id "
            "LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id"
        )
        search_clause, search_params = _search_clause(search)
        facet_clause, facet_params = _facet_clauses(filters)
        where = f"ci.collection_id = ? AND assets.asset_type IN ('image', 'video', 'raw') {search_clause} {facet_clause}"
        params: list[object] = [collection_id, *search_params, *facet_params]
        order = _collection_order_clause(sort)
    else:
        joins = "LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id"
        where, params = _view_where(status, search, filters, base)
        order = _browse_order_clause(sort)
    row = connection.execute(f"""
        SELECT position FROM (
            SELECT assets.asset_id, ROW_NUMBER() OVER (ORDER BY {order}) - 1 AS position
            FROM image_lookup_registry AS registry
            JOIN assets ON assets.asset_id = registry.image_asset_id
            {joins}
            WHERE {where}
        ) WHERE asset_id = ?
    """, [*params, asset_id]).fetchone()
    return row[0] if row else None


# ── facet options (the filter bar's dropdowns and sliders) ──────────────────
# Every number shown beside an option answers "how many photos would I see if
# I picked this?", so it is counted inside the current view: the folder (or
# status), the search text and every OTHER active filter. A facet's own keys
# are left out of its own count — with PNG selected, JPG must still say how
# many JPGs there are, or the dropdown could never be used to switch.
_FACET_FROM = (
    "FROM image_lookup_registry AS registry "
    "JOIN assets ON assets.asset_id = registry.image_asset_id "
    "LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id"
)


def _facet_scope(
    facet: str,
    *,
    collection_id: str | None,
    status: str,
    search: str | None,
    filters: dict | None,
    base: dict | None = None,
) -> tuple[str, list[object]]:
    """WHERE (without the keyword) + params for counting one facet's options."""
    own = _FACET_OWN_KEYS[facet]
    others = {k: v for k, v in (filters or {}).items() if k not in own}
    if collection_id:
        # A folder replaces the status, exactly as browse_collection does.
        search_clause, search_params = _search_clause(search)
        facet_clause, facet_params = _facet_clauses(others)
        where = "assets.asset_id IN (SELECT asset_id FROM collection_items WHERE collection_id = ?)"
        return f"{where} {search_clause} {facet_clause}", [collection_id, *search_params, *facet_params]
    # A smart collection's rules are the base set, never dropped as "own keys":
    # inside "PNG screenshots", JPG must honestly count 0.
    return _view_where(status or "all", search, others, base)


def get_facet_values(
    connection: sqlite3.Connection,
    collection_id: str | None = None,
    *,
    status: str = "all",
    search: str | None = None,
    filters: dict | None = None,
    base: dict | None = None,
) -> dict[str, object]:
    """Options for the filter bar: distinct cameras / lenses / tags / formats
    with counts, numeric ranges for the sliders, and the capture-time span.

    The universe is browseable assets (a registry image_asset_id row, same as
    the gallery): RAW imported via "Import" counts, RAW added as a
    reverse-lookup source does not. With no arguments this describes the whole
    library, which is what get_catalog_info reports to agents.
    """
    def scope_for(facet: str) -> tuple[str, list[object]]:
        return _facet_scope(facet, collection_id=collection_id, status=status, search=search, filters=filters, base=base)

    def value_counts(facet: str, expr: str, order: str = "c DESC") -> list[dict[str, object]]:
        where, params = scope_for(facet)
        rows = connection.execute(
            f"SELECT {expr} AS v, COUNT(*) AS c {_FACET_FROM} "
            f"WHERE {where} AND {expr} IS NOT NULL AND {expr} != '' GROUP BY v ORDER BY {order}",
            params,
        ).fetchall()
        return [{"value": r["v"], "count": r["c"]} for r in rows]

    def min_max(facet: str, col: str) -> dict[str, object]:
        where, params = scope_for(facet)
        r = connection.execute(
            f"SELECT MIN(assets.{col}) AS lo, MAX(assets.{col}) AS hi {_FACET_FROM} "
            f"WHERE {where} AND assets.{col} IS NOT NULL",
            params,
        ).fetchone()
        return {"min": r["lo"], "max": r["hi"]}

    # Only the most-used tags for the default dropdown; the rest are reachable
    # via server-side search (search_facet_values) so this stays bounded even
    # with thousands of tags.
    tag_where, tag_params = scope_for("tag")
    tag_rows = connection.execute(
        f"""
        SELECT t.tag AS v, COUNT(*) AS c
        FROM asset_tags AS t
        JOIN image_lookup_registry AS registry ON registry.image_asset_id = t.asset_id
        JOIN assets ON assets.asset_id = registry.image_asset_id
        LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id
        WHERE {tag_where}
        GROUP BY t.tag
        ORDER BY c DESC, t.tag
        LIMIT 60
        """,
        tag_params,
    ).fetchall()

    # What each photo's location is based on, including "none" — counted over
    # the effective location (the paired RAW's first), like the filter itself.
    source_where, source_params = scope_for("location_source")
    source_rows = connection.execute(
        f"""
        SELECT COALESCE((SELECT loc.source FROM asset_locations loc WHERE loc.asset_id = {_LOCATION_OWNER}), 'none') AS v,
               COUNT(*) AS c
        {_FACET_FROM}
        WHERE {source_where}
        GROUP BY v
        """,
        source_params,
    ).fetchall()
    source_counts = {r["v"]: r["c"] for r in source_rows}

    country_where, country_params = scope_for("country")
    country_rows = connection.execute(
        f"""
        SELECT loc.country_code AS v, COUNT(*) AS c
        {_FACET_FROM}
        JOIN asset_locations AS loc ON loc.asset_id = {_LOCATION_OWNER}
        WHERE {country_where} AND loc.country_code IS NOT NULL AND loc.country_code != ''
        GROUP BY v ORDER BY c DESC, v
        """,
        country_params,
    ).fetchall()

    return {
        "location_sources": [{"value": v, "count": source_counts[v]} for v in LOCATION_SOURCES if source_counts.get(v)],
        "countries": [_country_option(r["v"], r["c"]) for r in country_rows],
        # The most photographed cities; the rest through search_facet_values.
        "cities": _city_options(connection, *scope_for("city"), like="%", limit=60),
        "cameras": value_counts("camera", "assets.meta_camera_model"),
        "lenses": value_counts("lens", "assets.meta_lens_model"),
        "tags": [{"value": r["v"], "count": r["c"]} for r in tag_rows],
        # Dot-stripped + lowercased (jpg, png, mp4, cr2, 3fr, …).
        "extensions": value_counts("extension", "LOWER(TRIM(assets.extension, '.'))", "c DESC, v"),
        "iso": min_max("iso", "meta_iso"),
        "aperture": min_max("aperture", "meta_aperture"),
        "focal": min_max("focal", "meta_focal"),
        "shutter": min_max("shutter", "meta_shutter"),
        "capture_time": min_max("capture_time", "meta_capture_time"),
    }


def _country_option(iso: str, count: int) -> dict[str, object]:
    from ..geo_resolver import country_names

    names = country_names(iso)
    return {"value": iso, "count": count, "label_en": names["en"], "label_zh": names["zh"]}


def _city_options(
    connection: sqlite3.Connection, where: str, params: list[object], *, like: str, limit: int
) -> list[dict[str, object]]:
    rows = connection.execute(
        f"""
        SELECT loc.city_en AS v, MAX(loc.city_zh) AS zh, MAX(loc.country_code) AS country, COUNT(*) AS c
        {_FACET_FROM}
        JOIN asset_locations AS loc ON loc.asset_id = {_LOCATION_OWNER}
        WHERE {where} AND loc.city_en IS NOT NULL AND (loc.city_en LIKE ? OR loc.city_zh LIKE ?)
        GROUP BY v ORDER BY c DESC, v
        LIMIT ?
        """,
        [*params, like, like, limit],
    ).fetchall()
    return [
        {"value": r["v"], "count": r["c"], "label_en": r["v"], "label_zh": r["zh"] or r["v"], "country": r["country"]}
        for r in rows
    ]


def search_facet_values(
    connection: sqlite3.Connection,
    field: str,
    q: str = "",
    limit: int = 50,
    collection_id: str | None = None,
    *,
    status: str = "all",
    search: str | None = None,
    filters: dict | None = None,
    base: dict | None = None,
) -> list[dict[str, object]]:
    """Server-side facet search, so a dropdown never loads more than `limit`
    rows regardless of how many distinct values exist. Matches substring,
    ordered by frequency, counted inside the same view as get_facet_values."""
    if field not in ("tag", "camera", "lens", "city"):
        return []
    like = f"%{q}%" if q else "%"
    where, params = _facet_scope(field, collection_id=collection_id, status=status, search=search, filters=filters, base=base)
    if field == "city":
        return _city_options(connection, where, params, like=like, limit=limit)
    if field == "tag":
        rows = connection.execute(
            f"""
            SELECT t.tag AS v, COUNT(*) AS c
            FROM asset_tags AS t
            JOIN image_lookup_registry AS registry ON registry.image_asset_id = t.asset_id
            JOIN assets ON assets.asset_id = registry.image_asset_id
            LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id
            WHERE {where} AND t.tag LIKE ?
            GROUP BY t.tag
            ORDER BY c DESC, t.tag
            LIMIT ?
            """,
            [*params, like, limit],
        ).fetchall()
    else:
        col = "meta_camera_model" if field == "camera" else "meta_lens_model"
        rows = connection.execute(
            f"""
            SELECT assets.{col} AS v, COUNT(*) AS c {_FACET_FROM}
            WHERE {where} AND assets.{col} IS NOT NULL
              AND assets.{col} != '' AND assets.{col} LIKE ?
            GROUP BY assets.{col}
            ORDER BY c DESC
            LIMIT ?
            """,
            [*params, like, limit],
        ).fetchall()
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
    search: str | None = None,
    filters: dict | None = None,
    sort: str | None = None,
) -> list[sqlite3.Row]:
    """A folder's photos, narrowed by the same search text and facet filters
    the library view takes, in the toolbar's sort order. No sort (or
    "added-desc") keeps the folder's own order: most recently added first."""
    search_clause, search_params = _search_clause(search)
    facet_clause, facet_params = _facet_clauses(filters)
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
          {search_clause}
          {facet_clause}
        ORDER BY {_collection_order_clause(sort)}
        LIMIT ? OFFSET ?
        """,
        [collection_id, *search_params, *facet_params, limit, offset],
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
