from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class CatalogPaths:
    root: Path

    @property
    def db_path(self) -> Path:
        return self.root / "catalog.sqlite3"

    @property
    def previews_dir(self) -> Path:
        return self.root / "previews"

    @property
    def previews_hd_dir(self) -> Path:
        return self.root / "previews-hd"

    @property
    def derived_dir(self) -> Path:
        return self.root / "derived"

    @property
    def jobs_dir(self) -> Path:
        return self.root / "jobs"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    @property
    def settings_path(self) -> Path:
        return self.root / "settings.json"


def resolve_catalog(catalog_path: Path) -> CatalogPaths:
    root = catalog_path.resolve()
    if root.suffix == ".mwcatalog":
        root = root.with_suffix(".afcatalog")
    elif root.suffix != ".afcatalog":
        root = root.with_suffix(".afcatalog")
    return CatalogPaths(root=root)


def ensure_catalog(catalog_path: Path) -> CatalogPaths:
    catalog = resolve_catalog(catalog_path)
    catalog.root.mkdir(parents=True, exist_ok=True)
    for directory in (
        catalog.previews_dir,
        catalog.previews_hd_dir,
        catalog.derived_dir,
        catalog.jobs_dir,
        catalog.logs_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    if not catalog.settings_path.exists():
        catalog.settings_path.write_text('{\n  "version": 1\n}\n', encoding="utf-8")
    return catalog

