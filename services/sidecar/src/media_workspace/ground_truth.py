from __future__ import annotations

import csv
from pathlib import Path


def export_ground_truth(
    connection,
    output_csv: Path,
    statuses: list[str],
) -> dict[str, object]:
    logical_statuses = tuple(dict.fromkeys(statuses))
    sql_statuses: list[str] = []
    for status in logical_statuses:
        if status == "matched":
            sql_statuses.extend(["auto_bound", "manual_confirmed"])
        elif status == "unmatched":
            sql_statuses.append("unmatched")
        elif status == "pending":
            sql_statuses.append("pending_confirmation")
        else:
            raise ValueError(f"unsupported ground truth status: {status}")

    rows = connection.execute(
        f"""
        SELECT
            registry.image_path,
            raw_assets.canonical_path AS raw_path,
            registry.match_status,
            registry.score
        FROM image_lookup_registry AS registry
        LEFT JOIN assets AS raw_assets
            ON raw_assets.asset_id = registry.raw_asset_id
        WHERE registry.match_status IN ({",".join("?" for _ in sql_statuses)})
        ORDER BY registry.image_path
        """,
        sql_statuses,
    ).fetchall()

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["image_path", "raw_path", "notes"])
        writer.writeheader()
        for row in rows:
            note_status = _logical_status_label(str(row["match_status"]))
            writer.writerow(
                {
                    "image_path": row["image_path"],
                    "raw_path": row["raw_path"] or "",
                    "notes": f"{note_status};score={float(row['score']):.2f}",
                }
            )

    return {
        "output_csv": str(output_csv.resolve()),
        "rows": len(rows),
        "statuses": list(logical_statuses),
    }


def _logical_status_label(match_status: str) -> str:
    if match_status in {"auto_bound", "manual_confirmed"}:
        return "reviewed-match-v0"
    if match_status == "unmatched":
        return "reviewed-unmatched-v0"
    if match_status == "pending_confirmation":
        return "review-pending"
    return match_status
