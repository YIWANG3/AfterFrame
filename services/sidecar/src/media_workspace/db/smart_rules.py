"""Smart collection rules: a saved browse destination, not a rule engine.

A smart collection stores what the gallery was showing when it was saved —
status, search text, the FilterBar's facet dict, optionally a sort — and is
evaluated by the ordinary browse path. `collections.rules_json` holds:

    {"version": 1, "status": "all", "search": "", "filters": {...}, "sort": "...", "base": {...}?}

The column's historical default is '[]', which reads as "no rules".
"""
from __future__ import annotations

import json
from typing import Any

from .browse import _MAX_BASE_DEPTH as MAX_BASE_DEPTH
from .browse import FACET_KEYS, _status_clause

RULES_VERSION = 1

# The map viewport is a transient view state, not something to save.
_SAVABLE_FILTER_KEYS = FACET_KEYS - {"geo"}


def normalize_rules(rules: Any, _depth: int = 0) -> dict[str, Any]:
    """Validate rules coming from the app or an agent; raises ValueError.

    `base` nests another rules object: "inside that, refined by this". It is
    how a refinement made inside a smart collection is saved as a new one
    without merging keys that may collide."""
    if not isinstance(rules, dict):
        raise ValueError("Smart collection rules must be an object")
    if _depth >= MAX_BASE_DEPTH:
        raise ValueError("Smart collection rules are nested too deeply")
    version = rules.get("version", RULES_VERSION)
    if version != RULES_VERSION:
        raise ValueError(f"Unsupported smart collection rules version: {version}")
    status = rules.get("status") or "all"
    _status_clause(status)  # raises ValueError on an unknown status
    filters = rules.get("filters") or {}
    if not isinstance(filters, dict):
        raise ValueError("Smart collection filters must be an object")
    unknown = sorted(set(filters) - _SAVABLE_FILTER_KEYS)
    if unknown:
        raise ValueError(f"Unknown smart collection filter(s): {', '.join(unknown)}")
    out: dict[str, Any] = {
        "version": RULES_VERSION,
        "status": status,
        "search": str(rules.get("search") or "").strip(),
        "filters": {k: v for k, v in filters.items() if v not in (None, "")},
    }
    if rules.get("sort"):
        out["sort"] = str(rules["sort"])
    if rules.get("base"):
        out["base"] = normalize_rules(rules["base"], _depth + 1)
    if status == "all" and not out["search"] and not out["filters"] and "base" not in out:
        raise ValueError("A smart collection needs at least one condition")
    return out


def parse_rules(rules_json: str | None) -> dict[str, Any] | None:
    """Stored rules → dict, or None when there is nothing usable. Rules from a
    newer app version read as None, so an older app shows an empty collection
    instead of evaluating conditions it does not understand."""
    try:
        return normalize_rules(json.loads(rules_json or "[]"))
    except ValueError:  # includes json.JSONDecodeError
        return None
