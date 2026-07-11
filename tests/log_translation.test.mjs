import assert from "node:assert/strict";
import { handleRequest, localizeLogEntry } from "../worker.js";

const chatNotFound = localizeLogEntry(
    "failed to complete topic verification",
    JSON.stringify({
        userId: 987654321,
        error: "Telegram createForumTopic failed: {\"ok\":false,\"error_code\":400,\"description\":\"Bad Request: chat not found\"}",
    }),
);
assert.equal(chatNotFound.title, "验证完成后的话题处理失败");
assert.match(chatNotFound.reason, /找不到目标群组或聊天/);
assert.match(chatNotFound.suggestion, /TOPIC_GROUP_ID|话题群 ID/);
assert.match(chatNotFound.rawData, /createForumTopic/);

const immutableHeaders = localizeLogEntry(
    "unhandled request error",
    JSON.stringify({ error: "TypeError: Can't modify immutable headers. at loginSubmit (worker.js:200:22)" }),
);
assert.equal(immutableHeaders.title, "请求处理异常");
assert.match(immutableHeaders.reason, /不可变的 HTTP 响应头/);
assert.match(immutableHeaders.suggestion, /重新部署当前最新版/);

const d1Schema = localizeLogEntry("unhandled request error", JSON.stringify({ error: "D1_ERROR: no such table: device_fingerprint_profiles" }));
assert.match(d1Schema.reason, /缺少代码需要的数据表/);
assert.match(d1Schema.suggestion, /migrations/);

const d1Column = localizeLogEntry("unhandled request error", JSON.stringify({ error: "D1_ERROR: no such column: webrtc_ipv4_hash2" }));
assert.match(d1Column.reason, /表结构版本较旧/);
assert.match(d1Column.suggestion, /数据库迁移/);

const unknown = localizeLogEntry("custom future event", "raw details");
assert.equal(unknown.title, "custom future event");
assert.match(unknown.reason, /暂未匹配/);
assert.equal(unknown.rawData, "raw details");

const panelUser = "admin";
const panelSecret = "test-panel-secret";
const sessionBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(panelUser + "|" + panelSecret));
const sessionToken = [...new Uint8Array(sessionBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const logResponse = await handleRequest(new Request("https://example.test/logs", {
    headers: { Cookie: "tg_dualbot_session=" + sessionToken },
}), {
    PANEL_USER: panelUser,
    PANEL_SECRET: panelSecret,
    DB: {
        prepare(sql) {
            assert.match(String(sql), /FROM event_logs/);
            return {
                async all() {
                    return {
                        results: [{
                            id: 3,
                            level: "error",
                            message: "failed to complete topic verification",
                            data: JSON.stringify({ error: "Telegram createForumTopic failed: Bad Request: chat not found" }),
                            created_at: "2026-07-10T06:43:45.425Z",
                        }],
                    };
                },
            };
        },
    },
}, {});
assert.equal(logResponse.status, 200);
const logHtml = await logResponse.text();
assert.match(logHtml, /验证完成后的话题处理失败/);
assert.match(logHtml, /中文说明/);
assert.match(logHtml, /处理建议/);
assert.match(logHtml, /查看原始日志/);
assert.match(logHtml, /chat not found/);

console.log("log translation tests passed");
