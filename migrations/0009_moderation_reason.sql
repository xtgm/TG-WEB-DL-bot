PRAGMA foreign_keys = ON;

-- 仅用于从旧版数据库升级到带「封禁 / 静默隔离原因」的版本。
-- 新代码也会在首次请求时自动补齐这些字段，执行本文件只是让结构更明确。

ALTER TABLE users ADD COLUMN block_reason TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN blocked_at TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN mute_reason TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN muted_at TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked, updated_at DESC);
