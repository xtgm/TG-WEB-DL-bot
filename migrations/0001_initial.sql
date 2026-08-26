PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    language_code TEXT DEFAULT '',
    note TEXT DEFAULT '',
    blocked INTEGER DEFAULT 0,
    block_reason TEXT DEFAULT '',
    blocked_at TEXT DEFAULT '',
    inbound_muted INTEGER DEFAULT 0,
    mute_reason TEXT DEFAULT '',
    muted_at TEXT DEFAULT '',
    verified INTEGER DEFAULT 0,
    verification_status TEXT DEFAULT 'pending',
    verification_token TEXT DEFAULT '',
    last_verified_ip TEXT DEFAULT '',
    last_verified_at TEXT DEFAULT '',
    last_cf_country TEXT DEFAULT '',
    last_http_ip TEXT DEFAULT '',
    last_http_ip_version TEXT DEFAULT '',
    last_http_ipv4 TEXT DEFAULT '',
    last_http_ipv6 TEXT DEFAULT '',
    last_webrtc_ipv4 TEXT DEFAULT '',
    last_webrtc_ipv6 TEXT DEFAULT '',
    last_udp_status TEXT DEFAULT '',
    last_asn TEXT DEFAULT '',
    last_as_organization TEXT DEFAULT '',
    last_device_os TEXT DEFAULT '',
    last_user_agent TEXT DEFAULT '',
    topic_chat_id INTEGER,
    topic_thread_id INTEGER,
    topic_title TEXT DEFAULT '',
    topic_status TEXT DEFAULT '',
    topic_created_at TEXT DEFAULT '',
    topic_updated_at TEXT DEFAULT '',
    topic_last_error TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_map (
    admin_chat_id INTEGER NOT NULL,
    admin_message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_message_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (admin_chat_id, admin_message_id)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    user_message_id INTEGER,
    direction TEXT DEFAULT 'in',
    source TEXT DEFAULT 'user',
    message_type TEXT DEFAULT 'text',
    text TEXT DEFAULT '',
    forwarded INTEGER DEFAULT 0,
    admin_header_message_id INTEGER,
    admin_copy_message_id INTEGER,
    created_at TEXT NOT NULL,
    forwarded_at TEXT,
    error TEXT DEFAULT '',
    topic_chat_id INTEGER,
    topic_thread_id INTEGER,
    topic_message_id INTEGER,
    admin_chat_id INTEGER,
    admin_message_id INTEGER
);

CREATE TABLE IF NOT EXISTS spam_keywords (
    keyword TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_events (
    user_id INTEGER NOT NULL,
    ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ip TEXT NOT NULL,
    country TEXT DEFAULT '',
    colo TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    passed INTEGER DEFAULT 1,
    turnstile_action TEXT DEFAULT '',
    http_ip TEXT DEFAULT '',
    http_ip_version TEXT DEFAULT '',
    http_ipv4 TEXT DEFAULT '',
    http_ipv6 TEXT DEFAULT '',
    webrtc_ipv4 TEXT DEFAULT '',
    webrtc_ipv6 TEXT DEFAULT '',
    webrtc_protocol TEXT DEFAULT '',
    webrtc_candidate_type TEXT DEFAULT '',
    udp_status TEXT DEFAULT '',
    asn TEXT DEFAULT '',
    as_organization TEXT DEFAULT '',
    device_os TEXT DEFAULT '',
    token TEXT DEFAULT '',
    raw_client_data TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    chat_id INTEGER,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    language_code TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    http_ip TEXT DEFAULT '',
    http_ip_version TEXT DEFAULT '',
    http_ipv4 TEXT DEFAULT '',
    http_ipv6 TEXT DEFAULT '',
    webrtc_ipv4 TEXT DEFAULT '',
    webrtc_ipv6 TEXT DEFAULT '',
    webrtc_protocol TEXT DEFAULT '',
    webrtc_candidate_type TEXT DEFAULT '',
    udp_status TEXT DEFAULT '',
    asn TEXT DEFAULT '',
    as_organization TEXT DEFAULT '',
    country TEXT DEFAULT '',
    colo TEXT DEFAULT '',
    device_os TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    raw_client_data TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    verified_at TEXT
);

CREATE TABLE IF NOT EXISTS webrtc_identity_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webrtc_hash TEXT NOT NULL UNIQUE CHECK(length(webrtc_hash)=32),
    label_name TEXT NOT NULL CHECK(length(label_name) BETWEEN 1 AND 80),
    source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_by_user_id INTEGER NOT NULL,
    ip_version TEXT NOT NULL CHECK(ip_version IN ('IPv4','IPv6')),
    slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_user_id, slot)
);

CREATE TABLE IF NOT EXISTS webrtc_identity_confirmations (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES webrtc_identity_labels(id) ON DELETE CASCADE,
    confirmed_by_user_id INTEGER NOT NULL,
    confirmed_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_rate_events_user_ts ON rate_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_inbox_user_created ON inbox_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id);
CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_inbound_muted ON users(inbound_muted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_webrtc_identity_labels_source ON webrtc_identity_labels(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_webrtc_identity_confirmations_label ON webrtc_identity_confirmations(label_id);
CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_user_created ON ip_verifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_created ON ip_verifications(created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status);
CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_state ON fingerprint_labels_v2(active, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_source ON fingerprint_labels_v2(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_profiles_v2_label ON fingerprint_reference_profiles_v2(label_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_lookup_v2_reference ON fingerprint_reference_lookup_v2(reference_id);
CREATE INDEX IF NOT EXISTS idx_fingerprint_user_labels_v2_label ON fingerprint_user_labels_v2(label_id, confirmed_at DESC);
