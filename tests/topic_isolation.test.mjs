import assert from "node:assert/strict";
import { handleTelegramUpdate } from "../worker.js";

const topicQueries = [];
let writeCalls = 0;
const env = {
    CONTROL_MODE: "both",
    TOPIC_GROUP_ID: "-1001234567890",
    ADMIN_CHAT_IDS: "777",
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
                    if (sql.includes("topic_chat_id=?") && sql.includes("topic_thread_id=?")) {
                        topicQueries.push({ sql, bindings });
                        return null;
                    }
                    throw new Error("unexpected query: " + sql);
                },
                async run() {
                    writeCalls += 1;
                    throw new Error("unexpected database write: " + sql);
                },
            };
        },
    },
};

const originalFetch = globalThis.fetch;
let telegramCalls = 0;
globalThis.fetch = async () => {
    telegramCalls += 1;
    throw new Error("unknown shared topic must not call Telegram API");
};

const baseMessage = {
    message_id: 100,
    message_thread_id: 4242,
    chat: { id: -1001234567890, type: "supergroup" },
    from: { id: 777, is_bot: false },
};

try {
    await handleTelegramUpdate(env, { message: { ...baseMessage, text: "普通管理员消息" } });
    await handleTelegramUpdate(env, { message: { ...baseMessage, message_id: 101, text: "/admin" } });
    await handleTelegramUpdate(env, { message: { ...baseMessage, message_id: 102, text: "/admin@OtherBot" } });
    await handleTelegramUpdate(env, { message: { ...baseMessage, message_id: 103, from: { id: 888, is_bot: false }, text: "/admin" } });
} finally {
    globalThis.fetch = originalFetch;
}

assert.equal(telegramCalls, 0);
assert.equal(writeCalls, 0);
assert.equal(topicQueries.length, 4);
assert.equal(topicQueries.every((query) => Number(query.bindings[1]) === 4242), true);

let mutedUserReads = 0;
let mutedWrites = 0;
const mutedEnv = {
    CONTROL_MODE: "both",
    TOPIC_GROUP_ID: "-1001234567890",
    ADMIN_CHAT_IDS: "777",
    DB: {
        prepare(sqlValue) {
            const sql = String(sqlValue);
            return {
                bind() {
                    return this;
                },
                async first() {
                    if (sql.includes("SELECT value FROM settings WHERE key=?")) return null;
                    if (sql.includes("SELECT * FROM users WHERE user_id=?")) {
                        mutedUserReads += 1;
                        return { user_id: 12345, inbound_muted: 1 };
                    }
                    throw new Error("unexpected muted-user query: " + sql);
                },
                async run() {
                    mutedWrites += 1;
                    throw new Error("muted user must not write to database: " + sql);
                },
            };
        },
    },
};

globalThis.fetch = async () => {
    throw new Error("muted user must not call Telegram API");
};
try {
    await handleTelegramUpdate(mutedEnv, {
        update_id: 8001,
        message: {
            message_id: 201,
            chat: { id: 12345, type: "private" },
            from: { id: 12345, is_bot: false },
            text: "脚本刷屏消息",
        },
    });
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(mutedUserReads, 1);
assert.equal(mutedWrites, 0);

let callbackMuted = 0;
const callbackUpdates = [];
const callbackCalls = [];
const callbackUser = {
    user_id: 12345,
    username: "script_user",
    full_name: "Script User",
    verified: 1,
    blocked: 0,
    topic_thread_id: 4242,
    inbound_muted: 0,
};
const callbackEnv = {
    CONTROL_MODE: "both",
    TOPIC_GROUP_ID: "-1001234567890",
    ADMIN_CHAT_IDS: "777",
    BOT_TOKEN: "test-token",
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
                    if (sql.includes("FROM users u LEFT JOIN")) return { ...callbackUser, inbound_muted: callbackMuted };
                    throw new Error("unexpected callback query: " + sql);
                },
                async run() {
                    // 置为隔离时会写入原因与时间，解除隔离时会清空，两条语句都要接受。
                    if (sql.includes("UPDATE users SET inbound_muted=1")) {
                        callbackMuted = 1;
                        callbackUpdates.push([...bindings]);
                        return { meta: { changes: 1 } };
                    }
                    if (sql.includes("UPDATE users SET inbound_muted=0")) {
                        callbackMuted = 0;
                        callbackUpdates.push([...bindings]);
                        return { meta: { changes: 1 } };
                    }
                    throw new Error("unexpected callback write: " + sql);
                },
            };
        },
    },
};

