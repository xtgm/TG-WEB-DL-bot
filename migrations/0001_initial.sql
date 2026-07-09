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

CREATE INDEX IF NOT EXISTS idx_rate_events_user_ts ON rate_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_inbox_user_created ON inbox_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_user_created ON ip_verifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_created ON ip_verifications(created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status);
