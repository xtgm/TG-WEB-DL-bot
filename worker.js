const COOKIE_NAME = "tg_dualbot_session";
const DEFAULT_PANEL_USER = "admin";
const VERIFY_SESSION_HOURS = 24;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_CONTROL_MODE = "web";
const DEFAULT_TOPIC_CREATE_POLICY = "after_verify";

let verificationSchemaReady = false;

export default {
    async fetch(request, env, ctx) {
        try {
            return await handleRequest(request, env, ctx);
        } catch (error) {
            console.error(error);
            await logEvent(env, "error", "unhandled request error", { error: String(error?.stack || error) });
            return new Response("Internal Server Error", { status: 500 });
        }
    },
};

export async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
        return new Response(null, { status: 204 });
    }
    if (path === "/health") {
        return text("ok");
    }
    if (path === "/telegram/webhook" && method === "POST") {
        return telegramWebhook(request, env);
    }
    if (path === "/verify/ip-probe" && method === "GET") {
        return verifyIpProbe(request);
    }
    let verifyMatch = path.match(/^\/verify\/([A-Za-z0-9_-]{8,80})$/);
    if (verifyMatch && method === "GET") {
        return html(await verifyPage(request, env, verifyMatch[1]));
    }
    if (verifyMatch && method === "POST") {
        return verifySubmit(request, env, verifyMatch[1]);
    }
    if (path === "/verify" && method === "GET") {
        return html(await verifyPage(request, env, "", "请从 Telegram 内的验证按钮打开页面。"));
    }
    if (path === "/verify" && method === "POST") {
        return verifySubmit(request, env, "");
    }
    if (path === "/login" && method === "GET") {
        if (await isLoggedIn(request, env)) return redirect("/", request);
        return html(loginPage());
    }
    if (path === "/login" && method === "POST") {
        return loginSubmit(request, env);
    }
    if (path === "/logout") {
        const response = redirect("/login", request);
        response.headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
        return response;
    }

    if (!(await isLoggedIn(request, env))) {
        return redirect("/login", request);
    }

    if (path === "/" && method === "GET") return dashboard(request, env);
    if (path === "/inbox" && method === "GET") return inboxPage(request, env);
    if (path === "/users" && method === "GET") return usersPage(request, env);
    if (path === "/rules" && method === "GET") return rulesPage(request, env);
    if (path === "/rules" && method === "POST") return rulesSave(request, env);
    if (path === "/verifications" && method === "GET") return verificationsPage(request, env);
    if (path === "/settings" && method === "GET") return settingsPage(request, env);
    if (path === "/settings" && method === "POST") return settingsSave(request, env);
    if (path === "/logs" && method === "GET") return logsPage(request, env);

    let match = path.match(/^\/inbox\/(\d+)\/reply$/);
    if (match && method === "GET") return inboxReplyPage(request, env, Number(match[1]));
    if (match && method === "POST") return inboxReplySave(request, env, Number(match[1]));

    match = path.match(/^\/inbox\/(\d+)\/retry$/);
    if (match && method === "POST") return retryInbox(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/note$/);
    if (match && method === "POST") return userNoteSave(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/block$/);
    if (match && method === "POST") return userBlockSet(request, env, Number(match[1]), true);

    match = path.match(/^\/users\/(-?\d+)\/unblock$/);
    if (match && method === "POST") return userBlockSet(request, env, Number(match[1]), false);

    match = path.match(/^\/users\/(-?\d+)\/unverify$/);
    if (match && method === "POST") return userVerifyCancel(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/topic\/create$/);
    if (match && method === "POST") return userTopicCreate(request, env, Number(match[1]), false);

    match = path.match(/^\/users\/(-?\d+)\/topic\/rebuild$/);
    if (match && method === "POST") return userTopicCreate(request, env, Number(match[1]), true);

    match = path.match(/^\/users\/(-?\d+)\/topic\/unbind$/);
    if (match && method === "POST") return userTopicUnbind(request, env, Number(match[1]));

    return html(layout("未找到", `<div class="card"><p>页面不存在。</p></div>`), 404);
}

