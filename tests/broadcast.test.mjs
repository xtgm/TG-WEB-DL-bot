// 群发逻辑测试：验证目标口径、批内限速、游标推进、单条失败不中断、并发保护与完成通知。
import assert from "node:assert/strict";
import worker, { handleRequest, runPendingBroadcastBatch } from "../worker.js";

const BATCH_SIZE = 40;
const INTERVAL_MS = 500;
const ADMIN_ID = 999;

// 把 sleep 的等待时间压到 0，但保留每次调用的时长，用来断言限速参数。
const sleepCalls = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => {
    sleepCalls.push(ms);
    return realSetTimeout(fn, 0);
};

// worker.js 的 ensureVerificationSchema 会逐表检查是否已存在，全部报为已存在即可跳过建表。
const SCHEMA_TABLES = [
    "users",
    "inbox_messages",
    "ip_verifications",
    "verification_sessions",
    "webrtc_identity_labels",
    "webrtc_identity_confirmations",
    "telegram_updates",
    "fingerprint_profiles_v2",
    "fingerprint_labels_v2",
    "fingerprint_reference_profiles_v2",
    "fingerprint_reference_lookup_v2",
    "fingerprint_user_labels_v2",
    "broadcasts",
    "broadcast_recipients",
];

function makeState(users) {
    return {
        users,
        broadcasts: [],
        recipients: [],
        logs: [],
    };
}

// 按 SQL 特征分派的最小 D1 mock，只覆盖群发路径实际执行的语句。
function makeDb(state) {
    return {
        prepare(sqlValue) {
            const sql = String(sqlValue);
            let bindings = [];
            const statement = {
                bind(...values) {
                    bindings = values;
                    return statement;
                },
                async first() {
                    if (sql.includes("FROM broadcasts WHERE status='running'")) {
                        return state.broadcasts.find((b) => b.status === "running") || null;
                    }
                    if (sql.includes("SELECT * FROM broadcasts WHERE id=?")) {
                        return state.broadcasts.find((b) => b.id === Number(bindings[0])) || null;
                    }
                    if (sql.includes("SELECT COUNT(*) FROM users")) {
                        const onlyVerified = sql.includes("verified=1");
                        return {
                            count: state.users.filter((u) => u.blocked === 0 && (!onlyVerified || u.verified === 1)).length,
                        };
                    }
                    if (sql.includes("SELECT value FROM settings WHERE key=?")) return null;
                    throw new Error("unexpected query: " + sql);
                },
                async all() {
                    // 建表检查：把全部表名一次性报给 worker.js，让 ensureVerificationSchema 直接跳过建表。
                    if (sql.includes("sqlite_master")) {
                        return { results: SCHEMA_TABLES.map((name) => ({ name, type: "table" })) };
                    }
                    if (sql.includes("PRAGMA table_info")) return { results: [] };
                    if (sql.includes("SELECT user_id FROM users WHERE user_id > ?")) {
                        const cursor = Number(bindings[0]);
                        const limit = Number(bindings[1]);
                        const onlyVerified = sql.includes("verified=1");
                        return {
                            results: state.users
                                .filter((u) => u.user_id > cursor && u.blocked === 0 && (!onlyVerified || u.verified === 1))
                                .sort((a, b) => a.user_id - b.user_id)
                                .slice(0, limit)
                                .map((u) => ({ user_id: u.user_id })),
                        };
                    }
                    if (sql.includes("FROM broadcast_recipients")) return { results: [] };
                    if (sql.includes("FROM broadcasts b")) return { results: state.broadcasts.slice().reverse() };
                    throw new Error("unexpected query: " + sql);
                },
                async run() {
                    if (sql.includes("INSERT OR REPLACE INTO broadcast_recipients")) {
                        const [broadcastId, userId, status, messageId, error] = bindings;
                        state.recipients.push({ broadcastId, userId, status, messageId, error });
                        return { meta: { changes: 1 } };
                    }
                    if (sql.includes("UPDATE broadcasts SET cursor_user_id=?")) {
                        // 认领式（只推进游标）：绑定是 [新游标, 时间, id, 期望游标]。
                        const [cursor, , id, expectedCursor] = bindings;
                        const b = state.broadcasts.find((x) => x.id === Number(id));
                        if (!b || b.cursor_user_id !== Number(expectedCursor) || b.status !== "running") {
                            return { meta: { changes: 0 } };
                        }
                        b.cursor_user_id = Number(cursor);
                        return { meta: { changes: 1 } };
                    }
                    if (sql.includes("UPDATE broadcasts SET sent_count=sent_count+?")) {
                        // 计数累加：认领之后本批的成败单独累加，不带游标条件。
                        const [sent, failed, , id] = bindings;
                        const b = state.broadcasts.find((x) => x.id === Number(id));
                        if (!b) return { meta: { changes: 0 } };
                        b.sent_count += Number(sent);
                        b.failed_count += Number(failed);
                        return { meta: { changes: 1 } };
                    }
                    if (sql.includes("UPDATE broadcasts SET status='done'")) {
                        const id = Number(bindings[2]);
                        const b = state.broadcasts.find((x) => x.id === id);
                        if (b && b.status === "running") b.status = "done";
                        return { meta: { changes: b ? 1 : 0 } };
                    }
                    if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX") || sql.includes("ALTER TABLE")) {
                        return { meta: { changes: 0 } };
                    }
                    if (sql.includes("INSERT INTO event_logs")) {
                        state.logs.push({ level: bindings[0], message: bindings[1], data: JSON.parse(bindings[2] || "{}") });
                        return { meta: { changes: 1 } };
                    }
                    throw new Error("unexpected write: " + sql);
                },
            };
            return statement;
        },
    };
}

