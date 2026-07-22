"""Offline geo resolver: AI annotation location text → coordinates (Phase 2).

Resolves `asset_ai_annotations.location_json` against a Wikidata-derived
gazetteer bundled with the sidecar (data/gazetteer.json.gz). Fully offline at
runtime — the gazetteer is produced at build time by
research/gazetteer-lab/build_gazetteer.py.

Resolution rules (validated against real-catalog failures, see
research/gazetteer-lab/FINDINGS.md):
- normalize: strip parentheticals, split "A / B" and "A, B" compounds, strip
  descriptive suffixes ("X skyline" → "X")
- disambiguate by the annotation's own country (the naked top search hit for
  "Grindelwald" is in Tasmania, "Montmartre" in Saskatchewan)
- among remaining candidates prefer Wikipedia sitelink count; with no country
  context an ambiguous name only resolves when the top candidate clearly
  dominates — otherwise the tier is skipped (never "just pick one")
- tier fallback: landmark → locality → admin1 → country
- annotation confidence below MIN_CONFIDENCE never resolves
"""
from __future__ import annotations

import gzip
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

MIN_CONFIDENCE = 60
RESOLVER_VERSION = "wikidata-gazetteer-1"
GAZETTEER_PATH = Path(__file__).parent / "data" / "gazetteer.json.gz"

# "Big Sur coastline" / "Manhattan skyline" / "Vancouver downtown waterfront":
# descriptive suffixes the model appends to a real place name.
_DESCRIPTIVE_SUFFIXES = (
    "skyline", "coastline", "coast", "waterfront", "seafront", "shoreline",
    "cityscape", "downtown", "harbor", "harbour", "area",
)

# Ambiguity gate when no country context exists: resolve only when the top
# candidate clearly dominates by notability.
_DOMINANCE_RATIO = 2.0
_DOMINANCE_FLOOR = 30

# Approximate bounding-half-sizes (degrees) per precision tier. Only used for
# viewport intersection; markers always render at the centroid.
_TIER_HALF_SIZE = {"exact": 0.0, "locality": 0.15, "admin1": 1.5, "country": 4.0}


@dataclass
class ResolvedLocation:
    latitude: float
    longitude: float
    min_latitude: float
    max_latitude: float
    min_longitude: float
    max_longitude: float
    precision_level: str  # 'exact' (landmark) | 'locality' | 'admin1' | 'country'
    place_id: str  # "wd:Q..."
    matched_label: str
    country_code: Optional[str]
    confidence: Optional[float]


class Gazetteer:
    def __init__(self, payload: dict[str, Any]):
        self.countries_by_qid: dict[str, dict] = {}
        self.country_index: dict[str, dict] = {}
        for country in payload.get("countries", []):
            self.countries_by_qid[country["q"]] = country
            names = [country.get("en"), country.get("zh"), country.get("iso"), *country.get("aliases", [])]
            for name in names:
                if name:
                    self.country_index.setdefault(name.lower(), country)
        self.tiers: dict[str, dict[str, list[dict]]] = {}
        for tier in ("landmarks", "localities", "admin1"):
            index: dict[str, list[dict]] = {}
            for item in payload.get(tier, []):
                for name in (item.get("en"), item.get("zh")):
                    if name:
                        index.setdefault(name.lower(), []).append(item)
            self.tiers[tier] = index

    def resolve_country(self, name: str | None) -> dict | None:
        if not name:
            return None
        return self.country_index.get(str(name).strip().lower())

    def lookup(self, tier: str, name: str) -> list[dict]:
        return self.tiers.get(tier, {}).get(name.lower(), [])


_gazetteer: Gazetteer | None = None
_load_failed = False


def load_gazetteer() -> Gazetteer | None:
    """Lazy singleton; returns None (and keeps quiet) if the data file is
    absent — dev checkouts without a built gazetteer must not break
    annotation."""
    global _gazetteer, _load_failed
    if _gazetteer is not None or _load_failed:
        return _gazetteer
    try:
        with gzip.open(GAZETTEER_PATH, "rb") as f:
            _gazetteer = Gazetteer(json.load(f))
    except OSError:
        _load_failed = True
    return _gazetteer


def set_gazetteer_for_tests(payload: dict[str, Any] | None) -> None:
    global _gazetteer, _load_failed
    _gazetteer = Gazetteer(payload) if payload is not None else None
    _load_failed = False


