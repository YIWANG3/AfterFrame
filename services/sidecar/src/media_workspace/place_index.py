"""The gazetteer's places for reverse geocoding, read a few tiles at a time.

Naming the place a coordinate is in (Discover, the Country and City filters,
annotation context) uses the gazetteer's localities, admin1 regions and
countries. Taken from data/gazetteer.json.gz, with everything else in it
(102k landmarks, the name indexes the AI resolver needs), that cost every
sidecar process half a second and ~390 MB the first time it placed a photo —
ten seconds or more on a slow Windows PC, with the resident sidecar's other
requests queued behind it.

data/places.idx holds the same localities cut into 2° tiles, each compressed
on its own, with the small admin1 and country lists in the header; a lookup
reads only the tiles around it. It is built from the gazetteer and has to
match it (tests/test_place_index.py checks):

    python -m media_workspace.place_index     # after the gazetteer changes
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any

from .geo_resolver import GAZETTEER_PATH

PLACE_INDEX_PATH = Path(__file__).parent / "data" / "places.idx"
_MAGIC = b"AFPLACES1\n"
# The reverse geocoder's grid (discover._GridIndex) buckets places by cell; a
# tile is CELLS_PER_TILE × CELLS_PER_TILE cells, so no cell spans two tiles.
CELL_DEG = 0.5
CELLS_PER_TILE = 4
# A locality is stored as an array of these; a missing value is null.
_FIELDS = ("q", "lat", "lon", "links", "country", "en", "zh")

Cell = tuple[int, int]


def cell_of(lat: float, lon: float) -> Cell:
    return (math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG))


def tile_of(cell: Cell) -> Cell:
    return (cell[0] // CELLS_PER_TILE, cell[1] // CELLS_PER_TILE)


def _dumps(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class PlaceIndex:
    """Countries, admin1 regions and the tile directory up front; localities
    one tile at a time, as lookups reach them."""

    def __init__(self, data: bytes):
        if not data.startswith(_MAGIC):
            raise ValueError("not a place index")
        (header_size,) = struct.unpack_from("<I", data, len(_MAGIC))
        start = len(_MAGIC) + 4
        header = json.loads(zlib.decompress(data[start:start + header_size]))
        if (header.get("cell_deg"), header.get("cells_per_tile"), header.get("fields")) != (CELL_DEG, CELLS_PER_TILE, list(_FIELDS)):
            raise ValueError("place index laid out for another version")
        self._data = memoryview(data)
        self._body = start + header_size
        self.source_sha256: str = header["source_sha256"]
        self.countries: list[dict] = header["countries"]
        self.admin1: list[dict] = header["admin1"]
        self._tiles: dict[Cell, tuple[int, int]] = {(ty, tx): (offset, size) for ty, tx, offset, size in header["tiles"]}

    def localities(self, tile: Cell) -> list[dict]:
        where = self._tiles.get(tile)
        if where is None:
            return []
        offset, size = where
        rows = json.loads(zlib.decompress(self._data[self._body + offset:self._body + offset + size]))
        return [{field: value for field, value in zip(_FIELDS, row, strict=True) if value is not None} for row in rows]


def build(gazetteer_path: Path = GAZETTEER_PATH, out_path: Path = PLACE_INDEX_PATH) -> int:
    """Write the index for this gazetteer; returns how many localities it holds."""
    source = gazetteer_path.read_bytes()
    payload = json.loads(gzip.decompress(source))
    tiles: dict[Cell, list[list[Any]]] = {}
    count = 0
    for item in payload.get("localities", []):
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue  # the grid skips these too
        tiles.setdefault(tile_of(cell_of(lat, lon)), []).append([item.get(field) for field in _FIELDS])
        count += 1
    blobs: list[bytes] = []
    directory: list[list[int]] = []
    offset = 0
    for tile in sorted(tiles):
        blob = zlib.compress(_dumps(tiles[tile]), 9)
        directory.append([tile[0], tile[1], offset, len(blob)])
        blobs.append(blob)
        offset += len(blob)
    header = zlib.compress(_dumps({
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "cell_deg": CELL_DEG,
        "cells_per_tile": CELLS_PER_TILE,
        "fields": list(_FIELDS),
        "countries": payload.get("countries", []),
        "admin1": payload.get("admin1", []),
        "tiles": directory,
    }), 9)
    out_path.write_bytes(_MAGIC + struct.pack("<I", len(header)) + header + b"".join(blobs))
    return count


_index: PlaceIndex | None = None
_load_failed = False


def load_place_index() -> PlaceIndex | None:
    """Lazy singleton; None when the file is missing or unreadable (the
    reverse geocoder then falls back to the whole gazetteer)."""
    global _index, _load_failed
    if _index is not None or _load_failed:
        return _index
    try:
        _index = PlaceIndex(PLACE_INDEX_PATH.read_bytes())
    except (OSError, ValueError, KeyError, TypeError, struct.error, zlib.error):
        _load_failed = True
    return _index


if __name__ == "__main__":
    print(f"{PLACE_INDEX_PATH}: {build()} localities")
