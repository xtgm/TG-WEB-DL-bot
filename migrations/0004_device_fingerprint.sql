PRAGMA foreign_keys = ON;

-- 旧数据库升级到精确设备指纹版本；新部署直接执行 0001_initial.sql。
ALTER TABLE users
ADD COLUMN last_device_fingerprint TEXT NOT NULL DEFAULT ''
CHECK(last_device_fingerprint='' OR length(last_device_fingerprint)=32);

CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint
ON users(last_device_fingerprint)
WHERE last_device_fingerprint<>'';
