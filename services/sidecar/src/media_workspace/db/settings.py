"""app_settings key-value store.

Split from the monolithic db.py (review P3-5); one module per domain.
"""
from __future__ import annotations

import json
import os
import sqlite3
from hashlib import sha1
from pathlib import Path
from uuid import uuid4

from ..models import ImageCandidate, MatchDecision, RawMetadata

# Sentinel: distinguishes "don't touch error_text" from "clear it" in update_job.
_UNSET = object()
from ..schema import SCHEMA_STATEMENTS

RESOLVER_VERSION = "reverse_lookup_v3_embedded_metadata"
SCHEMA_VERSION = 5

from .core import _json

def get_app_setting(connection: sqlite3.Connection, setting_key: str) -> object | None:
    row = connection.execute(
        "SELECT value_json FROM app_settings WHERE setting_key = ?",
        (setting_key,),
    ).fetchone()
    if row is None:
        return None
    return json.loads(row["value_json"] or "null")


def set_app_setting(connection: sqlite3.Connection, setting_key: str, value: object, commit: bool = True) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (setting_key, value_json)
        VALUES (?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = CURRENT_TIMESTAMP
        """,
        (setting_key, _json(value)),
    )
    if commit:
        connection.commit()


def delete_app_setting(connection: sqlite3.Connection, setting_key: str, commit: bool = True) -> None:
    connection.execute("DELETE FROM app_settings WHERE setting_key = ?", (setting_key,))
    if commit:
        connection.commit()
