import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const initialSql = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const upgradeSql = readFileSync(new URL("../migrations/0006_fingerprint_similarity.sql", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

const fresh = new DatabaseSync(":memory:");
fresh.exec(initialSql);
fresh.exec(upgradeSql);
assert.equal(
    fresh.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='device_fingerprint_profiles'").get().count,
    1,
);

const upgrade = new DatabaseSync(":memory:");
upgrade.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(user_id INTEGER PRIMARY KEY);");
upgrade.exec(upgradeSql);
assert.equal(
    upgrade.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE 'idx_fp_profiles_%'").get().count,
    8,
);

const sqlMatch = workerSource.match(/await env\.DB\.prepare\(`(WITH slots\(slot\) AS \(VALUES\$\{slots\}\),[\s\S]*?last_seen_at=excluded\.last_seen_at)`\)\s*\.bind\(/);
assert.ok(sqlMatch, "could not locate production fingerprint profile upsert SQL");
const upsertSql = sqlMatch[1].replace("${slots}", "(1),(2),(3)");
fresh.prepare("INSERT INTO users(user_id, created_at, updated_at) VALUES(?,?,?)").run(42, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

function hash(character) {
    return character.repeat(32);
}

function upsertProfile(profileCharacter, second) {
    const profileHash = hash(profileCharacter);
    const timestamp = `2026-01-01T00:00:0${second}Z`;
    fresh.prepare(upsertSql).run(
        42, profileHash,
        42, profileHash, hash("a"), hash("b"), hash("c"), hash("d"), hash("e"), hash("f"),
        hash("1"), hash("2"), hash("3"), hash("4"), hash("5"), hash("6"), hash("7"), hash("8"), hash("9"), 1023, timestamp, timestamp,
    );
}

upsertProfile("7", 1);
upsertProfile("8", 2);
upsertProfile("9", 3);
assert.equal(fresh.prepare("SELECT COUNT(*) AS count FROM device_fingerprint_profiles WHERE user_id=42").get().count, 3);

upsertProfile("0", 4);
const hashes = fresh.prepare("SELECT profile_hash FROM device_fingerprint_profiles WHERE user_id=42 ORDER BY profile_hash").all().map((row) => row.profile_hash);
assert.equal(hashes.length, 3);
assert.equal(hashes.includes(hash("7")), false);
assert.equal(hashes.includes(hash("0")), true);

upsertProfile("0", 5);
assert.equal(fresh.prepare("SELECT seen_count FROM device_fingerprint_profiles WHERE user_id=42 AND profile_hash=?").get(hash("0")).seen_count, 2);
assert.equal(fresh.prepare("SELECT COUNT(*) AS count FROM device_fingerprint_profiles WHERE user_id=42").get().count, 3);

fresh.prepare("INSERT INTO users(user_id, note, created_at, updated_at) VALUES(?,?,?,?)")
    .run(43, "known label", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
function upsertProfileForUser(userId, profileCharacter, second) {
    const profileHash = hash(profileCharacter);
    const timestamp = `2026-01-01T00:00:0${second}Z`;
    fresh.prepare(upsertSql).run(
        userId, profileHash,
        userId, profileHash, hash("a"), hash("b"), hash("c"), hash("d"), hash("e"), hash("f"),
        hash("1"), hash("2"), hash("3"), hash("4"), hash("5"), hash("6"), hash("7"), hash("8"), hash("9"), 1023, timestamp, timestamp,
    );
}
upsertProfileForUser(43, "e", 6);
const labelId = fresh.prepare(`INSERT INTO webrtc_identity_labels(
    webrtc_hash,label_name,source_user_id,created_by_user_id,ip_version,slot,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?) RETURNING id`).get(hash("a"), "known label", 43, 1, "IPv4", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").id;
const confirmationMatch = workerSource.match(/env\.DB\.prepare\(`(INSERT INTO webrtc_identity_confirmations\(user_id, label_id, confirmed_by_user_id, confirmed_at\)[\s\S]*?confirmed_at=excluded\.confirmed_at)`\)\s*\.bind\(\s*Number\(label\.id\)/);
assert.ok(confirmationMatch, "could not locate production fingerprint confirmation SQL");
const confirmationSql = confirmationMatch[1];
const targetRow = fresh.prepare("SELECT slot,profile_hash,webrtc_ipv4_hash,webrtc_ipv4_hash2,webrtc_ipv6_hash,webrtc_ipv6_hash2 FROM device_fingerprint_profiles WHERE user_id=42 AND profile_hash=?").get(hash("0"));
const candidateRow = fresh.prepare("SELECT slot,profile_hash,webrtc_ipv4_hash,webrtc_ipv4_hash2,webrtc_ipv6_hash,webrtc_ipv6_hash2 FROM device_fingerprint_profiles WHERE user_id=43 AND profile_hash=?").get(hash("e"));
fresh.prepare(confirmationSql).run(
    labelId, 1, "2026-01-01T00:00:07Z", 42,
    42, targetRow.slot, targetRow.profile_hash, targetRow.webrtc_ipv4_hash, targetRow.webrtc_ipv4_hash2, targetRow.webrtc_ipv6_hash, targetRow.webrtc_ipv6_hash2,
    43, candidateRow.slot, candidateRow.profile_hash, candidateRow.webrtc_ipv4_hash, candidateRow.webrtc_ipv4_hash2, candidateRow.webrtc_ipv6_hash, candidateRow.webrtc_ipv6_hash2,
    0, 0, 0, "",
    labelId, 43, 43,
);
assert.equal(fresh.prepare("SELECT label_id FROM webrtc_identity_confirmations WHERE user_id=42").get().label_id, labelId);
const replay = fresh.prepare(confirmationSql).run(
    labelId, 1, "2026-01-01T00:00:08Z", 42,
    42, targetRow.slot, targetRow.profile_hash, targetRow.webrtc_ipv4_hash, targetRow.webrtc_ipv4_hash2, targetRow.webrtc_ipv6_hash, targetRow.webrtc_ipv6_hash2,
    43, candidateRow.slot, candidateRow.profile_hash, candidateRow.webrtc_ipv4_hash, candidateRow.webrtc_ipv4_hash2, candidateRow.webrtc_ipv6_hash, candidateRow.webrtc_ipv6_hash2,
    0, 0, 0, "",
    labelId, 43, 43,
);
assert.equal(replay.changes, 0);

const candidateSqlMatch = workerSource.match(/function fingerprintCandidateSql\(column\) \{\s*return `([\s\S]*?)`;\s*\}/);
assert.ok(candidateSqlMatch, "could not locate production candidate SQL");
const candidateSql = candidateSqlMatch[1]
    .replaceAll("${column}", "profile_hash")
    .replace("${FINGERPRINT_CANDIDATE_LIMIT}", "10");
const queryPlan = fresh.prepare("EXPLAIN QUERY PLAN " + candidateSql).all(999, hash("0"));
assert.equal(queryPlan.some((row) => String(row.detail || "").includes("idx_fp_profiles_profile")), true);
const webrtcSqlMatch = workerSource.match(/function fingerprintWebRtcCandidateSql\(column\) \{\s*return `([\s\S]*?)`;\s*\}/);
assert.ok(webrtcSqlMatch, "could not locate production WebRTC candidate SQL");
for (const [column, indexName] of [
    ["webrtc_ipv4_hash", "idx_fp_profiles_webrtc4"],
    ["webrtc_ipv4_hash2", "idx_fp_profiles_webrtc4b"],
    ["webrtc_ipv6_hash", "idx_fp_profiles_webrtc6"],
    ["webrtc_ipv6_hash2", "idx_fp_profiles_webrtc6b"],
]) {
    const webrtcSql = webrtcSqlMatch[1]
        .replaceAll("${column}", column)
        .replace("${FINGERPRINT_CANDIDATE_LIMIT}", "10");
    const webrtcPlan = fresh.prepare("EXPLAIN QUERY PLAN " + webrtcSql).all(999, hash("a"));
    assert.equal(webrtcPlan.some((row) => String(row.detail || "").includes(indexName)), true);
    assert.equal(webrtcPlan.some((row) => String(row.detail || "").startsWith("SCAN p")), false);
}
const legacyPlan = fresh.prepare(`EXPLAIN QUERY PLAN SELECT user_id,username,full_name,note,updated_at
FROM users
WHERE user_id<>? AND last_device_fingerprint=? AND last_device_fingerprint<>''
ORDER BY updated_at DESC LIMIT 10`).all(999, hash("0"));
assert.equal(legacyPlan.some((row) => String(row.detail || "").includes("idx_users_device_fingerprint_updated")), true);

console.log("fingerprint schema and bounded upsert tests passed");
