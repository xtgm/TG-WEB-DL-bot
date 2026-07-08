const COOKIE_NAME = "tg_dualbot_session";
const DEFAULT_PANEL_USER = "admin";

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

async function handleRequest(request, env, ctx) {
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
    if (path === "/verify" && method === "GET") {
        return html(verifyPage(request, env));
    }
    if (path === "/verify" && method === "POST") {
        return verifySubmit(request, env);
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
    return Response.redirect(new URL(path, request.url).toString(), status);
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
    const stats = await Promise.all([
        scalar(env, "SELECT COUNT(*) FROM users"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE blocked=1"),
        scalar(env, "SELECT COUNT(*) FROM inbox_messages"),
        scalar(env, "SELECT COUNT(*) FROM ip_verifications WHERE passed=1"),
    ]);
    const base = publicBaseUrl(env, request);
    const body = `<div class="grid">
<div class="card"><div class="muted">用户数</div><div class="metric">${stats[0]}</div></div>
<div class="card"><div class="muted">封禁用户</div><div class="metric">${stats[1]}</div></div>
<div class="card"><div class="muted">消息记录</div><div class="metric">${stats[2]}</div></div>
<div class="card"><div class="muted">CF 验证通过</div><div class="metric">${stats[3]}</div></div>
</div>
<div class="card"><h2>项目状态</h2><p class="muted">当前版本保留 Telegram 私聊双向通信、管理员回复、收件箱、用户管理、备注、封禁、广告拦截、多管理员、Cloudflare Turnstile 验证和 IP 记录。监控、RSS、群监听、AI 摘要、频道媒体、Docker/systemd 已从 Cloudflare 版本移除。</p>
<p><b>公开地址：</b><code>${h(base)}</code></p><p><b>验证页：</b><code>${h(`${base}/verify`)}</code></p></div>`;
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
        await relayStoredInboxToAdmins(env, row);
    } catch (error) {
        await markInboxError(env, id, String(error));
    }
    return redirect("/inbox", request);
}

async function usersPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM users ORDER BY updated_at DESC LIMIT 300").all();
    const bodyRows = (rows.results || []).map((u) => {
        const status = u.blocked ? `<span class="badge red">封禁</span>` : `<span class="badge green">正常</span>`;
        const actionPath = u.blocked ? "unblock" : "block";
        const actionText = u.blocked ? "解封" : "封禁";
        const actionClass = u.blocked ? "ok" : "danger";
        const ip = u.last_verified_ip ? `${h(u.last_verified_ip)}<br><small>${h(u.last_cf_country || "")} · ${h(u.last_verified_at || "")}</small>` : "-";
        return `<tr><td><b>${h(u.full_name || u.user_id)}</b><br><small>${u.user_id} @${h(u.username || "")}</small></td><td>${status}<br><small>${h(u.updated_at)}</small></td><td>${ip}</td><td>${h(u.note || "")}</td><td><form method="post" action="/users/${u.user_id}/note"><input name="note" value="${h(u.note || "")}"><button type="submit">保存备注</button></form><form method="post" action="/users/${u.user_id}/${actionPath}" style="margin-top:8px"><button class="${actionClass}" type="submit">${actionText}</button></form></td></tr>`;
    }).join("");
    return html(layout("用户管理", `<div class="card"><h2>用户管理</h2><p class="muted">展示已私聊过 Bot 的用户、封禁状态、备注和最近一次 CF 验证 IP。</p><table><tr><th>用户</th><th>状态</th><th>验证 IP</th><th>备注</th><th>操作</th></tr>${bodyRows}</table></div>`));
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
    const rows = await env.DB.prepare("SELECT v.*, u.full_name, u.username FROM ip_verifications v LEFT JOIN users u ON u.user_id=v.user_id ORDER BY v.id DESC LIMIT 300").all();
    const bodyRows = (rows.results || []).map((r) => `<tr><td>#${r.id}<br><span class="badge green">通过</span></td><td>${r.user_id ? `<b>${h(r.full_name || r.user_id)}</b><br><small>${r.user_id} @${h(r.username || "")}</small>` : "-"}</td><td><b>${h(r.ip)}</b><br><small>${h(r.country || "")} · ${h(r.colo || "")}</small></td><td>${h(r.user_agent || "")}</td><td>${h(r.created_at)}</td></tr>`).join("");
    return html(layout("CF 验证记录", `<div class="card"><h2>CF 验证记录</h2><p class="muted">访客通过 Cloudflare Turnstile 后会记录真实访问 IP。验证链接可用 <code>/verify?user_id=用户ID</code> 关联到 Telegram 用户。</p><table><tr><th>ID</th><th>用户</th><th>IP</th><th>User-Agent</th><th>时间</th></tr>${bodyRows}</table></div>`));
}

