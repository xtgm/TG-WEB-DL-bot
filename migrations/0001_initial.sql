PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    language_code TEXT DEFAULT '',
    note TEXT DEFAULT '',
    blocked INTEGER DEFAULT 0,
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
    last_device_fingerprint TEXT NOT NULL DEFAULT '' CHECK(last_device_fingerprint='' OR length(last_device_fingerprint)=32),
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

CREATE TABLE IF NOT EXISTS device_fingerprint_profiles (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
    profile_hash TEXT NOT NULL CHECK(length(profile_hash)=32),
    webrtc_ipv4_hash TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv4_hash='' OR length(webrtc_ipv4_hash)=32),
    webrtc_ipv4_hash2 TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv4_hash2='' OR length(webrtc_ipv4_hash2)=32),
    webrtc_ipv6_hash TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv6_hash='' OR length(webrtc_ipv6_hash)=32),
    webrtc_ipv6_hash2 TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv6_hash2='' OR length(webrtc_ipv6_hash2)=32),
    stable_hash TEXT NOT NULL DEFAULT '' CHECK(stable_hash='' OR length(stable_hash)=32),
    canvas_hash TEXT NOT NULL DEFAULT '' CHECK(canvas_hash='' OR length(canvas_hash)=32),
    renderer_hash TEXT NOT NULL DEFAULT '' CHECK(renderer_hash='' OR length(renderer_hash)=32),
    limits_hash TEXT NOT NULL DEFAULT '' CHECK(limits_hash='' OR length(limits_hash)=32),
    os_hash TEXT NOT NULL DEFAULT '' CHECK(os_hash='' OR length(os_hash)=32),
    screen_hash TEXT NOT NULL DEFAULT '' CHECK(screen_hash='' OR length(screen_hash)=32),
    dpr_depth_hash TEXT NOT NULL DEFAULT '' CHECK(dpr_depth_hash='' OR length(dpr_depth_hash)=32),
    hardware_hash TEXT NOT NULL DEFAULT '' CHECK(hardware_hash='' OR length(hardware_hash)=32),
    touch_hash TEXT NOT NULL DEFAULT '' CHECK(touch_hash='' OR length(touch_hash)=32),
    timezone_hash TEXT NOT NULL DEFAULT '' CHECK(timezone_hash='' OR length(timezone_hash)=32),
    language_hash TEXT NOT NULL DEFAULT '' CHECK(language_hash='' OR length(language_hash)=32),
    feature_mask INTEGER NOT NULL DEFAULT 0,
    seen_count INTEGER NOT NULL DEFAULT 1 CHECK(seen_count BETWEEN 1 AND 2147483647),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(user_id, slot),
    UNIQUE(user_id, profile_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rate_events_user_ts ON rate_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_inbox_user_created ON inbox_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id);
CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint ON users(last_device_fingerprint) WHERE last_device_fingerprint<>'';
CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint_updated ON users(last_device_fingerprint, updated_at DESC) WHERE last_device_fingerprint<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_profile ON device_fingerprint_profiles(profile_hash, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4 ON device_fingerprint_profiles(webrtc_ipv4_hash, last_seen_at DESC) WHERE webrtc_ipv4_hash<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4b ON device_fingerprint_profiles(webrtc_ipv4_hash2, last_seen_at DESC) WHERE webrtc_ipv4_hash2<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6 ON device_fingerprint_profiles(webrtc_ipv6_hash, last_seen_at DESC) WHERE webrtc_ipv6_hash<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6b ON device_fingerprint_profiles(webrtc_ipv6_hash2, last_seen_at DESC) WHERE webrtc_ipv6_hash2<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_stable ON device_fingerprint_profiles(stable_hash, last_seen_at DESC) WHERE stable_hash<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_renderer ON device_fingerprint_profiles(renderer_hash, last_seen_at DESC) WHERE renderer_hash<>'';
CREATE INDEX IF NOT EXISTS idx_fp_profiles_canvas ON device_fingerprint_profiles(canvas_hash, last_seen_at DESC) WHERE canvas_hash<>'';
CREATE INDEX IF NOT EXISTS idx_webrtc_identity_labels_source ON webrtc_identity_labels(source_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_webrtc_identity_confirmations_label ON webrtc_identity_confirmations(label_id);
CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_user_created ON ip_verifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_created ON ip_verifications(created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status);
