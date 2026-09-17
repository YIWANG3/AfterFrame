#!/usr/bin/env python3
"""Write a schema-v5 catalog database to <dest> for the legacy-catalog e2e.

    python3 make-legacy-catalog.py /path/to/catalog.sqlite3

Reuses tests/test_schema_migrations.create_v5_catalog (the sidecar's own
migration fixture: the pre-rename export_* tables, one asset, one registry
row, an old jobs table) so the e2e opens exactly what the unit tests
migrate — but through the app, on disk, end to end.
"""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
TEST_FILE = REPO / "tests" / "test_schema_migrations.py"


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 2
    sys.path.insert(0, str(REPO / "services" / "sidecar" / "src"))
    spec = importlib.util.spec_from_file_location("legacy_fixture", TEST_FILE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    dest = Path(argv[0])
    dest.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        Path(str(dest) + suffix).unlink(missing_ok=True)
    memory = module.create_v5_catalog()
    disk = sqlite3.connect(dest)
    memory.backup(disk)
    disk.close()
    print(f"{dest}: schema 5")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
