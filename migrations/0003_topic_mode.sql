PRAGMA foreign_keys = ON;

-- 仅用于从旧版数据库升级到 Telegram 话题双通道版本。
-- 新部署请直接执行 0001_initial.sql。

ALTER TABLE users ADD COLUMN topic_chat_id INTEGER;
ALTER TABLE users ADD COLUMN topic_thread_id INTEGER;
ALTER TABLE users ADD COLUMN topic_title TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN topic_status TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN topic_created_at TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN topic_updated_at TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN topic_last_error TEXT DEFAULT '';

ALTER TABLE inbox_messages ADD COLUMN topic_chat_id INTEGER;
ALTER TABLE inbox_messages ADD COLUMN topic_thread_id INTEGER;
ALTER TABLE inbox_messages ADD COLUMN topic_message_id INTEGER;
ALTER TABLE inbox_messages ADD COLUMN admin_chat_id INTEGER;
ALTER TABLE inbox_messages ADD COLUMN admin_message_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id);
CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at);