async function settingsPage(request, env) {
    const adminIds = await adminChatIds(env);
    const welcome = await getSetting(env, "welcome_message", "已连接机器人后台。你的消息会转交给管理员。");
    const base = publicBaseUrl(env, request);
    const body = `<div class="card"><h2>后台设置</h2><form method="post">
<label>管理员 Telegram Chat ID（最多 3 个，逗号分隔）</label><input name="admin_chat_ids" value="${h(adminIds.join(","))}">
<label>用户 /start 欢迎语</label><textarea name="welcome_message">${h(welcome)}</textarea>
<div class="grid"><div><label>公开地址</label><input value="${h(base)}" readonly></div><div><label>验证页</label><input value="${h(`${base}/verify`)}" readonly></div></div>
<div class="actions"><button class="primary" type="submit">保存设置</button></div></form></div>
<div class="card"><h2>Cloudflare Secrets 状态</h2>
<table><tr><th>名称</th><th>状态</th><th>说明</th></tr>
${secretRow("BOT_TOKEN", env.BOT_TOKEN, "Telegram Bot Token")}
${secretRow("PANEL_PASSWORD", env.PANEL_PASSWORD, "后台登录密码")}
${secretRow("PANEL_SECRET", env.PANEL_SECRET, "Cookie session secret")}
${secretRow("TELEGRAM_SECRET_TOKEN", env.TELEGRAM_SECRET_TOKEN, "Telegram webhook secret token")}
${secretRow("TURNSTILE_SECRET_KEY", env.TURNSTILE_SECRET_KEY, "Cloudflare Turnstile secret")}
${secretRow("TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY, "Cloudflare Turnstile site key，可放 vars")}
</table></div>`;
    return html(layout("设置", body));
}

function secretRow(name, value, note) {
    return `<tr><td><code>${name}</code></td><td>${value ? '<span class="badge green">已配置</span>' : '<span class="badge red">未配置</span>'}</td><td>${h(note)}</td></tr>`;
}

async function settingsSave(request, env) {
    const form = await request.formData();
    await setSetting(env, "admin_chat_ids", String(form.get("admin_chat_ids") || ""));
    await setSetting(env, "welcome_message", String(form.get("welcome_message") || "").trim());
    return redirect("/settings", request);
}

async function logsPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM event_logs ORDER BY id DESC LIMIT 200").all();
    const bodyRows = (rows.results || []).map((r) => `<tr><td>#${r.id}<br><span class="badge">${h(r.level)}</span></td><td>${h(r.message)}${r.data ? `<pre>${h(r.data)}</pre>` : ""}</td><td>${h(r.created_at)}</td></tr>`).join("");
    return html(layout("日志", `<div class="card"><h2>最近日志</h2><table><tr><th>ID</th><th>内容</th><th>时间</th></tr>${bodyRows}</table></div>`));
}

