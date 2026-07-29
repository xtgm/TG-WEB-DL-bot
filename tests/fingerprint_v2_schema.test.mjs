import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const initialSql = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const upgradeSql = readFileSync(new URL("../migrations/0007_fingerprint_v2.sql", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const tableNames = [
    "fingerprint_profiles_v2",
    "fingerprint_labels_v2",
    "fingerprint_reference_profiles_v2",
    "fingerprint_reference_lookup_v2",
    "fingerprint_user_labels_v2",
];

function columns(db, table) {
    return db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name);
}

const fresh = new DatabaseSync(":memory:");
fresh.exec(initialSql);
fresh.exec(upgradeSql);
for (const table of tableNames) {
    assert.equal(fresh.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(table).count, 1);
}

const upgrade = new DatabaseSync(":memory:");
upgrade.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(user_id INTEGER PRIMARY KEY);");
upgrade.exec(upgradeSql);
assert.equal(
    upgrade.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE 'idx_fingerprint_%'").get().count,
    5,
);

const runtimeBlock = workerSource.match(/async function ensureFingerprintV2Schema\(env, schemaObjects\) \{([\s\S]*?)\r?\n\}\r?\n\r?\nasync function ensureVerificationSchema/);
assert.ok(runtimeBlock, "runtime fingerprint schema block not found");
const runtimeTables = [...runtimeBlock[1].matchAll(/\["(fingerprint_[a-z0-9_]+)", \x60([\s\S]*?)\x60\]/g)];
assert.equal(runtimeTables.length, 5, "runtime schema must contain five V2 tables");
const runtime = new DatabaseSync(":memory:");
runtime.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(user_id INTEGER PRIMARY KEY);");
for (const [, , sql] of runtimeTables) runtime.exec(sql);
for (const table of tableNames) assert.deepEqual(columns(runtime, table), columns(upgrade, table), table + " runtime columns differ");

const runtimeSql = runtimeTables.map((item) => item[2]).join("\n");
for (const fragment of [
    "CHECK(slot BETWEEN 1 AND 3)",
    "CHECK(length(exact_hash) IN (43,64))",
    "json_valid(font_minhash)",
    "json_valid(device_vector)",
    "CHECK(quality_score BETWEEN 0 AND 100)",
    "CHECK(length(label_name) BETWEEN 1 AND 80)",
    "CHECK(source_slot BETWEEN 1 AND 3)",
    "http_key TEXT NOT NULL CHECK(length(http_key) IN (43,64))",
    "CHECK(quality_score BETWEEN 63 AND 100)",
    "kind IN (0,1,2) AND band=0",
    "CHECK(weighted_score BETWEEN 0 AND 100)",
]) {
    assert.ok(runtimeSql.includes(fragment), "runtime schema missing constraint: " + fragment);
}

upgrade.prepare("INSERT INTO users(user_id) VALUES(?),(?)").run(1, 2);
const profileInsert = upgrade.prepare(
    "INSERT INTO fingerprint_profiles_v2(user_id,slot,exact_hash,device_simhash,font_bits,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
);
for (let slot = 1; slot <= 3; slot += 1) {
    profileInsert.run(1, slot, String(slot).repeat(64), "0".repeat(16), "0".repeat(16), "2026-01-01", "2026-01-01");
}
assert.equal(upgrade.prepare("SELECT COUNT(*) AS count FROM fingerprint_profiles_v2 WHERE user_id=1").get().count, 3);
assert.throws(() => profileInsert.run(1, 4, "4".repeat(64), "0".repeat(16), "0".repeat(16), "2026-01-01", "2026-01-01"));

const insertLabel = upgrade.prepare(
    "INSERT INTO fingerprint_labels_v2(label_name,state,source_user_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?) RETURNING id",
);
const insertReference = upgrade.prepare(
    "INSERT INTO fingerprint_reference_profiles_v2(label_id,source_user_id,source_slot,exact_hash,device_simhash,font_bits,http_key,quality_score,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
);
const labelId = insertLabel.get("known", "blacklist", 1, 99, "2026-01-01", "2026-01-01").id;
const referenceId = insertReference.get(labelId, 1, 1, "a".repeat(64), "0".repeat(16), "0".repeat(16), "h".repeat(64), 63, 99, "2026-01-01").id;
upgrade.prepare("INSERT INTO fingerprint_reference_lookup_v2(kind,band,lookup_key,reference_id) VALUES(?,?,?,?)").run(1, 0, "shared", referenceId);
upgrade.prepare("INSERT INTO fingerprint_user_labels_v2(user_id,label_id,reference_id,confirmed_by_user_id,match_method,weighted_score,confirmed_at) VALUES(?,?,?,?,?,?,?)")
    .run(2, labelId, referenceId, 99, "webrtc", 60, "2026-01-01");
upgrade.prepare("DELETE FROM users WHERE user_id=?").run(1);
assert.equal(upgrade.prepare("SELECT COUNT(*) AS count FROM fingerprint_labels_v2").get().count, 0);
assert.equal(upgrade.prepare("SELECT COUNT(*) AS count FROM fingerprint_reference_profiles_v2").get().count, 0);
assert.equal(upgrade.prepare("SELECT COUNT(*) AS count FROM fingerprint_reference_lookup_v2").get().count, 0);
assert.equal(upgrade.prepare("SELECT COUNT(*) AS count FROM fingerprint_user_labels_v2").get().count, 0);

for (let index = 0; index < 30; index += 1) {
    const label = insertLabel.get("label-" + index, "watch", 2, 99, "2026-01-02", "2026-01-02").id;
    const reference = insertReference.get(label, 2, 1, index.toString(16).padStart(64, "0"), "0".repeat(16), "0".repeat(16), "h".repeat(64), 63, 99, "2026-01-02").id;
    upgrade.prepare("INSERT INTO fingerprint_reference_lookup_v2(kind,band,lookup_key,reference_id) VALUES(1,0,?,?)").run("shared", reference);
}
const candidateSql = "SELECT reference_id FROM fingerprint_reference_lookup_v2 " +
    "WHERE kind=1 AND band=0 AND lookup_key='shared' ORDER BY reference_id DESC LIMIT 24";
assert.equal(upgrade.prepare(candidateSql).all().length, 24);
const plan = upgrade.prepare("EXPLAIN QUERY PLAN " + candidateSql).all().map((row) => String(row.detail || ""));
assert.equal(plan.some((detail) => detail.includes("fingerprint_reference_lookup_v2") && detail.startsWith("SCAN")), false);

assert.match(workerSource, /MAX_FINGERPRINT_PROFILES_PER_USER = 3/);
assert.match(workerSource, /MAX_FINGERPRINT_LABELS_PER_USER = 5/);
assert.match(workerSource, /MAX_FINGERPRINT_REFERENCES_PER_LABEL = 12/);
assert.match(workerSource, /MAX_FINGERPRINT_CANDIDATES = 24/);
assert.match(workerSource, /fingerprintLookupEntries\(profile\)\.slice\(0, 14\)/);
assert.match(workerSource, /entry\.kind === 1 \? MAX_FINGERPRINT_CANDIDATES : entry\.kind === 3 \? 6 : 4/);
assert.doesNotMatch(workerSource, /WITH wanted\(kind,band,lookup_key,priority\)/);
assert.match(workerSource, /SELECT COUNT\(\*\) FROM fingerprint_labels_v2 WHERE source_user_id=\? AND active=1\) < \?/);
assert.match(workerSource, /SELECT COUNT\(\*\) FROM fingerprint_reference_profiles_v2 WHERE label_id=\?\) < \?/);

console.log("fingerprint V2 schema and bounded D1 tests passed");
