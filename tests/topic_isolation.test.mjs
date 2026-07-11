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

console.log("shared topic isolation tests passed");
