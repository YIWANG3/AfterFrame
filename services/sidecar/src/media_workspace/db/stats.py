"""The statistics page: what the library was shot with, how, and what was
kept (docs/prototypes/stats-page.html). One call answers the whole page.

The set counted is the gallery's — every photo and video the All Assets view
pages through — narrowed by the same facet filters (`filters`, as the
gallery's FilterBar sends them; the page's time range is date_from /
date_to). A number on the page opens the gallery with those filters plus the
one it stands for, so both must count the same rows: camera and lens are the
asset's own `meta_camera_model` / `meta_lens_model`, which the camera and
lens facets match; formats use the Format facet's families and the RAW
facet's pairing; places group by what the country and city facets can ask
for. The facets match videos as well as photos, so everything that opens the
gallery counts both. Only what is about photos alone and opens nothing (35 mm
focal lengths, the notes on photos without a camera or lens) leaves videos
out.

Nothing here needs a scan: every column already exists. The set is copied
into a temp table once and each section is a GROUP BY over it.
"""
from __future__ import annotations

import math
import sqlite3
from collections import defaultdict

from ..camera_names import camera_label, crop_factor
from ..formats import family_sql
from .browse import _view_where
from .facets import _SHOWN_SHAPE

CAMERA_LIMIT = 12
LENS_LIMIT = 15
COMBO_LIMIT = 10
CITY_LIMIT = 12
# The cameras' usage strips: this many months, ending at the newest photo.
TIMELINE_MONTHS = 24

_SCOPE = "temp.stats_scope"
_PHOTO = "kind != 'video'"

# Histogram bins. Aperture: nearest of the usual stops (in log space, so 1.7
# lands on 1.8 and 3.5 on 4). Shutter and ISO: whole stops.
APERTURE_STOPS = (1.0, 1.2, 1.4, 1.8, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0, 22.0)
_SHUTTER_FAST, _SHUTTER_SLOW = 13, -3  # 1/8000 s … 8 s
_SHUTTER_LABELS = {
    13: "1/8000", 12: "1/4000", 11: "1/2000", 10: "1/1000", 9: "1/500", 8: "1/250", 7: "1/125",
    6: "1/60", 5: "1/30", 4: "1/15", 3: "1/8", 2: "1/4", 1: "1/2", 0: "1s", -1: "2s", -2: "4s", -3: "8s+",
}
_ISO_LOW, _ISO_HIGH = -1, 7  # ISO 50 … 12800
# 35 mm equivalent focal lengths, the ones lenses are named after.
FOCAL_STOPS = (10, 12, 14, 16, 18, 20, 24, 28, 35, 40, 50, 60, 70, 85, 105, 135, 200, 300, 400, 600)

# A paired RAW, as the RAW facet (facets._HAS_RAW) reads it: a confirmed
# match, not a candidate still waiting for one.
_PAIRED = "registry.match_status IN ('auto_bound', 'manual_confirmed')"


def _nearest(value: float, stops: tuple[float, ...]) -> int:
    return min(range(len(stops)), key=lambda i: abs(math.log(value) - math.log(stops[i])))


def _aperture_bin(value: float) -> tuple[int, str]:
    index = _nearest(value, APERTURE_STOPS)
    stop = APERTURE_STOPS[index]
    return index, f"{stop:g}"


def _shutter_bin(value: float) -> tuple[int, str]:
    stops = max(_SHUTTER_SLOW, min(_SHUTTER_FAST, round(math.log2(1 / value))))
    return -stops, _SHUTTER_LABELS[stops]  # fastest first


def _iso_bin(value: float) -> tuple[int, str]:
    stops = max(_ISO_LOW, min(_ISO_HIGH, round(math.log2(value / 100))))
    label = str(round(100 * 2 ** stops))
    if stops == _ISO_HIGH:
        label += "+"
    return stops, label


