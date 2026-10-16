"""Extend only a private E2E catalog with a re-encoded copy of one real photo.

The copy (smaller, lower quality) is what a second export of the same picture
looks like: the look-alike index should put the two in one group. It comes
with its own 512 px preview and the original's colours, so launch only runs
the look-alike catch-up job, nothing else.
"""
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image

ORIGINAL = "image_1f9dab80c352819829ab31a8"  # B0016108
COPY = "image_lookalike_copy"

catalog = Path(sys.argv[1])
assert catalog.parent.name.startswith("afterframe-e2e-")
db = sqlite3.connect(catalog / "catalog.sqlite3")
db.row_factory = sqlite3.Row
columns = [r[1] for r in db.execute("PRAGMA table_info(assets)")]
original = dict(db.execute("SELECT * FROM assets WHERE asset_id = ?", (ORIGINAL,)).fetchone())

image_dir = catalog / "lookalike-images"
image_dir.mkdir()
image_path = image_dir / "B0016108-copy.jpg"
with Image.open(original["canonical_path"]) as image:
    image = image.convert("RGB")
    image.resize((image.width * 4 // 5, image.height * 4 // 5)).save(image_path, quality=70)
    preview = image.copy()
    preview.thumbnail((512, 512))
    preview_relative = f"previews/im/{COPY}.jpg"
    (catalog / preview_relative).parent.mkdir(parents=True, exist_ok=True)
    preview.save(catalog / preview_relative, quality=90)
stat = image_path.stat()
modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
metadata = json.loads(original["metadata_json"])
metadata.update(normalized_stem="b0016108-copy", stem_key="b0016108-copy", modified_time=modified, file_size=stat.st_size)
row = {k: original[k] for k in columns}
row.update(asset_id=COPY, stem="B0016108-copy", normalized_stem="b0016108-copy", stem_key="b0016108-copy",
           canonical_path=str(image_path), fingerprint=COPY, file_size=stat.st_size, modified_time=modified,
           metadata_json=json.dumps(metadata))
db.execute(f"INSERT INTO assets ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", [row[k] for k in columns])
db.execute("INSERT INTO image_lookup_registry (image_path, image_asset_id, match_status, resolver_version) VALUES (?, ?, 'unmatched', 'e2e')",
           (str(image_path), COPY))
db.execute("INSERT INTO preview_entries (cache_key, asset_id, kind, relative_path, width, height, status) VALUES (?, ?, 'preview', ?, ?, ?, 'ready')",
           (COPY, COPY, preview_relative, preview.width, preview.height))
db.executemany("INSERT INTO asset_colors (asset_id, rank, hex, share, l, a, b) VALUES (?, ?, ?, ?, ?, ?, ?)",
               [(COPY, *tuple(c)) for c in db.execute("SELECT rank, hex, share, l, a, b FROM asset_colors WHERE asset_id = ?", (ORIGINAL,))])
db.commit()
db.close()
