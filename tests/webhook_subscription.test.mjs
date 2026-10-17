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
            // 只把 state 里显式给了值的字段放进结果，复现真实行为：
            // Telegram 对没设置过的 max_connections / ip_address / has_custom_certificate 不返回该字段。
            const result = { url: state.url, allowed_updates: state.updates };
            if (state.maxConnections !== undefined) result.max_connections = state.maxConnections;
            if (state.ipAddress !== undefined) result.ip_address = state.ipAddress;
            if (state.customCert !== undefined) result.has_custom_certificate = state.customCert;
            if (state.pendingUpdates !== undefined) result.pending_update_count = state.pendingUpdates;
            return new Response(JSON.stringify({ ok: true, result }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (method === "setWebhook") {
            state.url = payload.url;
            state.updates = payload.allowed_updates;
            if (payload.max_connections !== undefined) state.maxConnections = payload.max_connections;
            if (payload.ip_address !== undefined) state.ipAddress = payload.ip_address;
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

// 6. 线上设过 max_connections 与 ip_address：补齐时必须原样带回。
//    setWebhook 是覆盖式语义，漏传这两项可能把它们重置掉（文档只对 allowed_updates
//    写明「不传则沿用上次」，max_connections 则写着默认 40）。
{
    const state = {
        url: WEBHOOK_URL,
        updates: ["message", "callback_query"],
        maxConnections: 100,
        ipAddress: "203.0.113.7",
        pendingUpdates: 3,
        calls: [],
        logs: [],
    };
    const { body } = await runInit(state);
    const setCall = state.calls.find((call) => call.method === "setWebhook");
    assert.ok(setCall, "缺少订阅项时应调用 setWebhook");
    assert.equal(setCall.payload.url, WEBHOOK_URL);
    assert.equal(setCall.payload.max_connections, 100, "线上的 max_connections 必须原样带回");
    assert.equal(setCall.payload.ip_address, "203.0.113.7", "线上的 ip_address 必须原样带回");
    assert.deepEqual(setCall.payload.allowed_updates, ["message", "callback_query", "my_chat_member"]);
    // 这一项绝不能出现：传 True 会丢掉还没推给机器人的待处理更新。
    assert.equal(
        Object.prototype.hasOwnProperty.call(setCall.payload, "drop_pending_updates"),
        false,
        "绝不能传 drop_pending_updates",
    );
    // 现况页要把读到的信息显示出来，方便一眼核对。
    assert.match(body, /100/);
    assert.match(body, /203\.0\.113\.7/);
}

// 7. 线上用自签证书：证书本体读不回来，不许自动处理，只提示手动执行。
{
    const state = { url: WEBHOOK_URL, updates: ["message"], customCert: true, calls: [], logs: [] };
    const { body } = await runInit(state);
    assert.equal(state.calls.some((call) => call.method === "setWebhook"), false, "自签证书时不能调 setWebhook");
    assert.match(body, /未做改动/);
    assert.equal(state.logs.length, 0);
}

// 8. 线上没设过 max_connections / ip_address（字段不返回）：payload 里就不要有这两项，
//    免得把本来「默认」的东西写成一个具体值。同时确认 drop_pending_updates 依然不出现。
{
    const state = { url: WEBHOOK_URL, updates: ["message"], calls: [], logs: [] };
    const { body } = await runInit(state);
    const setCall = state.calls.find((call) => call.method === "setWebhook");
    assert.ok(setCall, "缺少订阅项时应调用 setWebhook");
    assert.equal(Object.prototype.hasOwnProperty.call(setCall.payload, "max_connections"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(setCall.payload, "ip_address"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(setCall.payload, "drop_pending_updates"), false);
    assert.deepEqual(setCall.payload.allowed_updates, ["message", "my_chat_member"]);
    assert.match(body, /已补齐/);
}

console.log("webhook subscription tests passed");
