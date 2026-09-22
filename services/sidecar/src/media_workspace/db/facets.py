"""The facet filters: what the filter bar sends, as one registry.

Each facet is declared once. From the declarations come the WHERE fragments
(_facet_clauses), the set of keys a smart collection may save (FACET_KEYS),
and which keys a facet ignores when its own options are counted
(FACET_OWN_KEYS). Adding a filter dimension is adding a declaration here —
it used to mean a new branch in a forty-line if-chain plus three hand-kept
lists elsewhere.

Semantics, the usual ones for faceted search:
  - different facets are AND-combined;
  - several values WITHIN one facet are OR ("FC9113 or FC9184": either
    drone). A facet's value may be a scalar or a list; a scalar is a list of
    one, so filters saved before multi-select read unchanged;
  - tags are the one facet where "all of these" is as natural as "any of
    these" (night AND neon), so `tag_match: "all"` switches it.

Requires the `assets` alias (and `registry` for nothing here); text search is
not a facet and lives in browse._search_clause.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

Clause = tuple[str, list[object]]

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




def _values(raw: object) -> list[object]:
    """A facet value as a list: scalar → [scalar], empties dropped."""
    items = raw if isinstance(raw, (list, tuple)) else [raw]
    return [item for item in items if item is not None and item != ""]


def _in(expr: str, values: Sequence[object]) -> Clause:
    if len(values) == 1:
        return f"{expr} = ?", [values[0]]
    return f"{expr} IN ({', '.join('?' for _ in values)})", list(values)


@dataclass(frozen=True)
class Facet:
    name: str
    keys: tuple[str, ...]
    clauses: Callable[[dict], list[Clause]]
    # Keys that merely tune another key (tag_match) are not conditions by
    # themselves: alone they must produce no clause.
    modifiers: tuple[str, ...] = field(default=())


def _column_facet(name: str, column: str) -> Facet:
    """Exact match on an assets column; several values are OR."""
    def clauses(filters: dict) -> list[Clause]:
        values = _values(filters.get(name))
        return [_in(f"assets.{column}", values)] if values else []
    return Facet(name, (name,), clauses)


def _range_facet(name: str, column: str) -> Facet:
    lo_key, hi_key = f"{name}_min", f"{name}_max"

    def clauses(filters: dict) -> list[Clause]:
        out: list[Clause] = []
        if filters.get(lo_key) is not None:
            out.append((f"assets.{column} >= ?", [filters[lo_key]]))
        if filters.get(hi_key) is not None:
            out.append((f"assets.{column} <= ?", [filters[hi_key]]))
        return out
    return Facet(name, (lo_key, hi_key), clauses)


def _capture_time(filters: dict) -> list[Clause]:
    out: list[Clause] = []
    if filters.get("date_from"):
        out.append(("date(assets.meta_capture_time) >= date(?)", [filters["date_from"]]))
    if filters.get("date_to"):
        out.append(("date(assets.meta_capture_time) <= date(?)", [filters["date_to"]]))
    # Relative to today, so a saved filter keeps moving with the calendar.
    within_days = filters.get("date_within_days")
    if within_days is not None and int(within_days) > 0:
        out.append(("date(assets.meta_capture_time) >= date('now', ?)", [f"-{int(within_days)} days"]))
    return out


def _rating(filters: dict) -> list[Clause]:
    if filters.get("rating_min") is None:
        return []
    return [("assets.app_rating >= ?", [filters["rating_min"]])]


_ORIENTATION_SQL = {
    "portrait": "assets.meta_height > assets.meta_width",
    "landscape": "assets.meta_width > assets.meta_height",
    "square": "(assets.meta_width = assets.meta_height AND assets.meta_width IS NOT NULL)",
}


def _orientation(filters: dict) -> list[Clause]:
    picked = [_ORIENTATION_SQL[v] for v in _values(filters.get("orientation")) if v in _ORIENTATION_SQL]
    return [("(" + " OR ".join(picked) + ")", [])] if picked else []


def _asset_type(filters: dict) -> list[Clause]:
    values = [v for v in _values(filters.get("asset_type")) if v in ("image", "video", "raw")]
    return [_in("assets.asset_type", values)] if values else []


def _extension(filters: dict) -> list[Clause]:
    # File format (jpg / png / mp4 / cr2 / 3fr / …); the stored extension keeps
    # a leading dot, so trim it on both sides for a clean compare.
    values = [str(v).lower().lstrip(".") for v in _values(filters.get("extension"))]
    return [_in("LOWER(TRIM(assets.extension, '.'))", values)] if values else []


def _tag(filters: dict) -> list[Clause]:
    values = _values(filters.get("tag"))
    if not values:
        return []
    exists = "EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = assets.asset_id AND {cond})"
    if filters.get("tag_match") == "all":
        # Every tag must be present: one EXISTS per tag, AND-combined.
        return [(exists.format(cond="t.tag = ?"), [value]) for value in values]
    cond, params = _in("t.tag", values)
    return [(exists.format(cond=cond), params)]


def _people(filters: dict) -> list[Clause]:
    faces = "EXISTS (SELECT 1 FROM asset_faces AS face WHERE face.asset_id = assets.asset_id)"
    if filters.get("people") == "with_faces":
        return [(faces, [])]
    if filters.get("people") == "without_faces":
        return [(f"NOT {faces}", [])]
    return []


def _annotated(filters: dict) -> list[Clause]:
    annotation = "EXISTS (SELECT 1 FROM asset_ai_annotations AS ann WHERE ann.asset_id = assets.asset_id)"
    if filters.get("annotated") == "with":
        return [(annotation, [])]
    if filters.get("annotated") == "without":
        return [(f"NOT {annotation}", [])]
    return []


def _person_group(filters: dict) -> list[Clause]:
    values = _values(filters.get("person_group"))
    if not values:
        return []
    # Build the people's asset set once. A correlated EXISTS lets SQLite choose
    # group_id first for *every* gallery row, repeatedly walking all faces in a
    # large group (library size × group size). IN also dedupes multiple faces
    # in one photo without changing pagination semantics.
    cond, params = _in("membership.group_id", values)
    return [(
        f"""assets.asset_id IN (
                SELECT face.asset_id
                FROM person_group_faces AS membership
                JOIN asset_faces AS face ON face.face_id = membership.face_id
                WHERE {cond}
                  AND membership.membership_state != 'rejected'
            )""",
        params,
    )]


def _in_collection(filters: dict) -> list[Clause]:
    # Membership of a folder as a condition, so a smart collection can be saved
    # from inside one ("the five-star photos of this trip").
    values = _values(filters.get("in_collection"))
    if not values:
        return []
    cond, params = _in("collection_id", values)
    return [(f"assets.asset_id IN (SELECT asset_id FROM collection_items WHERE {cond})", params)]


# The asset whose location row counts for a photo: the paired RAW's when it has
# one, else the photo's own (the same RAW-first rule as _geo_filter_clause, the
# map and the Inspector).
_LOCATION_OWNER = """COALESCE(
    (SELECT reg.raw_asset_id FROM image_lookup_registry reg
     JOIN asset_locations raw_loc ON raw_loc.asset_id = reg.raw_asset_id
     WHERE reg.image_asset_id = assets.asset_id LIMIT 1),
    assets.asset_id)"""

# What the location is based on. "none" is the useful one: the photos that
# still need a place.
LOCATION_SOURCES = ("exif", "ai", "manual", "none")


def _location_source(filters: dict) -> list[Clause]:
    values = [v for v in _values(filters.get("location_source")) if v in LOCATION_SOURCES]
    if not values:
        return []
    located = f"EXISTS (SELECT 1 FROM asset_locations loc WHERE loc.asset_id = {_LOCATION_OWNER}" + "{cond})"
    parts: list[str] = []
    params: list[object] = []
    sources = [v for v in values if v != "none"]
    if sources:
        cond, cond_params = _in("loc.source", sources)
        parts.append(located.format(cond=f" AND {cond}"))
        params.extend(cond_params)
    if "none" in values:
        parts.append("NOT " + located.format(cond=""))
    return [("(" + " OR ".join(parts) + ")", params)]


def _color(filters: dict) -> list[Clause]:
    """Photos that have a swatch within a Lab distance of any asked colour.
    `color` is one hex or a list (any of them); `color_tolerance` names how
    far is still the same colour."""
    from ..colors import DEFAULT_TOLERANCE, MATCH_MIN_SHARE, TOLERANCES, lab_of, parse_hex

    targets = [rgb for rgb in (parse_hex(v) for v in _values(filters.get("color"))) if rgb is not None]
    if not targets:
        return []
    radius = TOLERANCES.get(str(filters.get("color_tolerance") or DEFAULT_TOLERANCE), TOLERANCES[DEFAULT_TOLERANCE])
    parts: list[str] = []
    params: list[object] = []
    for rgb in targets:
        lab_l, lab_a, lab_b = lab_of(*rgb)
        parts.append("((c.l - ?) * (c.l - ?) + (c.a - ?) * (c.a - ?) + (c.b - ?) * (c.b - ?)) <= ?")
        params.extend([lab_l, lab_l, lab_a, lab_a, lab_b, lab_b, radius * radius])
    return [(
        f"EXISTS (SELECT 1 FROM asset_colors c WHERE c.asset_id = assets.asset_id AND c.share >= {MATCH_MIN_SHARE} "
        f"AND ({' OR '.join(parts)}))",
        params,
    )]


def _place_facet(name: str, column: str, *, upper: bool = False) -> Facet:
    """Country / city of the effective location. The values are the
    gazetteer's canonical ones (ISO code, English city name), filled from the
    coordinates when a location is written, so GPS, AI and manual locations
    all land on the same options."""

    def clauses(filters: dict) -> list[Clause]:
        values = [str(v).strip() for v in _values(filters.get(name)) if str(v).strip()]
        if not values:
            return []
        cond, params = _in(f"loc.{column}", [v.upper() if upper else v for v in values])
        return [(f"EXISTS (SELECT 1 FROM asset_locations loc WHERE loc.asset_id = {_LOCATION_OWNER} AND {cond})", params)]

    return Facet(name, (name,), clauses)


def _contains_facet(name: str, expr: str) -> Facet:
    """Case-insensitive "contains" on one text field. The search box matches
    seven fields at once (a camera name hits as readily as a caption); these
    match exactly one, and can be saved into a smart collection as such."""
    def clauses(filters: dict) -> list[Clause]:
        text = str(filters.get(name) or "").strip()
        if not text:
            return []
        escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return [(f"{expr} LIKE ? ESCAPE '\\'", [f"%{escaped}%"])]
    return Facet(name, (name,), clauses)


def _geo(filters: dict) -> list[Clause]:
    clause = _geo_filter_clause(filters.get("geo"))
    return [clause] if clause is not None else []


FACETS: tuple[Facet, ...] = (
    _column_facet("camera", "meta_camera_model"),
    _column_facet("lens", "meta_lens_model"),
    _range_facet("iso", "meta_iso"),
    _range_facet("aperture", "meta_aperture"),
    _range_facet("focal", "meta_focal"),
    _range_facet("shutter", "meta_shutter"),
    Facet("capture_time", ("date_from", "date_to", "date_within_days"), _capture_time),
    Facet("rating", ("rating_min",), _rating),
    Facet("orientation", ("orientation",), _orientation),
    Facet("asset_type", ("asset_type",), _asset_type),
    Facet("tag", ("tag", "tag_match"), _tag, modifiers=("tag_match",)),
    Facet("extension", ("extension",), _extension),
    Facet("people", ("people",), _people),
    Facet("annotated", ("annotated",), _annotated),
    Facet("person_group", ("person_group",), _person_group),
    Facet("location_source", ("location_source",), _location_source),
    _place_facet("country", "country_code", upper=True),
    _place_facet("city", "city_en"),
    Facet("color", ("color", "color_tolerance"), _color, modifiers=("color_tolerance",)),
    _contains_facet("caption_contains", "(SELECT ann.caption FROM asset_ai_annotations ann WHERE ann.asset_id = assets.asset_id)"),
    _contains_facet("ocr_contains", "(SELECT ann.detected_text FROM asset_ai_annotations ann WHERE ann.asset_id = assets.asset_id)"),
    _contains_facet("path_contains", "(SELECT reg.image_path FROM image_lookup_registry reg WHERE reg.image_asset_id = assets.asset_id LIMIT 1)"),
    Facet("geo", ("geo",), _geo),
    Facet("in_collection", ("in_collection",), _in_collection),
)

# Every key a filter dict may carry. Smart collection rules are validated
# against this, so a saved filter can never name something browse ignores.
FACET_KEYS = frozenset(key for facet in FACETS for key in facet.keys)
# Keys that only tune another key; never a condition alone.
FACET_MODIFIER_KEYS = frozenset(key for facet in FACETS for key in facet.modifiers)
# Counting a facet's options ignores its own keys — with PNG picked, JPG must
# still say how many JPGs there are, or the dropdown could never switch value.
FACET_OWN_KEYS: dict[str, frozenset[str]] = {facet.name: frozenset(facet.keys) for facet in FACETS}


def _facet_clauses(filters: dict | None) -> Clause:
    """AND-combined WHERE fragment ("AND a AND b …") + params for a filter
    dict. Unknown and empty keys are ignored."""
    if not filters:
        return "", []
    clauses: list[str] = []
    params: list[object] = []
    for facet in FACETS:
        for clause, clause_params in facet.clauses(filters):
            clauses.append(clause)
            params.extend(clause_params)
    if not clauses:
        return "", []
    return "AND " + " AND ".join(clauses), params
