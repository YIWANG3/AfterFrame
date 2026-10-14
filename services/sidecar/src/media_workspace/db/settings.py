"""app_settings key-value store.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import sqlite3


def get_app_setting(connection: sqlite3.Connection, setting_key: str) -> object | None:
    row = connection.execute(
        "SELECT value_json FROM app_settings WHERE setting_key = ?",
        (setting_key,),
    ).fetchone()
    if row is None:
        return None
    return json.loads(row["value_json"] or "null")
