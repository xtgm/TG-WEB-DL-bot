PRAGMA foreign_keys = ON;

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

CREATE INDEX IF NOT EXISTS idx_fp_profiles_profile
ON device_fingerprint_profiles(profile_hash, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4
ON device_fingerprint_profiles(webrtc_ipv4_hash, last_seen_at DESC)
WHERE webrtc_ipv4_hash<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4b
ON device_fingerprint_profiles(webrtc_ipv4_hash2, last_seen_at DESC)
WHERE webrtc_ipv4_hash2<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6
ON device_fingerprint_profiles(webrtc_ipv6_hash, last_seen_at DESC)
WHERE webrtc_ipv6_hash<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6b
ON device_fingerprint_profiles(webrtc_ipv6_hash2, last_seen_at DESC)
WHERE webrtc_ipv6_hash2<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_stable
ON device_fingerprint_profiles(stable_hash, last_seen_at DESC)
WHERE stable_hash<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_renderer
ON device_fingerprint_profiles(renderer_hash, last_seen_at DESC)
WHERE renderer_hash<>'';

CREATE INDEX IF NOT EXISTS idx_fp_profiles_canvas
ON device_fingerprint_profiles(canvas_hash, last_seen_at DESC)
WHERE canvas_hash<>'';