def _rows(connection: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return connection.execute(sql, params).fetchall()


def _histogram(connection: sqlite3.Connection, column: str, binner) -> list[dict]:
    """Photos per bin of one exposure column, with the flags in each bin and
    the stored values it spans (min / max: the gallery's range filter). Bins
    between the first and last used one are kept at 0, so the chart reads as
    a scale."""
    bins: dict[int, dict] = {}
    for row in _rows(connection, f"""
        SELECT {column} AS v, COUNT(*) AS n, SUM(flag = 1) AS picks, SUM(flag = -1) AS rejects
        FROM {_SCOPE} WHERE {column} > 0 GROUP BY {column}
    """):
        key, label = binner(row["v"])
        entry = bins.setdefault(key, {"label": label, "count": 0, "picks": 0, "rejects": 0, "min": row["v"], "max": row["v"]})
        entry["count"] += row["n"]
        entry["picks"] += row["picks"]
        entry["rejects"] += row["rejects"]
        entry["min"] = min(entry["min"], row["v"])
        entry["max"] = max(entry["max"], row["v"])
    if not bins:
        return []
    out = []
    for key in range(min(bins), max(bins) + 1):
        if key in bins:
            out.append(bins[key])
        else:
            label = _empty_label(binner, key)
            if label is not None:
                out.append({"label": label, "count": 0, "picks": 0, "rejects": 0, "min": None, "max": None})
    return out


def _empty_label(binner, key: int) -> str | None:
    """The label of an empty bin between used ones."""
    if binner is _aperture_bin:
        return f"{APERTURE_STOPS[key]:g}"
    if binner is _shutter_bin:
        return _SHUTTER_LABELS.get(-key)
    if binner is _iso_bin:
        return str(round(100 * 2 ** key)) + ("+" if key == _ISO_HIGH else "")
    return None


def _months_back(last_month: str, count: int) -> list[str]:
    year, month = int(last_month[:4]), int(last_month[5:7])
    out = []
    for _ in range(count):
        out.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return out[::-1]


def _gear(connection: sqlite3.Connection, last_capture: str | None) -> dict:
    cameras = _rows(connection, f"""
        SELECT model, MAX(make) AS make, COUNT(*) AS n, SUM(flag = 1) AS picks, SUM(flag = -1) AS rejects,
               MIN(captured) AS first, MAX(captured) AS last
        FROM {_SCOPE} WHERE TRIM(COALESCE(model, '')) != ''
        GROUP BY model ORDER BY n DESC, model
    """)
    pairs = _rows(connection, f"""
        SELECT model, lens, COUNT(*) AS n FROM {_SCOPE}
        WHERE TRIM(COALESCE(model, '')) != '' AND TRIM(COALESCE(lens, '')) != ''
        GROUP BY model, lens ORDER BY n DESC, model, lens
    """)
    labels = {row["model"]: camera_label(row["make"], row["model"]) or row["model"] for row in cameras}
    top_lens: dict[str, str] = {}
    for row in pairs:
        top_lens.setdefault(row["model"], row["lens"])

    months = _months_back(last_capture[:7], TIMELINE_MONTHS) if last_capture else []
    monthly: dict[str, dict[str, int]] = defaultdict(dict)
    if months:
        for row in _rows(connection, f"""
            SELECT model, substr(captured, 1, 7) AS month, COUNT(*) AS n FROM {_SCOPE}
            WHERE TRIM(COALESCE(model, '')) != '' AND captured >= ?
            GROUP BY model, month
        """, (months[0],)):
            monthly[row["model"]][row["month"]] = row["n"]

    def camera_entry(row: sqlite3.Row) -> dict:
        return {
            "model": row["model"], "label": labels[row["model"]], "count": row["n"],
            "picks": row["picks"], "rejects": row["rejects"], "first": row["first"], "last": row["last"],
            "top_lens": top_lens.get(row["model"]),
            "monthly": [monthly[row["model"]].get(month, 0) for month in months],
        }

    lenses = _rows(connection, f"""
        SELECT lens, COUNT(*) AS n, SUM(flag = 1) AS picks, SUM(flag = -1) AS rejects,
               MIN(captured) AS first, MAX(captured) AS last
        FROM {_SCOPE} WHERE TRIM(COALESCE(lens, '')) != ''
        GROUP BY lens ORDER BY n DESC, lens
    """)
    lens_camera: dict[str, str] = {}
    for row in pairs:
        lens_camera.setdefault(row["lens"], labels.get(row["model"], row["model"]))

    counts = connection.execute(f"""
        SELECT SUM(TRIM(COALESCE(model, '')) = '') AS no_camera, SUM(TRIM(COALESCE(lens, '')) = '') AS no_lens
        FROM {_SCOPE} WHERE {_PHOTO}
    """).fetchone()
    return {
        "months": months,
        "cameras": [camera_entry(row) for row in cameras[:CAMERA_LIMIT]],
        "other_cameras": {"count": sum(row["n"] for row in cameras[CAMERA_LIMIT:]), "models": len(cameras[CAMERA_LIMIT:])},
        "without_camera": counts["no_camera"] or 0,
        "lenses": [
            {"lens": row["lens"], "count": row["n"], "picks": row["picks"], "rejects": row["rejects"],
             "first": row["first"], "last": row["last"], "camera": lens_camera.get(row["lens"])}
            for row in lenses[:LENS_LIMIT]
        ],
        "other_lenses": {"count": sum(row["n"] for row in lenses[LENS_LIMIT:]), "lenses": len(lenses[LENS_LIMIT:])},
        "without_lens": counts["no_lens"] or 0,
        "combos": [
            {"model": row["model"], "camera": labels.get(row["model"], row["model"]), "lens": row["lens"], "count": row["n"]}
            for row in pairs[:COMBO_LIMIT]
        ],
    }


def _focal(connection: sqlite3.Connection) -> dict:
    """35 mm equivalent focal lengths, through each camera's crop factor
    (camera_names). Cameras without a known factor — phones, drones — are
    counted apart rather than drawn at their physical focal length."""
    bins = [0] * len(FOCAL_STOPS)
    unknown = 0
    factors: dict[tuple, float | None] = {}
    for row in _rows(connection, f"""
        SELECT make, model, focal, COUNT(*) AS n FROM {_SCOPE}
        WHERE {_PHOTO} AND focal > 0 GROUP BY make, model, focal
    """):
        key = (row["make"], row["model"])
        if key not in factors:
            factors[key] = crop_factor(camera_label(row["make"], row["model"]))
        factor = factors[key]
        if factor is None:
            unknown += row["n"]
            continue
        bins[_nearest(row["focal"] * factor, FOCAL_STOPS)] += row["n"]
    used = [i for i, n in enumerate(bins) if n]
    if not used:
        return {"bins": [], "unknown": unknown}
    return {
        "bins": [{"label": str(FOCAL_STOPS[i]), "count": bins[i]} for i in range(used[0], used[-1] + 1)],
        "unknown": unknown,
    }


def _file_kind(asset_type: str, family: str) -> str:
    """`family`: the Format facet's (formats.family_sql), so JPEG here is
    every file the JPEG filter opens (.jpg, .jpeg, .jfif …)."""
    if asset_type == "video":
        return "video"
    if asset_type == "raw":
        return "raw"
    if family in ("jpeg", "heif"):
        return family
    return "other"


def _freed_bytes(connection: sqlite3.Connection, removable: dict[str, tuple[int, str | None]]) -> int:
    """Bytes deleting `removable` (asset_id → (own size, paired RAW)) would
    free: each file's own size, plus a RAW only when every photo that uses
    it is in the set (a RAW behind a kept version stays), and that RAW once."""
    total = sum(size or 0 for size, _ in removable.values())
    raws = sorted({raw for _, raw in removable.values() if raw})
    users: dict[str, set[str]] = defaultdict(set)
    for start in range(0, len(raws), 500):
        chunk = raws[start:start + 500]
        marks = ",".join("?" * len(chunk))
        for raw_id, image_id in connection.execute(
            f"SELECT raw_asset_id, image_asset_id FROM image_lookup_registry WHERE raw_asset_id IN ({marks})", chunk,
        ):
            users[raw_id].add(image_id)
    freed = [raw for raw in raws if users[raw] <= removable.keys()]
    for start in range(0, len(freed), 500):
        chunk = freed[start:start + 500]
        marks = ",".join("?" * len(chunk))
        total += connection.execute(f"SELECT COALESCE(SUM(file_size), 0) FROM assets WHERE asset_id IN ({marks})", chunk).fetchone()[0]
    return total


def _storage(connection: sqlite3.Connection) -> dict:
    """Bytes on disk of the set and the RAWs paired with it, each file once
    (a RAW behind several versions counts once)."""
    by_kind: dict[str, int] = defaultdict(int)
    by_year: dict[str, int] = defaultdict(int)
    for row in _rows(connection, f"""
        WITH ids AS (SELECT asset_id FROM {_SCOPE} UNION SELECT raw_id FROM {_SCOPE} WHERE raw_id IS NOT NULL)
        SELECT a.asset_type, {family_sql("LOWER(TRIM(a.extension, '.'))")} AS family,
               substr(a.meta_capture_time, 1, 4) AS year, SUM(a.file_size) AS bytes
        FROM assets AS a JOIN ids ON ids.asset_id = a.asset_id
        GROUP BY a.asset_type, family, year
    """):
        by_kind[_file_kind(row["asset_type"], row["family"] or "")] += row["bytes"] or 0
        by_year[row["year"] or ""] += row["bytes"] or 0

    rejected = {
        row["asset_id"]: (row["size"], row["raw_id"])
        for row in _rows(connection, f"SELECT asset_id, size, raw_id FROM {_SCOPE} WHERE flag = -1")
    }

    # Look-alike groups (asset_visual.dup_group) with two or more photos in
    # the set: keep the best of each (picked, then highest rated, then the
    # biggest file), the rest could go.
    groups: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in _rows(connection, f"""
        SELECT v.dup_group, s.asset_id, s.flag, s.rating, s.size, s.raw_id
        FROM {_SCOPE} AS s
        JOIN asset_visual AS v ON v.asset_id = s.asset_id
        WHERE v.dup_group IS NOT NULL AND s.{_PHOTO}
    """):
        groups[row["dup_group"]].append(row)
    extra: dict[str, tuple[int, str | None]] = {}
    group_count = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        group_count += 1
        members.sort(key=lambda r: (r["flag"] == 1, r["rating"], r["size"] or 0), reverse=True)
        extra.update((r["asset_id"], (r["size"], r["raw_id"])) for r in members[1:])

    missing = connection.execute(f"SELECT COUNT(*) FROM {_SCOPE} WHERE on_disk = 0").fetchone()[0]
    return {
        "total_bytes": sum(by_kind.values()),
        "by_kind": dict(by_kind),
        "by_year": [{"year": year, "bytes": by_year[year]} for year in sorted(y for y in by_year if y)],
        "rejected": {"count": len(rejected), "bytes": _freed_bytes(connection, rejected)},
        "lookalikes": {"groups": group_count, "count": len(extra), "bytes": _freed_bytes(connection, extra)},
        "missing": missing,
    }


def _places(connection: sqlite3.Connection) -> dict:
    """A paired RAW's location wins over its JPEG's, as the country and city
    facets read it (facets._LOCATION_OWNER). A city is what those facets can
    ask for — its country and English name — so a row opens exactly its
    photos; one without an English name groups by its key and opens nothing."""
    located = f"""
        SELECT s.asset_id,
               CASE WHEN rl.location_id IS NOT NULL THEN rl.country_code ELSE il.country_code END AS country,
               CASE WHEN rl.location_id IS NOT NULL THEN rl.city_key ELSE il.city_key END AS city_key,
               CASE WHEN rl.location_id IS NOT NULL THEN rl.city_en ELSE il.city_en END AS city_en,
               CASE WHEN rl.location_id IS NOT NULL THEN rl.city_zh ELSE il.city_zh END AS city_zh,
               CASE WHEN rl.location_id IS NOT NULL THEN rl.source ELSE il.source END AS source
        FROM {_SCOPE} AS s
        LEFT JOIN asset_locations AS rl ON rl.asset_id = s.raw_id
        LEFT JOIN asset_locations AS il ON il.asset_id = s.asset_id
        WHERE rl.location_id IS NOT NULL OR il.location_id IS NOT NULL
    """
    city = "COALESCE(country, '') || '|' || COALESCE(city_en, city_key)"
    totals = connection.execute(f"""
        SELECT COUNT(*) AS n, SUM(source = 'ai') AS ai, COUNT(DISTINCT country) AS countries,
               COUNT(DISTINCT CASE WHEN city_key IS NOT NULL THEN {city} END) AS cities
        FROM ({located})
    """).fetchone()
    cities = _rows(connection, f"""
        SELECT {city} AS city_key, MAX(city_en) AS city_en, MAX(city_zh) AS city_zh, MAX(country) AS country, COUNT(*) AS n
        FROM ({located}) WHERE city_key IS NOT NULL
        GROUP BY {city} ORDER BY n DESC, {city} LIMIT ?
    """, (CITY_LIMIT,))
    return {
        "located": totals["n"] or 0,
        "ai": totals["ai"] or 0,
        "countries": totals["countries"] or 0,
        "cities": totals["cities"] or 0,
        "top_cities": [
            {"city_key": row["city_key"], "city_en": row["city_en"], "city_zh": row["city_zh"],
             "country": row["country"], "count": row["n"]}
            for row in cities
        ],
    }


def _culling(connection: sqlite3.Connection) -> dict:
    row = connection.execute(f"""
        SELECT COUNT(*) AS total,
               SUM(flag != 0 OR rating > 0) AS reviewed,
               SUM(flag = 1) AS picks,
               SUM(flag = -1) AS rejects,
               SUM(rating >= 4) AS rated4,
               SUM(flag = 0 AND rating = 0 AND added >= datetime('now', '-30 days')) AS unreviewed_recent,
               SUM(EXISTS (
                       SELECT 1 FROM resource_sets AS rs
                       JOIN resource_set_items AS v ON v.set_id = rs.set_id AND v.role = 'version'
                       WHERE rs.primary_asset_id = s.asset_id)
                   OR EXISTS (
                       SELECT 1 FROM asset_links AS al
                       WHERE al.child_asset_id = s.asset_id AND al.relation_type = 'collage_source')) AS versions
        FROM {_SCOPE} AS s
    """).fetchone()
    ratings = {r["rating"]: r["n"] for r in _rows(connection, f"""
        SELECT rating, COUNT(*) AS n FROM {_SCOPE} WHERE rating BETWEEN 1 AND 5 GROUP BY rating
    """)}
    total = row["total"] or 0
    reviewed = row["reviewed"] or 0
    return {
        "total": total,
        "reviewed": reviewed,
        "unreviewed": total - reviewed,
        "unreviewed_recent": row["unreviewed_recent"] or 0,
        "picks": row["picks"] or 0,
        "rejects": row["rejects"] or 0,
        "rated4": row["rated4"] or 0,
        "versions": row["versions"] or 0,
        "ratings": [ratings.get(stars, 0) for stars in range(1, 6)],
    }


def _formats(connection: sqlite3.Connection) -> dict:
    out = {"raw_pair": 0, "raw": 0, "jpeg": 0, "heif": 0, "other": 0, "video": 0}
    for row in _rows(connection, f"""
        SELECT kind, family, paired, COUNT(*) AS n FROM {_SCOPE} GROUP BY kind, family, paired
    """):
        kind = "raw_pair" if row["paired"] and row["kind"] != "video" else _file_kind(row["kind"], row["family"] or "")
        out[kind] += row["n"]
    return out


def catalog_stats(connection: sqlite3.Connection, filters: dict | None = None) -> dict:
    where, params = _view_where("all", None, filters, None)
    connection.execute(f"DROP TABLE IF EXISTS {_SCOPE}")
    connection.execute(f"""
        CREATE TEMP TABLE stats_scope AS
        SELECT assets.asset_id, assets.asset_type AS kind,
               {family_sql("LOWER(TRIM(assets.extension, '.'))")} AS family,
               assets.file_size AS size, registry.raw_asset_id AS raw_id, {_PAIRED} AS paired,
               assets.meta_camera_model AS model,
               NULLIF(TRIM(json_extract(assets.metadata_json, '$.camera_make')), '') AS make,
               assets.meta_lens_model AS lens, assets.meta_iso AS iso, assets.meta_aperture AS aperture,
               assets.meta_shutter AS shutter, assets.meta_focal AS focal,
               assets.meta_capture_time AS captured,
               COALESCE(assets.app_flag, 0) AS flag, COALESCE(assets.app_rating, 0) AS rating,
               {_SHOWN_SHAPE} AS shape,
               assets.created_at AS added, assets.exists_on_disk AS on_disk
        FROM image_lookup_registry AS registry
        JOIN assets ON assets.asset_id = registry.image_asset_id
        LEFT JOIN asset_ai_annotations AS anno ON anno.asset_id = assets.asset_id
        WHERE {where}
    """, params)
    try:
        overview = connection.execute(f"""
            SELECT COUNT(*) AS total, SUM(kind = 'video') AS videos,
                   MIN(substr(captured, 1, 19)) AS first, MAX(substr(captured, 1, 19)) AS last,
                   COUNT(DISTINCT substr(captured, 1, 10)) AS days
            FROM {_SCOPE}
        """).fetchone()
        culling = _culling(connection)
        places = _places(connection)
        storage = _storage(connection)
        return {
            "overview": {
                "total": overview["total"] or 0,
                "photos": (overview["total"] or 0) - (overview["videos"] or 0),
                "videos": overview["videos"] or 0,
                "first": overview["first"],
                "last": overview["last"],
                "days": overview["days"] or 0,
                "picks": culling["picks"],
                "rejects": culling["rejects"],
                "countries": places["countries"],
                "cities": places["cities"],
                "bytes": storage["total_bytes"],
            },
            "gear": _gear(connection, overview["last"]),
            "exposure": {
                "focal": _focal(connection),
                "aperture": _histogram(connection, "aperture", _aperture_bin),
                "shutter": _histogram(connection, "shutter", _shutter_bin),
                "iso": _histogram(connection, "iso", _iso_bin),
            },
            "orientation": {
                row["shape"] or "unknown": row["n"]
                for row in _rows(connection, f"SELECT shape, COUNT(*) AS n FROM {_SCOPE} GROUP BY shape")
            },
            "formats": _formats(connection),
            "culling": culling,
            "places": places,
            "rhythm": {
                "days": [
                    [row["d"], row["n"]]
                    for row in _rows(connection, f"""
                        SELECT substr(captured, 1, 10) AS d, COUNT(*) AS n FROM {_SCOPE}
                        WHERE captured IS NOT NULL GROUP BY d ORDER BY d
                    """)
                ],
                "hours": _hours(connection),
            },
            "storage": storage,
        }
    finally:
        connection.execute(f"DROP TABLE IF EXISTS {_SCOPE}")


def _hours(connection: sqlite3.Connection) -> list[int]:
    hours = [0] * 24
    for row in _rows(connection, f"""
        SELECT CAST(substr(captured, 12, 2) AS INTEGER) AS h, COUNT(*) AS n FROM {_SCOPE}
        WHERE length(captured) >= 13 GROUP BY h
    """):
        if row["h"] is not None and 0 <= row["h"] < 24:
            hours[row["h"]] += row["n"]
    return hours
