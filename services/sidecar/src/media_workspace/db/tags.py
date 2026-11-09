"""Tags as entities: groups, aliases, pins, and the writes that keep them.

A photo's tags stay in asset_tags (one row per (asset, tag), the string is
the identity). This module owns what is said ABOUT a tag:

    tag_groups   the groups: 13 built-in ones (fixed ids, named through i18n
                 in the app) and the user's own; `ai_fill` says whether the
                 annotation prompt asks the model for tags in this group
    tags         one row per distinct tag: its group (NULL = ungrouped), pin
    tag_aliases  other spellings that resolve to a tag: the other language
                 of a vocabulary concept, a merged-away tag, a renamed one

Every write of a tag string goes through `TagResolver`: normalize, then
alias, then the library's own spelling, then the built-in vocabulary
(data/tag_vocabulary.json: en / zh spelling + group per concept), then a
brand-new tag. The vocabulary is also how a flat list of tags (an older
annotation, a model that ignored the grouped output) finds its groups.
"""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# (group_id, English name, ai_fill). Order is the display order.
BUILTIN_GROUPS: tuple[tuple[str, str, int], ...] = (
    ("weather", "Weather", 1),
    ("season", "Season", 1),
    ("time", "Time of day", 1),
    ("light", "Light", 1),
    ("subject", "Subject", 1),
    ("place", "Place type", 1),
    ("event", "Occasion", 1),
    ("gear", "Gear", 1),
    ("technique", "Technique", 1),
    ("style", "Style", 1),
    ("color", "Color", 1),
    ("mood", "Mood", 1),
    # The user's own bookkeeping (to edit, portfolio, client): never the model's.
    ("workflow", "Workflow", 0),
)
BUILTIN_GROUP_IDS = frozenset(group_id for group_id, _, _ in BUILTIN_GROUPS)

VOCABULARY_PATH = Path(__file__).parent.parent / "data" / "tag_vocabulary.json"


def normalize_tag(tag: str) -> str:
    """Lowercase, strip, collapse whitespace. The equality key for tags."""
    return re.sub(r"\s+", " ", str(tag or "").lower().strip())


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ── The vocabulary ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Concept:
    en: str
    zh: str
    group: str

    def spellings(self) -> tuple[str, str]:
        return (self.en, self.zh)


_VOCABULARY: list[Concept] | None = None
_VOCABULARY_INDEX: dict[str, Concept] | None = None


def vocabulary() -> list[Concept]:
    global _VOCABULARY, _VOCABULARY_INDEX
    if _VOCABULARY is None:
        data = json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))
        _VOCABULARY = [Concept(str(c["en"]), str(c["zh"]), str(c["group"])) for c in data["concepts"]]
        _VOCABULARY_INDEX = {}
        for concept in _VOCABULARY:
            for spelling in concept.spellings():
                _VOCABULARY_INDEX.setdefault(normalize_tag(spelling), concept)
    return _VOCABULARY


def concept_for(tag: str) -> Concept | None:
    """The vocabulary concept a spelling belongs to, if any."""
    vocabulary()
    assert _VOCABULARY_INDEX is not None
    return _VOCABULARY_INDEX.get(normalize_tag(tag))


# ── Groups ───────────────────────────────────────────────────────────────────

def ensure_builtin_groups(connection: sqlite3.Connection) -> None:
    """The built-in groups, present (idempotent). One the user deleted stays
    deleted: tag_groups_deleted remembers its id, which INSERT OR IGNORE
    alone could not tell from an id never seen."""
    deleted = {row[0] for row in connection.execute("SELECT group_id FROM tag_groups_deleted")}
    for order, (group_id, name, ai_fill) in enumerate(BUILTIN_GROUPS):
        if group_id in deleted:
            continue
        connection.execute(
            "INSERT OR IGNORE INTO tag_groups (group_id, name, kind, sort_order, ai_fill) VALUES (?, ?, 'builtin', ?, ?)",
            (group_id, name, order, ai_fill),
        )


def ensure_tag_rows(connection: sqlite3.Connection) -> None:
    """A `tags` row for every tag a photo carries (idempotent)."""
    connection.execute("INSERT OR IGNORE INTO tags (tag) SELECT DISTINCT tag FROM asset_tags")


