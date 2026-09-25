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
from .browse import _status_clause
from .facets import ANY_OF_KEY, EXCLUDE_KEY, FACET_KEYS, FACET_MODIFIER_KEYS, FACET_NAMES, FACET_OWN_KEYS, _values

RULES_VERSION = 1

# The map viewport is a transient view state, not something to save.
_SAVABLE_FILTER_KEYS = FACET_KEYS - {"geo"}
_EXCLUDABLE_FACETS = FACET_NAMES - {"geo"}


def _clean_filters(filters: dict[str, Any]) -> dict[str, Any]:
    """Drop empty values. A multi-value facet keeps a list; a list of one is
    stored as the scalar, so a single pick saves exactly as it always has."""
    out: dict[str, Any] = {}
    for key, value in filters.items():
        if isinstance(value, (list, tuple)):
            items = [item for item in value if item not in (None, "")]
            if items:
                out[key] = items[0] if len(items) == 1 else items
        elif value not in (None, ""):
            out[key] = value
    return out


def _has_condition(filters: dict[str, Any]) -> bool:
    # A modifier (tag_match, exclude) tunes another key; it is not a condition by itself.
    return any(key not in FACET_MODIFIER_KEYS for key in filters)


def _normalize_filters(filters: Any, *, in_group: bool = False) -> dict[str, Any]:
    if not isinstance(filters, dict):
        raise ValueError("Smart collection filters must be an object")
    if in_group and ANY_OF_KEY in filters:
        raise ValueError("Filter groups do not nest")
    unknown = sorted(set(filters) - _SAVABLE_FILTER_KEYS)
    if unknown:
        raise ValueError(f"Unknown smart collection filter(s): {', '.join(unknown)}")
    out = _clean_filters({key: value for key, value in filters.items() if key != ANY_OF_KEY})
    excluded = [str(name) for name in _values(out.pop(EXCLUDE_KEY, None))]
    unknown = sorted(set(excluded) - _EXCLUDABLE_FACETS)
    if unknown:
        raise ValueError(f"Unknown filter(s) to exclude: {', '.join(unknown)}")
    # Only a facet that holds a condition has a sense to flip.
    excluded = [name for name in dict.fromkeys(excluded)
                if any(key in out and key not in FACET_MODIFIER_KEYS for key in FACET_OWN_KEYS[name])]
    if excluded:
        out[EXCLUDE_KEY] = excluded[0] if len(excluded) == 1 else excluded
    groups = filters.get(ANY_OF_KEY)
    if groups not in (None, []):
        if not isinstance(groups, list):
            raise ValueError("any_of must be a list of filter groups")
        kept = [group for group in (_normalize_filters(g, in_group=True) for g in groups) if _has_condition(group)]
        if kept:
            out[ANY_OF_KEY] = kept
    return out


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
    out: dict[str, Any] = {
        "version": RULES_VERSION,
        "status": status,
        "search": str(rules.get("search") or "").strip(),
        "filters": _normalize_filters(rules.get("filters") or {}),
    }
    if rules.get("sort"):
        out["sort"] = str(rules["sort"])
    if rules.get("base"):
        out["base"] = normalize_rules(rules["base"], _depth + 1)
    if status == "all" and not out["search"] and not _has_condition(out["filters"]) and "base" not in out:
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
