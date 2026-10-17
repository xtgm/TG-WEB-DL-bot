// 初始化端点：把 Telegram Webhook 的订阅项补齐（漏掉 my_chat_member 时屏蔽提醒收不到）。
// 关键安全性质：url 一律用 getWebhookInfo 读到的原值回传，绝不自己拼地址，最坏结果只是「没有变化」。
import assert from "node:assert/strict";
import { handleRequest } from "../worker.js";

const SECRET = "init-secret";
const WEBHOOK_URL = "https://example.test/telegram/webhook";

function makeEnv(state) {
    return {
        TELEGRAM_SECRET_TOKEN: SECRET,
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
                        return null;
                    },
                    async all() {
                        return { results: [] };
                    },
                    async run() {
                        if (sql.includes("INSERT INTO event_logs")) {
                            state.logs.push({ level: bindings[0], message: bindings[1], data: bindings[2] });
                            return { meta: { changes: 1 } };
                        }
                        return { meta: { changes: 0 } };
                    },
                };
            },
        },
    };
}

function makeFetch(state) {
    return async (url, init) => {
        const method = String(url).split("/").pop();
        // getWebhookInfo 这类只读接口不带 body（tgCall 里是 JSON.stringify(undefined)）。
        // 无条件 JSON.parse 会在这里就抛错，而且抛在 push 之前 —— 调用记录被自己吞掉，
        // 表现为「fetch 明明发了却查不到」，排查时看不出来。
        const payload = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        state.calls.push({ method, payload });
        if (method === "getWebhookInfo") {
            return new Response(JSON.stringify({ ok: true, result: { url: state.url, allowed_updates: state.updates } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (method === "setWebhook") {
            state.url = payload.url;
            state.updates = payload.allowed_updates;
            return new Response(JSON.stringify({ ok: true, result: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        throw new Error("unexpected method: " + method);
    };
}

const originalFetch = globalThis.fetch;

async function runInit(state) {
    globalThis.fetch = makeFetch(state);
    try {
        const response = await handleRequest(new Request(`https://example.test/init/${SECRET}`), makeEnv(state), {});
        return { status: response.status, body: await response.text() };
    } finally {
        globalThis.fetch = originalFetch;
    }
}

// 1. 缺少 my_chat_member：补齐，且 url 用读到的原值原样回传。
{
    const state = {
        url: WEBHOOK_URL,
        updates: ["message", "edited_message", "callback_query"],
        calls: [],
        logs: [],
    };
    const { status, body } = await runInit(state);
    assert.equal(status, 200);
    const setCall = state.calls.find((call) => call.method === "setWebhook");
    assert.ok(setCall, "缺少订阅项时应调用 setWebhook");
    assert.equal(setCall.payload.url, WEBHOOK_URL);
    assert.equal(setCall.payload.secret_token, SECRET);
    assert.deepEqual(setCall.payload.allowed_updates, ["message", "edited_message", "callback_query", "my_chat_member"]);
    assert.match(body, /已补齐/);
    assert.ok(state.logs.some((entry) => entry.message === "webhook subscription repaired"));
}

// 2. 已经包含 my_chat_member：不动。
{
    const state = {
        url: WEBHOOK_URL,
        updates: ["message", "edited_message", "callback_query", "my_chat_member"],
        calls: [],
        logs: [],
    };
    const { body } = await runInit(state);
    assert.equal(state.calls.some((call) => call.method === "setWebhook"), false);
    assert.match(body, /无需改动/);
}

// 3. allowed_updates 是空数组，表示订阅全部更新，my_chat_member 本来就在其中。
{
    const state = { url: WEBHOOK_URL, updates: [], calls: [], logs: [] };
    const { body } = await runInit(state);
    assert.equal(state.calls.some((call) => call.method === "setWebhook"), false);
    assert.match(body, /无需改动/);
}

// 4. 从未设置 Webhook：不猜地址，提示先完成设置。
{
    const state = { url: "", updates: [], calls: [], logs: [] };
    const { body } = await runInit(state);
    assert.equal(state.calls.some((call) => call.method === "setWebhook"), false);
    assert.match(body, /尚未设置/);
}

// 5. 密钥不对：打不开端点，也不会碰 Telegram。
{
    const state = { url: WEBHOOK_URL, updates: ["message"], calls: [], logs: [] };
    globalThis.fetch = makeFetch(state);
    let status;
    try {
        const response = await handleRequest(new Request("https://example.test/init/wrong-secret"), makeEnv(state), {});
        status = response.status;
    } finally {
        globalThis.fetch = originalFetch;
    }
    assert.notEqual(status, 200);
    assert.equal(state.calls.length, 0);
}

console.log("webhook subscription tests passed");
