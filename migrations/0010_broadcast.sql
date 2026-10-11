-- 全体通知（群发）：一条群发任务 + 逐人送达结果。
-- 目标人群来自 users 表，即私聊过 Bot 的全部用户。
CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all', 'verified')),
    target_total INTEGER NOT NULL DEFAULT 0,
    cursor_user_id INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'done', 'cancelled')),
    preview_sent INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'failed')),
    message_id INTEGER,
    error TEXT DEFAULT '',
    sent_at TEXT,
    UNIQUE(broadcast_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status ON broadcast_recipients(broadcast_id, status);
