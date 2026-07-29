PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fingerprint_profiles_v2 (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
    algorithm_version INTEGER NOT NULL DEFAULT 2 CHECK(algorithm_version BETWEEN 1 AND 255),
    exact_hash TEXT NOT NULL CHECK(length(exact_hash) IN (43,64)),
    device_simhash TEXT NOT NULL CHECK(length(device_simhash)=16 AND device_simhash NOT GLOB '*[^0-9a-f]*'),
    device_feature_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_feature_mask BETWEEN 0 AND 2147483647),
    font_bits TEXT NOT NULL CHECK(length(font_bits)=16 AND font_bits NOT GLOB '*[^0-9a-f]*'),
    font_minhash TEXT NOT NULL DEFAULT '[]' CHECK(length(font_minhash)<=2048 AND json_valid(font_minhash) AND json_type(font_minhash)='array'),
    device_vector TEXT NOT NULL DEFAULT '[]' CHECK(length(device_vector)<=2048 AND json_valid(device_vector) AND json_type(device_vector)='array'),
    device_vector_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_vector_mask BETWEEN 0 AND 2147483647),
    canvas_key TEXT NOT NULL DEFAULT '' CHECK(length(canvas_key) IN (0,43,64)),
    webgl_key TEXT NOT NULL DEFAULT '' CHECK(length(webgl_key) IN (0,43,64)),
    audio_key TEXT NOT NULL DEFAULT '' CHECK(length(audio_key) IN (0,43,64)),
    webrtc_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_keys)<=1024 AND json_valid(webrtc_keys) AND json_type(webrtc_keys)='array'),
    webrtc_asn_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_asn_keys)<=1024 AND json_valid(webrtc_asn_keys) AND json_type(webrtc_asn_keys)='array'),
    webrtc_isp_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_isp_keys)<=1024 AND json_valid(webrtc_isp_keys) AND json_type(webrtc_isp_keys)='array'),
    http_key TEXT NOT NULL DEFAULT '' CHECK(length(http_key) IN (0,43,64)),
    http_asn_key TEXT NOT NULL DEFAULT '' CHECK(length(http_asn_key) IN (0,43,64)),
    http_isp_key TEXT NOT NULL DEFAULT '' CHECK(length(http_isp_key) IN (0,43,64)),
    quality_score INTEGER NOT NULL DEFAULT 0 CHECK(quality_score BETWEEN 0 AND 100),
    summary_json TEXT NOT NULL DEFAULT '{}' CHECK(length(summary_json)<=4096 AND json_valid(summary_json) AND json_type(summary_json)='object'),
    seen_count INTEGER NOT NULL DEFAULT 1 CHECK(seen_count BETWEEN 1 AND 2147483647),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(user_id, slot),
    UNIQUE(user_id, exact_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fingerprint_labels_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_name TEXT NOT NULL CHECK(length(label_name) BETWEEN 1 AND 80),
    note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=1000),
    state TEXT NOT NULL DEFAULT 'watch' CHECK(state IN ('watch','blacklist')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fingerprint_reference_profiles_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id INTEGER NOT NULL REFERENCES fingerprint_labels_v2(id) ON DELETE CASCADE,
    source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source_slot INTEGER NOT NULL CHECK(source_slot BETWEEN 1 AND 3),
    algorithm_version INTEGER NOT NULL DEFAULT 2 CHECK(algorithm_version BETWEEN 1 AND 255),
    exact_hash TEXT NOT NULL CHECK(length(exact_hash) IN (43,64)),
    device_simhash TEXT NOT NULL CHECK(length(device_simhash)=16 AND device_simhash NOT GLOB '*[^0-9a-f]*'),
    device_feature_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_feature_mask BETWEEN 0 AND 2147483647),
    font_bits TEXT NOT NULL CHECK(length(font_bits)=16 AND font_bits NOT GLOB '*[^0-9a-f]*'),
    font_minhash TEXT NOT NULL DEFAULT '[]' CHECK(length(font_minhash)<=2048 AND json_valid(font_minhash) AND json_type(font_minhash)='array'),
    device_vector TEXT NOT NULL DEFAULT '[]' CHECK(length(device_vector)<=2048 AND json_valid(device_vector) AND json_type(device_vector)='array'),
    device_vector_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_vector_mask BETWEEN 0 AND 2147483647),
    canvas_key TEXT NOT NULL DEFAULT '' CHECK(length(canvas_key) IN (0,43,64)),
    webgl_key TEXT NOT NULL DEFAULT '' CHECK(length(webgl_key) IN (0,43,64)),
    audio_key TEXT NOT NULL DEFAULT '' CHECK(length(audio_key) IN (0,43,64)),
    webrtc_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_keys)<=2048 AND json_valid(webrtc_keys) AND json_type(webrtc_keys)='array'),
    webrtc_asn_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_asn_keys)<=2048 AND json_valid(webrtc_asn_keys) AND json_type(webrtc_asn_keys)='array'),
    webrtc_isp_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_isp_keys)<=2048 AND json_valid(webrtc_isp_keys) AND json_type(webrtc_isp_keys)='array'),
    http_key TEXT NOT NULL CHECK(length(http_key) IN (43,64)),
    http_asn_key TEXT NOT NULL DEFAULT '' CHECK(length(http_asn_key) IN (0,43,64)),
    http_isp_key TEXT NOT NULL DEFAULT '' CHECK(length(http_isp_key) IN (0,43,64)),
    quality_score INTEGER NOT NULL DEFAULT 63 CHECK(quality_score BETWEEN 63 AND 100),
    summary_json TEXT NOT NULL DEFAULT '{}' CHECK(length(summary_json)<=4096 AND json_valid(summary_json) AND json_type(summary_json)='object'),
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_matched_at TEXT,
    match_count INTEGER NOT NULL DEFAULT 0 CHECK(match_count BETWEEN 0 AND 2147483647),
    UNIQUE(label_id, exact_hash)
);