globalThis.fetch = async (url, init) => {
    callbackCalls.push({
        method: String(url).split("/").pop(),
        payload: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};
try {
    await handleTelegramUpdate(callbackEnv, {
        callback_query: {
            id: "mute-callback",
            data: "topicadmin:mute:12345",
            from: { id: 777 },
            message: {
                chat: { id: -1001234567890, type: "supergroup" },
                message_thread_id: 4242,
            },
        },
    });
    assert.equal(callbackMuted, 1);
    assert.equal(callbackUpdates.length, 1);
    assert.equal(callbackCalls.some((call) => call.method === "answerCallbackQuery" && call.payload.text === "已开启静默隔离"), true);
    const mutedRefresh = callbackCalls.find((call) => call.method === "sendMessage");
    assert.match(mutedRefresh.payload.text, /消息接收：已静默隔离/);
    assert.equal(mutedRefresh.payload.reply_markup.inline_keyboard.flat().some((button) => button.text === "解除隔离"), true);

    callbackCalls.length = 0;
    await handleTelegramUpdate(callbackEnv, {
        callback_query: {
            id: "unmute-callback",
            data: "topicadmin:unmute:12345",
            from: { id: 777 },
            message: {
                chat: { id: -1001234567890, type: "supergroup" },
                message_thread_id: 4242,
            },
        },
    });
    assert.equal(callbackMuted, 0);
    assert.equal(callbackUpdates.length, 2);
    assert.equal(callbackCalls.some((call) => call.method === "answerCallbackQuery" && call.payload.text === "已解除静默隔离"), true);
    const unmutedRefresh = callbackCalls.find((call) => call.method === "sendMessage");
    assert.match(unmutedRefresh.payload.text, /消息接收：正常/);
    assert.equal(unmutedRefresh.payload.reply_markup.inline_keyboard.flat().some((button) => button.text === "静默隔离"), true);
} finally {
    globalThis.fetch = originalFetch;
}

const topic403Calls = [];
const topic403Env = {
    CONTROL_MODE: "both",
    TOPIC_GROUP_ID: "-1001234567890",
    ADMIN_CHAT_IDS: "777",
    BOT_TOKEN: "test-token",
    DB: {
        prepare(sqlValue) {
            const sql = String(sqlValue);
            return {
                bind() {
                    return this;
                },
                async first() {
                    if (sql.includes("SELECT value FROM settings WHERE key=?")) return null;
                    if (sql.includes("topic_chat_id=?") && sql.includes("topic_thread_id=?")) {
                        return { user_id: 12345, blocked: 0, inbound_muted: 0 };
                    }
                    throw new Error("unexpected 403-topic query: " + sql);
                },
                async run() {
                    if (sql.includes("INSERT INTO event_logs")) return { meta: { changes: 1 } };
                    throw new Error("unexpected 403-topic write: " + sql);
                },
            };
        },
    },
};

globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(String(init.body));
    topic403Calls.push({ method, payload });
    if (method === "copyMessage") {
        return new Response(JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
        }), {
            status: 403,
            headers: { "content-type": "application/json" },
        });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 701 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};
try {
    await handleTelegramUpdate(topic403Env, {
        message: {
            message_id: 202,
            message_thread_id: 4242,
            chat: { id: -1001234567890, type: "supergroup" },
            from: { id: 777, is_bot: false },
            text: "管理员回复用户",
        },
    });
} finally {
    globalThis.fetch = originalFetch;
}
const topic403Notice = topic403Calls.find((call) => call.method === "sendMessage");
assert.match(topic403Notice.payload.text, /目标用户已经屏蔽机器人/);
assert.match(topic403Notice.payload.text, /\/start/);
assert.doesNotMatch(topic403Notice.payload.text, /bot was blocked by the user/i);

