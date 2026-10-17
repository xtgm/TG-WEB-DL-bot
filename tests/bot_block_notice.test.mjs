// 用户屏蔽机器人 → 自动通知管理员并给一键拉黑按钮。
// 关键：Telegram 的 my_chat_member 在「屏蔽」和「解除屏蔽」时都会推，
// 判据必须取「私聊 + 新状态不是 member」，否则解除屏蔽会被误报成屏蔽。
import assert from "node:assert/strict";
import { handleTelegramUpdate } from "../worker.js";

const TOPIC_GROUP = -1001234567890;
const ADMIN_ID = 777;
const USER_ID = 24680;

function makeEnv(state) {
    return {
        CONTROL_MODE: "both",
        TOPIC_GROUP_ID: String(TOPIC_GROUP),
        ADMIN_CHAT_IDS: String(ADMIN_ID),
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
                        if (sql.includes("SELECT * FROM users WHERE user_id=?")) return state.user;
                        throw new Error("unexpected query: " + sql);
                    },
                    async all() {
                        throw new Error("unexpected all: " + sql);
                    },
                    async run() {
                        if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) return { meta: { changes: 1 } };
                        if (sql.includes("INSERT INTO event_logs")) {
                            state.logs.push({ level: bindings[0], message: bindings[1], data: bindings[2] });
                            return { meta: { changes: 1 } };
                        }
                        throw new Error("unexpected write: " + sql);
                    },
                };
            },
        },
    };
}

function baseState(user) {
    return { user, logs: [], calls: [] };
}

function makeFetch(state) {
    return async (url, init) => {
        state.calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + state.calls.length } }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}

// 私聊里新状态不是 member 就是被屏蔽；old/new 两个状态都给全，方便核对留痕。
function blockUpdate(updateId, newStatus, oldStatus = "member") {
    return {
        update_id: updateId,
        my_chat_member: {
            chat: { id: USER_ID, type: "private" },
            from: { id: USER_ID, is_bot: false },
            old_chat_member: { status: oldStatus, user: { id: USER_ID } },
            new_chat_member: { status: newStatus, user: { id: USER_ID } },
        },
    };
}

const originalFetch = globalThis.fetch;

// 1. 用户屏蔽机器人：往该用户已有的话题发通知，并挂上现成的拉黑按钮。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 0,
        topic_chat_id: TOPIC_GROUP,
        topic_thread_id: 4242,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7001, "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const notice = state.calls.find((call) => call.method === "sendMessage");
    assert.ok(notice, "用户屏蔽后应发出通知");
    assert.equal(Number(notice.payload.chat_id), TOPIC_GROUP);
    assert.equal(Number(notice.payload.message_thread_id), 4242);
    assert.match(notice.payload.text, /屏蔽/);
    const button = notice.payload.reply_markup.inline_keyboard.flat()[0];
    assert.equal(button.callback_data, `topicadmin:ban:${USER_ID}`);
    assert.ok(
        state.logs.some((entry) => entry.message === "user blocked the bot"),
        "屏蔽事件应写入 user blocked the bot 日志",
    );
}

// 2. 解除屏蔽：也发通知，但内容必须与屏蔽区分开，且不能误判成屏蔽。
//    这个用户不在黑名单里，所以不该挂「取消拉黑」按钮。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 0,
        topic_chat_id: TOPIC_GROUP,
        topic_thread_id: 4242,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7002, "member", "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const notices = state.calls.filter((call) => call.method === "sendMessage");
    assert.equal(notices.length, 1, "解除屏蔽应发出通知");
    assert.equal(Number(notices[0].payload.chat_id), TOPIC_GROUP);
    assert.equal(Number(notices[0].payload.message_thread_id), 4242);
    assert.match(notices[0].payload.text, /解除/);
    assert.equal(notices[0].payload.reply_markup, undefined, "不在黑名单时不该挂按钮");
    assert.ok(
        state.logs.some((entry) => entry.message === "user unblocked the bot"),
        "解除屏蔽应写入 user unblocked the bot 日志",
    );
    assert.equal(state.logs.some((entry) => entry.message === "user blocked the bot"), false);
}

// 3. 群组里的成员变更不是「用户屏蔽机器人」，整条忽略。
{
    const state = baseState({ user_id: USER_ID, blocked: 0 });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), {
            update_id: 7003,
            my_chat_member: {
                chat: { id: TOPIC_GROUP, type: "supergroup" },
                from: { id: USER_ID, is_bot: false },
                old_chat_member: { status: "member", user: { id: USER_ID } },
                new_chat_member: { status: "kicked", user: { id: USER_ID } },
            },
        });
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(state.logs.length, 0);
    assert.equal(state.calls.length, 0);
}

// 4. 从没交互过、没有话题的用户屏蔽机器人：通知退回管理员私聊，按钮照挂。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 0,
        topic_chat_id: null,
        topic_thread_id: null,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7004, "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const notice = state.calls.find((call) => call.method === "sendMessage");
    assert.ok(notice, "没有话题时应退回管理员私聊通知");
    assert.equal(Number(notice.payload.chat_id), ADMIN_ID);
    assert.equal(notice.payload.reply_markup.inline_keyboard.flat()[0].callback_data, `topicadmin:ban:${USER_ID}`);
}

// 5. 已经在黑名单里的用户再次屏蔽：不重复打扰，但事件仍要留痕。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 1,
        topic_chat_id: TOPIC_GROUP,
        topic_thread_id: 4242,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7005, "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(state.calls.length, 0);
    assert.ok(state.logs.some((entry) => entry.message === "user blocked the bot"));
}

// 6. 解除屏蔽时他还在黑名单里（屏蔽→拉黑→解封这个常见顺序）：通知上挂「取消拉黑」按钮。
//    按钮复用现成的 topicadmin:unban 回调，不新增任何回调代码。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 1,
        topic_chat_id: TOPIC_GROUP,
        topic_thread_id: 4242,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7006, "member", "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const notice = state.calls.find((call) => call.method === "sendMessage");
    assert.ok(notice, "在黑名单里时解除屏蔽也要发通知");
    const button = notice.payload.reply_markup.inline_keyboard.flat()[0];
    assert.equal(button.callback_data, `topicadmin:unban:${USER_ID}`);
    assert.ok(
        state.logs.some((entry) => entry.message === "user unblocked the bot"),
        "解除屏蔽仍要留痕",
    );
}

// 7. 解除屏蔽 + 从没交互过、没有话题：退回管理员私聊，按钮照挂（他在黑名单里时）。
{
    const state = baseState({
        user_id: USER_ID,
        username: "blocked_user",
        full_name: "Blocked User",
        blocked: 1,
        topic_chat_id: null,
        topic_thread_id: null,
    });
    globalThis.fetch = makeFetch(state);
    try {
        await handleTelegramUpdate(makeEnv(state), blockUpdate(7007, "member", "kicked"));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const notice = state.calls.find((call) => call.method === "sendMessage");
    assert.ok(notice, "没有话题时应退回管理员私聊通知");
    assert.equal(Number(notice.payload.chat_id), ADMIN_ID);
    assert.equal(notice.payload.reply_markup.inline_keyboard.flat()[0].callback_data, `topicadmin:unban:${USER_ID}`);
}

console.log("bot block notice tests passed");