function normalizePath(path) {
    if (!path || path === "") return "/";
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function text(body, status = 200) {
    return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(body, status = 200) {
    return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function redirect(path, request, status = 303) {
    return new Response(null, {
        status,
        headers: {
            Location: new URL(path, request.url).toString(),
        },
    });
}

function h(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function nowIso() {
    return new Date().toISOString();
}

async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    let diff = left.length ^ right.length;
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i += 1) {
        diff |= left.charCodeAt(i % left.length || 0) ^ right.charCodeAt(i % right.length || 0);
    }
    return diff === 0;
}

function parseCookies(request) {
    const raw = request.headers.get("Cookie") || "";
    const cookies = {};
    for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return cookies;
}

function panelUser(env) {
    return env.PANEL_USER || DEFAULT_PANEL_USER;
}

function panelSecret(env) {
    return env.PANEL_SECRET || "dev-secret-change-me";
}

async function sessionToken(env) {
    return sha256Hex(`${panelUser(env)}|${panelSecret(env)}`);
}

async function isLoggedIn(request, env) {
    const token = parseCookies(request)[COOKIE_NAME] || "";
    return Boolean(token) && constantTimeEqual(token, await sessionToken(env));
}

async function loginSubmit(request, env) {
    const form = await request.formData();
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");
    const expectedUser = panelUser(env);
    const expectedPass = env.PANEL_PASSWORD || "change-me";
    if (!constantTimeEqual(username, expectedUser) || !constantTimeEqual(password, expectedPass)) {
        return html(loginPage("用户名或密码错误"), 401);
    }
    const response = redirect("/", request);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    response.headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(await sessionToken(env))}; Path=/; Max-Age=${60 * 60 * 24 * 14}; HttpOnly; SameSite=Lax${secure}`,
    );
    return response;
}

function loginPage(error = "") {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · TG DualBot</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fb;color:#111827;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.card{width:min(420px,calc(100% - 32px));background:white;border:1px solid #d8dee9;border-radius:10px;padding:28px;box-shadow:0 18px 50px rgba(15,23,42,.12)}
h1{margin:0 0 8px;font-size:26px}.muted{color:#64748b;margin:0 0 22px;line-height:1.5}label{display:block;font-weight:700;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}
button{width:100%;margin-top:20px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:800;padding:12px;cursor:pointer}
.error{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;margin-bottom:14px}
</style></head><body><form class="card" method="post" action="/login">
<h1>TG DualBot</h1><p class="muted">Cloudflare 双向机器人后台</p>
${error ? `<div class="error">${h(error)}</div>` : ""}
<label>用户名</label><input name="username" autocomplete="username" required>
<label>密码</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button></form></body></html>`;
}

function layout(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · TG DualBot</title><style>
:root{--bg:#f4f6fb;--panel:#fff;--line:#d8dee9;--ink:#111827;--muted:#64748b;--blue:#2563eb;--red:#dc2626;--green:#16a34a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,sans-serif}
.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}.side{background:#0f172a;color:white;padding:18px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{font-size:20px;font-weight:900;margin-bottom:18px}.brand small{display:block;color:#94a3b8;font-size:12px;margin-top:3px}
nav{display:grid;gap:8px}nav a{color:#dbeafe;text-decoration:none;padding:10px 11px;border-radius:8px;font-weight:750}nav a:hover{background:#1e293b;text-decoration:none}
main{padding:24px;max-width:1360px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.top h1{margin:0;font-size:28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:14px 0;box-shadow:0 8px 24px rgba(15,23,42,.05)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.metric{font-size:26px;font-weight:900}.muted{color:var(--muted);line-height:1.5}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn,button{display:inline-block;border:0;border-radius:8px;background:#e2e8f0;color:#0f172a;padding:8px 11px;font-weight:800;text-decoration:none;cursor:pointer}
.btn.primary,button.primary{background:var(--blue);color:white}.btn.danger,button.danger{background:var(--red);color:white}.btn.ok{background:var(--green);color:white}
input,textarea,select{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px 11px;font:inherit}textarea{min-height:120px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
label{display:block;margin:10px 0 5px;font-weight:800}table{width:100%;border-collapse:collapse;background:white}th,td{border-bottom:1px solid #e2e8f0;text-align:left;padding:10px;vertical-align:top}th{font-size:12px;color:#475569;background:#f8fafc}
.badge{display:inline-block;border-radius:999px;background:#e2e8f0;color:#0f172a;padding:3px 8px;font-size:12px;font-weight:900}.badge.red{background:#fee2e2;color:#991b1b}.badge.green{background:#dcfce7;color:#166534}
pre{white-space:pre-wrap;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px;overflow:auto}.msg{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 12px;color:#1e3a8a;font-weight:700}
@media(max-width:800px){.shell{grid-template-columns:1fr}.side{height:auto;position:relative}main{padding:16px}}
</style></head><body><div class="shell"><aside class="side"><div class="brand">TG DualBot<small>Cloudflare 后台</small></div><nav>
<a href="/">总览</a><a href="/inbox">收件箱</a><a href="/users">用户管理</a><a href="/rules">广告拦截</a><a href="/verifications">CF 验证记录</a><a href="/settings">设置</a><a href="/logs">日志</a><a href="/logout">退出</a>
</nav></aside><main><div class="top"><h1>${h(title)}</h1><span class="badge">Worker + D1</span></div>${body}</main></div></body></html>`;
}

async function dashboard(request, env) {
    await ensureVerificationSchema(env);
    const stats = await Promise.all([
        scalar(env, "SELECT COUNT(*) FROM users"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE blocked=1"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE verified=1"),
        scalar(env, "SELECT COUNT(*) FROM inbox_messages"),
        scalar(env, "SELECT COUNT(*) FROM ip_verifications WHERE passed=1"),
    ]);
    const base = publicBaseUrl(env, request);
    const body = `<div class="grid">
<div class="card"><div class="muted">用户数</div><div class="metric">${stats[0]}</div></div>
<div class="card"><div class="muted">封禁用户</div><div class="metric">${stats[1]}</div></div>
<div class="card"><div class="muted">已验证用户</div><div class="metric">${stats[2]}</div></div>
<div class="card"><div class="muted">消息记录</div><div class="metric">${stats[3]}</div></div>
<div class="card"><div class="muted">CF 验证通过</div><div class="metric">${stats[4]}</div></div>
</div>
<div class="card"><h2>项目状态</h2><p class="muted">当前版本提供 Telegram 私聊双向通信、验证后聊天门禁、管理员回复、收件箱、用户管理、备注、封禁、广告拦截、多管理员、Cloudflare Turnstile 验证、IPv4/IPv6/UDP WebRTC 记录，并同时支持 Workers 和 Pages Functions 部署。</p>
<p><b>公开地址：</b><code>${h(base)}</code></p><p><b>验证入口：</b><code>${h(`${base}/verify/{token}`)}</code></p></div>`;
    return html(layout("总览", body));
}

async function inboxPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM inbox_messages ORDER BY id DESC LIMIT 200").all();
    const bodyRows = (rows.results || []).map((r) => {
        const status = r.direction === "out" ? "已回复" : r.error?.startsWith("spam:") ? "已拦截" : r.forwarded ? "已转发" : "未转发";
        const cls = status === "未转发" || status === "已拦截" ? "red" : "green";
        const flow = r.direction === "out" ? "管理员 -> 用户" : "用户 -> 管理员";
        const retry = r.direction === "in" && !r.forwarded ? `<form method="post" action="/inbox/${r.id}/retry"><button>重试转发</button></form>` : "";
        return `<tr><td>#${r.id}<br><span class="badge ${cls}">${h(status)}</span></td><td><b>${h(r.full_name || r.user_id)}</b><br><small>${r.user_id} @${h(r.username || "")}</small></td><td>${h(flow)}<br><small>${h(r.source || "")} · ${h(r.created_at)}</small></td><td>${h(r.text || "(非文本/媒体消息)")}${r.error ? `<br><small class="muted">${h(r.error)}</small>` : ""}</td><td><div class="actions"><a class="btn primary" href="/inbox/${r.id}/reply">回复</a>${retry}</div></td></tr>`;
    }).join("");
    return html(layout("收件箱", `<div class="card"><div class="toolbar"><div><h2>双向消息记录</h2><p class="muted">用户入站消息、Telegram 管理员回复、Web 后台回复都会记录在这里。</p></div></div><table><tr><th>ID/状态</th><th>用户</th><th>方向/来源</th><th>内容/错误</th><th>操作</th></tr>${bodyRows}</table></div>`));
}

async function inboxReplyPage(request, env, id) {
    const row = await getInboxMessage(env, id);
    if (!row) return html(layout("未找到", `<div class="card">消息不存在。</div>`), 404);
    const body = `<div class="card"><h2>回复用户</h2><p class="muted">#${row.id} · ${h(row.full_name)} · ${row.user_id}</p><pre>${h(row.text || "(非文本/媒体消息)")}</pre>
<form method="post"><label>回复内容</label><textarea name="text" required></textarea><div class="actions"><button class="primary" type="submit">发送回复</button><a class="btn" href="/inbox">返回</a></div></form></div>`;
    return html(layout("回复用户", body));
}

async function inboxReplySave(request, env, id) {
    const form = await request.formData();
    const textValue = String(form.get("text") || "").trim();
    const row = await getInboxMessage(env, id);
    if (!row) return html(layout("未找到", `<div class="card">消息不存在。</div>`), 404);
    if (!textValue) return html(layout("回复失败", `<div class="card">回复内容不能为空。</div>`), 400);
    try {
        const sent = await sendTextToUser(env, Number(row.user_id), textValue, "web:inbox");
        await notifyAdmins(env, `[Web 回复成功]\nuser_id: <code>${row.user_id}</code>\nmessage_id: ${sent.message_id}`);
        return html(layout("回复成功", `<div class="msg">已回复用户 ${h(row.user_id)}。</div><p><a class="btn" href="/inbox">返回收件箱</a></p>`));
    } catch (error) {
        return html(layout("回复失败", `<div class="card"><pre>${h(error)}</pre></div><p><a class="btn" href="/inbox/${id}/reply">返回</a></p>`), 500);
    }
}

async function retryInbox(request, env, id) {
    const row = await getInboxMessage(env, id);
    if (!row) return redirect("/inbox", request);
    try {
        await relayInboxByMode(env, row);
    } catch (error) {
        await markInboxError(env, id, String(error));
    }
    return redirect("/inbox", request);
}

async function usersPage(request, env) {
    await ensureVerificationSchema(env);
    const rows = await env.DB.prepare("SELECT * FROM users ORDER BY updated_at DESC LIMIT 300").all();
    const bodyRows = (rows.results || []).map((u) => {
        const status = u.blocked ? `<span class="badge red">封禁</span>` : u.verified ? `<span class="badge green">已验证</span>` : `<span class="badge red">未验证</span>`;
        const actionPath = u.blocked ? "unblock" : "block";
        const actionText = u.blocked ? "解封" : "封禁";
        const actionClass = u.blocked ? "ok" : "danger";
        const http = [
            u.last_http_ipv4 ? `IPv4: ${h(u.last_http_ipv4)}` : "IPv4: -",
            u.last_http_ipv6 ? `IPv6: ${h(u.last_http_ipv6)}` : "IPv6: -",
            u.last_asn ? `ASN: ${h(u.last_asn)}` : "ASN: -",
            u.last_as_organization ? h(u.last_as_organization) : "运营商: -",
        ].join("<br>");
        const udp = [
            u.last_webrtc_ipv4 ? `UDP IPv4: ${h(u.last_webrtc_ipv4)}` : "UDP IPv4: -",
            u.last_webrtc_ipv6 ? `UDP IPv6: ${h(u.last_webrtc_ipv6)}` : "UDP IPv6: -",
            `UDP 状态: ${h(u.last_udp_status || "-")}`,
            u.last_device_os ? `设备: ${h(u.last_device_os)}` : "设备: -",
        ].join("<br>");
        const topic = [
            u.topic_thread_id ? `话题 ID: ${h(u.topic_thread_id)}` : "话题 ID: -",
            `状态: ${h(u.topic_status || "-")}`,
            u.topic_title ? `标题: ${h(u.topic_title)}` : "标题: -",
            u.topic_last_error ? `错误: ${h(u.topic_last_error)}` : "",
        ].filter(Boolean).join("<br>");
        const unverify = u.verified ? `<form method="post" action="/users/${u.user_id}/unverify" style="margin-top:8px"><button type="submit">取消验证</button></form>` : "";
        const topicActions = `<form method="post" action="/users/${u.user_id}/topic/create" style="margin-top:8px"><button type="submit">创建话题</button></form><form method="post" action="/users/${u.user_id}/topic/rebuild" style="margin-top:8px"><button type="submit">重建话题</button></form><form method="post" action="/users/${u.user_id}/topic/unbind" style="margin-top:8px"><button type="submit">取消绑定</button></form>`;
        return `<tr><td><b>${h(u.full_name || u.user_id)}</b><br><small>${u.user_id} @${h(u.username || "")}<br>语言: ${h(u.language_code || "-")}</small></td><td>${status}<br><small>${h(u.verification_status || "")}<br>${h(u.updated_at)}</small></td><td>${http}<br><small>${h(u.last_verified_at || "")}</small></td><td>${udp}</td><td>${topic}</td><td>${h(u.note || "")}</td><td><form method="post" action="/users/${u.user_id}/note"><input name="note" value="${h(u.note || "")}"><button type="submit">保存备注</button></form><form method="post" action="/users/${u.user_id}/${actionPath}" style="margin-top:8px"><button class="${actionClass}" type="submit">${actionText}</button></form>${unverify}${topicActions}</td></tr>`;
    }).join("");
    return html(layout("用户管理", `<div class="card"><h2>用户管理</h2><p class="muted">展示已私聊过 Bot 的用户、验证状态、IPv4/IPv6、UDP WebRTC、话题绑定、封禁状态和备注。</p><table><tr><th>用户</th><th>状态</th><th>公网 HTTP 信息</th><th>UDP / WebRTC</th><th>话题</th><th>备注</th><th>操作</th></tr>${bodyRows}</table></div>`));
}

async function userNoteSave(request, env, userId) {
    const form = await request.formData();
    await env.DB.prepare("UPDATE users SET note=?, updated_at=? WHERE user_id=?")
        .bind(String(form.get("note") || "").trim(), nowIso(), userId)
        .run();
    return redirect("/users", request);
}

async function userBlockSet(request, env, userId, blocked) {
    await setBlock(env, userId, blocked);
    return redirect("/users", request);
}

async function userVerifyCancel(request, env, userId) {
    await setUserVerified(env, userId, false, "cancelled");
    return redirect("/users", request);
}

async function userTopicCreate(request, env, userId, forceNew) {
    await ensureVerificationSchema(env);
    try {
        await ensureUserTopic(env, userId, { forceNew, reason: forceNew ? "web:rebuild" : "web:create" });
    } catch (error) {
        await logEvent(env, "error", "failed to create topic from web", { userId, error: String(error?.message || error) });
    }
    return redirect("/users", request);
}

async function userTopicUnbind(request, env, userId) {
    await ensureVerificationSchema(env);
    await clearUserTopic(env, userId);
    return redirect("/users", request);
}

async function rulesPage(request, env) {
    const keywords = await getSpamKeywords(env);
    const autoBlock = await getSetting(env, "spam_auto_block", "true");
    const body = `<div class="card"><h2>私聊广告拦截</h2><p class="muted">只拦截用户私聊 Bot 的消息。命中后可自动封禁，并通知管理员。</p>
<form method="post"><label><input type="checkbox" name="auto_block" ${autoBlock !== "false" ? "checked" : ""} style="width:auto"> 命中后自动封禁</label>
<label>关键词（一行一个）</label><textarea name="keywords">${h(keywords.join("\n"))}</textarea>
<div class="actions"><button class="primary" type="submit">保存规则</button></div></form></div>`;
    return html(layout("广告拦截", body));
}

async function rulesSave(request, env) {
    const form = await request.formData();
    const keywords = String(form.get("keywords") || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    await env.DB.prepare("DELETE FROM spam_keywords").run();
    for (const keyword of [...new Set(keywords)]) {
        await env.DB.prepare("INSERT INTO spam_keywords(keyword, created_at) VALUES(?, ?)").bind(keyword, nowIso()).run();
    }
    await setSetting(env, "spam_auto_block", form.get("auto_block") ? "true" : "false");
    return redirect("/rules", request);
}

async function verificationsPage(request, env) {
    await ensureVerificationSchema(env);
    const rows = await env.DB.prepare("SELECT v.*, u.full_name, u.username FROM ip_verifications v LEFT JOIN users u ON u.user_id=v.user_id ORDER BY v.id DESC LIMIT 300").all();
    const bodyRows = (rows.results || []).map((r) => {
        const http = [
            `HTTP: ${h(r.http_ip || r.ip || "-")}`,
            `类型: ${h(r.http_ip_version || "-")}`,
            `IPv4: ${h(r.http_ipv4 || "-")}`,
            `IPv6: ${h(r.http_ipv6 || "-")}`,
            `ASN: ${h(r.asn || "-")}`,
            h(r.as_organization || ""),
        ].join("<br>");
        const udp = [
            `UDP IPv4: ${h(r.webrtc_ipv4 || "-")}`,
            `UDP IPv6: ${h(r.webrtc_ipv6 || "-")}`,
            `协议: ${h(r.webrtc_protocol || "-")}`,
            `类型: ${h(r.webrtc_candidate_type || "-")}`,
            `状态: ${h(r.udp_status || "-")}`,
        ].join("<br>");
        return `<tr><td>#${r.id}<br><span class="badge green">通过</span></td><td>${r.user_id ? `<b>${h(r.full_name || r.user_id)}</b><br><small>${r.user_id} @${h(r.username || "")}</small>` : "-"}</td><td>${http}<br><small>${h(r.country || "")} · ${h(r.colo || "")}</small></td><td>${udp}</td><td>${h(r.device_os || "-")}<br><small>${h(r.user_agent || "")}</small></td><td>${h(r.created_at)}</td></tr>`;
    }).join("");
    return html(layout("CF 验证记录", `<div class="card"><h2>CF 验证记录</h2><p class="muted">访客通过 Cloudflare Turnstile 后会记录 HTTP IPv4/IPv6、UDP WebRTC IPv4/IPv6、ASN、设备系统和 User-Agent。验证入口使用一次性 token 关联 Telegram 用户。</p><table><tr><th>ID</th><th>用户</th><th>公网 HTTP</th><th>UDP / WebRTC</th><th>设备/User-Agent</th><th>时间</th></tr>${bodyRows}</table></div>`));
}

async function settingsPage(request, env) {
    const adminIds = await adminChatIds(env);
    const welcome = await getSetting(env, "welcome_message", "已连接机器人后台。你的消息会转交给管理员。");
    const mode = await controlMode(env);
    const groupId = await topicGroupId(env);
    const createPolicy = await topicCreatePolicy(env);
    const syncWebReplies = await topicSyncWebReplies(env);
    const base = publicBaseUrl(env, request);
    const option = (value, label, selected) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`;
    const body = `<div class="card"><h2>后台设置</h2><form method="post">
<label>管理员 Telegram Chat ID（最多 3 个，逗号分隔）</label><input name="admin_chat_ids" value="${h(adminIds.join(","))}">
<label>用户 /start 欢迎语</label><textarea name="welcome_message">${h(welcome)}</textarea>
<div class="grid"><div><label>控制模式</label><select name="control_mode">${option("web", "仅 Web 后台", mode)}${option("topic", "仅 Telegram 话题", mode)}${option("both", "Web 后台 + Telegram 话题", mode)}</select></div><div><label>Telegram 话题群 ID</label><input name="topic_group_id" value="${h(groupId || "")}" placeholder="-1001234567890"></div></div>
<div class="grid"><div><label>话题创建策略</label><select name="topic_create_policy">${option("after_verify", "验证通过后创建", createPolicy)}${option("first_message", "用户首条消息时创建", createPolicy)}</select></div><div><label><input type="checkbox" name="topic_sync_web_replies" ${syncWebReplies ? "checked" : ""} style="width:auto"> Web/私聊回复同步到话题</label></div></div>
<div class="grid"><div><label>公开地址</label><input value="${h(base)}" readonly></div><div><label>验证入口</label><input value="${h(`${base}/verify/{token}`)}" readonly></div></div>
<div class="actions"><button class="primary" type="submit">保存设置</button></div></form></div>
<div class="card"><h2>Cloudflare Secrets 状态</h2>
<table><tr><th>名称</th><th>状态</th><th>说明</th></tr>
${secretRow("BOT_TOKEN", env.BOT_TOKEN, "Telegram Bot Token")}
${secretRow("PANEL_PASSWORD", env.PANEL_PASSWORD, "后台登录密码")}
${secretRow("PANEL_SECRET", env.PANEL_SECRET, "Cookie session secret")}
${secretRow("TELEGRAM_SECRET_TOKEN", env.TELEGRAM_SECRET_TOKEN, "Telegram webhook secret token")}
${secretRow("TURNSTILE_SECRET_KEY", env.TURNSTILE_SECRET_KEY, "Cloudflare Turnstile secret")}
${secretRow("TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY, "Cloudflare Turnstile site key，可放 vars")}
${secretRow("CONTROL_MODE", mode, "web / topic / both")}
${secretRow("TOPIC_GROUP_ID", groupId, "开启 Topics 的 Telegram 超级群 ID")}
</table></div>`;
    return html(layout("设置", body));
}

function secretRow(name, value, note) {
    return `<tr><td><code>${name}</code></td><td>${value ? '<span class="badge green">已配置</span>' : '<span class="badge red">未配置</span>'}</td><td>${h(note)}</td></tr>`;
}

async function settingsSave(request, env) {
    const form = await request.formData();
    const mode = String(form.get("control_mode") || DEFAULT_CONTROL_MODE).trim().toLowerCase();
    const safeMode = ["web", "topic", "both"].includes(mode) ? mode : DEFAULT_CONTROL_MODE;
    const policy = String(form.get("topic_create_policy") || DEFAULT_TOPIC_CREATE_POLICY).trim().toLowerCase();
    const safePolicy = ["after_verify", "first_message"].includes(policy) ? policy : DEFAULT_TOPIC_CREATE_POLICY;
    await setSetting(env, "admin_chat_ids", String(form.get("admin_chat_ids") || ""));
    await setSetting(env, "welcome_message", String(form.get("welcome_message") || "").trim());
    await setSetting(env, "control_mode", safeMode);
    await setSetting(env, "topic_group_id", String(form.get("topic_group_id") || "").trim());
    await setSetting(env, "topic_create_policy", safePolicy);
    await setSetting(env, "topic_sync_web_replies", form.get("topic_sync_web_replies") ? "true" : "false");
    return redirect("/settings", request);
}

async function logsPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM event_logs ORDER BY id DESC LIMIT 200").all();
    const bodyRows = (rows.results || []).map((r) => `<tr><td>#${r.id}<br><span class="badge">${h(r.level)}</span></td><td>${h(r.message)}${r.data ? `<pre>${h(r.data)}</pre>` : ""}</td><td>${h(r.created_at)}</td></tr>`).join("");
    return html(layout("日志", `<div class="card"><h2>最近日志</h2><table><tr><th>ID</th><th>内容</th><th>时间</th></tr>${bodyRows}</table></div>`));
}

async function verifyPage(request, env, token = "", error = "") {
    await ensureVerificationSchema(env);
    if (!token) {
        return verifyMessagePage("继续聊天前需要验证", `<p class="muted">${h(error || "请回到 Telegram，点击机器人发送的验证按钮。")}</p>`);
    }
    const session = await getVerificationSession(env, token);
    if (!session) {
        return verifyMessagePage("验证链接无效", `<p class="muted">请回到 Telegram 重新点击验证按钮。</p>`);
    }
    if (session.expires_at && Date.parse(session.expires_at) < Date.now()) {
        await markVerificationSession(env, token, "expired");
        return verifyMessagePage("验证链接已过期", `<p class="muted">请回到 Telegram 重新获取验证链接。</p>`);
    }
    if (session.status === "verified") {
        return verifySuccessPage();
    }
    if (!env.TURNSTILE_SITE_KEY) {
        return verifyMessagePage("CF 验证未配置", `<p>请先配置 <code>TURNSTILE_SITE_KEY</code> 和 <code>TURNSTILE_SECRET_KEY</code>。</p>`);
    }
    const tokenJson = JSON.stringify(token);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>继续聊天前需要验证</title>${verifyStyle()}<script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><main><form id="verifyForm" class="card" method="post" action="/verify/${h(token)}">
<h1>继续聊天前需要验证</h1><p class="muted">此页面使用 Cloudflare Turnstile 进行人机验证。验证通过后，机器人会为你建立独立话题并转发后续消息。</p>${error ? `<div class="error">${h(error)}</div>` : ""}
<input type="hidden" id="client_data" name="client_data" value="">
<div class="cf-turnstile" data-sitekey="${h(env.TURNSTILE_SITE_KEY)}"></div>
<button id="submitBtn" type="submit">完成验证</button></form></main><script>
const VERIFY_TOKEN = ${tokenJson};
const telegramWebApp = window.Telegram && window.Telegram.WebApp;
if (telegramWebApp) {
    telegramWebApp.ready();
    telegramWebApp.expand();
}
const form = document.getElementById("verifyForm");
const button = document.getElementById("submitBtn");
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = "正在验证...";
    try {
        const data = await collectClientData();
        document.getElementById("client_data").value = JSON.stringify(data).slice(0, 6000);
    } catch (error) {
        document.getElementById("client_data").value = JSON.stringify({ error: String(error && error.message || error) }).slice(0, 6000);
    }
    button.textContent = "正在提交验证...";
    form.submit();
});
async function collectClientData() {
    const data = {
        language: navigator.language || "",
        platform: navigator.platform || "",
        user_agent: navigator.userAgent || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        screen: { width: screen.width || 0, height: screen.height || 0, pixel_ratio: window.devicePixelRatio || 1 },
        probe: null,
        webrtc: null,
    };
    const tasks = [httpProbe(), collectWebRtcCandidates()];
    const results = await Promise.allSettled(tasks);
    data.probe = results[0].status === "fulfilled" ? results[0].value : { error: String(results[0].reason || "failed") };
    data.webrtc = results[1].status === "fulfilled" ? results[1].value : { udp_status: "failed", error: String(results[1].reason || "failed") };
    return data;
}
async function httpProbe() {
    const response = await fetch("/verify/ip-probe?token=" + encodeURIComponent(VERIFY_TOKEN) + "&t=" + Date.now(), { cache: "no-store" });
    return response.json();
}
function collectWebRtcCandidates() {
    return new Promise(async (resolve) => {
        if (!window.RTCPeerConnection) {
            resolve({ udp_status: "unsupported", candidates: [] });
            return;
        }
        const candidates = [];
        const pc = new RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }] });
        const finish = () => {
            try { pc.close(); } catch (error) {}
            const parsed = candidates.map(parseCandidate).filter(Boolean);
            const udp = parsed.filter((x) => x.protocol === "udp");
            const ipv4 = firstPublicIp(udp, "IPv4");
            const ipv6 = firstPublicIp(udp, "IPv6");
            resolve({
                udp_status: udp.length ? "success" : "empty",
                webrtc_ipv4: ipv4,
                webrtc_ipv6: ipv6,
                webrtc_protocol: udp.length ? "udp" : "",
                webrtc_candidate_type: udp.map((x) => x.type).filter(Boolean).join(",").slice(0, 80),
                candidates: parsed.slice(0, 20),
            });
        };
        pc.onicecandidate = (event) => {
            if (event.candidate && event.candidate.candidate) candidates.push(event.candidate.candidate);
            if (!event.candidate) finish();
        };
        try {
            pc.createDataChannel("probe");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            setTimeout(finish, 3500);
        } catch (error) {
            try { pc.close(); } catch (closeError) {}
            resolve({ udp_status: "failed", error: String(error && error.message || error), candidates: [] });
        }
    });
}
function parseCandidate(candidate) {
    const parts = String(candidate || "").split(/\s+/);
    const typIndex = parts.indexOf("typ");
    const ip = parts[4] || "";
    const protocol = String(parts[2] || "").toLowerCase();
    const type = typIndex >= 0 ? parts[typIndex + 1] || "" : "";
    if (!ip || ip.endsWith(".local")) return null;
    return { ip, version: ip.includes(":") ? "IPv6" : "IPv4", protocol, type, raw: candidate.slice(0, 500) };
}
function firstPublicIp(items, version) {
    const item = items.find((x) => x.version === version && x.type !== "host" && !isPrivateIp(x.ip));
    return item ? item.ip : "";
}
function isPrivateIp(ip) {
    return /^(10\.|127\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|169\.254\.)/.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip) || ip === "::1";
}
</script></body></html>`;
}

function verifyMessagePage(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title>${verifyStyle()}</head><body><main><div class="card"><h1>${h(title)}</h1>${body}</div></main></body></html>`;
}

function verifySuccessPage() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>验证成功</title>${verifyStyle()}</head><body><main><div class="card"><h1>验证成功</h1><p>验证已通过，请回到 Telegram 继续聊天。</p></div></main></body></html>`;
}

function verifyStyle() {
    return `<style>body{margin:0;background:#f4f0e8;color:#111827;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(520px,100%);background:#fffaf3;border:1px solid #e5d5bf;border-radius:22px;padding:30px;box-shadow:0 22px 70px rgba(86,64,38,.16)}h1{margin:0 0 14px;font-size:30px;line-height:1.2}.muted{color:#4b5563;line-height:1.65}.small{font-size:13px}.error{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px;margin:12px 0}button{width:100%;margin-top:20px;border:0;border-radius:999px;background:linear-gradient(90deg,#de6b22,#9f430f);color:white;font-weight:900;padding:14px 18px;cursor:pointer;font-size:16px}button:disabled{opacity:.65;cursor:wait}.cf-turnstile{margin:20px 0 8px}code,pre{background:#f3f4f6;border-radius:8px;padding:2px 5px}</style>`;
}

async function verifySubmit(request, env, token = "") {
    await ensureVerificationSchema(env);
    if (!token) return html(await verifyPage(request, env, "", "验证链接缺少 token，请从 Telegram 重新打开。"), 400);
    const session = await getVerificationSession(env, token);
    if (!session) return html(await verifyPage(request, env, "", "验证链接无效，请从 Telegram 重新打开。"), 404);
    if (session.expires_at && Date.parse(session.expires_at) < Date.now()) {
        await markVerificationSession(env, token, "expired");
        return html(await verifyPage(request, env, "", "验证链接已过期，请从 Telegram 重新获取。"), 400);
    }
    const form = await request.formData();
    const turnstileToken = String(form.get("cf-turnstile-response") || "");
    const clientData = parseClientData(form.get("client_data"));
    const ip = visitorIp(request);
    if (!turnstileToken) return html(await verifyPage(request, env, token, "请先完成人机验证。"), 400);
    if (!env.TURNSTILE_SECRET_KEY) return html(await verifyPage(request, env, token, "Turnstile Secret 未配置。"), 500);

    const verifyForm = new FormData();
    verifyForm.append("secret", env.TURNSTILE_SECRET_KEY);
    verifyForm.append("response", turnstileToken);
    if (ip) verifyForm.append("remoteip", ip);
    const result = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: verifyForm }).then((r) => r.json());
    if (!result.success) {
        await logEvent(env, "warn", "turnstile verification failed", result);
        return html(await verifyPage(request, env, token, "验证失败，请刷新后重试。"), 400);
    }

    const ts = nowIso();
    const cfInfo = requestCfInfo(request);
    const userAgent = request.headers.get("User-Agent") || "";
    const network = extractClientNetwork(clientData, ip);
    const deviceOs = detectDeviceOs(userAgent, clientData);
    const rawClientData = JSON.stringify(clientData || {}).slice(0, 6000);
    const userId = Number(session.user_id);
    await env.DB.prepare(`UPDATE verification_sessions SET status='verified', verified_at=?, http_ip=?, http_ip_version=?, http_ipv4=?, http_ipv6=?, webrtc_ipv4=?, webrtc_ipv6=?, webrtc_protocol=?, webrtc_candidate_type=?, udp_status=?, asn=?, as_organization=?, country=?, colo=?, device_os=?, user_agent=?, raw_client_data=? WHERE token=?`)
        .bind(ts, ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.webrtc_protocol, network.webrtc_candidate_type, network.udp_status, cfInfo.asn, cfInfo.asOrganization, cfInfo.country, cfInfo.colo, deviceOs, userAgent.slice(0, 500), rawClientData, token)
        .run();
    await env.DB.prepare(`INSERT INTO ip_verifications(user_id, ip, country, colo, user_agent, passed, turnstile_action, http_ip, http_ip_version, http_ipv4, http_ipv6, webrtc_ipv4, webrtc_ipv6, webrtc_protocol, webrtc_candidate_type, udp_status, asn, as_organization, device_os, token, raw_client_data, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, ip || "", cfInfo.country, cfInfo.colo, userAgent.slice(0, 500), 1, String(result.action || ""), ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.webrtc_protocol, network.webrtc_candidate_type, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, token, rawClientData, ts)
        .run();
    await env.DB.prepare(`UPDATE users SET verified=1, verification_status='verified', verification_token=?, language_code=COALESCE(NULLIF(language_code,''), ?), last_verified_ip=?, last_verified_at=?, last_cf_country=?, last_http_ip=?, last_http_ip_version=?, last_http_ipv4=?, last_http_ipv6=?, last_webrtc_ipv4=?, last_webrtc_ipv6=?, last_udp_status=?, last_asn=?, last_as_organization=?, last_device_os=?, last_user_agent=?, updated_at=? WHERE user_id=?`)
        .bind(token, session.language_code || "", ip || "", ts, cfInfo.country, ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, userAgent.slice(0, 500), ts, userId)
        .run();
    const verificationInfo = {
        username: session.username || "",
        fullName: session.full_name || String(userId),
        languageCode: session.language_code || "",
        httpIp: ip || "",
        httpIpVersion: ipVersion(ip),
        httpIpv4: network.http_ipv4,
        httpIpv6: network.http_ipv6,
        webrtcIpv4: network.webrtc_ipv4,
        webrtcIpv6: network.webrtc_ipv6,
        udpStatus: network.udp_status,
        candidateType: network.webrtc_candidate_type,
        asn: cfInfo.asn,
        asOrganization: cfInfo.asOrganization,
        country: cfInfo.country,
        colo: cfInfo.colo,
        deviceOs,
    };
    await completeTopicVerification(env, userId, verificationInfo);
    await notifyVerificationSuccess(env, userId, token, verificationInfo);
    await tgSendMessage(env, userId, "验证已通过，现在可以回到 Telegram 继续聊天。").catch(() => {});
    return html(verifySuccessPage());
}

function verifyIpProbe(request) {
    const ip = visitorIp(request);
    const cfInfo = requestCfInfo(request);
    const body = {
        http_ip: ip,
        http_ip_version: ipVersion(ip),
        http_ipv4: ipVersion(ip) === "IPv4" ? ip : "",
        http_ipv6: ipVersion(ip) === "IPv6" ? ip : "",
        country: cfInfo.country,
        colo: cfInfo.colo,
        asn: cfInfo.asn,
        as_organization: cfInfo.asOrganization,
        user_agent: request.headers.get("User-Agent") || "",
        ts: nowIso(),
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function visitorIp(request) {
    return (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0] || "").trim();
}

async function telegramWebhook(request, env) {
    if (env.TELEGRAM_SECRET_TOKEN) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (!constantTimeEqual(got, env.TELEGRAM_SECRET_TOKEN)) return text("forbidden", 403);
    }
    if (!env.BOT_TOKEN) {
        await logEvent(env, "error", "BOT_TOKEN is missing", {});
        return text("BOT_TOKEN missing", 500);
    }
    await ensureVerificationSchema(env);
    const update = await request.json();
    await handleTelegramUpdate(env, update);
    return json({ ok: true });
}

async function handleTelegramUpdate(env, update) {
    if (update.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
        return;
    }
    const message = update.message || update.edited_message;
    if (!message || !message.chat) return;
    const chatId = Number(message.chat.id);
    const textValue = message.text || "";
    const command = parseCommand(textValue);
    if (await isTopicGroupMessage(env, message)) {
        await handleTopicGroupMessage(env, message, command);
        return;
    }
    const admin = await isAdminChat(env, chatId);
    if (command) {
        await handleCommand(env, message, command, admin);
        return;
    }
    if (admin && message.reply_to_message && textValue) {
        await adminReplyByMessage(env, message);
        return;
    }
    if (admin) {
        if (textValue) {
            await tgSendMessage(env, chatId, "管理员普通消息不会自动转发。请回复 Bot 转发的用户消息，或使用 /reply <user_id> <内容>。");
        }
        return;
    }
    if (message.chat.type !== "private") return;
    await relayUserMessage(env, message);
}


async function controlMode(env) {
    const fromDb = await getSetting(env, "control_mode", "");
    const raw = String(fromDb || env.CONTROL_MODE || DEFAULT_CONTROL_MODE).trim().toLowerCase();
    return ["web", "topic", "both"].includes(raw) ? raw : DEFAULT_CONTROL_MODE;
}

async function topicGroupId(env) {
    const fromDb = await getSetting(env, "topic_group_id", "");
    const raw = String(fromDb || env.TOPIC_GROUP_ID || "").trim();
    const value = Number(raw);
    return Number.isFinite(value) && value !== 0 ? value : null;
}

async function topicCreatePolicy(env) {
    const fromDb = await getSetting(env, "topic_create_policy", "");
    const raw = String(fromDb || env.TOPIC_CREATE_POLICY || DEFAULT_TOPIC_CREATE_POLICY).trim().toLowerCase();
    return ["after_verify", "first_message"].includes(raw) ? raw : DEFAULT_TOPIC_CREATE_POLICY;
}

async function topicSyncWebReplies(env) {
    const raw = await getSetting(env, "topic_sync_web_replies", env.TOPIC_SYNC_WEB_REPLIES ?? "true");
    return String(raw || "true").toLowerCase() !== "false";
}

async function webRelayEnabled(env) {
    return (await controlMode(env)) !== "topic";
}

async function topicEnabled(env) {
    const mode = await controlMode(env);
    return (mode === "topic" || mode === "both") && Boolean(await topicGroupId(env));
}

async function isTopicGroupMessage(env, message) {
    const groupId = await topicGroupId(env);
    if (!groupId) return false;
    const mode = await controlMode(env);
    return (mode === "topic" || mode === "both") && Number(message.chat?.id) === groupId;
}

function isForwardableMessage(message) {
    if (!message) return false;
    if (message.text?.startsWith("/")) return false;
    if (message.new_chat_members || message.left_chat_member || message.group_chat_created || message.forum_topic_created || message.forum_topic_edited || message.forum_topic_closed || message.forum_topic_reopened) return false;
    return true;
}

async function handleTopicGroupMessage(env, message, command) {
    if (command?.name === "admin") {
        await handleTopicAdminCommand(env, message);
        return;
    }
    if (command) return;
    if (!message.message_thread_id || message.from?.is_bot || !isForwardableMessage(message)) return;
    if (!(await isAdminChat(env, message.from?.id))) return;
    const groupId = await topicGroupId(env);
    const user = await getUserByTopicThreadId(env, groupId, Number(message.message_thread_id));
    if (!user || user.blocked) return;
    try {
        const sent = await tgCall(env, "copyMessage", {
            chat_id: Number(user.user_id),
            from_chat_id: groupId,
            message_id: Number(message.message_id),
        });
        await createOutboxMessage(env, Number(user.user_id), messageText(message) || "(话题媒体消息)", "topic", sent.result.message_id, {
            topic_chat_id: groupId,
            topic_thread_id: Number(message.message_thread_id),
            topic_message_id: Number(message.message_id),
            admin_chat_id: Number(message.from.id),
            admin_message_id: Number(message.message_id),
        });
    } catch (error) {
        await logEvent(env, "error", "failed to relay topic message", { threadId: message.message_thread_id, error: String(error?.message || error) });
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(message.message_thread_id),
            text: `回复用户失败：${String(error?.message || error).slice(0, 400)}`,
        }).catch(() => {});
    }
}

async function handleTopicAdminCommand(env, message) {
    const groupId = await topicGroupId(env);
    if (!groupId || Number(message.chat?.id) !== groupId || !message.message_thread_id) return;
    if (!(await isAdminChat(env, message.from?.id))) {
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(message.message_thread_id),
            text: "无权限。",
        }).catch(() => {});
        return;
    }
    const user = await getUserByTopicThreadId(env, groupId, Number(message.message_thread_id));
    if (!user) {
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(message.message_thread_id),
            text: "当前话题没有绑定用户。",
        });
        return;
    }
    await tgCall(env, "sendMessage", {
        chat_id: groupId,
        message_thread_id: Number(message.message_thread_id),
        text: topicAdminText(user),
        reply_markup: topicAdminKeyboard(user),
    });
}

function topicAdminText(user) {
    return [
        "用户管理",
        `用户ID：${user.user_id}`,
        `昵称：${user.full_name || "-"}`,
        `用户名：${user.username ? `@${user.username}` : "无"}`,
        `状态：${user.blocked ? "已封禁" : user.verified ? "已验证" : "未验证"}`,
        `话题：${user.topic_thread_id || "无"}`,
        `备注：${user.note || "无"}`,
    ].join("\n");
}

function topicAdminKeyboard(user) {
    const verifyButton = user.verified
        ? { text: "取消验证", callback_data: `topicadmin:cancel:${user.user_id}` }
        : { text: "通过验证", callback_data: `topicadmin:approve:${user.user_id}` };
    const blockButton = user.blocked
        ? { text: "取消拉黑", callback_data: `topicadmin:unban:${user.user_id}` }
        : { text: "拉黑", callback_data: `topicadmin:ban:${user.user_id}` };
    return {
        inline_keyboard: [
            [verifyButton],
            [blockButton],
            [{ text: "获取用户信息", callback_data: `topicadmin:who:${user.user_id}` }],
            [{ text: "重建话题", callback_data: `topicadmin:rebuild:${user.user_id}` }],
        ],
    };
}

async function handleTopicAdminCallback(env, query) {
    const data = String(query.data || "");
    const [, action, rawUserId] = data.split(":");
    const userId = Number(rawUserId);
    const adminId = Number(query.from?.id || 0);
    if (!(await isAdminChat(env, adminId))) {
        await answerCallbackQuery(env, query.id, "无权限");
        return;
    }
    if (!Number.isFinite(userId)) {
        await answerCallbackQuery(env, query.id, "参数错误");
        return;
    }
    const groupId = await topicGroupId(env);
    const user = await getUser(env, userId);
    if (!user) {
        await answerCallbackQuery(env, query.id, "找不到用户");
        return;
    }
    if (action === "approve") {
        await setUserVerified(env, userId, true, "verified");
        await tgSendMessage(env, userId, "管理员已为你通过验证。你现在可以继续聊天。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已通过验证");
    } else if (action === "cancel") {
        await setUserVerified(env, userId, false, "cancelled");
        await tgSendMessage(env, userId, "管理员已取消你的验证状态，请重新完成验证后继续聊天。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已取消验证");
    } else if (action === "ban") {
        await setBlock(env, userId, true);
        await tgSendMessage(env, userId, "管理员已将你加入黑名单，后续消息不会被转发。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已拉黑");
    } else if (action === "unban") {
        await setBlock(env, userId, false);
        await tgSendMessage(env, userId, "管理员已取消你的拉黑状态。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已取消拉黑");
    } else if (action === "who") {
        const threadId = Number(query.message?.message_thread_id || user.topic_thread_id || 0);
        await answerCallbackQuery(env, query.id, "已发送用户信息");
        if (groupId && threadId) {
            await tgCall(env, "sendMessage", { chat_id: groupId, message_thread_id: threadId, text: formatUserInfo(await getUser(env, userId)) });
        }
    } else if (action === "rebuild") {
        await ensureUserTopic(env, userId, { forceNew: true, reason: "topicadmin:rebuild" });
        await answerCallbackQuery(env, query.id, "已重建话题");
    } else {
        await answerCallbackQuery(env, query.id, "未知操作");
        return;
    }
    if (groupId && query.message?.message_thread_id && action !== "rebuild") {
        const latest = await getUser(env, userId);
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(query.message.message_thread_id),
            text: topicAdminText(latest),
            reply_markup: topicAdminKeyboard(latest),
        }).catch(() => {});
    }
}

async function relayInboxByMode(env, row, originalMessage = null) {
    const errors = [];
    let delivered = false;
    const mode = await controlMode(env);
    const topicReady = await topicEnabled(env);
    if (mode === "topic" && !topicReady) errors.push("topic: 未配置 TOPIC_GROUP_ID 或话题模式未启用");
    if (await webRelayEnabled(env)) {
        try {
            await relayStoredInboxToAdmins(env, row, originalMessage);
            delivered = true;
        } catch (error) {
            errors.push(`web: ${String(error?.message || error)}`);
        }
    }
    if (topicReady) {
        try {
            await relayInboxToTopic(env, row);
            delivered = true;
        } catch (error) {
            errors.push(`topic: ${String(error?.message || error)}`);
        }
    }
    if (!delivered && errors.length) throw new Error(errors.join(" | "));
    if (errors.length) await logEvent(env, "warn", "partial relay failure", { inboxId: row.id, errors });
}

async function relayInboxToTopic(env, row) {
    const userId = Number(row.user_id);
    let topic = await ensureUserTopic(env, userId, { reason: "relay" });
    if (!topic) return false;
    try {
        const copy = await copyUserMessageToTopic(env, row, topic);
        await markInboxTopicForwarded(env, row.id, topic, copy.message_id);
        return true;
    } catch (error) {
        if (!isMessageThreadNotFoundError(error)) throw error;
        topic = await ensureUserTopic(env, userId, { forceNew: true, reason: "thread-not-found" });
        const copy = await copyUserMessageToTopic(env, row, topic);
        await markInboxTopicForwarded(env, row.id, topic, copy.message_id);
        return true;
    }
}

async function copyUserMessageToTopic(env, row, topic) {
    if (row.user_message_id) {
        const result = await tgCall(env, "copyMessage", {
            chat_id: topic.chatId,
            from_chat_id: Number(row.user_id),
            message_id: Number(row.user_message_id),
            message_thread_id: topic.threadId,
        });
        return result.result;
    }
    const result = await tgCall(env, "sendMessage", {
        chat_id: topic.chatId,
        message_thread_id: topic.threadId,
        text: row.text || "(非文本/媒体消息)",
    });
    return result.result;
}

async function syncOutboxToTopic(env, userId, textValue, source, outboxId) {
    if (!(await topicEnabled(env)) || !(await topicSyncWebReplies(env))) return;
    let topic = await ensureUserTopic(env, userId, { reason: "outbox-sync" });
    if (!topic) return;
    const label = source === "web:inbox" ? "Web 后台回复" : "管理员回复";
    const payload = `[${label}]\n${textValue || "(空消息)"}`;
    try {
        const sent = await tgCall(env, "sendMessage", {
            chat_id: topic.chatId,
            message_thread_id: topic.threadId,
            text: payload.slice(0, 3900),
        });
        await updateInboxTopicMeta(env, outboxId, topic, sent.result.message_id, null, null);
    } catch (error) {
        if (!isMessageThreadNotFoundError(error)) throw error;
        topic = await ensureUserTopic(env, userId, { forceNew: true, reason: "outbox-thread-not-found" });
        const sent = await tgCall(env, "sendMessage", {
            chat_id: topic.chatId,
            message_thread_id: topic.threadId,
            text: payload.slice(0, 3900),
        });
        await updateInboxTopicMeta(env, outboxId, topic, sent.result.message_id, null, null);
    }
}

async function ensureUserTopic(env, userId, options = {}) {
    if (!(await topicEnabled(env))) return null;
    const groupId = await topicGroupId(env);
    const user = await getUser(env, userId);
    if (!user) throw new Error(`User ${userId} not found`);
    if (user.topic_thread_id && !options.forceNew) {
        return { chatId: Number(user.topic_chat_id || groupId), threadId: Number(user.topic_thread_id), title: user.topic_title || "" };
    }
    const title = topicTitleForUser(user);
    try {
        const topic = await tgCall(env, "createForumTopic", {
            chat_id: groupId,
            name: title,
        });
        const threadId = Number(topic.result.message_thread_id);
        await setUserTopic(env, userId, groupId, threadId, title, "active", "");
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: threadId,
            text: topicIntroText({ ...user, topic_thread_id: threadId }),
            parse_mode: "HTML",
            disable_web_page_preview: true,
        }).catch((error) => logEvent(env, "warn", "failed to send topic intro", { userId, error: String(error?.message || error) }));
        return { chatId: groupId, threadId, title };
    } catch (error) {
        await setUserTopicError(env, userId, String(error?.message || error));
        throw error;
    }
}

function topicTitleForUser(user) {
    const name = String(user.full_name || user.username || user.user_id || "User").replace(/[\r\n]+/g, " ").trim();
    const suffix = user.username ? `@${user.username}` : String(user.user_id);
    return `${name} ${suffix}`.slice(0, 120);
}

function topicIntroText(user) {
    return [
        "用户话题已创建",
        `用户 ID：<code>${h(user.user_id)}</code>`,
        `昵称：${h(user.full_name || "-")}`,
        `用户名：${user.username ? `@${h(user.username)}` : "无"}`,
        `语言：${h(user.language_code || "-")}`,
        `状态：${user.blocked ? "已封禁" : user.verified ? "已验证" : "未验证"}`,
    ].join("\n");
}

function topicVerificationText(info) {
    return [
        "本次验证信息",
        `HTTP IP：${info.httpIp || "-"}`,
        `公网 IPv4：${info.httpIpv4 || "-"}`,
        `公网 IPv6：${info.httpIpv6 || "-"}`,
        `WebRTC IPv4：${info.webrtcIpv4 || "-"}`,
        `WebRTC IPv6：${info.webrtcIpv6 || "-"}`,
        `UDP 状态：${info.udpStatus || "-"}`,
        `ASN：${info.asn || "-"}`,
        `运营商：${info.asOrganization || "-"}`,
        `国家/地区：${info.country || "-"}`,
        `设备系统：${info.deviceOs || "-"}`,
    ].join("\n");
}

async function completeTopicVerification(env, userId, info) {
    if (!(await topicEnabled(env))) return;
    if ((await topicCreatePolicy(env)) !== "after_verify") return;
    try {
        const topic = await ensureUserTopic(env, userId, { reason: "verify" });
        if (!topic) return;
        await tgCall(env, "sendMessage", {
            chat_id: topic.chatId,
            message_thread_id: topic.threadId,
            text: topicVerificationText(info),
            disable_web_page_preview: true,
        });
    } catch (error) {
        await logEvent(env, "error", "failed to complete topic verification", { userId, error: String(error?.message || error) });
    }
}

async function setUserTopic(env, userId, chatId, threadId, title, status, lastError = "") {
    const ts = nowIso();
    await env.DB.prepare(`UPDATE users SET topic_chat_id=?, topic_thread_id=?, topic_title=?, topic_status=?, topic_created_at=?, topic_updated_at=?, topic_last_error=?, updated_at=? WHERE user_id=?`)
        .bind(chatId, threadId, title || "", status || "active", ts, ts, String(lastError || "").slice(0, 1000), ts, userId)
        .run();
}

async function setUserTopicError(env, userId, error) {
    const ts = nowIso();
    await env.DB.prepare("UPDATE users SET topic_status='error', topic_last_error=?, topic_updated_at=?, updated_at=? WHERE user_id=?")
        .bind(String(error || "").slice(0, 1000), ts, ts, userId)
        .run();
}

async function clearUserTopic(env, userId) {
    const ts = nowIso();
    await env.DB.prepare("UPDATE users SET topic_chat_id=NULL, topic_thread_id=NULL, topic_title='', topic_status='unbound', topic_updated_at=?, topic_last_error='', updated_at=? WHERE user_id=?")
        .bind(ts, ts, userId)
        .run();
}

async function getUserByTopicThreadId(env, chatId, threadId) {
    return env.DB.prepare("SELECT * FROM users WHERE topic_chat_id=? AND topic_thread_id=?")
        .bind(Number(chatId), Number(threadId))
        .first();
}

function isMessageThreadNotFoundError(error) {
    return String(error?.message || error).toLowerCase().includes("message thread not found");
}

function parseCommand(textValue) {
    const text = String(textValue || "").trim();
    if (!text.startsWith("/")) return null;
    const first = text.split(/\s+/, 1)[0];
    return {
        name: first.slice(1).split("@")[0].toLowerCase(),
        args: text.slice(first.length).trim(),
    };
}

async function handleCommand(env, message, command, isAdmin) {
    const chatId = Number(message.chat.id);
    if (command.name === "start") {
        const user = message.from || {};
        await upsertUser(env, user);
        if (!(await isVerified(env, user.id))) {
            await sendVerificationPrompt(env, chatId, user, "请先完成验证后再开始聊天。验证通过前，你发送的消息不会被转发。");
            return;
        }
        const welcome = await getSetting(env, "welcome_message", "已连接机器人后台。你的消息会转交给管理员。");
        await tgSendMessage(env, chatId, `${welcome}\n\n当前状态：已验证，可以开始聊天。`);
        return;
    }
    if (command.name === "verify") {
        await upsertUser(env, message.from || {});
        await sendVerificationPrompt(env, chatId, message.from || {}, "请打开验证页面完成 Cloudflare 验证。");
        return;
    }
    if (!isAdmin) {
        await tgSendMessage(env, chatId, "该命令仅管理员可用。");
        return;
    }
    try {
        if (command.name === "reply") {
            const [uid, text] = parseUserIdAndText(command.args);
            const sent = await sendTextToUser(env, uid, text, "tg:reply");
            await tgSendMessage(env, chatId, `已发送给用户 ${uid}，message_id=${sent.message_id}`);
        } else if (command.name === "block") {
            const uid = parseUserId(command.args);
            await setBlock(env, uid, true);
            await tgSendMessage(env, chatId, `已封禁用户 ${uid}`);
        } else if (command.name === "unblock") {
            const uid = parseUserId(command.args);
            await setBlock(env, uid, false);
            await tgSendMessage(env, chatId, `已解封用户 ${uid}`);
        } else if (command.name === "note") {
            const [uid, note] = parseUserIdAndText(command.args);
            await env.DB.prepare("UPDATE users SET note=?, updated_at=? WHERE user_id=?").bind(note, nowIso(), uid).run();
            await tgSendMessage(env, chatId, `已更新用户 ${uid} 备注`);
        } else if (command.name === "who") {
            const uid = parseUserId(command.args);
            const row = await getUser(env, uid);
            await tgSendMessage(env, chatId, row ? formatUserInfo(row) : `找不到用户 ${uid}`);
        } else if (command.name === "spamwords") {
            const words = await getSpamKeywords(env);
            await tgSendMessage(env, chatId, words.length ? `广告关键词：\n${words.map((w) => `- ${w}`).join("\n")}` : "暂无广告关键词");
        } else if (command.name === "spamadd") {
            const word = command.args.trim();
            if (!word) throw new Error("用法：/spamadd 关键词");
            await env.DB.prepare("INSERT OR IGNORE INTO spam_keywords(keyword, created_at) VALUES(?, ?)").bind(word, nowIso()).run();
            await tgSendMessage(env, chatId, `已添加广告关键词：${word}`);
        } else if (command.name === "spamdel") {
            const word = command.args.trim();
            if (!word) throw new Error("用法：/spamdel 关键词");
            await env.DB.prepare("DELETE FROM spam_keywords WHERE keyword=?").bind(word).run();
            await tgSendMessage(env, chatId, `已删除广告关键词：${word}`);
        } else if (command.name === "verifylink") {
            const uid = parseUserId(command.args);
            const row = await getUser(env, uid);
            const link = await createVerificationLink(env, row || { user_id: uid, id: uid, full_name: String(uid) }, uid);
            await tgSendMessage(env, chatId, link || "未配置 PUBLIC_BASE_URL。");
        } else {
            await tgSendMessage(env, chatId, `管理员命令帮助

/admin — 显示本帮助
/reply <用户ID> <内容> — 向指定用户发送消息
/block <用户ID> — 封禁用户，阻止其继续发送消息
/unblock <用户ID> — 解除用户封禁
/note <用户ID> <备注> — 添加或更新后台用户备注
/who <用户ID> — 查看用户资料、验证和封禁状态
/spamwords — 查看全部广告拦截关键词
/spamadd <关键词> — 添加一个广告拦截关键词
/spamdel <关键词> — 删除一个广告拦截关键词
/verifylink <用户ID> — 为指定用户生成新的验证链接
/verify — 为当前账号生成新的验证链接
/start — 查看当前连接和验证状态`);
        }
    } catch (error) {
        await tgSendMessage(env, chatId, `命令执行失败：${String(error.message || error)}`);
    }
}

function parseUserId(args) {
    const first = String(args || "").trim().split(/\s+/, 1)[0];
    if (!/^-?\d+$/.test(first)) throw new Error("缺少 user_id");
    return Number(first);
}

function parseUserIdAndText(args) {
    const parts = String(args || "").trim().split(/\s+/);
    if (parts.length < 2 || !/^-?\d+$/.test(parts[0])) throw new Error("格式应为：<user_id> <内容>");
    return [Number(parts[0]), String(args).trim().slice(parts[0].length).trim()];
}

function formatUserInfo(row) {
    return `用户信息\nuser_id: ${row.user_id}\nusername: @${row.username || ""}\nfull_name: ${row.full_name || ""}\nblocked: ${Boolean(row.blocked)}\nverified: ${Boolean(row.verified)}\nstatus: ${row.verification_status || "-"}\nnote: ${row.note || ""}\nHTTP IPv4: ${row.last_http_ipv4 || "-"}\nHTTP IPv6: ${row.last_http_ipv6 || "-"}\nUDP IPv4: ${row.last_webrtc_ipv4 || "-"}\nUDP IPv6: ${row.last_webrtc_ipv6 || "-"}\nASN: ${row.last_asn || "-"}\ntopic_thread_id: ${row.topic_thread_id || "-"}\ntopic_status: ${row.topic_status || "-"}\nupdated_at: ${row.updated_at}`;
}

async function relayUserMessage(env, message) {
    const user = message.from || {};
    await upsertUser(env, user);
    if (await isBlocked(env, user.id)) {
        await tgSendMessage(env, message.chat.id, "你当前无法发送消息。");
        return;
    }
    if (!(await isVerified(env, user.id))) {
        await sendVerificationPrompt(env, message.chat.id, user, "请先完成验证后再开始聊天。验证通过前，你发送的消息不会被转发。");
        return;
    }
    if (await rateLimited(env, user.id)) {
        await tgSendMessage(env, message.chat.id, "发送太快了，请稍后再试。");
        return;
    }
    const inboxId = await createInboxMessage(env, message);
    const textValue = messageText(message);
    const hits = await spamHits(env, textValue);
    const autoBlock = await getSetting(env, "spam_auto_block", "true");
    if (hits.length && autoBlock !== "false") {
        await setBlock(env, user.id, true);
        await markInboxError(env, inboxId, `spam: ${hits.join(", ")}`);
        await notifyAdmins(env, `[垃圾消息已拉黑]\nuser_id: <code>${user.id}</code>\n命中：${h(hits.join(", "))}\n内容：${h(textValue.slice(0, 300))}`);
        await tgSendMessage(env, message.chat.id, "消息已被系统拦截。");
        return;
    }
    const row = await getInboxMessage(env, inboxId);
    try {
        await relayInboxByMode(env, row, message);
        await tgSendMessage(env, message.chat.id, "已收到。");
    } catch (error) {
        await markInboxError(env, inboxId, String(error));
        await logEvent(env, "error", "failed to relay user message", { inboxId, error: String(error) });
        await tgSendMessage(env, message.chat.id, "已收到消息，但转发管理员暂时失败。");
    }
}

async function relayStoredInboxToAdmins(env, row, originalMessage = null) {
    const ids = await adminChatIds(env);
    if (!ids.length) throw new Error("未配置管理员 ADMIN_CHAT_IDS");
    const user = await getUser(env, Number(row.user_id));
    const note = user?.note || "";
    let firstHeaderId = null;
    let firstCopyId = null;
    let sentAny = false;
    for (const adminId of ids) {
        const header = `[用户消息 #${row.id}]\nuser_id: <code>${row.user_id}</code>\nname: ${h(row.full_name || "")}\nusername: @${h(row.username || "")}\nnote: ${h(note)}\ntime: ${h(nowIso())}`;
        const sent = await tgCall(env, "sendMessage", {
            chat_id: adminId,
            text: header,
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
        await saveMessageMap(env, adminId, sent.result.message_id, row.user_id, row.user_message_id);
        firstHeaderId ||= sent.result.message_id;
        try {
            const copy = await tgCall(env, "copyMessage", {
                chat_id: adminId,
                from_chat_id: row.user_id,
                message_id: row.user_message_id,
                reply_to_message_id: sent.result.message_id,
            });
            await saveMessageMap(env, adminId, copy.result.message_id, row.user_id, row.user_message_id);
            firstCopyId ||= copy.result.message_id;
        } catch (error) {
            const fallback = await tgCall(env, "sendMessage", {
                chat_id: adminId,
                text: row.text || "(非文本/媒体消息，copyMessage 失败)",
                reply_to_message_id: sent.result.message_id,
            });
            await saveMessageMap(env, adminId, fallback.result.message_id, row.user_id, row.user_message_id);
            firstCopyId ||= fallback.result.message_id;
        }
        sentAny = true;
    }
    if (!sentAny) throw new Error("no admin message sent");
    await markInboxForwarded(env, row.id, firstHeaderId, firstCopyId);
}

async function adminReplyByMessage(env, message) {
    const replyId = Number(message.reply_to_message.message_id);
    const adminChatId = Number(message.chat.id);
    const target = await env.DB.prepare("SELECT user_id FROM message_map WHERE admin_chat_id=? AND admin_message_id=?")
        .bind(adminChatId, replyId)
        .first();
    if (!target) return;
    if (await isBlocked(env, Number(target.user_id))) {
        await tgSendMessage(env, adminChatId, `用户 ${target.user_id} 已被封禁。`);
        return;
    }
    const sent = await sendTextToUser(env, Number(target.user_id), message.text, "tg:reply");
    await tgSendMessage(env, adminChatId, `已发送给用户 ${target.user_id}，message_id=${sent.message_id}`);
}

async function sendTextToUser(env, userId, textValue, source) {
    await ensureVerificationSchema(env);
    if (await isBlocked(env, userId)) throw new Error(`用户 ${userId} 已被封禁`);
    const sent = await tgCall(env, "sendMessage", { chat_id: userId, text: textValue });
    const outboxId = await createOutboxMessage(env, userId, textValue, source, sent.result.message_id);
    if (source !== "topic") {
        await syncOutboxToTopic(env, userId, textValue, source, outboxId).catch((error) => logEvent(env, "warn", "failed to sync outbox to topic", { userId, source, error: String(error?.message || error) }));
    }
    return sent.result;
}

async function notifyAdmins(env, textValue, extraPayload = {}) {
    if (!(await webRelayEnabled(env))) return;
    const ids = await adminChatIds(env);
    for (const id of ids) {
        try {
            await tgCall(env, "sendMessage", { chat_id: id, text: textValue, parse_mode: "HTML", disable_web_page_preview: true, ...extraPayload });
        } catch (error) {
            await logEvent(env, "error", "failed to notify admin", { id, error: String(error) });
        }
    }
}

async function tgSendMessage(env, chatId, textValue) {
    return tgCall(env, "sendMessage", { chat_id: chatId, text: textValue });
}

async function tgCall(env, method, payload) {
    if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
    }
    return data;
}

async function adminChatIds(env) {
    const fromDb = await getSetting(env, "admin_chat_ids", "");
    const raw = fromDb || env.ADMIN_CHAT_IDS || "";
    return [...new Set(String(raw).split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite))].slice(0, 3);
}

async function isAdminChat(env, chatId) {
    return (await adminChatIds(env)).includes(Number(chatId));
}

async function upsertUser(env, from) {
    const userId = Number(from.id);
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ") || String(userId);
    const username = from.username || "";
    const languageCode = from.language_code || "";
    const ts = nowIso();
    await env.DB.prepare(`INSERT INTO users(user_id, username, full_name, language_code, created_at, updated_at)
VALUES(?,?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, language_code=excluded.language_code, updated_at=excluded.updated_at`)
        .bind(userId, username, fullName, languageCode, ts, ts)
        .run();
}

async function getUser(env, userId) {
    return env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(userId).first();
}

async function isBlocked(env, userId) {
    const row = await getUser(env, userId);
    return Boolean(row?.blocked);
}

async function setBlock(env, userId, blocked) {
    await env.DB.prepare("UPDATE users SET blocked=?, updated_at=? WHERE user_id=?").bind(blocked ? 1 : 0, nowIso(), userId).run();
}

async function isVerified(env, userId) {
    const row = await getUser(env, userId);
    return Boolean(row?.verified);
}

async function setUserVerified(env, userId, verified, status = null) {
    await ensureVerificationSchema(env);
    await env.DB.prepare("UPDATE users SET verified=?, verification_status=?, updated_at=? WHERE user_id=?")
        .bind(verified ? 1 : 0, status || (verified ? "verified" : "pending"), nowIso(), userId)
        .run();
}

function getMessageType(message) {
    if (message.text) return "text";
    if (message.photo) return "photo";
    if (message.video) return "video";
    if (message.document) return "document";
    if (message.audio) return "audio";
    if (message.voice) return "voice";
    if (message.sticker) return "sticker";
    return "message";
}

function messageText(message) {
    return String(message.text || message.caption || "");
}

async function createInboxMessage(env, message) {
    const from = message.from || {};
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id || "");
    const result = await env.DB.prepare(`INSERT INTO inbox_messages(user_id, username, full_name, user_message_id, direction, source, message_type, text, forwarded, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .bind(Number(from.id), from.username || "", fullName, Number(message.message_id), "in", "user", getMessageType(message), messageText(message), 0, nowIso())
        .run();
    return result.meta.last_row_id;
}

async function createOutboxMessage(env, userId, textValue, source, messageId, meta = {}) {
    await ensureVerificationSchema(env);
    const user = await getUser(env, userId);
    const result = await env.DB.prepare(`INSERT INTO inbox_messages(user_id, username, full_name, user_message_id, direction, source, message_type, text, forwarded, created_at, forwarded_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, user?.username || "", user?.full_name || String(userId), messageId || null, "out", source, meta.message_type || "text", textValue, 1, nowIso(), nowIso())
        .run();
    const id = result.meta.last_row_id;
    if (meta.topic_chat_id || meta.topic_thread_id || meta.topic_message_id || meta.admin_chat_id || meta.admin_message_id) {
        await updateInboxTopicMeta(env, id, {
            chatId: meta.topic_chat_id || null,
            threadId: meta.topic_thread_id || null,
        }, meta.topic_message_id || null, meta.admin_chat_id || null, meta.admin_message_id || null);
    }
    return id;
}

async function getInboxMessage(env, id) {
    return env.DB.prepare("SELECT * FROM inbox_messages WHERE id=?").bind(id).first();
}

async function markInboxForwarded(env, id, headerId, copyId) {
    await env.DB.prepare("UPDATE inbox_messages SET forwarded=1, admin_header_message_id=?, admin_copy_message_id=?, forwarded_at=?, error='' WHERE id=?")
        .bind(headerId || null, copyId || null, nowIso(), id)
        .run();
}

async function markInboxError(env, id, error) {
    await env.DB.prepare("UPDATE inbox_messages SET error=? WHERE id=?").bind(String(error).slice(0, 1000), id).run();
}

async function saveMessageMap(env, adminChatId, adminMessageId, userId, userMessageId) {
    await env.DB.prepare("INSERT OR REPLACE INTO message_map(admin_chat_id, admin_message_id, user_id, user_message_id, created_at) VALUES(?,?,?,?,?)")
        .bind(Number(adminChatId), Number(adminMessageId), Number(userId), userMessageId ? Number(userMessageId) : null, nowIso())
        .run();
}

async function updateInboxTopicMeta(env, id, topic, topicMessageId = null, adminChatId = null, adminMessageId = null) {
    if (!id) return;
    await ensureVerificationSchema(env);
    await env.DB.prepare("UPDATE inbox_messages SET topic_chat_id=?, topic_thread_id=?, topic_message_id=?, admin_chat_id=?, admin_message_id=? WHERE id=?")
        .bind(topic?.chatId || null, topic?.threadId || null, topicMessageId || null, adminChatId || null, adminMessageId || null, id)
        .run();
}

async function markInboxTopicForwarded(env, id, topic, topicMessageId) {
    await ensureVerificationSchema(env);
    await env.DB.prepare("UPDATE inbox_messages SET forwarded=1, topic_chat_id=?, topic_thread_id=?, topic_message_id=?, forwarded_at=?, error='' WHERE id=?")
        .bind(topic?.chatId || null, topic?.threadId || null, topicMessageId || null, nowIso(), id)
        .run();
}

async function getSpamKeywords(env) {
    const rows = await env.DB.prepare("SELECT keyword FROM spam_keywords ORDER BY keyword").all();
    return (rows.results || []).map((r) => String(r.keyword));
}

async function spamHits(env, textValue) {
    const textLower = String(textValue || "").toLowerCase();
    if (!textLower) return [];
    const words = await getSpamKeywords(env);
    return words.filter((word) => word && textLower.includes(word.toLowerCase()));
}

async function rateLimited(env, userId) {
    const windowSeconds = Number(await getSetting(env, "rate_window_seconds", "10"));
    const maxMessages = Number(await getSetting(env, "rate_max_messages", "4"));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM rate_events WHERE user_id=? AND ts<?").bind(userId, now - windowSeconds).run();
    await env.DB.prepare("INSERT INTO rate_events(user_id, ts) VALUES(?, ?)").bind(userId, now).run();
    const count = await scalar(env, "SELECT COUNT(*) FROM rate_events WHERE user_id=?", userId);
    return count > maxMessages;
}

async function getSetting(env, key, fallback = "") {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
    return row?.value ?? fallback;
}

async function setSetting(env, key, value) {
    await env.DB.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?,?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .bind(key, String(value ?? ""), nowIso())
        .run();
}

async function scalar(env, sql, ...bindings) {
    const statement = env.DB.prepare(sql);
    const row = await (bindings.length ? statement.bind(...bindings) : statement).first();
    if (!row) return 0;
    return Number(Object.values(row)[0] || 0);
}

async function logEvent(env, level, message, data = {}) {
    try {
        await env.DB.prepare("INSERT INTO event_logs(level, message, data, created_at) VALUES(?,?,?,?)")
            .bind(level, message, JSON.stringify(data).slice(0, 4000), nowIso())
            .run();
    } catch (error) {
        console.error("failed to write log", error);
    }
}

function publicBaseUrl(env, request = null) {
    const configured = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    if (request) {
        const url = new URL(request.url);
        return `${url.protocol}//${url.host}`;
    }
    return "";
}

function verifyLinkForToken(env, token, request = null) {
    const base = publicBaseUrl(env, request);
    if (!base || !token) return "";
    return `${base}/verify/${encodeURIComponent(String(token))}`;
}

async function createVerificationLink(env, from, chatId = null, request = null) {
    await ensureVerificationSchema(env);
    const token = randomToken();
    const userId = Number(from.id ?? from.user_id);
    if (!userId) return "";
    const fullName = from.full_name || [from.first_name, from.last_name].filter(Boolean).join(" ") || String(userId);
    const username = from.username || "";
    const languageCode = from.language_code || "";
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + VERIFY_SESSION_HOURS * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(`INSERT INTO verification_sessions(token, user_id, chat_id, username, full_name, language_code, status, created_at, expires_at)
VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(token, userId, chatId ? Number(chatId) : userId, username, fullName, languageCode, "pending", ts, expiresAt)
        .run();
    await env.DB.prepare(`INSERT INTO users(user_id, username, full_name, language_code, verification_status, verification_token, created_at, updated_at)
VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, language_code=excluded.language_code, verification_status='pending', verification_token=excluded.verification_token, updated_at=excluded.updated_at`)
        .bind(userId, username, fullName, languageCode, "pending", token, ts, ts)
        .run();
    return verifyLinkForToken(env, token, request);
}

async function sendVerificationPrompt(env, chatId, from, textValue) {
    const link = await createVerificationLink(env, from, chatId);
    if (!link) {
        await tgSendMessage(env, chatId, "未配置 PUBLIC_BASE_URL，暂时无法生成验证链接。");
        return;
    }
    await tgCall(env, "sendMessage", {
        chat_id: chatId,
        text: `${textValue}\n\n请优先使用“Telegram 内验证”；如无法打开，再使用“浏览器验证”。验证通过前，你发送的消息不会被转发。`,
        reply_markup: {
            inline_keyboard: [
                [{ text: "Telegram 内验证", web_app: { url: link } }],
                [{ text: "浏览器验证", url: link }],
            ],
        },
        disable_web_page_preview: true,
    });
}

async function getVerificationSession(env, token) {
    return env.DB.prepare("SELECT * FROM verification_sessions WHERE token=?").bind(token).first();
}

async function markVerificationSession(env, token, status) {
    await env.DB.prepare("UPDATE verification_sessions SET status=? WHERE token=?").bind(status, token).run();
}

function randomToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleCallbackQuery(env, query) {
    const data = String(query.data || "");
    if (data.startsWith("topicadmin:")) {
        await handleTopicAdminCallback(env, query);
        return;
    }
    const adminId = Number(query.from?.id || query.message?.chat?.id || 0);
    if (!(await isAdminChat(env, adminId))) {
        await answerCallbackQuery(env, query.id, "无权限");
        return;
    }
    const [action, rawUserId] = data.split(":");
    const userId = Number(rawUserId);
    if (!Number.isFinite(userId)) {
        await answerCallbackQuery(env, query.id, "参数错误");
        return;
    }
    if (action === "unverify") {
        await setUserVerified(env, userId, false, "cancelled");
        await tgSendMessage(env, userId, "你的验证已被管理员取消，请重新完成验证后继续聊天。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已取消验证");
        await tgSendMessage(env, adminId, `已取消用户 ${userId} 的验证状态。`);
        return;
    }
    if (action === "block") {
        await setBlock(env, userId, true);
        await answerCallbackQuery(env, query.id, "已拉黑");
        await tgSendMessage(env, adminId, `已拉黑用户 ${userId}。`);
        return;
    }
    if (action === "who") {
        const row = await getUser(env, userId);
        await answerCallbackQuery(env, query.id, "已发送用户信息");
        await tgSendMessage(env, adminId, row ? formatUserInfo(row) : `找不到用户 ${userId}`);
        return;
    }
    await answerCallbackQuery(env, query.id, "未知操作");
}

async function answerCallbackQuery(env, callbackQueryId, textValue) {
    if (!callbackQueryId) return;
    await tgCall(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: textValue || "OK" });
}

async function notifyVerificationSuccess(env, userId, token, info) {
    const username = info.username ? `@${h(info.username)}` : "无";
    const textValue = `新用户验证通过\n用户 ID：<code>${userId}</code>\n昵称：${h(info.fullName || "-")}\n用户名：${username}\n语言：${h(info.languageCode || "-")}\n\n本次验证信息\n设备系统：${h(info.deviceOs || "-")}\nHTTP IP：<code>${h(info.httpIp || "-")}</code>\nHTTP IP 类型：${h(info.httpIpVersion || "-")}\n公网 IPv4：<code>${h(info.httpIpv4 || "-")}</code>\n公网 IPv6：<code>${h(info.httpIpv6 || "-")}</code>\n公网 ASN：${h(info.asn || "-")}\n运营商：${h(info.asOrganization || "-")}\n国家/地区：${h(info.country || "-")}\nCloudflare 机房：${h(info.colo || "-")}\n\nUDP / WebRTC 信息\nWebRTC IPv4：<code>${h(info.webrtcIpv4 || "-")}</code>\nWebRTC IPv6：<code>${h(info.webrtcIpv6 || "-")}</code>\nUDP 状态：${h(info.udpStatus || "-")}\nCandidate 类型：${h(info.candidateType || "-")}`;
    await notifyAdmins(env, textValue, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "取消验证", callback_data: `unverify:${userId}` }],
                [{ text: "拉黑", callback_data: `block:${userId}` }],
                [{ text: "获取用户名", callback_data: `who:${userId}` }],
            ],
        },
    });
}

function parseClientData(value) {
    const raw = String(value || "").slice(0, 6000);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        return { parse_error: String(error.message || error) };
    }
}

function extractClientNetwork(clientData, httpIp) {
    const probe = clientData?.probe && typeof clientData.probe === "object" ? clientData.probe : {};
    const webrtc = clientData?.webrtc && typeof clientData.webrtc === "object" ? clientData.webrtc : {};
    const httpIps = [httpIp, probe.http_ip, probe.http_ipv4, probe.http_ipv6].filter(Boolean).map(String);
    const httpIpv4 = firstIpByVersion(httpIps, "IPv4");
    const httpIpv6 = firstIpByVersion(httpIps, "IPv6");
    const webrtcIpv4 = cleanIp(webrtc.webrtc_ipv4, "IPv4");
    const webrtcIpv6 = cleanIp(webrtc.webrtc_ipv6, "IPv6");
    const udpStatus = String(webrtc.udp_status || (webrtcIpv4 || webrtcIpv6 ? "success" : "empty")).slice(0, 40);
    return {
        http_ipv4: httpIpv4,
        http_ipv6: httpIpv6,
        webrtc_ipv4: webrtcIpv4,
        webrtc_ipv6: webrtcIpv6,
        webrtc_protocol: String(webrtc.webrtc_protocol || "").slice(0, 20),
        webrtc_candidate_type: String(webrtc.webrtc_candidate_type || "").slice(0, 80),
        udp_status: udpStatus,
    };
}

function firstIpByVersion(values, version) {
    for (const value of values) {
        const ip = cleanIp(value, version);
        if (ip) return ip;
    }
    return "";
}

function cleanIp(value, version = "") {
    const ip = String(value || "").trim();
    if (!ip || ip.length > 80) return "";
    if (version && ipVersion(ip) !== version) return "";
    return /^[0-9a-fA-F:.]+$/.test(ip) ? ip : "";
}

function ipVersion(ip) {
    const value = String(ip || "").trim();
    if (!value) return "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return "IPv4";
    if (value.includes(":")) return "IPv6";
    return "";
}

function requestCfInfo(request) {
    return {
        country: String(request.cf?.country || request.headers.get("CF-IPCountry") || ""),
        colo: String(request.cf?.colo || ""),
        asn: request.cf?.asn ? String(request.cf.asn) : "",
        asOrganization: String(request.cf?.asOrganization || ""),
    };
}

function detectDeviceOs(userAgent, clientData = {}) {
    const ua = String(userAgent || clientData.user_agent || "");
    const platform = String(clientData.platform || "");
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    if (/Windows/i.test(ua) || /Win/i.test(platform)) return "Windows";
    if (/Mac OS|Macintosh/i.test(ua) || /Mac/i.test(platform)) return "macOS";
    if (/Linux/i.test(ua)) return "Linux";
    return platform || "Unknown";
}

async function ensureVerificationSchema(env) {
    if (verificationSchemaReady) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS verification_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        chat_id INTEGER,
        username TEXT DEFAULT '',
        full_name TEXT DEFAULT '',
        language_code TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        http_ip TEXT DEFAULT '',
        http_ip_version TEXT DEFAULT '',
        http_ipv4 TEXT DEFAULT '',
        http_ipv6 TEXT DEFAULT '',
        webrtc_ipv4 TEXT DEFAULT '',
        webrtc_ipv6 TEXT DEFAULT '',
        webrtc_protocol TEXT DEFAULT '',
        webrtc_candidate_type TEXT DEFAULT '',
        udp_status TEXT DEFAULT '',
        asn TEXT DEFAULT '',
        as_organization TEXT DEFAULT '',
        country TEXT DEFAULT '',
        colo TEXT DEFAULT '',
        device_os TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        raw_client_data TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        verified_at TEXT
    )`).run();
    const userColumns = [
        "language_code TEXT DEFAULT ''",
        "verified INTEGER DEFAULT 0",
        "verification_status TEXT DEFAULT 'pending'",
        "verification_token TEXT DEFAULT ''",
        "last_http_ip TEXT DEFAULT ''",
        "last_http_ip_version TEXT DEFAULT ''",
        "last_http_ipv4 TEXT DEFAULT ''",
        "last_http_ipv6 TEXT DEFAULT ''",
        "last_webrtc_ipv4 TEXT DEFAULT ''",
        "last_webrtc_ipv6 TEXT DEFAULT ''",
        "last_udp_status TEXT DEFAULT ''",
        "last_asn TEXT DEFAULT ''",
        "last_as_organization TEXT DEFAULT ''",
        "last_device_os TEXT DEFAULT ''",
        "last_user_agent TEXT DEFAULT ''",
        "topic_chat_id INTEGER",
        "topic_thread_id INTEGER",
        "topic_title TEXT DEFAULT ''",
        "topic_status TEXT DEFAULT ''",
        "topic_created_at TEXT DEFAULT ''",
        "topic_updated_at TEXT DEFAULT ''",
        "topic_last_error TEXT DEFAULT ''",
    ];
    const inboxColumns = [
        "topic_chat_id INTEGER",
        "topic_thread_id INTEGER",
        "topic_message_id INTEGER",
        "admin_chat_id INTEGER",
        "admin_message_id INTEGER",
    ];
    const verificationColumns = [
        "http_ip TEXT DEFAULT ''",
        "http_ip_version TEXT DEFAULT ''",
        "http_ipv4 TEXT DEFAULT ''",
        "http_ipv6 TEXT DEFAULT ''",
        "webrtc_ipv4 TEXT DEFAULT ''",
        "webrtc_ipv6 TEXT DEFAULT ''",
        "webrtc_protocol TEXT DEFAULT ''",
        "webrtc_candidate_type TEXT DEFAULT ''",
        "udp_status TEXT DEFAULT ''",
        "asn TEXT DEFAULT ''",
        "as_organization TEXT DEFAULT ''",
        "device_os TEXT DEFAULT ''",
        "token TEXT DEFAULT ''",
        "raw_client_data TEXT DEFAULT ''",
    ];
    for (const column of userColumns) await addColumnIfMissing(env, "users", column);
    for (const column of inboxColumns) await addColumnIfMissing(env, "inbox_messages", column);
    for (const column of verificationColumns) await addColumnIfMissing(env, "ip_verifications", column);
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status)").run();
    verificationSchemaReady = true;
}

async function addColumnIfMissing(env, table, columnSql) {
    try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run();
    } catch (error) {
        const message = String(error?.message || error).toLowerCase();
        if (!message.includes("duplicate") && !message.includes("exists") && !message.includes("duplicate column")) throw error;
    }
}
