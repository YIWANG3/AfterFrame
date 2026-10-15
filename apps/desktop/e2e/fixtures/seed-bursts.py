"""Extend only a private E2E catalog with a burst: three frames of one real
photo (slightly different crops, the camera's clock one second apart, well
after the original's own time) and a fourth frame of the same scene a minute
later. Each comes with its own
512 px preview and the original's colours but no look-alike row, so launch
runs the look-alike catch-up job, which is what groups them.
"""
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image

ORIGINAL = "image_771e6f50a43a51f6ae68ba70"  # 0Y1A6707-9, Canon EOS R6m2
# Twelve seconds after the original (17:34:08), which so stays out of the burst.
FRAMES = [("burst-frame-1", "2025-10-04T17:34:20", 0), ("burst-frame-2", "2025-10-04T17:34:21", 16),
          ("burst-frame-3", "2025-10-04T17:34:22", 32), ("burst-later", "2025-10-04T17:35:30", 8)]

catalog = Path(sys.argv[1])
assert catalog.parent.name.startswith("afterframe-e2e-")
db = sqlite3.connect(catalog / "catalog.sqlite3")
db.row_factory = sqlite3.Row
columns = [r[1] for r in db.execute("PRAGMA table_info(assets)")]
original = dict(db.execute("SELECT * FROM assets WHERE asset_id = ?", (ORIGINAL,)).fetchone())
palette = db.execute("SELECT rank, hex, share, l, a, b FROM asset_colors WHERE asset_id = ?", (ORIGINAL,)).fetchall()
image_dir = catalog / "burst-images"
image_dir.mkdir()
with Image.open(original["canonical_path"]) as source:
    source = source.convert("RGB")
    for asset_id, taken, crop in FRAMES:
        image_path = image_dir / f"{asset_id}.jpg"
        frame = source.crop((crop, crop // 2, source.width - crop // 2, source.height - crop))
        frame.save(image_path, quality=90)
        preview = frame.copy()
        preview.thumbnail((512, 512))
        preview_relative = f"previews/bu/{asset_id}.jpg"
        (catalog / preview_relative).parent.mkdir(parents=True, exist_ok=True)
        preview.save(catalog / preview_relative, quality=90)
        stat = image_path.stat()
        modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
        metadata = json.loads(original["metadata_json"])
        metadata.update(capture_time=taken, normalized_stem=asset_id, stem_key=asset_id, modified_time=modified,
                        file_size=stat.st_size, width=frame.width, height=frame.height, gps_latitude=None, gps_longitude=None)
        row = {k: original[k] for k in columns}
        row.update(asset_id=asset_id, stem=asset_id, normalized_stem=asset_id, stem_key=asset_id,
                   canonical_path=str(image_path), fingerprint=asset_id, file_size=stat.st_size, modified_time=modified,
                   metadata_json=json.dumps(metadata), created_at="2030-01-01 00:00:00", updated_at="2030-01-01 00:00:00")
        db.execute(f"INSERT INTO assets ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", [row[k] for k in columns])
        db.execute("INSERT INTO image_lookup_registry (image_path, image_asset_id, match_status, resolver_version) VALUES (?, ?, 'unmatched', 'e2e')",
                   (str(image_path), asset_id))
        db.execute("INSERT INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status) VALUES (?, ?, 'preview', ?, ?, ?, 'ready')",
                   (asset_id, asset_id, preview_relative, preview.width, preview.height))
        db.executemany("INSERT INTO asset_colors (asset_id, rank, hex, share, l, a, b) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       [(asset_id, *tuple(c)) for c in palette])
db.commit()
db.close()
