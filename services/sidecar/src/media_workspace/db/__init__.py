"""Domain-split data layer. Import surface is unchanged: every symbol
previously on media_workspace.db is re-exported here."""

from .core import connect, init_db, _ensure_column, set_catalog_path, _json
from .settings import get_app_setting, set_app_setting, delete_app_setting
from .resource_sets import split_incorrectly_merged_sets, _link_id, _resource_set_id, get_resource_set, get_resource_set_for_asset, _next_resource_sort_order, add_asset_to_resource_set, create_resource_set, attach_asset_to_resource_set, list_export_assets_missing_resource_set, find_export_asset_ids_by_stem, list_singleton_primary_resource_sets, list_incorrectly_merged_resource_sets, reassign_asset_to_resource_set, split_shared_asset_ids, remove_raw_from_resource_sets, link_assets
from .assets import list_collage_sources, list_collages_using_asset, upsert_raw_asset, upsert_export_asset, upsert_registry, get_registry, load_raw_cache, load_raw_candidates, load_raw_candidates_by_camera_token, load_raw_candidates_by_capture_window, load_raw_candidates_by_camera, load_raw_cache_index, load_raw_enrichment_candidates, list_assets_for_preview, list_assets_for_annotation, count_assets_for_annotation, upsert_preview_entry, upsert_catalog_root, list_catalog_roots, list_repaint_history, confirm_match, list_pending, get_duplicate_assets, set_asset_rating
from .browse import list_version_siblings, _browse_order_clause, _facet_clauses, list_export_assets, get_facet_values, search_facet_values, get_export_asset_detail, get_export_asset_detail_by_path, browse_collection
from .jobs import _job_id, _decode_job_row, create_job, update_job, get_job, get_latest_job, list_jobs, list_active_jobs, request_job_cancel, is_cancel_requested
from .collections import _collection_id, list_collections, create_collection, update_collection, delete_collection, add_collection_items, remove_collection_items
from .maintenance import cleanup_orphan_export_assets, delete_export_asset_from_catalog, summary
from .jobs import _UNSET  # sentinel shared with update_job callers
from .core import _file_id, RESOLVER_VERSION, SCHEMA_VERSION
