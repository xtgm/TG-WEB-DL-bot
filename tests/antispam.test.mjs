import assert from "node:assert/strict";
import { handleTelegramUpdate } from "../worker.js";

// 背景：2026-07-28 有个匿名马甲号用同一句话刷了 635 次，前后 16 小时。
// 短窗口限流（10 秒 4 条）对他的节奏（90 秒一条）完全无效，
// 垃圾词表也命中不了纯辱骂内容。这里覆盖补上的两道闸。
const originalFetch = globalThis.fetch;
const SPAM_TEXT = "你们做的就是垃圾知道吗";

// history 模拟 inbox_messages 里该用户已存的文本，让重复计数走真实累加。
function makeEnv({ history = [], rateShort = 1, rateLong = 1 } = {}) {
    const claimed = new Set();
    const state = { history, logs: [], telegram: [], blockWrites: 0, inboxWrites: 0 };
    const user = {
        user_id: 24680,
        username: "mock_spammer_1",
        full_name: "Mock Spammer One",
        verified: 1,
        blocked: 0,
        inbound_muted: 0,
    };
    return {
        state,
        env: {
            CONTROL_MODE: "web",
            ADMIN_CHAT_IDS: "777",
            BOT_TOKEN: "test-token",
            // 用户的 username/full_name 全部用假值：真实刷屏号的身份串只在线上库，
            // 测试里放进公开仓库属于隐私泄露，且测试也不依赖具体值。
            DB: {
                prepare(sqlValue) {
                    const sql = String(sqlValue);
                    let bindings = [];
                    return {
                        bind(...values) {
                            bindings = values;
                            return this;
                        },
                        async first() {
                            if (sql.includes("SELECT value FROM settings WHERE key=?")) return null;
                            if (sql.includes("SELECT * FROM users WHERE user_id=?")) return user;
                            if (sql.includes("FROM users u LEFT JOIN")) return user;
                            // 长窗口计数带 AS long_hits 别名，短窗口没有，靠这个区分两条查询。
                            if (sql.includes("AS long_hits")) return { long_hits: rateLong };
                            if (sql.includes("FROM rate_events WHERE user_id=?")) return { count: rateShort };
                            if (sql.includes("AS repeat_hits")) {
                                const text = String(bindings[1] || "");
                                return { repeat_hits: state.history.filter((item) => item === text).length };
                            }
                            if (sql.includes("SELECT * FROM inbox_messages WHERE id=?")) {
                                return { id: 81, user_id: 24680, user_message_id: 303, text: SPAM_TEXT };
                            }
                            throw new Error("unexpected first: " + sql);
                        },
                        async all() {
                            if (sql.includes("SELECT keyword FROM spam_keywords")) return { results: [] };
                            throw new Error("unexpected all: " + sql);
                        },
                        async run() {
                            if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
                                const id = Number(bindings[0]);
                                const isNew = !claimed.has(id);
                                if (isNew) claimed.add(id);
                                return { meta: { changes: isNew ? 1 : 0 } };
                            }
                            if (sql.includes("INSERT INTO inbox_messages")) {
                                state.history.push(String(bindings[7] || ""));
                                state.inboxWrites += 1;
                                return { meta: { changes: 1, last_row_id: 81 } };
                            }
                            if (sql.includes("INSERT INTO event_logs")) {
                                state.logs.push({ level: bindings[0], message: bindings[1] });
                                return { meta: { changes: 1 } };
                            }
                            if (sql.includes("UPDATE users SET blocked=1")) {
                                state.blockWrites += 1;
                                return { meta: { changes: 1 } };
                            }
                            if (
                                sql.includes("INSERT INTO users")
                                || sql.includes("DELETE FROM rate_events")
                                || sql.includes("INSERT INTO rate_events")
                                || sql.includes("INSERT OR REPLACE INTO message_map")
                                || sql.includes("UPDATE inbox_messages")
                                || sql.includes("DELETE FROM telegram_updates")
                            ) {
                                return { meta: { changes: 1 } };
                            }
                            throw new Error("unexpected run: " + sql);
                        },
                    };
                },
            },
        },
    };
}

function installFetch(calls) {
    globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop();
        calls.push({ method, payload: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 800 + calls.length } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}

function spamUpdate(index, text = SPAM_TEXT) {
    return {
        update_id: 9000 + index,
        message: {
            message_id: 300 + index,
            chat: { id: 24680, type: "private" },
            from: { id: 24680, username: "mock_spammer_1", first_name: "l", last_name: "w", is_bot: false },
            text,
        },
    };
}

// 场景一：同一段文本连发 6 次。前 5 次正常转发，第 6 次必须被拦下并自动拉黑。
{
    const { env, state } = makeEnv();
    const calls = [];
    installFetch(calls);
    try {
        for (let index = 1; index <= 6; index += 1) await handleTelegramUpdate(env, spamUpdate(index));
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(state.inboxWrites, 5, "第 6 次重复内容不应再写入 inbox");
    assert.equal(state.blockWrites, 1, "命中重复刷屏后应当自动拉黑");
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 5, "第 6 次不应再转发给管理员");
    assert.ok(
        state.logs.some((entry) => entry.message === "repetitive spam blocked"),
        "重复刷屏应当留下日志",
    );
}

// 场景二：短窗口没超（10 秒 1 条），但一小时内已经 31 条 —— 慢速刷屏必须被拦住。
{
    const { env, state } = makeEnv({ rateShort: 1, rateLong: 31 });
    const calls = [];
    installFetch(calls);
    try {
        await handleTelegramUpdate(env, spamUpdate(20, "换句话继续刷"));
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(state.inboxWrites, 0, "长窗口超限时不应写入 inbox");
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 0, "长窗口超限时不应转发");
    assert.ok(
        calls.some((call) => call.method === "sendMessage" && Number(call.payload.chat_id) === 24680),
        "长窗口超限时应当告知用户",
    );
}

// 场景三：边界。一小时内 30 条不拦（阈值是「超过 30」才拦），换一段没发过的新内容。
{
    const { env, state } = makeEnv({ rateShort: 1, rateLong: 30 });
    const calls = [];
    installFetch(calls);
    try {
        await handleTelegramUpdate(env, spamUpdate(21, "边界内的一条"));
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.equal(state.inboxWrites, 1, "未超阈值时应当正常处理");
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
}

console.log("antispam gate tests passed");
