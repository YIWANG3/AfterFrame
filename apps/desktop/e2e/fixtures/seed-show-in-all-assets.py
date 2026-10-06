"""Extend only a private E2E catalog with 100 bursts of 4 photos each.

The 4 photos of a burst share one capture time; bursts are a minute apart.
Names are scattered (burst b, shot s is DSC_<(4b+s)*7919 mod 400>), so the
name order is not the capture order and a test can tell which one it sees.
"""
import json
import os
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

BURSTS, SHOTS = 100, 4
# One photo deep in the library that the Rated view shows on its own.
RATED = {"burst-060-2": 3}


def stem_of(burst, shot):
    return f"DSC_{(burst * SHOTS + shot) * 7919 % (BURSTS * SHOTS):04}"


def capture_time_of(burst):
    return (datetime(2031, 1, 1, tzinfo=UTC) + timedelta(minutes=burst)).isoformat()


catalog = Path(sys.argv[1])
assert catalog.parent.name.startswith("afterframe-e2e-")
db = sqlite3.connect(catalog / "catalog.sqlite3")
db.row_factory = sqlite3.Row
columns = [r[1] for r in db.execute("PRAGMA table_info(assets)")]
original = dict(db.execute("SELECT * FROM assets WHERE stem = '001-red'").fetchone())
preview = db.execute("SELECT * FROM preview_entries WHERE asset_id=? AND kind='preview' LIMIT 1",
                     (original["asset_id"],)).fetchone()
source = Path(__file__).parent / "test-images" / "001-red.jpg"
# Every copy is that file, so it carries that file's colours. A photo without
# them makes launch start the colours catch-up job (see seed-version-navigation.py).
palette = db.execute("""SELECT rank, hex, share, l, a, b FROM asset_colors
                        WHERE asset_id = ?""", (original["asset_id"],)).fetchall()
assert palette, "fixture catalog lost 001-red's colours"
image_dir = catalog / "burst-images"
image_dir.mkdir()
for burst in range(BURSTS):
    for shot in range(SHOTS):
        asset_id = f"burst-{burst:03}-{shot}"
        stem = stem_of(burst, shot)
        image_path = image_dir / f"{stem}.jpg"
        os.link(source, image_path)
        stat = image_path.stat()
        modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
        metadata = json.loads(original["metadata_json"])
        # No GPS: 400 photos on one spot would only crowd the map.
        metadata.update(capture_time=capture_time_of(burst), gps_latitude=None, gps_longitude=None,
                        normalized_stem=stem, stem_key=stem, modified_time=modified, file_size=stat.st_size)
        row = {k: original[k] for k in columns}
        # Size and mtime must match the file on disk exactly, or browse flags
        # every row as source_changed and queues a refresh of all 400.
        row.update(asset_id=asset_id, stem=stem, normalized_stem=stem, stem_key=stem,
                   canonical_path=str(image_path), fingerprint=asset_id, app_rating=RATED.get(asset_id, 0),
                   file_size=stat.st_size, modified_time=modified, metadata_json=json.dumps(metadata),
                   created_at="2030-01-01 00:00:00", updated_at="2030-01-01 00:00:00")
        db.execute(f"INSERT INTO assets ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                   [row[k] for k in columns])
        db.execute("""INSERT INTO image_lookup_registry
                      (image_path, image_asset_id, match_status, resolver_version)
                      VALUES (?, ?, 'unmatched', 'e2e')""", (str(image_path), asset_id))
        if preview:
            db.execute("""INSERT INTO preview_entries
                          (cache_key, asset_id, kind, relative_path, width, height, status)
                          VALUES (?, ?, 'preview', ?, ?, ?, 'ready')""",
                       (asset_id, asset_id, preview["relative_path"], preview["width"], preview["height"]))
        db.executemany("INSERT INTO asset_colors (asset_id, rank, hex, share, l, a, b) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       [(asset_id, *tuple(c)) for c in palette])
db.commit()
db.close()
