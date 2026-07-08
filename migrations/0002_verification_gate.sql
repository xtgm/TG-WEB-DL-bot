PRAGMA foreign_keys = ON;

-- 仅用于从旧版数据库升级到带验证门禁的版本。
-- 新部署请直接执行 0001_initial.sql；如果旧库已经被运行时代码自动补过字段，本文件可能因重复字段而停止。

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

ALTER TABLE users ADD COLUMN language_code TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN verification_status TEXT DEFAULT 'pending';
ALTER TABLE users ADD COLUMN verification_token TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_http_ip TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_http_ip_version TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_http_ipv4 TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_http_ipv6 TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_webrtc_ipv4 TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_webrtc_ipv6 TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_udp_status TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_asn TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_as_organization TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_device_os TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN last_user_agent TEXT DEFAULT '';

ALTER TABLE ip_verifications ADD COLUMN http_ip TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN http_ip_version TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN http_ipv4 TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN http_ipv6 TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN webrtc_ipv4 TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN webrtc_ipv6 TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN webrtc_protocol TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN webrtc_candidate_type TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN udp_status TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN asn TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN as_organization TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN device_os TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN token TEXT DEFAULT '';
ALTER TABLE ip_verifications ADD COLUMN raw_client_data TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status);
