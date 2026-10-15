"""Domain-split data layer. The names re-exported here are the ones callers
import from the package; module-private helpers and functions only used
through their own submodule (db.colors, db.core, …) are not re-exported."""

from ..schema import SCHEMA_VERSION
from .assets import (
    confirm_match,
    count_assets_for_annotation,
    count_assets_missing_display_shape,
    dedupe_preview_entries,
    get_duplicate_assets,
    get_registry,
    list_assets_for_annotation,
    list_assets_for_preview,
    list_assets_missing_display_shape,
    list_catalog_roots,
    list_collage_sources,
    list_collages_using_asset,
    list_pending,
    list_repaint_history,
    load_raw_cache,
    load_raw_cache_index,
    load_raw_candidates,
    load_raw_candidates_by_camera,
    load_raw_candidates_by_camera_token,
    load_raw_candidates_by_capture_window,
    load_raw_enrichment_candidates,
    set_asset_description,
    set_asset_flag,
    set_asset_rating,
    set_display_shape,
    upsert_catalog_root,
    upsert_image_asset,
    upsert_preview_entry,
    upsert_raw_asset,
    upsert_registry,
    upsert_video_asset,
)
from .browse import (
    browse_collection,
    camera_makes,
    get_facet_values,
    get_image_asset_detail,
    get_image_asset_detail_by_path,
    list_image_assets,
    list_version_siblings,
    locate_image_asset,
    search_facet_values,
)
from .collections import (
    add_collection_items,
    create_collection,
    delete_collection,
    list_collections,
    remove_collection_items,
    reorder_collections,
    update_collection,
)
from .colors import get_asset_colors
from .core import connect, init_db, set_catalog_path
from .jobs import (
    create_job,
    get_job,
    get_latest_job,
    is_cancel_requested,
    is_pause_requested,
    list_active_jobs,
    list_jobs,
    request_job_cancel,
    request_job_pause,
    request_job_resume,
    update_job,
)
from .locations import (
    delete_asset_location,
    get_asset_location,
    list_map_points,
    set_manual_asset_location,
    upsert_ai_asset_location,
    upsert_asset_location_from_metadata,
)
from .maintenance import cleanup_orphan_image_assets, delete_image_asset_from_catalog, relink_asset, summary, verify_assets
from .people import (
    assign_face_to_group,
    assign_faces_to_group,
    get_asset_people,
    get_people_asset_index,
    get_person_group_detail,
    list_asset_faces,
    list_people_index_candidates,
    list_person_groups,
    list_similar_person_groups,
    merge_person_groups,
    rebuild_candidate_groups,
    remove_face_from_group,
    remove_faces_from_group,
    replace_asset_faces,
    set_person_group_cover,
    set_person_group_name,
    set_person_group_state,
    set_person_groups_state,
    upsert_face_model,
    upsert_people_asset_index,
)
from .resource_sets import (
    attach_asset_to_resource_set,
    find_image_asset_ids_by_stem,
    get_resource_set_for_asset,
    list_image_assets_missing_resource_set,
    list_singleton_primary_resource_sets,
    reassign_asset_to_resource_set,
    remove_raw_from_resource_sets,
    split_incorrectly_merged_sets,
    split_shared_asset_ids,
)
from .settings import get_app_setting
