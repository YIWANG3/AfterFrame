from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Thresholds:
    auto_bind: float = 0.90
    manual_review: float = 0.7