function makeFetch(failIds, sentIds) {
    return async (url, options) => {
        const payload = JSON.parse(options.body);
        const chatId = Number(payload.chat_id);
        if (failIds.has(chatId)) {
            return {
                ok: false,
                status: 403,
                json: async () => ({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" }),
            };
        }
        sentIds.push(chatId);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sentIds.length } }) };
    };
}

const originalFetch = globalThis.fetch;

function buildUsers(count) {
    const users = [];
    for (let i = 1; i <= count; i += 1) {
        users.push({ user_id: 1000 + i, blocked: 0, verified: 0 });
    }
    return users;
}

async function runOnce(state, env) {
    await runPendingBroadcastBatch(env);
}

let passed = 0;
function ok(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed += 1;
            console.log("ok - " + name);
        });
}

await ok("每批只取 40 人，批内按 500ms 间隔限速，最后一个不 sleep", async () => {
    const users = buildUsers(41);
    const state = makeState(users);
    state.broadcasts.push({
        id: 1,
        content: "测试通知",
        audience: "all",
        target_total: 41,
        cursor_user_id: 0,
        sent_count: 0,
        failed_count: 0,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    });
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set(), sentIds);
    sleepCalls.length = 0;

    await runOnce(state, { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    // 第一批只发前 40 人，第 41 人留给下一次 Cron。
    assert.equal(sentIds.length, 40);
    assert.equal(sentIds[0], 1001);
    assert.equal(sentIds[39], 1040);
    assert.equal(state.broadcasts[0].cursor_user_id, 1040);
    assert.equal(state.broadcasts[0].sent_count, 40);
    assert.equal(state.broadcasts[0].status, "running");

    // 40 条里最后一条不 sleep，所以是 39 次，每次 500ms。
    assert.equal(sleepCalls.length, BATCH_SIZE - 1);
    assert.ok(sleepCalls.every((ms) => ms === INTERVAL_MS));
});

await ok("已封禁用户不发，verified 口径只发已验证用户", async () => {
    const users = [
        { user_id: 1, blocked: 1, verified: 1 },
        { user_id: 2, blocked: 0, verified: 1 },
        { user_id: 3, blocked: 0, verified: 0 },
        { user_id: 4, blocked: 0, verified: 1 },
    ];
    const state = makeState(users);
    state.broadcasts.push({
        id: 2,
        content: "仅验证用户",
        audience: "verified",
        target_total: 2,
        cursor_user_id: 0,
        sent_count: 0,
        failed_count: 0,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    });
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set(), sentIds);

    await runOnce(state, { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    // user_id=1 已封禁、user_id=3 未验证，两者都不得发送。末尾那条是发给管理员的完成汇总。
    assert.deepEqual(sentIds.filter((id) => id !== ADMIN_ID), [2, 4]);
    // 不足一批就视为全部发完。
    assert.equal(state.broadcasts[0].status, "done");
});

await ok("单条 403 记为失败并继续发，失败名单落在 recipients", async () => {
    const users = buildUsers(5);
    const state = makeState(users);
    state.broadcasts.push({
        id: 3,
        content: "含失败样本",
        audience: "all",
        target_total: 5,
        cursor_user_id: 0,
        sent_count: 0,
        failed_count: 0,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    });
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set([1002, 1004]), sentIds);

    await runOnce(state, { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    // 两个 403 用户被跳过，其余三个照常发出。末尾那条是发给管理员的完成汇总。
    assert.deepEqual(sentIds.filter((id) => id !== ADMIN_ID), [1001, 1003, 1005]);
    assert.equal(state.broadcasts[0].sent_count, 3);
    assert.equal(state.broadcasts[0].failed_count, 2);
    assert.equal(state.broadcasts[0].status, "done");

    const failed = state.recipients.filter((r) => r.status === "failed").map((r) => r.userId);
    assert.deepEqual(failed, [1002, 1004]);
    const sent = state.recipients.filter((r) => r.status === "sent").map((r) => r.userId);
    assert.deepEqual(sent, [1001, 1003, 1005]);
});

await ok("另一个实例已认领同一批时，本批一条都不发", async () => {
    const users = buildUsers(3);
    const state = makeState(users);
    const broadcast = {
        id: 4,
        content: "并发保护",
        audience: "all",
        target_total: 3,
        cursor_user_id: 0,
        sent_count: 0,
        failed_count: 0,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };
    state.broadcasts.push(broadcast);
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set(), sentIds);

    // 模拟：本实例读出这一批人之后、认领之前，另一个执行体已经把同一批认领走了（游标推到末尾）。
    // 真实事故（2026-10-11 与 10-16 两次群发）：两个执行体读到同一个游标，同一批人各发一遍，
    // 用户收到两条同样的通知，而且后一个实例的计数被一并丢弃、失败数少报。
    const db = makeDb(state);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sqlValue) => {
        const statement = originalPrepare(sqlValue);
        if (String(sqlValue).includes("SELECT user_id FROM users WHERE user_id > ?")) {
            const originalAll = statement.all.bind(statement);
            statement.all = async (...args) => {
                const result = await originalAll(...args);
                broadcast.cursor_user_id = 1003;
                return result;
            };
        }
        return statement;
    };

    await runOnce(state, { DB: db, ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    // 关键：抢不到认领就一条都不发 —— 用户不会收到第二条同样的通知。
    assert.equal(sentIds.length, 0);
    assert.equal(state.recipients.length, 0);
    // 游标保持别人写入的值，计数不叠加。
    assert.equal(broadcast.cursor_user_id, 1003);
    assert.equal(broadcast.sent_count, 0);
    assert.equal(broadcast.failed_count, 0);
    assert.equal(broadcast.status, "running");
    assert.ok(
        state.logs.some((entry) => entry.message === "broadcast cursor already advanced"),
        "抢不到认领时应留下 broadcast cursor already advanced 日志",
    );
});

await ok("没有进行中的任务时 Cron 直接返回，不碰数据库发送逻辑", async () => {
    const state = makeState([]);
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set(), sentIds);

    await runOnce(state, { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    assert.equal(sentIds.length, 0);
    assert.equal(state.recipients.length, 0);
});

await ok("完成后汇总通知管理员，成功失败数与任务一致", async () => {
    const users = [
        { user_id: 7, blocked: 0, verified: 1 },
        { user_id: 8, blocked: 0, verified: 1 },
    ];
    const state = makeState(users);
    state.broadcasts.push({
        id: 5,
        content: "收尾通知",
        audience: "verified",
        target_total: 2,
        cursor_user_id: 0,
        sent_count: 0,
        failed_count: 0,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    });
    const sentIds = [];
    globalThis.fetch = makeFetch(new Set([8]), sentIds);

    await runOnce(state, { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" });

    assert.equal(state.broadcasts[0].status, "done");
    // 最后一条发给管理员的是完成汇总。
    assert.equal(sentIds[sentIds.length - 1], ADMIN_ID);
});

await ok("scheduled handler 已挂载，Cron 才能推进群发", async () => {
    assert.equal(typeof worker.scheduled, "function");
    assert.equal(typeof worker.fetch, "function");
});

await ok("群发页面在登录门禁之后，未登录只跳转登录页", async () => {
    const state = makeState(buildUsers(3));
    const env = { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" };
    const response = await handleRequest(new Request("https://example.com/broadcast"), env, {});
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "https://example.com/login");
});

async function sha256HexForTest(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function panelRequest(path) {
    // worker.js 用 PANEL_USER|PANEL_SECRET 的 sha256 作为会话 token，用默认值构造一条合法 Cookie。
    const token = await sha256HexForTest("admin|dev-secret-change-me");
    return new Request(`https://example.com${path}`, { headers: { cookie: `tg_dualbot_session=${token}` } });
}

await ok("没有进行中任务时，页面渲染表单、范围人数和预览按钮", async () => {
    const users = buildUsers(5);
    users[1].verified = 1;
    users[3].verified = 1;
    const state = makeState(users);
    const env = { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" };

    const response = await handleRequest(await panelRequest("/broadcast"), env, {});
    assert.equal(response.status, 200);
    const body = await response.text();

    // 模板字符串一旦写坏，这些标记会整页消失。
    assert.ok(body.includes("发送群发通知"));
    assert.ok(body.includes("全部用户（5 人）"));
    assert.ok(body.includes("仅已验证用户（2 人）"));
    // 预览按钮必须和正式发送共用同一个表单，否则留空的预览拿不到内容。
    assert.ok(body.includes('formaction="/broadcast/preview"'));
    assert.ok(body.includes('action="/broadcast"'));
    assert.ok(body.includes("还没有群发记录"));
});

await ok("有进行中任务时，页面显示进度并隐藏发送表单，避免重复创建", async () => {
    const state = makeState(buildUsers(5));
    state.broadcasts.push({
        id: 9,
        content: "进行中的内容",
        audience: "all",
        target_total: 5,
        cursor_user_id: 0,
        sent_count: 2,
        failed_count: 1,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    });
    const env = { DB: makeDb(state), ADMIN_CHAT_IDS: String(ADMIN_ID), BOT_TOKEN: "test-token" };

    const response = await handleRequest(await panelRequest("/broadcast"), env, {});
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.ok(body.includes("进行中的群发 #9"));
    // 已处理 = 成功 2 + 失败 1。
    assert.ok(body.includes("3 / 5"));
    assert.ok(body.includes("取消这次群发"));
    assert.ok(body.includes("进行中的内容"));
    // 表单不出现，同一时间只能有一个任务在跑。
    assert.ok(!body.includes('formaction="/broadcast/preview"'));
});

globalThis.fetch = originalFetch;
globalThis.setTimeout = realSetTimeout;

console.log(`\n${passed} 项测试全部通过`);
