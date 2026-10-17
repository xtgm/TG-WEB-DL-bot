import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// 来源标注：几十条同名日志必须能一眼看出是哪个任务、哪个用户触发的。
const broadcastFailed = localizeLogEntry(
    "broadcast send failed",
    JSON.stringify({
        broadcastId: 7,
        userId: 24680,
        error: 'Telegram sendMessage failed: {"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}',
    }),
);
assert.equal(broadcastFailed.context, "任务 7 · 用户 24680");
assert.match(broadcastFailed.reason, /屏蔽机器人/);

// 账号已注销是另一种 403：没有专属映射时页面只会显示「这条日志没有对应的处理建议」，
// 看的人会以为是屏蔽或配置问题。这两种原因的处置完全不同，必须分开翻译。
const broadcastDeactivated = localizeLogEntry(
    "broadcast send failed",
    JSON.stringify({
        broadcastId: 2,
        userId: 24680,
        error: 'Telegram sendMessage failed: {"ok":false,"error_code":403,"description":"Forbidden: user is deactivated"}',
    }),
);
assert.match(broadcastDeactivated.reason, /注销|停用/);
assert.match(broadcastDeactivated.suggestion, /账号|名单/);

// 字段缺失的跳过，不产出空标签。
const broadcastCreated = localizeLogEntry(
    "broadcast created",
    JSON.stringify({ broadcastId: 3, audience: "verified", targetTotal: 20, unexpected: "x" }),
);
assert.equal(broadcastCreated.context, "任务 3 · 范围 verified · 目标数 20");

// 没有上下文映射的日志不产出来源行，避免给无关条目硬凑字段。
const unmapped = localizeLogEntry("unhandled request error", JSON.stringify({ error: "boom" }));
assert.equal(unmapped.context, "");

// data 不是合法 JSON 时也不能让翻译层崩掉。
const brokenData = localizeLogEntry("broadcast send failed", "not-a-json");
assert.equal(brokenData.context, "");

const botBlocked = localizeLogEntry(
    "failed to relay topic message",
    JSON.stringify({
        error: "Telegram copyMessage failed: {\"ok\":false,\"error_code\":403,\"description\":\"Forbidden: bot was blocked by the user\"}",
    }),
);
assert.equal(botBlocked.title, "话题消息转发给用户失败");
assert.match(botBlocked.reason, /目标用户已经屏蔽机器人/);
assert.match(botBlocked.suggestion, /\/start/);

const immutableHeaders = localizeLogEntry(
    "unhandled request error",
    JSON.stringify({ error: "TypeError: Can't modify immutable headers. at loginSubmit (worker.js:200:22)" }),
);
assert.equal(immutableHeaders.title, "请求处理异常");
assert.match(immutableHeaders.reason, /不可变的 HTTP 响应头/);
assert.match(immutableHeaders.suggestion, /重新部署当前最新版/);

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
                bind() {
                    return this;
                },
                async all() {
                    return {
                        results: [{
                            id: 3,
                            level: "error",
                            message: "failed to complete topic verification",
                            data: JSON.stringify({ userId: 987654321, error: "Telegram createForumTopic failed: Bad Request: chat not found" }),
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
// 来源标注必须出现在日志页上，否则几十条同名日志分不清是哪条触发的。
assert.match(logHtml, /log-context/);
assert.match(logHtml, /用户 987654321/);

// ===== 分类切页（方案 C）：全量日志必须先归类、先有中文标题 =====
{
    const workerSource = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
    const usedMessages = [...workerSource.matchAll(/logEvent\(\s*env\s*,\s*"[a-z]+"\s*,\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(usedMessages.length >= 20, "应能从 worker.js 提取到日志消息名，实际 " + usedMessages.length);
    for (const message of new Set(usedMessages)) {
        const entry = localizeLogEntry(message, "{}");
        assert.ok(entry.category && entry.category !== "other", "日志缺少分类：" + message);
        assert.notEqual(entry.title, message, "日志缺少中文标题：" + message);
    }
}

const groupRows = [
    {
        id: 3,
        level: "warn",
        message: "broadcast send failed",
        data: JSON.stringify({ broadcastId: 2, userId: 24680, error: "Forbidden: bot was blocked by the user" }),
        created_at: "2026-10-16T04:00:36.875Z",
    },
    {
        id: 2,
        level: "info",
        message: "broadcast created",
        data: JSON.stringify({ broadcastId: 2, audience: "verified", targetTotal: 337 }),
        created_at: "2026-10-16T03:58:12.004Z",
    },
];

function logsEnv(sink, extraStats = []) {
    return {
        PANEL_USER: panelUser,
        PANEL_SECRET: panelSecret,
        DB: {
            prepare(sqlValue) {
                const sql = String(sqlValue);
                sink.push(sql);
                return {
                    bind() { return this; },
                    async first() { return null; },
                    async all() {
                        if (sql.includes("GROUP BY message")) {
                            return {
                                results: [
                                    { message: "broadcast send failed", c: 37 },
                                    { message: "broadcast created", c: 1 },
                                    ...extraStats,
                                ],
                            };
                        }
                        if (sql.includes("FROM event_logs")) return { results: groupRows };
                        return { results: [] };
                    },
                };
            },
        },
    };
}

// 会话 Cookie 与上面日志页渲染用的是同一个 token。
const logRequest = (path) => new Request("https://example.test" + path, {
    headers: { Cookie: "tg_dualbot_session=" + sessionToken },
});

const allSink = [];
const allLogResponse = await handleRequest(logRequest("/logs"), logsEnv(allSink), {});
assert.equal(allLogResponse.status, 200);
const allLogHtml = await allLogResponse.text();
assert.match(allLogHtml, /按类型切换查看/);
for (const label of ["全部", "群发", "消息转发", "话题", "验证与指纹", "命令", "系统"]) {
    assert.ok(allLogHtml.includes(label), "日志页缺少类型标签：" + label);
}
for (const header of ["级别", "事件", "说明与处理建议", "时间"]) {
    assert.ok(allLogHtml.includes(header), "日志表缺少列：" + header);
}
assert.ok(allLogHtml.includes("群发单条发送失败"), "群发失败日志应显示中文标题");
assert.ok(allSink.some((sql) => sql.includes("GROUP BY message")), "应统计各类型条数");
assert.equal(allSink.some((sql) => sql.includes("message IN (")), false, "“全部”不应按类型过滤");

const typeSink = [];
const typeLogResponse = await handleRequest(logRequest("/logs?type=broadcast&limit=2"), logsEnv(typeSink), {});
assert.equal(typeLogResponse.status, 200);
const typeLogHtml = await typeLogResponse.text();
assert.ok(typeSink.some((sql) => sql.includes("message IN (")), "选中类型后应只查该类型");
assert.ok(typeSink.some((sql) => sql.includes("LIMIT ?")), "列表查询应带条数上限");
assert.match(typeLogHtml, /加载更多/);

// 历史遗留、当前代码已不再写入的日志落进「其他」，并单独出一个标签，
// 这样“全部”的计数与各标签之和始终一致，不会有日志在页面上看不到。
const otherSink = [];
const otherLogResponse = await handleRequest(
    logRequest("/logs?type=other"),
    logsEnv(otherSink, [{ message: "legacy old event name", c: 5 }]),
    {},
);
assert.equal(otherLogResponse.status, 200);
assert.ok(otherSink.some((sql) => sql.includes("message NOT IN (")), "“其他”应按未收录 message 反向过滤");
const otherLogHtml = await otherLogResponse.text();
assert.ok(otherLogHtml.includes("其他"), "存在未收录日志时应出现“其他”标签");

console.log("log translation tests passed");