def list_tag_groups(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT g.group_id, g.name, g.kind, g.sort_order, g.ai_fill,
               (SELECT COUNT(*) FROM tags t WHERE t.group_id = g.group_id) AS tag_count
        FROM tag_groups g
        ORDER BY g.sort_order, g.created_at, g.group_id
        """
    ).fetchall()
    return [dict(row) for row in rows]


def group_exists(connection: sqlite3.Connection, group_id: str | None) -> bool:
    if not group_id:
        return False
    return connection.execute("SELECT 1 FROM tag_groups WHERE group_id = ?", (group_id,)).fetchone() is not None


def create_group(connection: sqlite3.Connection, name: str, *, ai_fill: bool = True, commit: bool = True) -> dict[str, Any]:
    name = str(name or "").strip()
    if not name:
        raise ValueError("A tag group needs a name")
    group_id = f"grp_{secrets.token_hex(6)}"
    order = connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag_groups").fetchone()[0]
    connection.execute(
        "INSERT INTO tag_groups (group_id, name, kind, sort_order, ai_fill) VALUES (?, ?, 'custom', ?, ?)",
        (group_id, name, order, 1 if ai_fill else 0),
    )
    if commit:
        connection.commit()
    return {"group_id": group_id, "name": name, "kind": "custom", "sort_order": order, "ai_fill": 1 if ai_fill else 0, "tag_count": 0}


def update_group(
    connection: sqlite3.Connection, group_id: str, *, name: str | None = None, ai_fill: bool | None = None, commit: bool = True,
) -> dict[str, Any]:
    if not group_exists(connection, group_id):
        raise ValueError(f"Unknown tag group: {group_id}")
    if name is not None:
        name = str(name).strip()
        if not name:
            raise ValueError("A tag group needs a name")
        connection.execute("UPDATE tag_groups SET name = ? WHERE group_id = ?", (name, group_id))
    if ai_fill is not None:
        connection.execute("UPDATE tag_groups SET ai_fill = ? WHERE group_id = ?", (1 if ai_fill else 0, group_id))
    if commit:
        connection.commit()
    return next(group for group in list_tag_groups(connection) if group["group_id"] == group_id)


def delete_group(connection: sqlite3.Connection, group_id: str, *, commit: bool = True) -> dict[str, Any]:
    """The group goes; its tags become ungrouped. A built-in id is remembered
    as deleted so init does not bring the group back; smart collections that
    filtered on the group lose that condition."""
    row = connection.execute("SELECT kind FROM tag_groups WHERE group_id = ?", (group_id,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown tag group: {group_id}")
    moved = connection.execute("SELECT COUNT(*) FROM tags WHERE group_id = ?", (group_id,)).fetchone()[0]
    connection.execute("UPDATE tags SET group_id = NULL, updated_at = ? WHERE group_id = ?", (_now(), group_id))
    connection.execute("DELETE FROM tag_groups WHERE group_id = ?", (group_id,))
    if row["kind"] == "builtin":
        connection.execute("INSERT OR IGNORE INTO tag_groups_deleted (group_id) VALUES (?)", (group_id,))
    rewrite_smart_rule_values(connection, "tag_group", {group_id: None})
    if commit:
        connection.commit()
    return {"group_id": group_id, "ungrouped": moved}


# ── Resolving spellings ──────────────────────────────────────────────────────

@dataclass
class Resolved:
    tag: str                 # the library's spelling to write
    group_id: str | None     # the group it has, or the vocabulary's suggestion for a new one
    is_new: bool             # no `tags` row yet
    concept: Concept | None  # the vocabulary concept, when it is one


class TagResolver:
    """Loads the library's tags and aliases once; answers for many spellings.
    Writes nothing: `ensure_tag` does."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection
        self.by_norm: dict[str, tuple[str, str | None]] = {}
        for tag, group_id in connection.execute("SELECT tag, group_id FROM tags"):
            self.by_norm.setdefault(normalize_tag(tag), (tag, group_id))
        self.aliases: dict[str, str] = dict(connection.execute("SELECT alias, tag FROM tag_aliases").fetchall())
        self.groups: set[str] = {row[0] for row in connection.execute("SELECT group_id FROM tag_groups")}

    def _group_or_none(self, group_id: str | None) -> str | None:
        return group_id if group_id in self.groups else None

    def resolve(self, raw: str) -> Resolved | None:
        norm = normalize_tag(raw)
        if not norm:
            return None
        target = self.aliases.get(norm)
        if target is not None:
            known = self.by_norm.get(normalize_tag(target))
            if known is not None:
                return Resolved(known[0], known[1], False, concept_for(known[0]))
        known = self.by_norm.get(norm)
        if known is not None:
            return Resolved(known[0], known[1], False, concept_for(known[0]))
        concept = concept_for(norm)
        if concept is not None:
            # The other spelling of the same concept may already be the library's.
            for spelling in concept.spellings():
                other = self.by_norm.get(normalize_tag(spelling))
                if other is not None:
                    return Resolved(other[0], other[1], False, concept)
            spelled = concept.en if norm == normalize_tag(concept.en) else concept.zh
            return Resolved(spelled, self._group_or_none(concept.group), True, concept)
        return Resolved(str(raw).strip(), None, True, None)

    def remember(self, resolved: Resolved) -> None:
        """After `ensure_tag` wrote it, so the next spelling in the same batch finds it."""
        self.by_norm.setdefault(normalize_tag(resolved.tag), (resolved.tag, resolved.group_id))
        if resolved.concept is not None:
            for spelling in resolved.concept.spellings():
                self.aliases.setdefault(normalize_tag(spelling), resolved.tag)


def resolve_tag(connection: sqlite3.Connection, raw: str) -> Resolved | None:
    return TagResolver(connection).resolve(raw)


def ensure_tag(
    connection: sqlite3.Connection,
    resolved: Resolved,
    *,
    group_id: str | None = None,
    resolver: TagResolver | None = None,
) -> str | None:
    """The `tags` row for a resolved spelling, created if new; its aliases
    for a vocabulary concept. `group_id` is a suggestion (the model's, the
    Inspector's picker) for a tag that has no group yet; a vocabulary tag
    takes the vocabulary's group, and a group a tag already has stays.
    Returns the tag's group after the write."""
    now = _now()
    suggested = group_id if group_id and group_exists(connection, group_id) else None
    if resolved.is_new:
        wanted = resolved.group_id if resolved.concept is not None else suggested
        connection.execute(
            "INSERT OR IGNORE INTO tags (tag, group_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (resolved.tag, wanted, now, now),
        )
    elif suggested is not None:
        connection.execute(
            "UPDATE tags SET group_id = ?, updated_at = ? WHERE tag = ? AND group_id IS NULL", (suggested, now, resolved.tag),
        )
    if resolved.concept is not None:
        for spelling in resolved.concept.spellings():
            if normalize_tag(spelling) != normalize_tag(resolved.tag):
                connection.execute(
                    "INSERT OR IGNORE INTO tag_aliases (alias, tag) VALUES (?, ?)", (normalize_tag(spelling), resolved.tag),
                )
    row = connection.execute("SELECT group_id FROM tags WHERE tag = ?", (resolved.tag,)).fetchone()
    resolved.group_id = row[0] if row else None
    resolved.is_new = False
    if resolver is not None:
        resolver.remember(resolved)
    return resolved.group_id


# ── A photo's tags ───────────────────────────────────────────────────────────
#
# One list per photo, in asset_tags: what the user typed and what an
# annotation run proposed, each row saying which (source 'user' / 'ai').
# Search, the tag filter, the Inspector and MCP all read it. A run replaces
# its own earlier proposals and never touches the user's; a tag the user adds
# that the AI had proposed becomes theirs. asset_ai_annotations.tags_json is
# only the record of what the last run proposed.

def get_asset_tags(connection: sqlite3.Connection, asset_id: str) -> list[str]:
    """The photo's tags, in the order they were put on it."""
    rows = connection.execute(
        "SELECT tag FROM asset_tags WHERE asset_id = ? ORDER BY created_at, rowid", (asset_id,)
    ).fetchall()
    return [row["tag"] for row in rows]


def _put_user_tag(connection: sqlite3.Connection, asset_id: str, tag: str, now: str) -> None:
    """`tag` (already the library's spelling) onto the photo as the user's."""
    cursor = connection.execute("UPDATE asset_tags SET source = 'user' WHERE asset_id = ? AND tag = ?", (asset_id, tag))
    if cursor.rowcount == 0:
        connection.execute(
            "INSERT INTO asset_tags (asset_id, tag, source, created_at) VALUES (?, ?, 'user', ?)",
            (asset_id, tag, now),
        )


def _known_asset_ids(connection: sqlite3.Connection, asset_ids: list[str]) -> set[str]:
    wanted = list(dict.fromkeys(a for a in asset_ids or [] if a))
    known: set[str] = set()
    for start in range(0, len(wanted), 500):
        chunk = wanted[start:start + 500]
        known.update(
            row[0] for row in connection.execute(
                f"SELECT asset_id FROM assets WHERE asset_id IN ({','.join('?' * len(chunk))})", chunk,
            )
        )
    return known


def add_asset_tag(
    connection: sqlite3.Connection, asset_id: str, tag: str, *, group_id: str | None = None, commit: bool = True,
) -> dict[str, Any]:
    """A tag onto a photo by hand. It makes no annotation row: a hand-tagged
    photo is still one AI hasn't described, so "annotate missing" still
    takes it and the "AI annotated" filter doesn't count it. `group_id` is
    where a NEW tag goes (the Inspector's group picker); an existing tag
    keeps its group."""
    resolver = TagResolver(connection)
    resolved = resolver.resolve(tag or "")
    if resolved is not None:
        ensure_tag(connection, resolved, group_id=group_id, resolver=resolver)
        _put_user_tag(connection, asset_id, resolved.tag, _now())
    if commit:
        connection.commit()
    return {"asset_id": asset_id, "tags": get_asset_tags(connection, asset_id)}


def add_asset_tags(
    connection: sqlite3.Connection, asset_ids: list[str], tags: list[str], *, group_id: str | None = None,
) -> dict[str, Any]:
    """Add every tag to every asset in one transaction (the gallery's batch
    "Add Tags…"). Ids the catalog doesn't hold are skipped, not created."""
    resolver = TagResolver(connection)
    clean: list[str] = []
    for raw in tags or []:
        resolved = resolver.resolve(raw or "")
        if resolved is None or resolved.tag in clean:
            continue
        ensure_tag(connection, resolved, group_id=group_id, resolver=resolver)
        clean.append(resolved.tag)
    wanted = list(dict.fromkeys(a for a in asset_ids or [] if a))
    known = _known_asset_ids(connection, wanted) if wanted else set()
    updated = [a for a in wanted if a in known]
    if clean:
        now = _now()
        for asset_id in updated:
            for tag in clean:
                _put_user_tag(connection, asset_id, tag, now)
    connection.commit()
    return {"ok": True, "asset_ids": updated, "tags": clean, "missing": [a for a in wanted if a not in known]}


def remove_asset_tag(connection: sqlite3.Connection, asset_id: str, tag: str, *, commit: bool = True) -> dict[str, Any]:
    """Take a tag off a photo, whoever put it there. Any spelling of it."""
    resolved = resolve_tag(connection, tag or "")
    if resolved is not None:
        if resolved.is_new:
            # No entity for it (a spelling never registered): still take it off by name.
            connection.execute(
                "DELETE FROM asset_tags WHERE asset_id = ? AND LOWER(tag) = ?", (asset_id, normalize_tag(resolved.tag)),
            )
        else:
            connection.execute("DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?", (asset_id, resolved.tag))
    if commit:
        connection.commit()
    return {"asset_id": asset_id, "tags": get_asset_tags(connection, asset_id)}


def remove_asset_tags(connection: sqlite3.Connection, asset_ids: list[str], tags: list[str]) -> dict[str, Any]:
    """Take every tag off every asset in one transaction (the batch "Remove Tags…")."""
    resolver = TagResolver(connection)
    clean: list[str] = []
    for raw in tags or []:
        resolved = resolver.resolve(raw or "")
        if resolved is not None and not resolved.is_new and resolved.tag not in clean:
            clean.append(resolved.tag)
    wanted = list(dict.fromkeys(a for a in asset_ids or [] if a))
    removed = 0
    if clean and wanted:
        for start in range(0, len(wanted), 400):
            chunk = wanted[start:start + 400]
            cursor = connection.execute(
                f"DELETE FROM asset_tags WHERE asset_id IN ({','.join('?' * len(chunk))}) "
                f"AND tag IN ({','.join('?' * len(clean))})",
                [*chunk, *clean],
            )
            removed += cursor.rowcount
    connection.commit()
    return {"ok": True, "asset_ids": wanted, "tags": clean, "removed": removed}


def list_selection_tags(connection: sqlite3.Connection, asset_ids: list[str]) -> list[dict[str, Any]]:
    """The tags on a set of photos, with how many of them carry each: the
    batch "Remove Tags…" dialog's candidates."""
    wanted = list(dict.fromkeys(a for a in asset_ids or [] if a))
    if not wanted:
        return []
    counts: dict[str, int] = {}
    for start in range(0, len(wanted), 500):
        chunk = wanted[start:start + 500]
        for tag, count in connection.execute(
            f"SELECT tag, COUNT(*) FROM asset_tags WHERE asset_id IN ({','.join('?' * len(chunk))}) GROUP BY tag", chunk,
        ):
            counts[tag] = counts.get(tag, 0) + count
    groups = tag_groups_for(connection, list(counts))
    return [
        {"tag": tag, "count": count, "group_id": groups.get(tag)}
        for tag, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


# ── Reading tags with their groups ───────────────────────────────────────────

def tag_groups_for(connection: sqlite3.Connection, tags: list[str]) -> dict[str, str | None]:
    """Each tag's group (NULL for ungrouped and for tags without a row)."""
    out: dict[str, str | None] = {}
    clean = [t for t in tags if t]
    for start in range(0, len(clean), 500):
        chunk = clean[start:start + 500]
        for tag, group_id in connection.execute(
            f"SELECT tag, group_id FROM tags WHERE tag IN ({','.join('?' * len(chunk))})", chunk,
        ):
            out[tag] = group_id
    return out


def list_tags_grouped(
    connection: sqlite3.Connection,
    *,
    limit: int | None = None,
    query: str | None = None,
    group: str | None = None,
    include_unused: bool = True,
) -> dict[str, Any]:
    """Every tag with its use count, by group: the Tags page and MCP's
    list_tags. `limit` caps each group's list (most used first, pinned
    first); `query` narrows to tags (or aliases) containing it; `group` is
    one group id, or "ungrouped"."""
    where: list[str] = []
    params: list[object] = []
    if query:
        like = f"%{normalize_tag(query)}%"
        where.append("(LOWER(t.tag) LIKE ? OR EXISTS (SELECT 1 FROM tag_aliases a WHERE a.tag = t.tag AND a.alias LIKE ?))")
        params.extend([like, like])
    if group == "ungrouped":
        where.append("t.group_id IS NULL")
    elif group:
        where.append("t.group_id = ?")
        params.append(group)
    if not include_unused:
        where.append("uses.c > 0")
    rows = connection.execute(
        f"""
        SELECT t.tag, t.group_id, t.pinned, COALESCE(uses.c, 0) AS count,
               (SELECT json_group_array(a.alias) FROM tag_aliases a WHERE a.tag = t.tag) AS aliases_json
        FROM tags t
        LEFT JOIN (SELECT tag, COUNT(*) AS c FROM asset_tags GROUP BY tag) AS uses ON uses.tag = t.tag
        {('WHERE ' + ' AND '.join(where)) if where else ''}
        ORDER BY t.pinned DESC, count DESC, t.tag
        """,
        params,
    ).fetchall()
    by_group: dict[str | None, list[dict[str, Any]]] = {}
    for row in rows:
        entry = {
            "tag": row["tag"],
            "count": row["count"],
            "pinned": bool(row["pinned"]),
            "aliases": [a for a in json.loads(row["aliases_json"] or "[]") if a],
        }
        bucket = by_group.setdefault(row["group_id"], [])
        if limit is None or len(bucket) < limit:
            bucket.append(entry)
    groups = []
    for info in list_tag_groups(connection):
        if group and group != info["group_id"]:
            continue
        groups.append({**info, "tags": by_group.get(info["group_id"], [])})
    ungrouped = by_group.get(None, []) if group in (None, "ungrouped") else []
    return {"count": len(rows), "groups": groups, "ungrouped": ungrouped}


def list_top_tags(connection: sqlite3.Connection, limit: int = 200) -> list[str]:
    """Most-used tags first (flat), for callers that only want the names."""
    rows = connection.execute(
        "SELECT tag, COUNT(*) AS uses FROM asset_tags GROUP BY tag ORDER BY uses DESC, tag ASC LIMIT ?", (limit,),
    ).fetchall()
    return [r["tag"] for r in rows]


def reuse_hints(connection: sqlite3.Connection, *, per_group: int = 25, ungrouped: int = 40) -> list[dict[str, Any]]:
    """What the annotation prompt lists: each group the model may fill
    (ai_fill), with the library's most-used tags in it, and the most-used
    ungrouped tags. Every group is listed, examples or not, so the model
    knows the buckets it can use."""
    listed = list_tags_grouped(connection, limit=max(per_group, ungrouped), include_unused=False)
    out: list[dict[str, Any]] = []
    for group in listed["groups"]:
        if not group["ai_fill"]:
            continue
        out.append({"id": group["group_id"], "name": group["name"], "examples": [t["tag"] for t in group["tags"][:per_group]]})
    out.append({"id": "other", "name": "Other", "examples": [t["tag"] for t in listed["ungrouped"][:ungrouped]]})
    return out


# ── Library-level edits ──────────────────────────────────────────────────────

def set_tag_group(connection: sqlite3.Connection, tags: list[str], group_id: str | None, *, commit: bool = True) -> dict[str, Any]:
    """Move tags into a group (None = ungrouped)."""
    if group_id and not group_exists(connection, group_id):
        raise ValueError(f"Unknown tag group: {group_id}")
    resolver = TagResolver(connection)
    moved: list[str] = []
    now = _now()
    for raw in tags or []:
        resolved = resolver.resolve(raw or "")
        if resolved is None:
            continue
        if resolved.is_new:
            ensure_tag(connection, resolved, resolver=resolver)
        connection.execute("UPDATE tags SET group_id = ?, updated_at = ? WHERE tag = ?", (group_id, now, resolved.tag))
        moved.append(resolved.tag)
    if commit:
        connection.commit()
    return {"tags": moved, "group_id": group_id}


def pin_tag(connection: sqlite3.Connection, tag: str, pinned: bool, *, commit: bool = True) -> dict[str, Any]:
    resolved = resolve_tag(connection, tag or "")
    if resolved is None:
        raise ValueError("A tag is required")
    if resolved.is_new:
        ensure_tag(connection, resolved)
    connection.execute("UPDATE tags SET pinned = ?, updated_at = ? WHERE tag = ?", (1 if pinned else 0, _now(), resolved.tag))
    if commit:
        connection.commit()
    return {"tag": resolved.tag, "pinned": bool(pinned)}


def _merge_rows(connection: sqlite3.Connection, source: str, target: str) -> int:
    """asset_tags rows of `source` become `target`; a photo that has both
    keeps one row, the user's claim on it winning. Returns photos touched."""
    both = connection.execute(
        """
        SELECT s.asset_id, s.source AS s_source, t.source AS t_source
        FROM asset_tags s JOIN asset_tags t ON t.asset_id = s.asset_id AND t.tag = ?
        WHERE s.tag = ?
        """,
        (target, source),
    ).fetchall()
    for row in both:
        if row["s_source"] == "user" and row["t_source"] != "user":
            connection.execute("UPDATE asset_tags SET source = 'user' WHERE asset_id = ? AND tag = ?", (row["asset_id"], target))
        connection.execute("DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?", (row["asset_id"], source))
    cursor = connection.execute("UPDATE asset_tags SET tag = ? WHERE tag = ?", (target, source))
    return cursor.rowcount + len(both)


def _retire_tag(connection: sqlite3.Connection, source: str, target: str) -> None:
    """`source`'s row goes, its aliases and its own name now point at `target`."""
    connection.execute("UPDATE tag_aliases SET tag = ? WHERE tag = ?", (target, source))
    connection.execute("DELETE FROM tags WHERE tag = ?", (source,))
    connection.execute("INSERT OR REPLACE INTO tag_aliases (alias, tag) VALUES (?, ?)", (normalize_tag(source), target))
    # An alias that spells the target itself is no alias.
    connection.execute("DELETE FROM tag_aliases WHERE alias = ?", (normalize_tag(target),))


def merge_tags(connection: sqlite3.Connection, sources: list[str], target: str, *, commit: bool = True) -> dict[str, Any]:
    """Several tags become one. `target` may be one of the sources, another
    existing tag, or a new name. The merged-away names stay as aliases; the
    target keeps its group (or takes the first source's), its pin, and every
    photo any of them was on. Smart collections that named a source now
    name the target."""
    resolver = TagResolver(connection)
    resolved_target = resolver.resolve(target or "")
    if resolved_target is None:
        raise ValueError("A target tag is required")
    source_tags: list[str] = []
    for raw in sources or []:
        resolved = resolver.resolve(raw or "")
        if resolved is None or resolved.is_new or resolved.tag == resolved_target.tag or resolved.tag in source_tags:
            continue
        source_tags.append(resolved.tag)
    if not source_tags:
        return {"target": resolved_target.tag, "merged": [], "photos": 0}
    now = _now()
    if resolved_target.is_new:
        first = connection.execute("SELECT group_id, pinned FROM tags WHERE tag = ?", (source_tags[0],)).fetchone()
        if resolved_target.concept is None:
            resolved_target.group_id = first["group_id"]
        ensure_tag(connection, resolved_target, resolver=resolver)
        if first["pinned"]:
            connection.execute("UPDATE tags SET pinned = 1 WHERE tag = ?", (resolved_target.tag,))
    photos = 0
    for source in source_tags:
        info = connection.execute("SELECT group_id, pinned FROM tags WHERE tag = ?", (source,)).fetchone()
        photos += _merge_rows(connection, source, resolved_target.tag)
        if info is not None:
            if info["group_id"]:
                connection.execute(
                    "UPDATE tags SET group_id = ?, updated_at = ? WHERE tag = ? AND group_id IS NULL",
                    (info["group_id"], now, resolved_target.tag),
                )
            if info["pinned"]:
                connection.execute("UPDATE tags SET pinned = 1 WHERE tag = ?", (resolved_target.tag,))
        _retire_tag(connection, source, resolved_target.tag)
    connection.execute("UPDATE tags SET updated_at = ? WHERE tag = ?", (now, resolved_target.tag))
    rewrite_smart_rule_values(connection, "tag", dict.fromkeys(source_tags, resolved_target.tag))
    if commit:
        connection.commit()
    return {"target": resolved_target.tag, "merged": source_tags, "photos": photos}


def rename_tag(connection: sqlite3.Connection, tag: str, new_name: str, *, commit: bool = True) -> dict[str, Any]:
    """A new spelling for a tag; the old one stays as an alias. Renaming onto
    a name the library already has is a merge into that tag."""
    resolver = TagResolver(connection)
    current = resolver.resolve(tag or "")
    if current is None or current.is_new:
        raise ValueError(f"Unknown tag: {tag}")
    new_name = str(new_name or "").strip()
    if not new_name:
        raise ValueError("A tag needs a name")
    existing = resolver.resolve(new_name)
    if existing is not None and not existing.is_new and existing.tag != current.tag:
        merged = merge_tags(connection, [current.tag], existing.tag, commit=commit)
        return {"tag": merged["target"], "from": current.tag, "merged": True}
    if new_name == current.tag:
        return {"tag": current.tag, "from": current.tag, "merged": False}
    now = _now()
    # Same tag, new spelling. tag_aliases follows the key (ON UPDATE CASCADE);
    # the old spelling joins the aliases so it keeps resolving here.
    connection.execute("UPDATE tags SET tag = ?, updated_at = ? WHERE tag = ?", (new_name, now, current.tag))
    connection.execute("UPDATE asset_tags SET tag = ? WHERE tag = ?", (new_name, current.tag))
    connection.execute("DELETE FROM tag_aliases WHERE alias = ?", (normalize_tag(new_name),))
    if normalize_tag(new_name) != normalize_tag(current.tag):
        connection.execute("INSERT OR REPLACE INTO tag_aliases (alias, tag) VALUES (?, ?)", (normalize_tag(current.tag), new_name))
    rewrite_smart_rule_values(connection, "tag", {current.tag: new_name})
    if commit:
        connection.commit()
    return {"tag": new_name, "from": current.tag, "merged": False}


def delete_tag(connection: sqlite3.Connection, tag: str, *, commit: bool = True) -> dict[str, Any]:
    """The tag comes off every photo and ceases to exist (aliases with it)."""
    resolved = resolve_tag(connection, tag or "")
    if resolved is None or resolved.is_new:
        raise ValueError(f"Unknown tag: {tag}")
    photos = connection.execute("DELETE FROM asset_tags WHERE tag = ?", (resolved.tag,)).rowcount
    connection.execute("DELETE FROM tags WHERE tag = ?", (resolved.tag,))
    rewrite_smart_rule_values(connection, "tag", {resolved.tag: None})
    if commit:
        connection.commit()
    return {"tag": resolved.tag, "photos": photos}


def regroup_by_vocabulary(connection: sqlite3.Connection, *, only_ungrouped: bool = True, commit: bool = True) -> dict[str, Any]:
    """Give every tag the vocabulary knows its vocabulary group (only the
    ungrouped ones unless told otherwise), and every vocabulary tag its other
    spelling as an alias."""
    groups = {row[0] for row in connection.execute("SELECT group_id FROM tag_groups")}
    now = _now()
    moved = 0
    for tag, group_id in connection.execute("SELECT tag, group_id FROM tags").fetchall():
        concept = concept_for(tag)
        if concept is None:
            continue
        for spelling in concept.spellings():
            if normalize_tag(spelling) != normalize_tag(tag):
                connection.execute("INSERT OR IGNORE INTO tag_aliases (alias, tag) VALUES (?, ?)", (normalize_tag(spelling), tag))
        if concept.group not in groups or concept.group == group_id or (only_ungrouped and group_id is not None):
            continue
        connection.execute("UPDATE tags SET group_id = ?, updated_at = ? WHERE tag = ?", (concept.group, now, tag))
        moved += 1
    if commit:
        connection.commit()
    return {"regrouped": moved}


def merge_vocabulary_pairs(connection: sqlite3.Connection) -> list[tuple[str, str]]:
    """Where a vocabulary concept is in the library under both its spellings,
    the less-used one is merged into the more-used one (the migration's one
    automatic data change; the other spelling lives on as an alias)."""
    merged: list[tuple[str, str]] = []
    counts = dict(connection.execute("SELECT tag, COUNT(*) FROM asset_tags GROUP BY tag").fetchall())
    present = {normalize_tag(tag): tag for tag in (row[0] for row in connection.execute("SELECT tag FROM tags"))}
    for concept in vocabulary():
        spellings = [present[normalize_tag(s)] for s in concept.spellings() if normalize_tag(s) in present]
        if len(set(spellings)) < 2:
            continue
        spellings.sort(key=lambda tag: (-counts.get(tag, 0), tag != concept.en, tag))
        target, source = spellings[0], spellings[1]
        merge_tags(connection, [source], target, commit=False)
        merged.append((source, target))
    return merged


# ── Smart collections that name tags ─────────────────────────────────────────

def _rewrite_filters(filters: Any, key: str, mapping: dict[str, str | None]) -> tuple[Any, bool]:
    if not isinstance(filters, dict):
        return filters, False
    changed = False
    out = dict(filters)
    if key in out:
        values = out[key] if isinstance(out[key], list) else [out[key]]
        kept: list[Any] = []
        for value in values:
            if isinstance(value, str) and value in mapping:
                changed = True
                replacement = mapping[value]
                if replacement is not None and replacement not in kept:
                    kept.append(replacement)
            elif value not in kept:
                kept.append(value)
        if not kept:
            out.pop(key, None)
        elif len(kept) == 1:
            out[key] = kept[0]
        else:
            out[key] = kept
        # A match mode only means something with several tags (the bar drops it too).
        if key == "tag" and len(kept) < 2:
            out.pop("tag_match", None)
    groups = out.get("any_of")
    if isinstance(groups, list):
        rewritten = []
        for group in groups:
            new_group, group_changed = _rewrite_filters(group, key, mapping)
            changed = changed or group_changed
            rewritten.append(new_group)
        out["any_of"] = rewritten
    return out, changed


def _rewrite_rules(rules: Any, key: str, mapping: dict[str, str | None]) -> tuple[Any, bool]:
    if not isinstance(rules, dict):
        return rules, False
    out = dict(rules)
    filters, changed = _rewrite_filters(out.get("filters") or {}, key, mapping)
    if changed:
        out["filters"] = filters
    if isinstance(out.get("base"), dict):
        base, base_changed = _rewrite_rules(out["base"], key, mapping)
        if base_changed:
            out["base"] = base
            changed = True
    return out, changed


def rewrite_smart_rule_values(connection: sqlite3.Connection, key: str, mapping: dict[str, str | None]) -> int:
    """Replace (or, with None, drop) values of one filter key in every smart
    collection's rules: a merged or renamed tag, a deleted group. Returns how
    many collections changed. The rules are written back as they are, not
    re-validated: a collection left without a condition reads as inert
    (smart_rules.parse_rules), not as an error here."""
    if not mapping:
        return 0
    changed_count = 0
    rows = connection.execute("SELECT collection_id, rules_json FROM collections WHERE kind = 'smart'").fetchall()
    for row in rows:
        try:
            rules = json.loads(row["rules_json"] or "[]")
        except ValueError:
            continue
        rewritten, changed = _rewrite_rules(rules, key, mapping)
        if changed:
            connection.execute(
                "UPDATE collections SET rules_json = ?, updated_at = CURRENT_TIMESTAMP WHERE collection_id = ?",
                (json.dumps(rewritten, ensure_ascii=False), row["collection_id"]),
            )
            changed_count += 1
    return changed_count
