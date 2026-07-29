PRAGMA foreign_keys = ON;

-- 仅用于从旧版数据库升级到静默隔离与 Telegram Webhook 幂等版本。
-- 新代码也会在首次请求时自动补齐这些结构。

ALTER TABLE users ADD COLUMN inbound_muted INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS telegram_updates (
    update_id INTEGER PRIMARY KEY,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_inbound_muted
ON users(inbound_muted, updated_at DESC);