def _candidate_names(raw: str) -> list[str]:
    """Ordered candidate query strings from one messy AI field."""
    text = re.sub(r"\([^)]*\)", "", str(raw)).strip()
    ordered: list[str] = []
    seen: set[str] = set()

    def add(name: str) -> None:
        name = name.strip().strip(".")
        if name and name.lower() not in seen:
            seen.add(name.lower())
            ordered.append(name)

    for part in re.split(r"\s*/\s*", text):
        part = part.strip()
        if not part:
            continue
        add(part)
        first_segment = part.split(",")[0]
        add(first_segment)
        # strip trailing descriptive words, repeatedly ("downtown waterfront")
        words = first_segment.split()
        while len(words) > 1 and words[-1].lower() in _DESCRIPTIVE_SUFFIXES:
            words = words[:-1]
            add(" ".join(words))
    return ordered


def _pick(matches: list[dict], country_qids: frozenset[str] | None) -> dict | None:
    if country_qids:
        matches = [m for m in matches if m.get("country") is None or m.get("country") in country_qids]
    if not matches:
        return None
    matches = sorted(matches, key=lambda m: -(m.get("links") or 0))
    if len(matches) == 1 or country_qids:
        return matches[0]
    # No country context and multiple same-name candidates: only resolve when
    # the leader clearly dominates — the doc forbids picking arbitrarily.
    top, second = matches[0], matches[1]
    top_links = top.get("links") or 0
    second_links = second.get("links") or 0
    if top_links >= _DOMINANCE_FLOOR and top_links >= _DOMINANCE_RATIO * max(1, second_links):
        return top
    return None


def _resolved(item: dict, precision: str, gazetteer: Gazetteer, confidence: float | None) -> ResolvedLocation:
    half = _TIER_HALF_SIZE[precision]
    latitude, longitude = float(item["lat"]), float(item["lon"])
    country = item.get("country")
    iso = None
    if country and country in gazetteer.countries_by_qid:
        iso = gazetteer.countries_by_qid[country].get("iso")
    elif item.get("iso"):
        iso = item["iso"]
    return ResolvedLocation(
        latitude=latitude,
        longitude=longitude,
        min_latitude=max(-90.0, latitude - half),
        max_latitude=min(90.0, latitude + half),
        min_longitude=max(-180.0, longitude - half),
        max_longitude=min(180.0, longitude + half),
        precision_level=precision,
        place_id=f"wd:{item['q']}",
        matched_label=item.get("en") or item.get("zh") or item["q"],
        country_code=iso,
        confidence=confidence,
    )


def resolve_location(location: dict[str, Any] | None) -> ResolvedLocation | None:
    """Resolve one annotation location dict (v1 or v2 shape) to coordinates."""
    if not isinstance(location, dict):
        return None
    gazetteer = load_gazetteer()
    if gazetteer is None:
        return None

    confidence = location.get("confidence")
    if isinstance(confidence, (int, float)) and confidence < MIN_CONFIDENCE:
        return None
    confidence_value = float(confidence) if isinstance(confidence, (int, float)) else None

    country_entry = gazetteer.resolve_country(location.get("country"))
    # Items inside a territory usually carry the SOVEREIGN's P17 (Hong Kong
    # landmarks say China) — accept the territory and its parent.
    country_qids: frozenset[str] | None = None
    if country_entry:
        country_qids = frozenset(
            q for q in (country_entry["q"], country_entry.get("parent")) if q
        )

    def match(tier: str, raw) -> dict | None:
        if not raw:
            return None
        for candidate in _candidate_names(str(raw)):
            picked = _pick(gazetteer.lookup(tier, candidate), country_qids)
            if picked:
                return picked
        return None

    # The landmark string also falls back into the locality tier: models label
    # neighborhoods/places as "landmark" ("Manhattan", "Big Sur") and those
    # live in the settlement classes, not the landmark classes.
    landmark = location.get("landmark")
    for tier, precision in (("landmarks", "exact"), ("localities", "locality")):
        picked = match(tier, landmark)
        if picked:
            return _resolved(picked, precision, gazetteer, confidence_value)

    picked = match("localities", location.get("locality"))
    if picked:
        return _resolved(picked, "locality", gazetteer, confidence_value)
    picked = match("admin1", location.get("admin1"))
    if picked:
        return _resolved(picked, "admin1", gazetteer, confidence_value)

    # The v1 fuzzy "region" can name either a city or a state/province. Try
    # BOTH tiers and take the more notable match — tier order alone let a tiny
    # locality shadow the obvious admin1 ("California" the Maryland CDP vs
    # California the state).
    region = location.get("region")
    if region:
        locality_match = match("localities", region)
        admin1_match = match("admin1", region)
        best = max(
            [(m, p) for m, p in ((locality_match, "locality"), (admin1_match, "admin1")) if m],
            key=lambda pair: pair[0].get("links") or 0,
            default=None,
        )
        if best:
            return _resolved(best[0], best[1], gazetteer, confidence_value)

    if country_entry:
        return _resolved(country_entry, "country", gazetteer, confidence_value)
    return None
