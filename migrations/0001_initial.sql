PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT '',
    full_name TEXT DEFAULT '',
    note TEXT DEFAULT '',
    blocked INTEGER DEFAULT 0,
    last_verified_ip TEXT DEFAULT '',
    last_verified_at TEXT DEFAULT '',
    last_cf_country TEXT DEFAULT '',
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
    error TEXT DEFAULT ''
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

CREATE INDEX IF NOT EXISTS idx_rate_events_user_ts ON rate_events(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_inbox_user_created ON inbox_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox_messages(created_at);

CREATE TABLE IF NOT EXISTS ip_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ip TEXT NOT NULL,
    country TEXT DEFAULT '',
    colo TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    passed INTEGER DEFAULT 1,
    turnstile_action TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_verifications_user_created ON ip_verifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ip_verifications_created ON ip_verifications(created_at);
