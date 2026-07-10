PRAGMA foreign_keys = ON;

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

CREATE INDEX IF NOT EXISTS idx_webrtc_identity_labels_source
ON webrtc_identity_labels(source_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_webrtc_identity_confirmations_label
ON webrtc_identity_confirmations(label_id);