const claimedUpdates = new Set();
const inboundCalls = [];
const inboundLogs = [];
let inboxInsertCount = 0;
const inboundUser = {
    user_id: 24680,
    username: "inbound_user",
    full_name: "Inbound User",
    verified: 1,
    blocked: 0,
    inbound_muted: 0,
};
const inboxRow = {
    id: 81,
    user_id: 24680,
    username: "inbound_user",
    full_name: "Inbound User",
    user_message_id: 303,
    text: "只应转发一次",
};
const inboundEnv = {
    CONTROL_MODE: "web",
    ADMIN_CHAT_IDS: "777",
    BOT_TOKEN: "test-token",
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
                    if (sql.includes("SELECT * FROM users WHERE user_id=?")) return inboundUser;
                    if (sql.includes("SELECT COUNT(*) FROM rate_events")) return { count: 1 };
                    if (sql.includes("SELECT * FROM inbox_messages WHERE id=?")) return inboxRow;
                    if (sql.includes("FROM users u LEFT JOIN")) return inboundUser;
                    throw new Error("unexpected inbound query: " + sql);
                },
                async all() {
                    if (sql.includes("SELECT keyword FROM spam_keywords")) return { results: [] };
                    throw new Error("unexpected inbound all query: " + sql);
                },
                async run() {
                    if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
                        const updateId = Number(bindings[0]);
                        const isNew = !claimedUpdates.has(updateId);
                        if (isNew) claimedUpdates.add(updateId);
                        return { meta: { changes: isNew ? 1 : 0 } };
                    }
                    if (sql.includes("INSERT INTO inbox_messages")) {
                        inboxInsertCount += 1;
                        return { meta: { changes: 1, last_row_id: 81 } };
                    }
                    if (sql.includes("INSERT INTO event_logs")) {
                        inboundLogs.push({ level: bindings[0], message: bindings[1], data: bindings[2] });
                        return { meta: { changes: 1 } };
                    }
                    if (
                        sql.includes("INSERT INTO users")
                        || sql.includes("DELETE FROM rate_events")
                        || sql.includes("INSERT INTO rate_events")
                        || sql.includes("INSERT OR REPLACE INTO message_map")
                        || sql.includes("UPDATE inbox_messages SET forwarded=1")
                    ) {
                        return { meta: { changes: 1 } };
                    }
                    if (sql.includes("DELETE FROM telegram_updates")) {
                        claimedUpdates.delete(Number(bindings[0]));
                        return { meta: { changes: 1 } };
                    }
                    throw new Error("unexpected inbound write: " + sql);
                },
            };
        },
    },
};

globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(String(init.body));
    inboundCalls.push({ method, payload });
    if (method === "sendMessage" && Number(payload.chat_id) === inboundUser.user_id) {
        return new Response(JSON.stringify({
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
        }), {
            status: 403,
            headers: { "content-type": "application/json" },
        });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 800 + inboundCalls.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};
const repeatedUpdate = {
    update_id: 9001,
    message: {
        message_id: 303,
        chat: { id: 24680, type: "private" },
        from: { id: 24680, username: "inbound_user", first_name: "Inbound", last_name: "User", is_bot: false },
        text: "只应转发一次",
    },
};
try {
    await handleTelegramUpdate(inboundEnv, repeatedUpdate);
    await handleTelegramUpdate(inboundEnv, repeatedUpdate);
} finally {
    globalThis.fetch = originalFetch;
}
assert.equal(inboxInsertCount, 1);
assert.equal(inboundCalls.filter((call) => call.method === "copyMessage").length, 1);
assert.equal(inboundCalls.filter((call) => call.method === "sendMessage" && Number(call.payload.chat_id) === 777).length, 1);
// 转发成功后不再给用户发送自动回执，所以用户侧应当收到 0 条机器人消息。
assert.equal(inboundCalls.filter((call) => call.method === "sendMessage" && Number(call.payload.chat_id) === 24680).length, 0);
assert.equal(inboundLogs.some((entry) => entry.message === "failed to notify user"), false);

console.log("topic and inbound isolation tests passed");