function verifyPage(request, env, error = "") {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user_id") || "";
    const ip = visitorIp(request);
    if (!env.TURNSTILE_SITE_KEY) {
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF 验证</title>${verifyStyle()}</head><body><main><div class="card"><h1>CF 验证未配置</h1><p>请先配置 <code>TURNSTILE_SITE_KEY</code> 和 <code>TURNSTILE_SECRET_KEY</code>。</p><p class="muted">当前访问 IP：${h(ip || "-")}</p></div></main></body></html>`;
    }
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF 验证</title>${verifyStyle()}<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><main><form class="card" method="post" action="/verify">
<h1>Cloudflare 验证</h1><p class="muted">通过验证后会显示你的访问 IP，并记录到后台。</p>${error ? `<div class="error">${h(error)}</div>` : ""}
<input type="hidden" name="user_id" value="${h(userId)}">
<div class="cf-turnstile" data-sitekey="${h(env.TURNSTILE_SITE_KEY)}"></div>
<button type="submit">提交验证</button><p class="muted">当前连接 IP：${h(ip || "-")}</p></form></main></body></html>`;
}

function verifyStyle() {
    return `<style>body{margin:0;background:#f4f6fb;color:#111827;font-family:system-ui,-apple-system,Segoe UI,sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(480px,100%);background:white;border:1px solid #d8dee9;border-radius:12px;padding:28px;box-shadow:0 18px 50px rgba(15,23,42,.12)}h1{margin:0 0 10px}.muted{color:#64748b;line-height:1.5}.error{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;padding:10px;margin:12px 0}button{margin-top:18px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:800;padding:12px 15px;cursor:pointer}</style>`;
}

async function verifySubmit(request, env) {
    const form = await request.formData();
    const token = String(form.get("cf-turnstile-response") || "");
    const userIdRaw = String(form.get("user_id") || "").trim();
    const ip = visitorIp(request);
    if (!token) return html(verifyPage(request, env, "请先完成人机验证。"), 400);
    if (!env.TURNSTILE_SECRET_KEY) return html(verifyPage(request, env, "Turnstile Secret 未配置。"), 500);

    const verifyForm = new FormData();
    verifyForm.append("secret", env.TURNSTILE_SECRET_KEY);
    verifyForm.append("response", token);
    if (ip) verifyForm.append("remoteip", ip);
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: verifyForm,
    }).then((r) => r.json());
    if (!result.success) {
        await logEvent(env, "warn", "turnstile verification failed", result);
        return html(verifyPage(request, env, "验证失败，请刷新后重试。"), 400);
    }

    const userId = userIdRaw && /^-?\d+$/.test(userIdRaw) ? Number(userIdRaw) : null;
    const country = String(request.cf?.country || request.headers.get("CF-IPCountry") || "");
    const colo = String(request.cf?.colo || "");
    const userAgent = request.headers.get("User-Agent") || "";
    const ts = nowIso();
    await env.DB.prepare("INSERT INTO ip_verifications(user_id, ip, country, colo, user_agent, passed, turnstile_action, created_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(userId, ip || "", country, colo, userAgent.slice(0, 500), 1, String(result.action || ""), ts)
        .run();
    if (userId) {
        await env.DB.prepare("UPDATE users SET last_verified_ip=?, last_verified_at=?, last_cf_country=?, updated_at=? WHERE user_id=?")
            .bind(ip || "", ts, country, ts, userId)
            .run();
    }
    await notifyAdmins(env, `[CF 验证通过]\nuser_id: <code>${userId || "-"}</code>\nIP: <code>${h(ip || "-")}</code>\n国家/地区: ${h(country || "-")}\n机房: ${h(colo || "-")}`);
    const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>验证通过</title>${verifyStyle()}</head><body><main><div class="card"><h1>验证通过</h1><p>你的访问 IP：</p><pre>${h(ip || "-")}</pre><p class="muted">国家/地区：${h(country || "-")}<br>Cloudflare 机房：${h(colo || "-")}<br>时间：${h(ts)}</p></div></main></body></html>`;
    return html(body);
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
    const update = await request.json();
    await handleTelegramUpdate(env, update);
    return json({ ok: true });
}

async function handleTelegramUpdate(env, update) {
    const message = update.message || update.edited_message;
    if (!message || !message.chat) return;
    const chatId = Number(message.chat.id);
    const textValue = message.text || "";
    const admin = await isAdminChat(env, chatId);
    const command = parseCommand(textValue);
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
        const welcome = await getSetting(env, "welcome_message", "已连接机器人后台。你的消息会转交给管理员。");
        const link = verifyLinkForUser(env, user.id);
        await tgSendMessage(env, chatId, `${welcome}${link ? `\n\nCF 验证链接：${link}` : ""}`);
        return;
    }
    if (command.name === "verify") {
        const link = verifyLinkForUser(env, message.from?.id);
        await tgSendMessage(env, chatId, link ? `打开以下链接完成 CF 验证：\n${link}` : "未配置 PUBLIC_BASE_URL，暂时无法生成验证链接。");
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
            const link = verifyLinkForUser(env, uid);
            await tgSendMessage(env, chatId, link || "未配置 PUBLIC_BASE_URL。");
        } else {
            await tgSendMessage(env, chatId, "可用命令：/reply /block /unblock /note /who /spamwords /spamadd /spamdel /verifylink");
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
    return `用户信息\nuser_id: ${row.user_id}\nusername: @${row.username || ""}\nfull_name: ${row.full_name || ""}\nblocked: ${Boolean(row.blocked)}\nnote: ${row.note || ""}\nlast_ip: ${row.last_verified_ip || "-"}\nupdated_at: ${row.updated_at}`;
}

async function relayUserMessage(env, message) {
    const user = message.from || {};
    await upsertUser(env, user);
    if (await isBlocked(env, user.id)) {
        await tgSendMessage(env, message.chat.id, "你当前无法发送消息。");
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
        await relayStoredInboxToAdmins(env, row, message);
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
    if (await isBlocked(env, userId)) throw new Error(`用户 ${userId} 已被封禁`);
    const sent = await tgCall(env, "sendMessage", { chat_id: userId, text: textValue });
    await createOutboxMessage(env, userId, textValue, source, sent.result.message_id);
    return sent.result;
}

async function notifyAdmins(env, textValue) {
    const ids = await adminChatIds(env);
    for (const id of ids) {
        try {
            await tgCall(env, "sendMessage", { chat_id: id, text: textValue, parse_mode: "HTML", disable_web_page_preview: true });
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
    const ts = nowIso();
    await env.DB.prepare(`INSERT INTO users(user_id, username, full_name, created_at, updated_at)
VALUES(?,?,?,?,?)
ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, updated_at=excluded.updated_at`)
        .bind(userId, username, fullName, ts, ts)
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

async function createOutboxMessage(env, userId, textValue, source, messageId) {
    const user = await getUser(env, userId);
    const result = await env.DB.prepare(`INSERT INTO inbox_messages(user_id, username, full_name, user_message_id, direction, source, message_type, text, forwarded, created_at, forwarded_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, user?.username || "", user?.full_name || String(userId), messageId || null, "out", source, "text", textValue, 1, nowIso(), nowIso())
        .run();
    return result.meta.last_row_id;
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

function verifyLinkForUser(env, userId) {
    const base = publicBaseUrl(env);
    if (!base || !userId) return "";
    return `${base}/verify?user_id=${encodeURIComponent(String(userId))}`;
}