-- kind: 0=exact, 1=WebRTC, 2=HTTP, 3=SimHash band, 4=MinHash band.
CREATE TABLE IF NOT EXISTS fingerprint_reference_lookup_v2 (
    kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 4),
    band INTEGER NOT NULL CHECK(
        (kind IN (0,1,2) AND band=0)
        OR (kind IN (3,4) AND band BETWEEN 0 AND 3)
    ),
    lookup_key TEXT NOT NULL CHECK(length(lookup_key) BETWEEN 1 AND 256),
    reference_id INTEGER NOT NULL REFERENCES fingerprint_reference_profiles_v2(id) ON DELETE CASCADE,
    PRIMARY KEY(kind, band, lookup_key, reference_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fingerprint_user_labels_v2 (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES fingerprint_labels_v2(id) ON DELETE CASCADE,
    reference_id INTEGER REFERENCES fingerprint_reference_profiles_v2(id) ON DELETE SET NULL,
    confirmed_by_user_id INTEGER NOT NULL,
    match_method TEXT NOT NULL CHECK(length(match_method) BETWEEN 1 AND 32),
    weighted_score INTEGER NOT NULL CHECK(weighted_score BETWEEN 0 AND 100),
    evidence_mask INTEGER NOT NULL DEFAULT 0 CHECK(evidence_mask BETWEEN 0 AND 2147483647),
    confirmed_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_state ON fingerprint_labels_v2(active, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_source ON fingerprint_labels_v2(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_profiles_v2_label ON fingerprint_reference_profiles_v2(label_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_lookup_v2_reference ON fingerprint_reference_lookup_v2(reference_id);
CREATE INDEX IF NOT EXISTS idx_fingerprint_user_labels_v2_label ON fingerprint_user_labels_v2(label_id, confirmed_at DESC);
