from __future__ import annotations

import time
from pathlib import Path

from .config import DEFAULT_IMAGE_EXTENSIONS, Thresholds
from .reverse_lookup import resolve_image


class ImageWatcher:
    def __init__(
        self,
        connection,
        image_dirs: tuple[Path, ...],
        thresholds: Thresholds | None = None,
        poll_interval_seconds: float = 2.0,
    ) -> None:
        self.connection = connection
        self.image_dirs = tuple(path.resolve() for path in image_dirs)
        self.thresholds = thresholds or Thresholds()
        self.poll_interval_seconds = poll_interval_seconds
        self._seen: dict[str, int] = {}

    def poll_once(self) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        for image_dir in self.image_dirs:
            if not image_dir.exists():
                continue
            for path in sorted(image_dir.rglob("*")):
                if not path.is_file() or path.suffix.lower() not in DEFAULT_IMAGE_EXTENSIONS:
                    continue
                stat = path.stat()
                key = str(path.resolve())
                marker = stat.st_mtime_ns
                if self._seen.get(key) == marker:
                    continue
                self._seen[key] = marker
                decision = resolve_image(self.connection, path, thresholds=self.thresholds)
                events.append(
                    {
                        "path": key,
                        "status": decision.status,
                        "score": decision.score,
                        "raw_asset_id": decision.raw_asset_id,
                    }
                )
        return events

    def run(self) -> None:
        while True:
            self.poll_once()
            time.sleep(self.poll_interval_seconds)

