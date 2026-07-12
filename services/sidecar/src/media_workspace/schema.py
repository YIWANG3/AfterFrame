SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS catalog_info (
        catalog_id INTEGER PRIMARY KEY CHECK (catalog_id = 1),
        catalog_path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS catalog_roots (
        root_id TEXT PRIMARY KEY,
        root_type TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS assets (
        asset_id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        stem TEXT NOT NULL,
        normalized_stem TEXT NOT NULL,
        stem_key TEXT NOT NULL,
        extension TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        exists_on_disk INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS asset_files (
        file_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS asset_links (
        link_id TEXT PRIMARY KEY,
        parent_asset_id TEXT NOT NULL,
        child_asset_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        recipe_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1,
        confirmed_by TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(parent_asset_id, child_asset_id, relation_type),
        FOREIGN KEY(parent_asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY(child_asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS raw_metadata_cache (
        raw_asset_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        stem TEXT NOT NULL,
        normalized_stem TEXT NOT NULL,
        stem_key TEXT NOT NULL,
        capture_time TEXT,
        camera_model TEXT,
        lens_model TEXT,
        width INTEGER,
        height INTEGER,
        aspect_ratio REAL,
        file_size INTEGER NOT NULL,
        modified_time TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        metadata_level TEXT NOT NULL DEFAULT 'full',
        fingerprint_level TEXT NOT NULL DEFAULT 'head-tail',
        enrichment_status TEXT NOT NULL DEFAULT 'done',
        cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raw_asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS image_lookup_registry (
        image_path TEXT PRIMARY KEY,
        image_asset_id TEXT NOT NULL,
        raw_asset_id TEXT,
        match_status TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        resolver_version TEXT NOT NULL,
        feature_vector_json TEXT NOT NULL DEFAULT '{}',
        candidate_json TEXT NOT NULL DEFAULT '[]',
        confirmed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(image_asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY(raw_asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        progress REAL NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 50,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        resume_cursor_json TEXT NOT NULL DEFAULT '{}',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS preview_entries (
        cache_key TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resource_sets (
        set_id TEXT PRIMARY KEY,
        primary_asset_id TEXT NOT NULL,
        raw_asset_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(primary_asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY(raw_asset_id) REFERENCES assets(asset_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resource_set_items (
        set_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('primary', 'raw', 'version')),
        version_kind TEXT,
        parent_asset_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (set_id, asset_id),
        FOREIGN KEY(set_id) REFERENCES resource_sets(set_id) ON DELETE CASCADE,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
        FOREIGN KEY(parent_asset_id) REFERENCES assets(asset_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_roots_type ON catalog_roots(root_type)",
    "CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type)",
    "CREATE INDEX IF NOT EXISTS idx_assets_stem_key ON assets(stem_key)",
    "CREATE INDEX IF NOT EXISTS idx_assets_fingerprint ON assets(fingerprint)",
    "CREATE INDEX IF NOT EXISTS idx_asset_links_parent ON asset_links(parent_asset_id)",
    "CREATE INDEX IF NOT EXISTS idx_asset_links_child ON asset_links(child_asset_id)",
    "CREATE INDEX IF NOT EXISTS idx_raw_cache_stem_key ON raw_metadata_cache(stem_key)",
    "CREATE INDEX IF NOT EXISTS idx_raw_cache_capture_time ON raw_metadata_cache(capture_time)",
    "CREATE INDEX IF NOT EXISTS idx_registry_status ON image_lookup_registry(match_status)",
    # browse_collection and origin-binding lookups join on image_asset_id
    "CREATE INDEX IF NOT EXISTS idx_registry_image_asset ON image_lookup_registry(image_asset_id)",
    # The browse query LEFT JOINs preview_entries twice on (asset_id, kind) —
    # without this index SQLite builds a transient index on every browse call.
    "CREATE INDEX IF NOT EXISTS idx_preview_entries_asset ON preview_entries(asset_id, kind)",
    "CREATE INDEX IF NOT EXISTS idx_resource_sets_primary ON resource_sets(primary_asset_id)",
    "CREATE INDEX IF NOT EXISTS idx_resource_set_items_asset ON resource_set_items(asset_id)",
    "CREATE INDEX IF NOT EXISTS idx_resource_set_items_parent ON resource_set_items(parent_asset_id)",
    """
    CREATE TABLE IF NOT EXISTS collections (
        collection_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('manual', 'smart')),
        parent_collection_id TEXT,
        rules_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(parent_collection_id) REFERENCES collections(collection_id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS collection_items (
        collection_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_id, asset_id),
        FOREIGN KEY(collection_id) REFERENCES collections(collection_id) ON DELETE CASCADE,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_collection_items_asset ON collection_items(asset_id)",
    """
    CREATE TABLE IF NOT EXISTS asset_ai_annotations (
        asset_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        caption TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        location_json TEXT,
        detected_text TEXT,
        raw_response TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS asset_tags (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ai',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (asset_id, tag),
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag)",
    "CREATE INDEX IF NOT EXISTS idx_asset_tags_asset ON asset_tags(asset_id)",
    """
    CREATE TABLE IF NOT EXISTS face_models (
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (model_id, model_version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS people_asset_index (
        asset_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        input_hash TEXT,
        status TEXT NOT NULL,
        face_count INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        file_size INTEGER,
        file_mtime REAL,
        indexed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (asset_id, model_id, model_version),
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
        FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS asset_faces (
        face_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        bbox_json TEXT NOT NULL,
        landmarks_json TEXT NOT NULL,
        quality TEXT NOT NULL,
        detection_confidence REAL NOT NULL,
        embedding_blob BLOB NOT NULL,
        thumbnail_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE,
        FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS person_groups (
        group_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        name TEXT,
        state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'confirmed', 'ignored')),
        cover_face_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(model_id, model_version) REFERENCES face_models(model_id, model_version) ON DELETE CASCADE,
        FOREIGN KEY(cover_face_id) REFERENCES asset_faces(face_id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS person_group_faces (
        group_id TEXT NOT NULL,
        face_id TEXT NOT NULL UNIQUE,
        membership_state TEXT NOT NULL DEFAULT 'automatic' CHECK (membership_state IN ('automatic', 'confirmed', 'rejected')),
        source TEXT NOT NULL DEFAULT 'automatic' CHECK (source IN ('automatic', 'user_confirmed', 'user_split', 'user_merged')),
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, face_id),
        FOREIGN KEY(group_id) REFERENCES person_groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY(face_id) REFERENCES asset_faces(face_id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_people_asset_index_model_status ON people_asset_index(model_id, model_version, status)",
    "CREATE INDEX IF NOT EXISTS idx_asset_faces_asset_model ON asset_faces(asset_id, model_id, model_version)",
    "CREATE INDEX IF NOT EXISTS idx_person_groups_model_state ON person_groups(model_id, model_version, state)",
    "CREATE INDEX IF NOT EXISTS idx_person_group_faces_face ON person_group_faces(face_id)",
    # Tombstones for files removed from the catalog while left on disk. A watched
    # directory would otherwise auto-re-import them on the next catch-up scan. We
    # record one only when the file still exists on disk at delete time (a
    # disk-delete trashes the file first, so its stat fails and no row is written
    # — exactly the rows we'd never need). file_size + mtime let an auto-import
    # tell "the same file the user removed" (suppress) from "the editor re-saved
    # to this path" (let it back in, dropping the stale tombstone).
    """
    CREATE TABLE IF NOT EXISTS deleted_files (
        path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
]
