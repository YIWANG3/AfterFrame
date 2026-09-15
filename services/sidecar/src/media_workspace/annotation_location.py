"""GPS context for annotation. Coordinates win; gazetteer labels are approximate.

The bundled gazetteer contains points, not administrative boundary polygons.
Never present a nearest town/state as a verified address or infer a landmark.
"""
from functools import lru_cache
import json

from .db.locations import _valid_coordinates


@lru_cache(maxsize=4096)
def _nearby_labels(latitude: float, longitude: float) -> dict:
    from .discover import load_reverse_geocoder

    geo = load_reverse_geocoder()
    if geo is None:
        return {}
    town, _ = geo.localities.nearest(latitude, longitude, 40.0)
    state, _ = geo.admin1.nearest(latitude, longitude, 250.0)
    anchor = town or state
    if not anchor:
        return {}  # No country-centroid fallback for oceans / missing coverage.
    country_id = anchor.get("country")
    country = geo.country_by_qid.get(country_id, {})
    return {
        "country": country.get("en"),
        "admin1": state.get("en") if state and state.get("country") == country_id else None,
        "locality": town.get("en") if town else None,
    }


def gps_location(metadata: dict | str | None) -> dict | None:
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (ValueError, TypeError):
            return None
    if not isinstance(metadata, dict):
        return None
    coordinates = _valid_coordinates(metadata.get("gps_latitude"), metadata.get("gps_longitude"))
    if coordinates is None:
        return None
    latitude, longitude = coordinates
    # GPS remains authoritative even if the optional offline dataset fails.
    try:
        labels = _nearby_labels(latitude, longitude)
    except (OSError, ValueError, KeyError):
        labels = {}
    return {
        **labels, "latitude": latitude, "longitude": longitude,
        "source": "exif", "approximate_names": True,
        "landmark": None, "confidence": None,
    }


def asset_gps_location(connection, asset_id: str) -> dict | None:
    row = connection.execute("SELECT metadata_json FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
    return gps_location(row["metadata_json"]) if row else None


def effective_location(metadata, guess):
    """Read-time overlay also fixes old annotations without rewriting user data."""
    gps = gps_location(metadata)
    if gps:
        return gps
    # A saved GPS-derived label must not survive removal of its source GPS.
    return None if isinstance(guess, dict) and guess.get("source") == "exif" else guess
