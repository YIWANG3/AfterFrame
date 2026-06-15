from __future__ import annotations

import csv
from pathlib import Path

from .db import get_registry
from .reverse_lookup import resolve_image


def _normalize_path(value: str | None) -> str | None:
    if not value:
        return None
    return str(Path(value).resolve())


def _lookup_matched_raw_path(connection, image_path: Path) -> str | None:
    row = get_registry(connection, image_path)
    if row is None or not row["raw_asset_id"]:
        return None
    asset = connection.execute(
        "SELECT canonical_path FROM assets WHERE asset_id = ?",
        (row["raw_asset_id"],),
    ).fetchone()
    return str(Path(asset["canonical_path"]).resolve()) if asset else None


def evaluate_ground_truth(connection, truth_csv: Path, refresh: bool = False) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    counts = {
        "total": 0,
        "correct_match": 0,
        "correct_unmatched": 0,
        "wrong_match": 0,
        "missed_match": 0,
        "unexpected_match": 0,
    }

    with truth_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for record in reader:
            image_path = Path(record["image_path"]).resolve()
            expected_raw_path = _normalize_path(record.get("raw_path"))
            notes = (record.get("notes") or "").strip()
            counts["total"] += 1

            if refresh:
                resolve_image(connection, image_path)

            matched_raw_path = _lookup_matched_raw_path(connection, image_path)

            if expected_raw_path and matched_raw_path == expected_raw_path:
                outcome = "correct_match"
                counts[outcome] += 1
            elif expected_raw_path and matched_raw_path is None:
                outcome = "missed_match"
                counts[outcome] += 1
            elif expected_raw_path and matched_raw_path != expected_raw_path:
                outcome = "wrong_match"
                counts[outcome] += 1
            elif not expected_raw_path and matched_raw_path is None:
                outcome = "correct_unmatched"
                counts[outcome] += 1
            else:
                outcome = "unexpected_match"
                counts[outcome] += 1

            rows.append(
                {
                    "image_path": str(image_path),
                    "expected_raw_path": expected_raw_path,
                    "matched_raw_path": matched_raw_path,
                    "outcome": outcome,
                    "notes": notes,
                }
            )

    expected_matches = counts["correct_match"] + counts["missed_match"] + counts["wrong_match"]
    predicted_matches = counts["correct_match"] + counts["wrong_match"] + counts["unexpected_match"]
    precision = counts["correct_match"] / predicted_matches if predicted_matches else 0.0
    recall = counts["correct_match"] / expected_matches if expected_matches else 0.0

    return {
        "summary": {
            **counts,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
        },
        "rows": rows,
    }
