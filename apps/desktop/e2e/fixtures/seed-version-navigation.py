"""Extend only a private E2E catalog with versions on distant pages."""
import os
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

catalog = Path(sys.argv[1])
assert catalog.parent.name.startswith("afterframe-e2e-")
db = sqlite3.connect(catalog / "catalog.sqlite3")
db.row_factory = sqlite3.Row
columns = [r[1] for r in db.execute("PRAGMA table_info(assets)")]
original = dict(db.execute("SELECT * FROM assets WHERE asset_type='image' LIMIT 1").fetchone())
preview = db.execute("SELECT * FROM preview_entries WHERE asset_id=? AND kind='preview' LIMIT 1",
                     (original["asset_id"],)).fetchone()
if preview is None:
    preview = db.execute("SELECT * FROM preview_entries WHERE kind='preview' LIMIT 1").fetchone()
source = Path(__file__).parent / "test-images" / "001-red.jpg"
# Every copy is that file, so it carries that file's colours. A photo without
# them makes launch start the colours catch-up job, whose writes stall the
# serial sidecar for seconds on CI runners.
palette = db.execute("""SELECT rank, hex, share, l, a, b FROM asset_colors
                        JOIN assets USING (asset_id) WHERE assets.stem = '001-red'""").fetchall()
assert palette, "fixture catalog lost 001-red's colours"
image_dir = catalog / "navigation-images"
image_dir.mkdir()
for i in range(400):
    asset_id = f"navigation-{i:04}"
    stem = f"nav-{i:04}"
    image_path = image_dir / f"{stem}.jpg"
    os.link(source, image_path)
    stat = image_path.stat()
    row = {k: original[k] for k in columns}
    # Size and mtime must match the file on disk exactly (same format as the
    # sidecar's iso_mtime). Otherwise browse flags every row as source_changed
    # and the gallery queues a 400-file refresh-assets on the serial sidecar,
    # which stalls navigation for seconds on CI runners.
    row.update(asset_id=asset_id, stem=stem, normalized_stem=stem, stem_key=stem,
               canonical_path=str(image_path), fingerprint=asset_id, app_rating=5 if i == 0 else 0,
               file_size=stat.st_size,
               modified_time=datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat(),
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
db.execute("INSERT INTO resource_sets (set_id, primary_asset_id) VALUES ('navigation-set', 'navigation-0000')")
db.executemany("""INSERT INTO resource_set_items (set_id, asset_id, role, sort_order)
                  VALUES ('navigation-set', ?, ?, ?)""",
               [("navigation-0000", "primary", 0), ("navigation-0399", "version", 1)])
db.commit()
db.close()
