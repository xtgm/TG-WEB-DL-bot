import {
    FINGERPRINT_FONT_CATALOG,
    FINGERPRINT_MIN_EXACT_QUALITY,
    buildFingerprintProfile,
    fingerprintLookupEntries,
    fingerprintProfileDatabaseValues,
    profileFromDatabaseRow,
    scoreFingerprintProfiles,
} from "./fingerprint-v2.js";

const COOKIE_NAME = "tg_dualbot_session";
const DEFAULT_PANEL_USER = "admin";
const VERIFY_SESSION_HOURS = 24;
const VERIFY_PROCESSING_STALE_MS = 2 * 60 * 1000;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_CONTROL_MODE = "web";
const DEFAULT_TOPIC_CREATE_POLICY = "after_verify";
const WEBRTC_IDENTITY_VERSION = "tg-dualbot-webrtc-v1";
const MAX_WEBRTC_LABELS_PER_USER = 5;
const MAX_FINGERPRINT_PROFILES_PER_USER = 3;
const MAX_FINGERPRINT_LABELS_PER_USER = 5;
const MAX_FINGERPRINT_REFERENCES_PER_LABEL = 12;
const MAX_FINGERPRINT_CANDIDATES = 24;
const FP_AUTO_BLOCK_DEFAULT_SCORE = 95;
// 群发：每批人数与批内间隔。批内 40 条 × 500ms = 20 秒发完一批，Cron 每分钟发一批。
// 稳态约 0.7 条/秒，远低于 Telegram 约 30 条/秒的上限；批内留 40 秒余量给网络抖动。
const BROADCAST_BATCH_SIZE = 40;
const BROADCAST_BATCH_INTERVAL_MS = 500;
// 预留给消息头尾的字数，Telegram 单条上限 4096。
const BROADCAST_MAX_CONTENT = 3800;
const USER_WITH_IDENTITY_SELECT = "SELECT u.*, c.label_id AS confirmed_identity_label_id, c.confirmed_at AS identity_confirmed_at, l.label_name AS identity_label_name, l.source_user_id AS identity_label_source_user_id, " +
    "ful.label_id AS fingerprint_confirmed_label_id, ful.weighted_score AS fingerprint_confirmed_score, ful.confirmed_at AS fingerprint_confirmed_at, " +
    "fl.label_name AS fingerprint_label_name, fl.state AS fingerprint_label_state, " +
    "fp.exact_hash AS latest_fingerprint_hash, fp.slot AS latest_fingerprint_slot, fp.quality_score AS latest_fingerprint_quality " +
    "FROM users u LEFT JOIN webrtc_identity_confirmations c ON c.user_id=u.user_id LEFT JOIN webrtc_identity_labels l ON l.id=c.label_id " +
    "LEFT JOIN fingerprint_user_labels_v2 ful ON ful.user_id=u.user_id LEFT JOIN fingerprint_labels_v2 fl ON fl.id=ful.label_id " +
    "LEFT JOIN fingerprint_profiles_v2 fp ON fp.user_id=u.user_id AND fp.slot=(SELECT p2.slot FROM fingerprint_profiles_v2 p2 WHERE p2.user_id=u.user_id ORDER BY p2.last_seen_at DESC LIMIT 1)";

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
    // Cron 只做一件事：推进还没发完的群发任务。没有进行中的任务时直接返回。
    async scheduled(event, env, ctx) {
        await ctx.waitUntil(runPendingBroadcastBatch(env));
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
    if (path === "/moderation" && method === "GET") return moderationPage(request, env);
    if (path === "/rules" && method === "GET") return rulesPage(request, env);
    if (path === "/rules" && method === "POST") return rulesSave(request, env);
    if (path === "/verifications" && method === "GET") return verificationsPage(request, env);
    if (path === "/settings" && method === "GET") return settingsPage(request, env);
    if (path === "/settings" && method === "POST") return settingsSave(request, env);
    if (path === "/logs" && method === "GET") return logsPage(request, env);
    if (path === "/broadcast" && method === "GET") return broadcastPage(request, env);
    if (path === "/broadcast" && method === "POST") return broadcastSave(request, env, ctx);
    if (path === "/broadcast/preview" && method === "POST") return broadcastPreview(request, env);
    if (path === "/broadcast/cancel" && method === "POST") return broadcastCancel(request, env);

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

    match = path.match(/^\/users\/(-?\d+)\/mute$/);
    if (match && method === "POST") return userMuteSet(request, env, Number(match[1]), true);

    match = path.match(/^\/users\/(-?\d+)\/unmute$/);
    if (match && method === "POST") return userMuteSet(request, env, Number(match[1]), false);

    match = path.match(/^\/moderation\/(-?\d+)\/block$/);
    if (match && method === "POST") return userBlockSet(request, env, Number(match[1]), true);

    match = path.match(/^\/moderation\/(-?\d+)\/unblock$/);
    if (match && method === "POST") return userBlockSet(request, env, Number(match[1]), false);

    match = path.match(/^\/moderation\/(-?\d+)\/mute$/);
    if (match && method === "POST") return userMuteSet(request, env, Number(match[1]), true);

    match = path.match(/^\/moderation\/(-?\d+)\/unmute$/);
    if (match && method === "POST") return userMuteSet(request, env, Number(match[1]), false);

    match = path.match(/^\/users\/(-?\d+)\/unverify$/);
    if (match && method === "POST") return userVerifyCancel(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/fingerprints$/);
    if (match && method === "GET") return userFingerprintsPage(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/fingerprints\/mark$/);
    if (match && method === "POST") return userFingerprintMark(request, env, Number(match[1]));

    match = path.match(/^\/fingerprint-labels\/(\d+)\/delete$/);
    if (match && method === "POST") return fingerprintLabelDeleteWeb(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/topic\/create$/);
    if (match && method === "POST") return userTopicCreate(request, env, Number(match[1]), false);

    match = path.match(/^\/users\/(-?\d+)\/topic\/rebuild$/);
    if (match && method === "POST") return userTopicCreate(request, env, Number(match[1]), true);

    match = path.match(/^\/users\/(-?\d+)\/topic\/unbind$/);
    if (match && method === "POST") return userTopicUnbind(request, env, Number(match[1]));

    match = path.match(/^\/users\/(-?\d+)\/delete$/);
    if (match && method === "POST") return userDelete(request, env, Number(match[1]));

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

// 无论有无值都输出同一套两行结构（日期行 + 时间行），保证同列各行高度一致。
function tableTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return '<time class="table-time muted"><span>-</span><small>-</small></time>';
    const separator = raw.indexOf("T");
    const date = separator > 0 ? raw.slice(0, separator) : raw;
    const time = separator > 0 ? raw.slice(separator + 1) : "-";
    return `<time class="table-time" datetime="${h(raw)}"><span>${h(date)}</span><small>${h(time)}</small></time>`;
}

function nowIso() {
    return new Date().toISOString();
}

async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCymruTxt(value) {
    return String(value || "").replace(/^"|"$/g, "").replace(/"\s+"/g, "").split("|").map((part) => part.trim());
}

function cymruOriginHost(ip) {
    const version = ipVersion(ip);
    if (version === "IPv4") return `${ip.split(".").reverse().join(".")}.origin.asn.cymru.com`;
    if (version !== "IPv6") return "";
    const normalized = normalizeIpv6Address(ip);
    if (!normalized) return "";
    return `${normalized.replaceAll(":", "").split("").reverse().join(".")}.origin6.asn.cymru.com`;
}

async function dnsTxtLookup(name, timeoutMs = 1200) {
    if (!name) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
            headers: { Accept: "application/dns-json" },
            signal: controller.signal,
        });
        if (!response.ok) return [];
        const body = await response.json();
        return (Array.isArray(body.Answer) ? body.Answer : []).map((item) => String(item?.data || "")).filter(Boolean);
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

async function lookupWebRtcNetworkMetadata(ip) {
    const normalized = cleanIp(ip);
    if (!normalized || !isPublicWebRtcIp(normalized)) return { ip: normalized, asn: "", isp: "" };
    const cache = globalThis.caches?.default;
    const cacheRequest = new Request(`https://fingerprint-network-cache.invalid/ip/${encodeURIComponent(normalized)}`);
    try {
        const cached = cache ? await cache.match(cacheRequest) : null;
        if (cached) return cached.json();
    } catch {}
    const origin = parseCymruTxt((await dnsTxtLookup(cymruOriginHost(normalized)))[0] || "");
    const asn = String(origin[0] || "").replace(/^AS/i, "");
    let isp = "";
    if (asn) {
        const details = parseCymruTxt((await dnsTxtLookup(`AS${asn}.asn.cymru.com`))[0] || "");
        isp = String(details[4] || "");
    }
    const result = { ip: normalized, asn, isp };
    try {
        if (cache) {
            await cache.put(cacheRequest, new Response(JSON.stringify(result), {
                headers: { "content-type": "application/json", "cache-control": `public, max-age=${asn ? 2592000 : 21600}` },
            }));
        }
    } catch {}
    return result;
}

async function fingerprintNetworkMetadata(request, network, cfInfo) {
    const httpIp = visitorIp(request);
    const primaryWebRtc = [...new Set([network.webrtc_ipv4, network.webrtc_ipv6].filter(Boolean))].slice(0, 2);
    const webrtc = await Promise.all(primaryWebRtc.map(async (ip) => {
        if (cleanIp(ip) === cleanIp(httpIp)) return { ip: cleanIp(ip), asn: String(cfInfo.asn || ""), isp: String(cfInfo.asOrganization || "") };
        return lookupWebRtcNetworkMetadata(ip);
    }));
    return {
        http: { ip: httpIp, asn: String(cfInfo.asn || ""), isp: String(cfInfo.asOrganization || "") },
        webrtc,
    };
}

function normalizeIpv6Address(value) {
    const input = String(value || "").trim().toLowerCase();
    if (!input || input.indexOf("::") !== input.lastIndexOf("::")) return "";
    const parseParts = (text) => {
        if (!text) return [];
        const parts = text.split(":");
        const result = [];
        for (const part of parts) {
            if (!part) return null;
            if (part.includes(".")) {
                const octets = part.split(".").map(Number);
                if (octets.length !== 4 || !octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return null;
                result.push(((octets[0] << 8) | octets[1]).toString(16));
                result.push(((octets[2] << 8) | octets[3]).toString(16));
            } else {
                if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
                result.push(part);
            }
        }
        return result;
    };
    const compressed = input.includes("::");
    const [leftText, rightText = ""] = compressed ? input.split("::") : [input, ""];
    const left = parseParts(leftText);
    const right = parseParts(rightText);
    if (!left || !right) return "";
    const missing = 8 - left.length - right.length;
    if ((compressed && missing < 1) || (!compressed && missing !== 0)) return "";
    const groups = [...left, ...Array(compressed ? missing : 0).fill("0"), ...right];
    if (groups.length !== 8) return "";
    return groups.map((part) => Number.parseInt(part, 16).toString(16).padStart(4, "0")).join(":");
}

function normalizedWebRtcIdentityAddress(value = {}) {
    const rawIpv4 = cleanIp(value.webrtc_ipv4 ?? value.last_webrtc_ipv4, "IPv4");
    if (rawIpv4) {
        const octets = rawIpv4.split(".").map(Number);
        if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
            return { ip: octets.join("."), ipVersion: "IPv4" };
        }
    }
    const rawIpv6 = cleanIp(value.webrtc_ipv6 ?? value.last_webrtc_ipv6, "IPv6");
    const ipv6 = normalizeIpv6Address(rawIpv6);
    if (ipv6) return { ip: ipv6, ipVersion: "IPv6" };
    return { ip: "", ipVersion: "" };
}

function normalizedWebRtcAddressList(value = {}, version) {
    const values = version === "IPv4"
        ? [...(Array.isArray(value.webrtc_ipv4_candidates) ? value.webrtc_ipv4_candidates : []), value.webrtc_ipv4, value.last_webrtc_ipv4]
        : [...(Array.isArray(value.webrtc_ipv6_candidates) ? value.webrtc_ipv6_candidates : []), value.webrtc_ipv6, value.last_webrtc_ipv6];
    const addresses = [];
    const seen = new Set();
    for (const raw of values) {
        const ip = cleanIp(raw, version);
        if (!ip || !isPublicWebRtcIp(ip) || seen.has(ip)) continue;
        seen.add(ip);
        addresses.push(ip);
    }
    return addresses.sort().slice(0, 2);
}

async function buildWebRtcIdentity(value = {}) {
    const address = normalizedWebRtcIdentityAddress(value);
    const ipv4Addresses = normalizedWebRtcAddressList(value, "IPv4");
    const ipv6Addresses = normalizedWebRtcAddressList(value, "IPv6");
    const hashInputs = [
        ["IPv4", ipv4Addresses[0]],
        ["IPv4", ipv4Addresses[1]],
        ["IPv6", ipv6Addresses[0]],
        ["IPv6", ipv6Addresses[1]],
    ];
    const hashes = await Promise.all(hashInputs.map(([version, ip]) => (
        ip ? sha256Hex(JSON.stringify([WEBRTC_IDENTITY_VERSION, version, ip])) : ""
    )));
    const ipv4Hash = hashes[0] ? hashes[0].slice(0, 32) : "";
    const ipv4Hash2 = hashes[1] ? hashes[1].slice(0, 32) : "";
    const ipv6Hash = hashes[2] ? hashes[2].slice(0, 32) : "";
    const ipv6Hash2 = hashes[3] ? hashes[3].slice(0, 32) : "";
    const hash = address.ipVersion === "IPv4" ? ipv4Hash : address.ipVersion === "IPv6" ? ipv6Hash : "";
    return { ...address, hash, ipv4Hash, ipv4Hash2, ipv6Hash, ipv6Hash2 };
}

async function findWebRtcIdentityLabel(env, userId, network) {
    const identity = await buildWebRtcIdentity(network);
    if (!identity.hash) return { ...identity, label: null };
    const label = await env.DB.prepare(
        "SELECT l.id, l.webrtc_hash, l.label_name, l.source_user_id, l.created_by_user_id, l.ip_version, l.created_at, l.updated_at, " +
        "CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS confirmed " +
        "FROM webrtc_identity_labels l " +
        "LEFT JOIN webrtc_identity_confirmations c ON c.user_id=? AND c.label_id=l.id " +
        "WHERE l.webrtc_hash=? LIMIT 1",
    ).bind(Number(userId), identity.hash).first();
    return { ...identity, label: label || null };
}

async function getWebRtcIdentityLabelById(env, labelId) {
    return env.DB.prepare("SELECT * FROM webrtc_identity_labels WHERE id=?").bind(Number(labelId)).first();
}

async function upsertWebRtcIdentityConfirmation(env, user, label, adminId) {
    const expectedIpv4 = String(user?.last_webrtc_ipv4 || "");
    const expectedIpv6 = String(user?.last_webrtc_ipv6 || "");
    const result = await env.DB.prepare(
        "INSERT INTO webrtc_identity_confirmations(user_id, label_id, confirmed_by_user_id, confirmed_at) " +
        "SELECT u.user_id, l.id, ?, ? FROM users u JOIN webrtc_identity_labels l ON l.id=? " +
        "WHERE u.user_id=? AND u.last_webrtc_ipv4=? AND lower(u.last_webrtc_ipv6)=lower(?) " +
        "ON CONFLICT(user_id) DO UPDATE SET label_id=excluded.label_id, confirmed_by_user_id=excluded.confirmed_by_user_id, confirmed_at=excluded.confirmed_at",
    ).bind(Number(adminId), nowIso(), Number(label?.id), Number(user?.user_id), expectedIpv4, expectedIpv6).run();
    return Number(result.meta?.changes || 0) > 0;
}

async function markWebRtcIdentityLabel(env, user, adminId, expectedHash = "") {
    const labelName = String(user?.note || "").trim().slice(0, 80);
    if (!labelName) return { error: "请先使用 /note 或后台备注设置标签，再标记 WebRTC。" };
    const identity = await buildWebRtcIdentity({
        last_webrtc_ipv4: user?.last_webrtc_ipv4,
        last_webrtc_ipv6: user?.last_webrtc_ipv6,
    });
    if (!identity.hash) return { error: "该用户没有可用的 WebRTC 地址，无法标记。" };
    if (expectedHash && (!/^[0-9a-f]{32}$/.test(expectedHash) || identity.hash !== expectedHash)) {
        return { error: "用户 WebRTC 已变化，请使用最新验证通知重新标记。" };
    }
    const existing = await env.DB.prepare("SELECT * FROM webrtc_identity_labels WHERE webrtc_hash=?")
        .bind(identity.hash)
        .first();
    if (existing && Number(existing.source_user_id) !== Number(user.user_id)) {
        return { error: "该 WebRTC 已标记为“" + String(existing.label_name || "").slice(0, 80) + "”，如需更换请先删除旧标签。" };
    }
    let labelId = Number(existing?.id || 0);
    let insertedByThisCall = false;
    if (!existing) {
        const slotRows = await env.DB.prepare("SELECT slot FROM webrtc_identity_labels WHERE source_user_id=?")
            .bind(Number(user.user_id))
            .all();
        const usedSlots = new Set((slotRows.results || []).map((row) => Number(row.slot)));
        let slot = 0;
        for (let candidate = 1; candidate <= MAX_WEBRTC_LABELS_PER_USER; candidate += 1) {
            if (!usedSlots.has(candidate)) {
                slot = candidate;
                break;
            }
        }
        if (!slot) return { error: "该用户最多保存 5 个 WebRTC 标签，请先删除旧标签。" };
        const ts = nowIso();
        const insertResult = await env.DB.prepare(
            "INSERT OR IGNORE INTO webrtc_identity_labels(webrtc_hash, label_name, source_user_id, created_by_user_id, ip_version, slot, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(identity.hash, labelName, Number(user.user_id), Number(adminId), identity.ipVersion, slot, ts, ts).run();
        insertedByThisCall = Number(insertResult.meta?.changes || 0) > 0;
        const inserted = await env.DB.prepare("SELECT * FROM webrtc_identity_labels WHERE webrtc_hash=?").bind(identity.hash).first();
        if (!inserted) return { error: "标签位置刚被其他管理员占用，请重试。" };
        if (Number(inserted.source_user_id) !== Number(user.user_id)) {
            return { error: "该 WebRTC 已标记为“" + String(inserted.label_name || "").slice(0, 80) + "”，如需更换请先删除旧标签。" };
        }
        labelId = Number(inserted.id || 0);
    }
    if (!labelId) return { error: "WebRTC 标签保存失败，请稍后重试。" };
    const savedLabel = await getWebRtcIdentityLabelById(env, labelId);
    if (!savedLabel) return { error: "WebRTC 标签已被其他管理员删除，请重试。" };
    if (!(await upsertWebRtcIdentityConfirmation(env, user, savedLabel, adminId))) {
        if (insertedByThisCall) {
            await env.DB.prepare(
                "DELETE FROM webrtc_identity_labels WHERE id=? AND NOT EXISTS (SELECT 1 FROM webrtc_identity_confirmations WHERE label_id=?)",
            ).bind(labelId, labelId).run();
        }
        return { error: "用户 WebRTC 刚刚发生变化，请使用最新验证通知重新标记。" };
    }
    await env.DB.prepare("UPDATE webrtc_identity_labels SET label_name=?, ip_version=?, updated_at=? WHERE id=? AND source_user_id=?")
        .bind(labelName, identity.ipVersion, nowIso(), labelId, Number(user.user_id))
        .run();
    return { labelId, labelName, identity };
}

async function confirmWebRtcIdentityLabel(env, userId, labelId, adminId) {
    const [user, label] = await Promise.all([
        getUser(env, Number(userId)),
        getWebRtcIdentityLabelById(env, Number(labelId)),
    ]);
    if (!user) return { error: "找不到用户。" };
    if (!label) return { error: "标签已经不存在。" };
    const current = await buildWebRtcIdentity({
        last_webrtc_ipv4: user.last_webrtc_ipv4,
        last_webrtc_ipv6: user.last_webrtc_ipv6,
    });
    if (!current.hash || current.hash !== String(label.webrtc_hash || "")) {
        return { error: "用户当前 WebRTC 已变化，不能使用旧通知确认。" };
    }
    if (!(await upsertWebRtcIdentityConfirmation(env, user, label, adminId))) {
        return { error: "用户 WebRTC 刚刚发生变化，请重新验证后再确认。" };
    }
    return { user, label, identity: current };
}

async function deleteWebRtcIdentityLabel(env, labelId) {
    const label = await getWebRtcIdentityLabelById(env, Number(labelId));
    if (!label) return null;
    await env.DB.batch([
        env.DB.prepare("DELETE FROM webrtc_identity_confirmations WHERE label_id=?").bind(Number(labelId)),
        env.DB.prepare("DELETE FROM webrtc_identity_labels WHERE id=?").bind(Number(labelId)),
    ]);
    return label;
}

async function sendCallbackContextMessage(env, query, textValue, replyMarkup = null) {
    const chatId = Number(query.message?.chat?.id || query.from?.id || 0);
    if (!chatId) return;
    const payload = { chat_id: chatId, text: String(textValue || "") };
    const threadId = Number(query.message?.message_thread_id || 0);
    if (threadId) payload.message_thread_id = threadId;
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await tgCall(env, "sendMessage", payload);
}

async function sendWebRtcIdentityLabels(env, query, userId) {
    const [user, labels] = await Promise.all([
        getUserWithIdentity(env, Number(userId)),
        env.DB.prepare("SELECT id, label_name, ip_version, updated_at FROM webrtc_identity_labels WHERE source_user_id=? ORDER BY updated_at DESC LIMIT 10")
            .bind(Number(userId))
            .all(),
    ]);
    if (!user) {
        await sendCallbackContextMessage(env, query, "找不到用户。");
        return;
    }
    const rows = labels.results || [];
    const lines = [
        "WebRTC 标签",
        "用户 ID：" + user.user_id,
        "当前人工确认标签：" + (user.identity_label_name || "无"),
        "直接标记数量：" + rows.length,
    ];
    for (const row of rows) {
        lines.push("", "#" + row.id + " " + row.label_name, "地址类型：" + row.ip_version, "更新时间：" + row.updated_at);
    }
    const replyMarkup = rows.length ? {
        inline_keyboard: rows.map((row) => [{
            text: "删除 #" + row.id + " " + String(row.label_name || "").slice(0, 20),
            callback_data: "rtcdelete:" + row.id,
        }]),
    } : null;
    await sendCallbackContextMessage(env, query, lines.join("\n"), replyMarkup);
}

function fingerprintProfileColumns(prefix = "") {
    const p = prefix ? `${prefix}.` : "";
    return [
        "algorithm_version", "exact_hash", "device_simhash", "device_feature_mask", "font_bits", "font_minhash",
        "device_vector", "device_vector_mask", "canvas_key", "webgl_key", "audio_key", "webrtc_keys",
        "webrtc_asn_keys", "webrtc_isp_keys", "http_key", "http_asn_key", "http_isp_key", "quality_score", "summary_json",
    ].map((column) => `${p}${column}`).join(", ");
}

function fingerprintProfileBindings(profile) {
    const values = fingerprintProfileDatabaseValues(profile);
    return [
        values.algorithm_version, values.exact_hash, values.device_simhash, values.device_feature_mask,
        values.font_bits, values.font_minhash, values.device_vector, values.device_vector_mask,
        values.canvas_key, values.webgl_key, values.audio_key, values.webrtc_keys,
        values.webrtc_asn_keys, values.webrtc_isp_keys, values.http_key, values.http_asn_key,
        values.http_isp_key, values.quality_score, values.summary_json,
    ];
}

async function latestFingerprintProfile(env, userId) {
    const row = await env.DB.prepare(
        `SELECT user_id, slot, ${fingerprintProfileColumns()}, seen_count, first_seen_at, last_seen_at ` +
        "FROM fingerprint_profiles_v2 WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 1",
    ).bind(Number(userId)).first();
    return row ? { row, profile: profileFromDatabaseRow(row) } : null;
}

async function saveRollingFingerprintProfile(env, userId, profile) {
    const exact = await env.DB.prepare(
        "SELECT slot FROM fingerprint_profiles_v2 WHERE user_id=? AND exact_hash=? LIMIT 1",
    ).bind(Number(userId), profile.exactHash).first();
    const ts = nowIso();
    if (exact) {
        await env.DB.prepare(
            "UPDATE fingerprint_profiles_v2 SET seen_count=seen_count+1, last_seen_at=?, quality_score=?, summary_json=? WHERE user_id=? AND slot=?",
        ).bind(ts, Number(profile.qualityScore || 0), JSON.stringify(profile.summary || {}), Number(userId), Number(exact.slot)).run();
        return latestFingerprintProfile(env, userId);
    }
    const slots = await env.DB.prepare(
        "SELECT slot, last_seen_at FROM fingerprint_profiles_v2 WHERE user_id=? ORDER BY last_seen_at ASC",
    ).bind(Number(userId)).all();
    const rows = slots.results || [];
    const used = new Set(rows.map((row) => Number(row.slot)));
    let slot = 0;
    for (let candidate = 1; candidate <= MAX_FINGERPRINT_PROFILES_PER_USER; candidate += 1) {
        if (!used.has(candidate)) { slot = candidate; break; }
    }
    if (!slot) slot = Number(rows[0]?.slot || 1);
    const columns = fingerprintProfileColumns().split(", ");
    const placeholders = columns.map(() => "?").join(",");
    const updates = columns.map((column) => `${column}=excluded.${column}`).join(",");
    await env.DB.prepare(
        `INSERT INTO fingerprint_profiles_v2(user_id,slot,${columns.join(",")},seen_count,first_seen_at,last_seen_at) ` +
        `VALUES(?,?,${placeholders},1,?,?) ON CONFLICT(user_id,slot) DO UPDATE SET ${updates},seen_count=1,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at`,
    ).bind(Number(userId), slot, ...fingerprintProfileBindings(profile), ts, ts).run();
    return latestFingerprintProfile(env, userId);
}

async function getFingerprintLabelById(env, labelId) {
    return env.DB.prepare("SELECT * FROM fingerprint_labels_v2 WHERE id=? AND active=1")
        .bind(Number(labelId)).first();
}

async function getFingerprintReferenceById(env, referenceId) {
    return env.DB.prepare(
        `SELECT r.*, l.label_name, l.note, l.state, l.active FROM fingerprint_reference_profiles_v2 r ` +
        "JOIN fingerprint_labels_v2 l ON l.id=r.label_id WHERE r.id=? AND l.active=1",
    ).bind(Number(referenceId)).first();
}

async function ensureFingerprintReferenceLookups(env, referenceId, profile) {
    const entries = fingerprintLookupEntries(profile).slice(0, 14);
    if (!entries.length) return;
    await env.DB.batch(entries.map((entry) => env.DB.prepare(
        "INSERT OR IGNORE INTO fingerprint_reference_lookup_v2(kind,band,lookup_key,reference_id) VALUES(?,?,?,?)",
    ).bind(entry.kind, entry.band, entry.key, Number(referenceId))));
}

async function insertFingerprintReference(env, label, sourceUserId, sourceSlot, profile, adminId) {
    if (Number(profile?.qualityScore || 0) < FINGERPRINT_MIN_EXACT_QUALITY || !profile?.httpKey) {
        throw new Error("当前指纹质量或HTTP信息不足，不能保存为参考锚点。");
    }
    const existing = await env.DB.prepare(
        "SELECT id FROM fingerprint_reference_profiles_v2 WHERE label_id=? AND exact_hash=? LIMIT 1",
    ).bind(Number(label.id), profile.exactHash).first();
    if (existing) {
        await ensureFingerprintReferenceLookups(env, Number(existing.id), profile);
        return getFingerprintReferenceById(env, Number(existing.id));
    }
    const columns = fingerprintProfileColumns().split(", ");
    const placeholders = columns.map(() => "?").join(",");
    const ts = nowIso();
    const insertSql = "INSERT INTO fingerprint_reference_profiles_v2(label_id,source_user_id,source_slot," +
        columns.join(",") + ",created_by_user_id,created_at,last_matched_at,match_count) SELECT ?,?,?," +
        placeholders + ",?,?,NULL,0 WHERE " +
        "(SELECT COUNT(*) FROM fingerprint_reference_profiles_v2 WHERE label_id=?) < ? AND " +
        "NOT EXISTS (SELECT 1 FROM fingerprint_reference_profiles_v2 WHERE label_id=? AND exact_hash=?)";
    const result = await env.DB.prepare(insertSql).bind(
        Number(label.id), Number(sourceUserId), Number(sourceSlot), ...fingerprintProfileBindings(profile), Number(adminId), ts,
        Number(label.id), MAX_FINGERPRINT_REFERENCES_PER_LABEL, Number(label.id), profile.exactHash,
    ).run();
    let referenceId = Number(result.meta?.changes || 0) > 0 ? Number(result.meta?.last_row_id || 0) : 0;
    if (!referenceId) {
        const row = await env.DB.prepare(
            "SELECT id FROM fingerprint_reference_profiles_v2 WHERE label_id=? AND exact_hash=? LIMIT 1",
        ).bind(Number(label.id), profile.exactHash).first();
        referenceId = Number(row?.id || 0);
    }
    if (!referenceId) throw new Error(`该标签最多保存 ${MAX_FINGERPRINT_REFERENCES_PER_LABEL} 个已确认指纹，请先删除旧标签或建立新标签。`);
    await ensureFingerprintReferenceLookups(env, referenceId, profile);
    return getFingerprintReferenceById(env, referenceId);
}

async function upsertFingerprintUserLabel(env, userId, labelId, referenceId, adminId, match) {
    await env.DB.prepare(
        "INSERT INTO fingerprint_user_labels_v2(user_id,label_id,reference_id,confirmed_by_user_id,match_method,weighted_score,evidence_mask,confirmed_at) " +
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET label_id=excluded.label_id,reference_id=excluded.reference_id," +
        "confirmed_by_user_id=excluded.confirmed_by_user_id,match_method=excluded.match_method,weighted_score=excluded.weighted_score," +
        "evidence_mask=excluded.evidence_mask,confirmed_at=excluded.confirmed_at",
    ).bind(
        Number(userId), Number(labelId), Number(referenceId || 0) || null, Number(adminId),
        match?.exact ? "exact" : match?.webrtcIpExact ? "webrtc" : "similarity",
        Number(match?.score || 100), Number(match?.evidenceMask || 0), nowIso(),
    ).run();
}

async function fingerprintReferenceRows(env, referenceIds) {
    const ids = [...new Set(referenceIds.map(Number).filter((value) => Number.isFinite(value) && value > 0))].slice(0, MAX_FINGERPRINT_CANDIDATES);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const result = await env.DB.prepare(
        `SELECT r.*, l.label_name, l.note, l.state, l.source_user_id AS label_source_user_id ` +
        `FROM fingerprint_reference_profiles_v2 r JOIN fingerprint_labels_v2 l ON l.id=r.label_id ` +
        `WHERE r.id IN (${placeholders}) AND l.active=1 LIMIT ${MAX_FINGERPRINT_CANDIDATES}`,
    ).bind(...ids).all();
    return result.results || [];
}

async function findFingerprintMatches(env, currentProfile) {
    if (!currentProfile?.exactHash) return [];
    // 规则6（跨浏览器且换网络的弱证据档）默认关闭，需要在设置页开启后才纳入候选。
    const allowWeakSuspect = await weakSuspectEnabled(env);
    const exactRows = await env.DB.prepare(
        "SELECT reference_id FROM fingerprint_reference_lookup_v2 WHERE kind=0 AND band=0 AND lookup_key=? " +
        "ORDER BY reference_id DESC LIMIT " + MAX_FINGERPRINT_CANDIDATES,
    ).bind(currentProfile.exactHash).all();
    let referenceIds = (exactRows.results || []).map((row) => Number(row.reference_id)).filter((id) => id > 0);
    if (!referenceIds.length) {
        const entries = fingerprintLookupEntries(currentProfile).slice(0, 14);
        const ordered = [
            ...entries.filter((entry) => entry.kind === 1),
            ...entries.filter((entry) => entry.kind === 3),
            ...entries.filter((entry) => entry.kind === 4),
            ...entries.filter((entry) => entry.kind === 2),
        ];
        const statements = ordered.map((entry) => {
            const limit = entry.kind === 1 ? MAX_FINGERPRINT_CANDIDATES : entry.kind === 3 ? 6 : 4;
            return env.DB.prepare(
                "SELECT reference_id FROM fingerprint_reference_lookup_v2 WHERE kind=? AND band=? AND lookup_key=? " +
                "ORDER BY reference_id DESC LIMIT " + limit,
            ).bind(entry.kind, entry.band, entry.key);
        });
        const results = statements.length ? await env.DB.batch(statements) : [];
        const seen = new Set();
        referenceIds = [];
        for (const result of results) {
            for (const row of (result.results || [])) {
                const id = Number(row.reference_id);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                referenceIds.push(id);
                if (referenceIds.length >= MAX_FINGERPRINT_CANDIDATES) break;
            }
            if (referenceIds.length >= MAX_FINGERPRINT_CANDIDATES) break;
        }
    }
    const rows = await fingerprintReferenceRows(env, referenceIds);
    const bestByLabel = new Map();
    for (const row of rows) {
        const match = scoreFingerprintProfiles(currentProfile, profileFromDatabaseRow(row), { allowWeakSuspect });
        if (!match.qualifies) continue;
        const candidate = { ...match, referenceId: Number(row.id), labelId: Number(row.label_id), labelName: row.label_name, note: row.note, state: row.state, sourceUserId: Number(row.label_source_user_id || row.source_user_id) };
        const previous = bestByLabel.get(candidate.labelId);
        if (!previous || candidate.score > previous.score) bestByLabel.set(candidate.labelId, candidate);
    }
    return [...bestByLabel.values()].sort((left, right) => {
        const stateOrder = Number(right.state === "blacklist") - Number(left.state === "blacklist");
        return stateOrder || right.score - left.score || right.referenceId - left.referenceId;
    }).slice(0, 5);
}

async function markFingerprintLabel(env, userId, adminId, expectedPrefix = "") {
    const [user, latest] = await Promise.all([getUser(env, Number(userId)), latestFingerprintProfile(env, Number(userId))]);
    if (!user) return { error: "找不到用户。" };
    if (!latest?.profile?.exactHash) return { error: "该用户没有可标记的指纹，请先重新验证。" };
    if (Number(latest.profile.qualityScore || 0) < FINGERPRINT_MIN_EXACT_QUALITY || !latest.profile.httpKey) return { error: "当前指纹质量或HTTP信息不足，不能建立参考档案；请让用户在信息采集更完整的环境重新验证。" };
    if (expectedPrefix && !latest.profile.exactHash.startsWith(String(expectedPrefix))) return { error: "用户指纹已经变化，请使用最新验证通知重新标记。" };
    const labelName = String(user.note || "").trim().slice(0, 80);
    if (!labelName) return { error: "请先使用 /note 或后台备注设置标签，再标记指纹。" };
    let label = await env.DB.prepare(
        "SELECT * FROM fingerprint_labels_v2 WHERE source_user_id=? AND label_name=? AND active=1 ORDER BY updated_at DESC LIMIT 1",
    ).bind(Number(userId), labelName).first();
    if (!label) {
        const ts = nowIso();
        const insert = await env.DB.prepare(
            "INSERT INTO fingerprint_labels_v2(label_name,note,state,active,source_user_id,created_by_user_id,created_at,updated_at) " +
            "SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM fingerprint_labels_v2 WHERE source_user_id=? AND active=1) < ? " +
            "AND NOT EXISTS (SELECT 1 FROM fingerprint_labels_v2 WHERE source_user_id=? AND label_name=? AND active=1)",
        ).bind(
            labelName, "", user.blocked ? "blacklist" : "watch", 1, Number(userId), Number(adminId), ts, ts,
            Number(userId), MAX_FINGERPRINT_LABELS_PER_USER, Number(userId), labelName,
        ).run();
        if (Number(insert.meta?.changes || 0) > 0) label = await getFingerprintLabelById(env, Number(insert.meta?.last_row_id || 0));
        if (!label) {
            label = await env.DB.prepare(
                "SELECT * FROM fingerprint_labels_v2 WHERE source_user_id=? AND label_name=? AND active=1 ORDER BY updated_at DESC LIMIT 1",
            ).bind(Number(userId), labelName).first();
        }
        if (!label) return { error: `该用户最多保存 ${MAX_FINGERPRINT_LABELS_PER_USER} 个指纹标签。` };
    }
    if (!label) return { error: "指纹标签保存失败。" };
    try {
        const reference = await insertFingerprintReference(env, label, userId, latest.row.slot, latest.profile, adminId);
        await upsertFingerprintUserLabel(env, userId, label.id, reference.id, adminId, { exact: true, score: 100, evidenceMask: 1 });
        return { label, reference, latest };
    } catch (error) {
        return { error: String(error?.message || error) };
    }
}

async function confirmFingerprintMatch(env, userId, labelId, adminId, expectedPrefix = "") {
    const [latest, label] = await Promise.all([latestFingerprintProfile(env, Number(userId)), getFingerprintLabelById(env, Number(labelId))]);
    if (!latest?.profile) return { error: "用户没有当前指纹，请先重新验证。" };
    if (!label) return { error: "指纹标签已经不存在。" };
    if (expectedPrefix && !latest.profile.exactHash.startsWith(String(expectedPrefix))) return { error: "用户指纹已经变化，不能使用旧通知确认。" };
    const refs = await env.DB.prepare(
        "SELECT * FROM fingerprint_reference_profiles_v2 WHERE label_id=? ORDER BY created_at DESC LIMIT 12",
    ).bind(Number(labelId)).all();
    let best = null;
    for (const row of (refs.results || [])) {
        // 人工点「确认同一人」时放宽弱证据档，因为这已经是管理员的主动判断。
        const match = scoreFingerprintProfiles(latest.profile, profileFromDatabaseRow(row), { allowWeakSuspect: true });
        if (!best || match.score > best.match.score) best = { row, match };
    }
    if (!best?.match?.qualifies) return { error: "当前指纹与该标签未达到候选门槛，不能确认。" };
    try {
        const reference = Number(latest.profile.qualityScore || 0) >= FINGERPRINT_MIN_EXACT_QUALITY && latest.profile.httpKey
            ? await insertFingerprintReference(env, label, userId, latest.row.slot, latest.profile, adminId)
            : best.row;
        await upsertFingerprintUserLabel(env, userId, labelId, reference.id, adminId, best.match);
        return { label, reference, match: best.match, latest };
    } catch (error) {
        return { error: String(error?.message || error) };
    }
}

async function deleteFingerprintLabel(env, labelId) {
    const label = await env.DB.prepare("SELECT * FROM fingerprint_labels_v2 WHERE id=?").bind(Number(labelId)).first();
    if (!label) return null;
    await env.DB.batch([
        env.DB.prepare("DELETE FROM fingerprint_reference_lookup_v2 WHERE reference_id IN (SELECT id FROM fingerprint_reference_profiles_v2 WHERE label_id=?)").bind(Number(labelId)),
        env.DB.prepare("DELETE FROM fingerprint_user_labels_v2 WHERE label_id=?").bind(Number(labelId)),
        env.DB.prepare("DELETE FROM fingerprint_reference_profiles_v2 WHERE label_id=?").bind(Number(labelId)),
        env.DB.prepare("DELETE FROM fingerprint_labels_v2 WHERE id=?").bind(Number(labelId)),
    ]);
    return label;
}

async function sendFingerprintLabels(env, query, userId) {
    const [user, labels, confirmed] = await Promise.all([
        getUserWithIdentity(env, Number(userId)),
        env.DB.prepare(
            "SELECT l.id,l.label_name,l.note,l.state,l.updated_at,COUNT(r.id) AS reference_count " +
            "FROM fingerprint_labels_v2 l LEFT JOIN fingerprint_reference_profiles_v2 r ON r.label_id=l.id " +
            "WHERE l.source_user_id=? AND l.active=1 GROUP BY l.id ORDER BY l.updated_at DESC LIMIT 10",
        ).bind(Number(userId)).all(),
        env.DB.prepare(
            "SELECT l.id,l.label_name,l.state,ul.weighted_score,ul.confirmed_at FROM fingerprint_user_labels_v2 ul " +
            "JOIN fingerprint_labels_v2 l ON l.id=ul.label_id WHERE ul.user_id=? LIMIT 1",
        ).bind(Number(userId)).first(),
    ]);
    if (!user) {
        await sendCallbackContextMessage(env, query, "找不到用户。");
        return;
    }
    const rows = labels.results || [];
    const lines = [
        "指纹标签 V2",
        "用户 ID：" + user.user_id,
        "当前人工确认：" + (confirmed ? `${confirmed.label_name}（${confirmed.weighted_score}%）` : "无"),
        "直接标记数量：" + rows.length,
    ];
    for (const row of rows) {
        lines.push(
            "",
            `#${row.id} ${row.label_name}`,
            "状态：" + (row.state === "blacklist" ? "指纹黑名单" : "观察标签"),
            "参考档案：" + Number(row.reference_count || 0),
            "更新时间：" + row.updated_at,
        );
    }
    const replyMarkup = rows.length ? {
        inline_keyboard: rows.map((row) => [{
            text: `删除 #${row.id} ${String(row.label_name || "").slice(0, 20)}`,
            callback_data: `fpdelete:${row.id}`,
        }]),
    } : null;
    await sendCallbackContextMessage(env, query, lines.join("\n"), replyMarkup);
}

// 单个维度的命中标记：完全一致用 ✓，完全不同用 ✗，中间值给百分比，无数据给 －。
function vectorPartMark(part) {
    if (!part || part.value === null || part.value === undefined) return "－";
    if (part.value >= 0.999) return "✓";
    if (part.value <= 0.001) return "✗";
    return `${Math.round(part.value * 100)}%`;
}

function vectorLine(vector) {
    if (!vector || !Array.isArray(vector.parts)) return "无数据";
    return vector.parts.map((part) => `${part.name} ${vectorPartMark(part)}`).join("  ");
}

function vectorHeadline(vector) {
    if (!vector || vector.score === null) return "无数据";
    return vector.coverage >= 100 ? `${vector.score}%` : `${vector.score}%（采集 ${vector.coverage}%）`;
}

// 四向量证据卡片。管理员据此判断「凭什么判成同一人」，而不是只看一个总分。
function fingerprintVectorCard(match) {
    const v = match?.vectors;
    if (!v) return "";
    return [
        `设备指纹总分：${match.score}%`,
        "",
        `├─ 向量 A · WebRTC (30%)　${vectorHeadline(v.rtc)}`,
        `│   ${vectorLine(v.rtc)}`,
        `├─ 向量 B · 公网 IP (20%)　${vectorHeadline(v.http)}`,
        `│   ${vectorLine(v.http)}`,
        `├─ 向量 C · 渲染指纹 (25%)　${vectorHeadline(v.render)}`,
        `│   ${vectorLine(v.render)}`,
        `└─ 向量 D · 稳定不变量 (25%)　${vectorHeadline(v.stable)}`,
        `    ${vectorLine(v.stable)}`,
    ].join("\n");
}

// 档位对应的结论措辞。rtcWeakDevice 与 stableOnly 会附加风险提示。
function fingerprintTierNote(match) {
    const stable = match?.vectors?.stable;
    const render = match?.vectors?.render;
    switch (match?.tier) {
        case "exact":
            return "完整指纹一致，同一设备同一网络环境。";
        case "rtcRender":
            return "WebRTC IP 与渲染指纹三项同时一致，证据最强。";
        case "rtcOnly":
            return "WebRTC IP 一致。跨设备、跨平台、跨浏览器均以此为准。";
        case "rtcWeakDevice":
            return `WebRTC IP 一致，但设备层仅 ${render?.score ?? 0}% / ${stable?.score ?? 0}%。也可能是同一出口网络下的另一台设备，建议人工核实后再拉黑。`;
        case "httpFull":
            return "公网 IP、ASN、ISP 全部一致（WebRTC 未采集到）。";
        case "render":
            return "渲染指纹三项一致，同一台设备同一浏览器，只是换了网络。";
        case "stableNet":
            return "渲染指纹已变但稳定不变量高度一致，且网络层提供支撑，判定为同设备换浏览器。";
        case "stableOnly":
            return "仅稳定不变量一致，网络层无交集。可能是同设备换浏览器又换网络，也可能是同型号的另一台设备，两者信号无法区分。";
        case "networkOnly":
            return "仅网络相近，设备层证据不足，不构成同一人。";
        default:
            return "加权相似度达到阈值，无单项强证据。";
    }
}

function fingerprintMatchText(matches = []) {
    if (!matches.length) return "";
    const lines = ["指纹候选"];
    for (const match of matches.slice(0, 3)) {
        const state = match.state === "blacklist" ? "指纹黑名单" : "观察标签";
        lines.push("", `标签：${match.labelName}　[${state}]`, fingerprintVectorCard(match), "", `判定：${match.tierLabel || "相似"}`, `说明：${fingerprintTierNote(match)}`);
    }
    return lines.join("\n");
}

// 按档位给不同按钮：确认档给「确认并拉黑」，弱证据档只给「确认同一人」并附「忽略」。
// 已经自动拉黑过的不再重复提供拉黑按钮。
function fingerprintMatchButtons(userId, match, slot, prefix, alreadyBlocked = false) {
    const confirm = { text: `确认同一人（${match.score}%）`, callback_data: `fpconfirm:${userId}:${match.labelId}:${slot}:${prefix}` };
    if (alreadyBlocked) return [confirm];
    if (match.confirmTier) {
        return [confirm, { text: "确认并拉黑", callback_data: `fpban:${userId}:${match.labelId}:${slot}:${prefix}` }];
    }
    return [confirm];
}

function clientDataForVerificationStorage(clientData = {}, network = {}) {
    const probe = clientData?.probe && typeof clientData.probe === "object" ? clientData.probe : {};
    return {
        probe: {
            http_ip_version: String(probe.http_ip_version || "").slice(0, 16),
            country: String(probe.country || "").slice(0, 16),
            colo: String(probe.colo || "").slice(0, 32),
            asn: String(probe.asn || "").slice(0, 32),
            as_organization: String(probe.as_organization || "").slice(0, 200),
            error: String(probe.error || "").slice(0, 100),
        },
        webrtc: {
            udp_status: String(network.udp_status || "").slice(0, 40),
            webrtc_ipv4: String(network.webrtc_ipv4 || "").slice(0, 64),
            webrtc_ipv6: String(network.webrtc_ipv6 || "").slice(0, 128),
            webrtc_protocol: String(network.webrtc_protocol || "").slice(0, 20),
            webrtc_candidate_type: String(network.webrtc_candidate_type || "").slice(0, 80),
            candidates: Array.isArray(network.webrtc_candidates) ? network.webrtc_candidates.slice(0, 4) : [],
        },
        error: String(clientData.error || "").slice(0, 300),
        parse_error: String(clientData.parse_error || "").slice(0, 300),
    };
}

async function getIdentityLabelForUser(env, userId) {
    return env.DB.prepare(
        "SELECT l.*, CASE WHEN c.user_id IS NULL THEN 'source' ELSE 'confirmed' END AS relation_kind " +
        "FROM webrtc_identity_labels l " +
        "LEFT JOIN webrtc_identity_confirmations c ON c.label_id=l.id AND c.user_id=? " +
        "WHERE c.user_id IS NOT NULL OR l.source_user_id=? " +
        "ORDER BY CASE WHEN c.user_id IS NULL THEN 1 ELSE 0 END, l.updated_at DESC LIMIT 1",
    ).bind(Number(userId), Number(userId)).first();
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
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录 · TG DualBot</title><style>
*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
:root{--ink:#142033;--muted:#667085;--line:#d9e0ea;--blue:#1d4ed8;--blue-dark:#173f9f}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:radial-gradient(circle at 12% 12%,#dbeafe 0,transparent 34%),radial-gradient(circle at 88% 82%,#e0f2fe 0,transparent 30%),#eef2f7;color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",Roboto,sans-serif}
.card{width:min(430px,100%);background:rgba(255,255,255,.96);border:1px solid rgba(203,213,225,.9);border-radius:18px;padding:clamp(22px,6vw,34px);box-shadow:0 24px 70px rgba(15,23,42,.14)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;color:var(--blue);font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.eyebrow::before{content:"";width:28px;height:3px;border-radius:999px;background:var(--blue)}
h1{margin:0 0 8px;font-size:clamp(26px,7vw,32px);letter-spacing:-.03em}.muted{color:var(--muted);margin:0 0 24px;line-height:1.65}label{display:block;font-weight:800;margin:15px 0 7px}
input{width:100%;min-height:48px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;font-size:16px;transition:border-color .18s,box-shadow .18s}
input:focus-visible{outline:3px solid #2563eb;outline-offset:2px;border-color:#2563eb;box-shadow:none}
button{width:100%;min-height:48px;margin-top:22px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--blue-dark));color:white;font:inherit;font-size:16px;font-weight:900;cursor:pointer;box-shadow:0 10px 24px rgba(29,78,216,.22);transition:transform .18s,box-shadow .18s}button:hover{transform:translateY(-1px);box-shadow:0 14px 30px rgba(29,78,216,.28)}button:focus-visible{outline:3px solid #fbbf24;outline-offset:3px}
.error{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;border-radius:10px;padding:11px 13px;margin-bottom:14px;line-height:1.5}@media(max-height:620px){body{place-items:start center}.card{margin-block:auto}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style></head><body><form class="card" method="post" action="/login">
<div class="eyebrow">Cloudflare Control</div><h1>TG DualBot</h1><p class="muted">登录双向机器人管理后台，集中管理用户、消息、验证和 Telegram 话题。</p>
${error ? `<div class="error" role="alert">${h(error)}</div>` : ""}
<label for="panel-username">用户名</label><input id="panel-username" name="username" autocomplete="username" required>
<label for="panel-password">密码</label><input id="panel-password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button></form></body></html>`;
}

function layout(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${h(title)} · TG DualBot</title><style>
:root{--bg:#eef2f7;--panel:#fff;--line:#d9e0ea;--ink:#172033;--muted:#667085;--nav:#0b1324;--nav-soft:#17233b;--blue:#1d4ed8;--blue-soft:#eff6ff;--red:#dc2626;--green:#15803d;--amber:#b45309;--shadow:0 12px 34px rgba(15,23,42,.07)}
*,*::before,*::after{box-sizing:border-box}html{min-height:100%;max-width:100%;overflow-x:clip;background:var(--bg);-webkit-text-size-adjust:100%;text-size-adjust:100%}body{margin:0;min-height:100%;max-width:100%;overflow-x:clip;background:linear-gradient(180deg,#f7f9fc 0,var(--bg) 260px);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",Roboto,sans-serif;font-size:15px}
.shell{display:grid;grid-template-columns:252px minmax(0,1fr);min-height:100vh;min-height:100dvh}.side{position:sticky;top:0;height:100vh;height:100dvh;overflow:auto;padding:24px 18px;background:linear-gradient(180deg,#0b1324,#101a30);color:#fff;border-right:1px solid rgba(148,163,184,.14)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px;padding:0 7px;font-size:19px;font-weight:900;letter-spacing:-.02em}.brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(145deg,#2563eb,#0ea5e9);box-shadow:0 10px 26px rgba(37,99,235,.3);font-size:14px;letter-spacing:.04em}.brand small{display:block;color:#93a4bf;font-size:12px;font-weight:700;letter-spacing:.02em;margin-top:3px}
nav{display:grid;gap:5px}nav a{display:flex;align-items:center;min-height:44px;color:#dbe7f8;text-decoration:none;padding:10px 12px;border:1px solid transparent;border-radius:10px;font-weight:800;transition:background .16s,border-color .16s,transform .16s}nav a:hover{background:var(--nav-soft);border-color:rgba(148,163,184,.16);transform:translateX(2px)}nav a:focus-visible{background:var(--nav-soft);border-color:#fbbf24;outline:3px solid #fbbf24;outline-offset:2px}nav a:last-child{margin-top:12px;color:#fecaca;border-top:1px solid rgba(148,163,184,.14);border-radius:0;padding-top:18px}
main{min-width:0;width:100%;max-width:1540px;margin-inline:auto;padding:clamp(18px,2.4vw,34px)}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.top h1{margin:0;font-size:clamp(25px,3vw,32px);letter-spacing:-.035em}.top>.badge{background:#e8eef7;color:#344054}
.card{min-width:0;max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:clamp(15px,1.7vw,22px);margin:16px 0;box-shadow:var(--shadow)}.card h2{margin:0 0 8px;font-size:19px;letter-spacing:-.015em}.card p:last-child{margin-bottom:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.grid>.card{margin:0}.metrics-grid{grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:16px}.metric-card{position:relative;overflow:hidden;min-height:110px}.metric-card::after{content:"";position:absolute;right:-22px;bottom:-34px;width:92px;height:92px;border-radius:999px;background:var(--blue-soft)}.metric{position:relative;z-index:1;margin-top:10px;font-size:29px;font-weight:950;letter-spacing:-.04em;line-height:1.1}.muted,small{color:var(--muted);line-height:1.6}
.toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.toolbar h2,.toolbar p{margin-top:0}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px;align-items:stretch}.row-actions form{display:flex;margin:0;min-width:0}.row-actions form>button,.row-actions>.btn,.row-actions>button{width:100%;min-width:0}
.note-form{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:8px;align-items:center}.note-form input{min-width:0}
.btn,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;height:38px;border:1px solid transparent;border-radius:9px;background:#e8edf4;color:#1e293b;padding:0 10px;font:inherit;font-size:13px;font-weight:850;line-height:1;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;touch-action:manipulation;transition:transform .15s,box-shadow .15s,background .15s}.btn:hover,button:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(15,23,42,.1)}.btn:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,.table-wrap:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
.btn.primary,button.primary{background:var(--blue);color:#fff}.btn.danger,button.danger{background:var(--red);color:#fff}.btn.ok,button.ok{background:var(--green);color:#fff}
button.ghost,button:disabled{background:#f1f5f9;color:#94a3b8;border-color:#e2e8f0;cursor:not-allowed}button.ghost:hover,button:disabled:hover{transform:none;box-shadow:none}
input,textarea,select{width:100%;min-height:38px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:var(--ink);padding:8px 10px;font:inherit;font-size:13px;transition:border-color .16s,box-shadow .16s}input:focus,textarea:focus,select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}textarea{min-height:120px;font-size:14px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}input[readonly]{background:#f8fafc;color:#475569}input[type="checkbox"]{width:18px;min-height:18px;height:18px;margin:0;accent-color:var(--blue)}
label{display:block;margin:11px 0 6px;font-weight:850}.check-row{display:flex;align-items:center;gap:9px;min-height:42px;margin:11px 0 6px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#f8fafc;font-weight:800}
.table-wrap{display:block;width:100%;max-width:100%;min-width:0;contain:inline-size;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-gutter:stable;border:1px solid var(--line);border-radius:11px;background:#fff;-webkit-overflow-scrolling:touch}.table-wrap table{min-width:var(--table-min,760px)}
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;font-size:13px;line-height:1.5}
thead th{position:sticky;top:0;z-index:1;height:38px;padding:0 12px;background:#f6f8fb;color:#475467;font-size:12px;font-weight:900;letter-spacing:.02em;white-space:nowrap;vertical-align:middle}
th,td{border-bottom:1px solid #e6ebf2;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
td{padding:12px;min-width:0}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfdff}
/* 表格内统一的排版原子类：短标签一律不折行，长文本一律限行，保证每行高度可预期。 */
.cell{display:grid;gap:3px;min-width:0}
.cell-lines{display:grid;gap:2px;min-width:0;line-height:1.55}
.cell-lines>span{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:normal;word-break:normal}
.cell-lines>span.wrap{white-space:normal;overflow-wrap:anywhere;word-break:break-word;text-overflow:clip}
.nowrap{white-space:nowrap;overflow-wrap:normal;word-break:normal}
.num{white-space:nowrap;overflow-wrap:normal;word-break:normal;font-variant-numeric:tabular-nums}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}
.clamp-1{-webkit-line-clamp:1}.clamp-2{-webkit-line-clamp:2}.clamp-3{-webkit-line-clamp:3}.clamp-4{-webkit-line-clamp:4}
.kv{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);gap:8px 14px}.kv dt{color:var(--muted);font-weight:850}.kv dd{min-width:0;margin:0}
.table-identity{display:grid;gap:3px;min-width:0}.table-identity>b{display:block;min-width:0;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.table-meta{display:grid;gap:1px;min-width:0;color:var(--muted);font-size:12px;line-height:1.45}.table-meta>span{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.table-id{white-space:nowrap;overflow-wrap:normal;word-break:normal;font-variant-numeric:tabular-nums}
.table-username{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;overflow-wrap:normal;word-break:normal}
.table-lines{line-height:1.55}
.table-time{display:grid;gap:1px;margin-top:5px;color:var(--muted);font-size:11px;line-height:1.35;white-space:nowrap;overflow-wrap:normal;word-break:normal;font-variant-numeric:tabular-nums}.table-time small{display:block;font-size:11px;line-height:1.35}
.ua-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-top:5px;color:var(--muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere;word-break:break-word}
/* 各表固定列宽：table-layout:fixed + 明确宽度，保证每列对齐、行高一致、不横向溢出。 */
.users-table{table-layout:fixed}
.users-table th:nth-child(1){width:150px}.users-table th:nth-child(2){width:118px}.users-table th:nth-child(3){width:208px}
.users-table th:nth-child(4){width:238px}.users-table th:nth-child(5){width:158px}.users-table th:nth-child(6){width:110px}.users-table th:nth-child(7){width:412px}
.inbox-table{table-layout:fixed}
.inbox-table th:nth-child(1){width:96px}.inbox-table th:nth-child(2){width:172px}.inbox-table th:nth-child(3){width:150px}.inbox-table th:nth-child(5){width:112px}
.verifications-table{table-layout:fixed}
.verifications-table th:nth-child(1){width:76px}.verifications-table th:nth-child(2){width:162px}.verifications-table th:nth-child(3){width:230px}
.verifications-table th:nth-child(4){width:192px}.verifications-table th:nth-child(6){width:132px}
.logs-table{table-layout:fixed}.logs-table th:nth-child(1){width:92px}.logs-table th:nth-child(3){width:400px}.logs-table th:nth-child(4){width:126px}
.moderation-table{table-layout:fixed}
.moderation-table th:nth-child(1){width:180px}.moderation-table th:nth-child(2){width:128px}.moderation-table th:nth-child(4){width:132px}.moderation-table th:nth-child(5){width:280px}
.broadcast-table{table-layout:fixed}
.broadcast-table th:nth-child(1){width:70px}.broadcast-table th:nth-child(2){width:300px}.broadcast-table th:nth-child(3){width:130px}.broadcast-table th:nth-child(4){width:80px}.broadcast-table th:nth-child(5){width:80px}.broadcast-table th:nth-child(6){width:280px}.broadcast-table th:nth-child(7){width:150px}
.secrets-table{table-layout:fixed}.secrets-table th:nth-child(1){width:230px}.secrets-table th:nth-child(2){width:110px}
.fingerprints-table{table-layout:fixed}.fingerprints-table th:nth-child(1){width:80px}.fingerprints-table th:nth-child(3){width:130px}.fingerprints-table th:nth-child(4){width:110px}.fingerprints-table th:nth-child(5){width:130px}.fingerprints-table th:nth-child(6){width:110px}
.verifications-table td:nth-child(1),.verifications-table td:nth-child(6){overflow-wrap:normal;word-break:normal}
.badge{display:inline-flex;align-items:center;justify-content:center;min-height:22px;border-radius:999px;background:#e8edf4;color:#1f2937;padding:3px 9px;font-size:12px;font-weight:900;white-space:nowrap}.badge.red{background:#fee2e2;color:#991b1b}.badge.green{background:#dcfce7;color:#166534}.badge.warn{background:#fef3c7;color:#92400e}
pre{max-width:100%;max-height:min(360px,60dvh);white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;background:#0d1729;color:#e5edf8;border-radius:10px;padding:13px;font-size:12px;line-height:1.55}
.msg{background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:10px 12px;color:#1e3a8a;font-weight:750;line-height:1.55}
.log-body{display:grid;gap:8px;min-width:0}.log-body>b{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 处理建议块整块排版：长建议换行后左边缘与“处理建议：”对齐，不再出现标签与正文错位。 */
.log-hint{min-height:44px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:10px 12px;color:#1e3a8a;font-size:12px;font-weight:750;line-height:1.65}.log-hint.empty{background:#f8fafc;border-color:var(--line);color:var(--muted);font-weight:700}
/* 来源标注：任务号、用户 ID 等，让同名日志一眼能区分。 */
.log-context{display:inline-block;margin:1px 0 3px;padding:3px 10px;border-radius:7px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:850;line-height:1.5;overflow-wrap:anywhere;max-width:100%}
.log-msg{color:#475467;font-size:12px;line-height:1.6}.log-msg b{color:#344054}
/* 日志页类型标签：一次只显示一类，条数跟在类型名后面。 */
.tabs{display:flex;gap:6px;flex-wrap:wrap;padding:2px 2px 0;border-bottom:2px solid var(--line);margin-bottom:16px}
.tab{display:inline-flex;align-items:center;gap:8px;padding:11px 14px;border:2px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;color:#475467;font-size:13px;font-weight:900;text-decoration:none}
.tab:hover{background:#f2f5fa}
.tab.on{background:#fff;border-color:var(--line);color:var(--blue);box-shadow:inset 0 -3px 0 0 var(--blue)}
.tab .num{color:#94a3b8;font-weight:900;font-variant-numeric:tabular-nums}.tab.on .num{color:var(--blue)}
details summary{display:flex;align-items:center;min-height:34px;cursor:pointer;font-weight:800;font-size:12px}
code{overflow-wrap:anywhere;color:#1d4ed8}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1180px){.metrics-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
/* 窄屏统一改为卡片式：所有表格都带 responsive-wrap + responsive-table，新增表格自动继承。 */
@media (max-width:1430px){
.responsive-wrap{border:0;background:transparent;overflow:visible}
.responsive-wrap .responsive-table{display:block!important;min-width:0!important;table-layout:auto;background:transparent}
.responsive-wrap .responsive-table thead{display:none}
.responsive-wrap .responsive-table tbody{display:grid;gap:12px}
.responsive-wrap .responsive-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 8px 22px rgba(15,23,42,.05)}
.responsive-wrap .responsive-table td{display:block;min-width:0!important;width:auto;padding:12px 14px;border:0;border-bottom:1px solid #edf1f6}
.responsive-wrap .responsive-table td::before{content:attr(data-label);display:block;margin-bottom:5px;color:#667085;font-size:11px;font-weight:900;letter-spacing:.04em}
.responsive-wrap .responsive-table td[data-span="full"],.responsive-wrap .responsive-table td:last-child{grid-column:1/-1}
.responsive-wrap .responsive-table td:last-child{border-bottom:0}
.responsive-wrap .responsive-table tbody tr:hover{background:#fff}
.cell-lines>span,.table-identity>b,.table-meta>span{white-space:normal;overflow:visible;text-overflow:clip}
.clamp{-webkit-line-clamp:unset;display:block;overflow:visible}
}
@media(max-width:960px),(max-height:500px) and (orientation:landscape){body{font-size:16px}.shell{grid-template-columns:1fr}.side{position:sticky;top:0;z-index:20;height:auto;max-height:none;padding:max(12px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) 12px max(14px,env(safe-area-inset-left))}.brand{margin-bottom:10px}.brand-mark{width:36px;height:36px}nav{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;padding:2px 32px 4px 0;scrollbar-width:thin;-webkit-overflow-scrolling:touch}nav::after{content:"更多 →";display:flex;align-items:center;flex:0 0 auto;color:#93a4bf;font-size:12px;font-weight:800;padding:0 4px}nav a{flex:0 0 auto;min-height:48px;padding:9px 12px}nav a:last-child{margin:0;border-top:1px solid rgba(248,113,113,.25);border-radius:9px;padding-top:9px}main{padding:16px max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}.top{align-items:flex-start;margin-bottom:12px}.top h1{font-size:25px}.card{padding:15px;margin:12px 0}.note-form{grid-template-columns:1fr}table{font-size:15px}.btn,button{min-height:46px;height:46px;font-size:15px}input,textarea,select,.check-row{min-height:46px;font-size:15px}.table-wrap{border-radius:9px}}
@media(max-width:560px){.metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px}.metric-card{min-height:100px}.metric{font-size:26px}.top>.badge{display:none}.grid{grid-template-columns:1fr}.responsive-wrap .responsive-table tr{grid-template-columns:1fr}.responsive-wrap .responsive-table td{grid-column:1/-1}.row-actions{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:420px){.metrics-grid{grid-template-columns:1fr!important}.actions{display:grid;grid-template-columns:1fr}.actions>*,.actions form,.actions button,.actions .btn{width:100%}.row-actions{grid-template-columns:1fr}.kv{grid-template-columns:1fr;gap:4px}.kv dd{margin-bottom:8px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style></head><body><div class="shell"><aside class="side"><div class="brand"><span class="brand-mark">TG</span><span>TG DualBot<small>Cloudflare 控制台</small></span></div><nav aria-label="后台主导航">
<a href="/">总览</a><a href="/inbox">收件箱</a><a href="/users">用户管理</a><a href="/moderation">名单管理</a><a href="/broadcast">群发通知</a><a href="/rules">广告拦截</a><a href="/verifications">CF 验证记录</a><a href="/settings">设置</a><a href="/logs">日志</a><a href="/logout">退出</a>
</nav></aside><main><div class="top"><h1>${h(title)}</h1><span class="badge">Worker + D1</span></div>${body}</main></div></body></html>`;
}

async function dashboard(request, env) {
    await ensureVerificationSchema(env);
    const stats = await Promise.all([
        scalar(env, "SELECT COUNT(*) FROM users"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE verified=1"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE blocked=1"),
        scalar(env, "SELECT COUNT(*) FROM users WHERE inbound_muted=1"),
        scalar(env, "SELECT COUNT(*) FROM inbox_messages"),
        scalar(env, "SELECT COUNT(*) FROM ip_verifications WHERE passed=1"),
    ]);
    const base = publicBaseUrl(env, request);
    const mode = await controlMode(env);
    const modeText = mode === "web" ? "仅 Web 后台" : mode === "topic" ? "仅 Telegram 话题" : "Web 后台 + Telegram 话题";
    const body = `<div class="grid metrics-grid" style="grid-template-columns:repeat(6,minmax(0,1fr))">
<div class="card metric-card"><div class="muted">用户总数</div><div class="metric">${stats[0]}</div></div>
<div class="card metric-card"><div class="muted">已验证</div><div class="metric">${stats[1]}</div></div>
<div class="card metric-card"><div class="muted">已封禁</div><div class="metric">${stats[2]}</div></div>
<div class="card metric-card"><div class="muted">已隔离</div><div class="metric">${stats[3]}</div></div>
<div class="card metric-card"><div class="muted">消息记录</div><div class="metric">${stats[4]}</div></div>
<div class="card metric-card"><div class="muted">验证通过</div><div class="metric">${stats[5]}</div></div>
</div>
<div class="card"><h2>项目状态</h2><p class="muted">当前版本提供 Telegram 私聊双向通信、验证后聊天门禁、管理员回复、收件箱、用户管理、名单管理、备注、封禁与静默隔离、广告拦截、多管理员、Cloudflare Turnstile 验证、IPv4/IPv6/UDP WebRTC 记录与 V2 设备指纹，并同时支持 Workers 和 Pages Functions 部署。</p>
<dl class="kv"><dt>控制模式</dt><dd>${h(modeText)}</dd><dt>公开地址</dt><dd><code>${h(base)}</code></dd><dt>验证入口</dt><dd><code>${h(`${base}/verify/{token}`)}</code></dd></dl></div>
<div class="card"><h2>四条通道共用同一份记录</h2><p class="muted">用户私聊入站、Telegram 话题内回复、管理员私聊 reply 回复、Web 后台回复都会写入同一张 <code>inbox_messages</code> 表，因此无论从哪一侧操作，收件箱与话题都能看到完整往来记录。</p>
<div class="actions"><a class="btn primary" href="/inbox">查看收件箱</a><a class="btn" href="/users">用户管理</a><a class="btn" href="/moderation">名单管理</a><a class="btn" href="/logs">查看日志</a></div></div>`;
    return html(layout("总览", body));
}

const INBOX_SOURCE_LABELS = {
    user: "用户私聊",
    topic: "话题回复",
    "web:inbox": "Web 后台",
    "tg:reply": "管理员私聊",
};

function sourceText(value) {
    const raw = String(value || "").trim();
    return INBOX_SOURCE_LABELS[raw] || raw || "-";
}

// 统一的多行信息单元格：每条一行、超长省略号截断，不会把一行文字撑成三行。
// 传入的所有条目都会渲染（包含空值行），行数固定才能让同列各行高度一致。
function lineCell(lines, wrapLast = false) {
    const html = lines.map((line, index) => (
        `<span${wrapLast && index === lines.length - 1 ? ' class="wrap"' : ""}>${h(line)}</span>`
    )).join("");
    return `<div class="cell-lines">${html}</div>`;
}

// 统一的用户身份单元格：昵称一行、ID 一行、用户名一行（无用户名也占位），
// 再跟上可选的附加行。行数在同一张表内恒定，保证行高一致。
function identityCell(fullName, userId, username, extraLines = []) {
    const lines = [
        `<span class="table-id">${h(userId)}</span>`,
        `<span class="table-username">${username ? `@${h(username)}` : "无用户名"}</span>`,
    ];
    for (const line of extraLines) lines.push(`<span>${line}</span>`);
    return `<div class="table-identity"><b>${h(fullName || userId)}</b><div class="table-meta">${lines.join("")}</div></div>`;
}

async function inboxPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM inbox_messages ORDER BY id DESC LIMIT 200").all();
    const bodyRows = (rows.results || []).map((r) => {
        const status = r.direction === "out" ? "已回复" : r.error?.startsWith("spam:") ? "已拦截" : r.forwarded ? "已转发" : "未转发";
        const cls = status === "未转发" || status === "已拦截" ? "red" : "green";
        const flow = r.direction === "out" ? "管理员 → 用户" : "用户 → 管理员";
        // 不可重试时渲染 disabled 占位，让每行都是「回复 + 重试转发」两个按钮，行高一致。
        const retry = r.direction === "in" && !r.forwarded
            ? `<form method="post" action="/inbox/${r.id}/retry"><button type="submit">重试转发</button></form>`
            : '<button type="button" class="ghost" disabled title="仅未转发的入站消息可重试">重试转发</button>';
        return `<tr>
<td data-label="ID / 状态"><div class="cell"><span class="table-id">#${h(r.id)}</span><span class="badge ${cls}">${h(status)}</span></div></td>
<td data-label="用户">${identityCell(r.full_name, r.user_id, r.username)}</td>
<td data-label="方向 / 来源">${lineCell([flow, sourceText(r.source)])}${tableTime(r.created_at)}</td>
<td data-label="内容 / 错误" data-span="full"><div class="clamp clamp-3">${h(r.text || "(非文本/媒体消息)")}</div><div class="clamp clamp-2 muted" style="margin-top:5px;font-size:12px">${h(r.error || "无错误")}</div></td>
<td data-label="操作"><div class="row-actions" style="grid-template-columns:minmax(0,1fr);margin-top:0"><a class="btn primary" href="/inbox/${r.id}/reply">回复</a>${retry}</div></td>
</tr>`;
    }).join("");
    return html(layout("收件箱", `<div class="card"><div class="toolbar"><div><h2>双向消息记录</h2><p class="muted">用户入站消息、Telegram 话题回复、管理员私聊回复、Web 后台回复都会记录在这里，四条通道共用同一份记录。</p></div></div><div class="table-wrap responsive-wrap" style="--table-min:1040px" tabindex="0" aria-label="双向消息记录，可横向滚动"><table class="inbox-table responsive-table"><caption class="sr-only">双向消息记录</caption><thead><tr><th scope="col">ID / 状态</th><th scope="col">用户</th><th scope="col">方向 / 来源</th><th scope="col">内容 / 错误</th><th scope="col">操作</th></tr></thead><tbody>${bodyRows || '<tr><td data-span="full" colspan="5" class="muted">暂无消息记录。</td></tr>'}</tbody></table></div></div>`));
}

async function inboxReplyPage(request, env, id) {
    const row = await getInboxMessage(env, id);
    if (!row) return html(layout("未找到", `<div class="card">消息不存在。</div>`), 404);
    const body = `<div class="card"><h2>回复用户</h2><p class="muted">#${row.id} · ${h(row.full_name)} · ${row.user_id}</p><pre>${h(row.text || "(非文本/媒体消息)")}</pre>
<form method="post"><label for="reply-text">回复内容</label><textarea id="reply-text" name="text" required></textarea><div class="actions"><button class="primary" type="submit">发送回复</button><a class="btn" href="/inbox">返回</a></div></form></div>`;
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

// 操作列固定 9 个按钮（3 列 × 3 行），条件不满足时渲染 disabled 占位，
// 保证每一行的按钮网格尺寸与行高完全一致。
function userActionGrid(u) {
    const id = u.user_id;
    const blockPath = u.blocked ? "unblock" : "block";
    const blockText = u.blocked ? "解封" : "封禁";
    const blockClass = u.blocked ? "ok" : "danger";
    const mutePath = u.inbound_muted ? "unmute" : "mute";
    const muteText = u.inbound_muted ? "解除隔离" : "静默隔离";
    const post = (path, text, cls = "", confirm = "") => (
        `<form method="post" action="/users/${id}/${path}"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ""}><button${cls ? ` class="${cls}"` : ""} type="submit">${text}</button></form>`
    );
    const disabled = (text) => `<button type="button" class="ghost" disabled title="当前不可用">${text}</button>`;
    return [
        post(blockPath, blockText, blockClass),
        u.verified ? post("unverify", "取消验证") : disabled("取消验证"),
        post(mutePath, muteText, u.inbound_muted ? "ok" : ""),
        `<a class="btn" href="/users/${id}/fingerprints">指纹标签</a>`,
        u.latest_fingerprint_hash ? post("fingerprints/mark", "标记指纹") : disabled("标记指纹"),
        post("topic/create", "创建话题"),
        post("topic/rebuild", "重建话题"),
        u.topic_thread_id ? post("topic/unbind", "解绑话题") : disabled("解绑话题"),
        post("delete", "删除用户", "danger", "确定要永久删除该用户及其全部消息和验证记录吗？此操作无法恢复。"),
    ].join("");
}

async function usersPage(request, env) {
    await ensureVerificationSchema(env);
    const rows = await env.DB.prepare(USER_WITH_IDENTITY_SELECT + " ORDER BY u.updated_at DESC LIMIT 300").all();
    const bodyRows = (rows.results || []).map((u) => {
        const status = u.blocked
            ? '<span class="badge red">已封禁</span>'
            : u.verified ? '<span class="badge green">已验证</span>' : '<span class="badge warn">未验证</span>';
        const mute = u.inbound_muted ? '<span class="badge warn">已隔离</span>' : "";
        const http = lineCell([
            `IPv4: ${u.last_http_ipv4 || "-"}`,
            `IPv6: ${u.last_http_ipv6 || "-"}`,
            `ASN: ${u.last_asn || "-"}`,
            `运营商: ${u.last_as_organization || "-"}`,
        ]);
        const udp = lineCell([
            `UDP IPv4: ${u.last_webrtc_ipv4 || "-"}`,
            `UDP IPv6: ${u.last_webrtc_ipv6 || "-"}`,
            `UDP 状态: ${u.last_udp_status || "-"}`,
            `设备: ${u.last_device_os || "-"}`,
            `WebRTC 标签: ${u.identity_label_name || "-"}`,
            `V2 指纹: ${u.latest_fingerprint_hash ? String(u.latest_fingerprint_hash).slice(0, 16) : "-"}`,
            `V2 确认: ${u.fingerprint_label_name ? `${u.fingerprint_label_name} ${u.fingerprint_confirmed_score || 0}%` : "-"}`,
        ]);
        const topic = lineCell([
            `话题 ID: ${u.topic_thread_id || "-"}`,
            `状态: ${u.topic_status || "-"}`,
            `标题: ${u.topic_title || "-"}`,
            `错误: ${u.topic_last_error || "无"}`,
        ]);
        return `<tr>
<td data-label="用户">${identityCell(u.full_name, u.user_id, u.username, [`语言: ${h(u.language_code || "-")}`])}</td>
<td data-label="状态"><div class="cell">${status}${mute}<span class="table-meta"><span>${h(u.verification_status || "-")}</span></span></div>${tableTime(u.updated_at)}</td>
<td data-label="公网 HTTP 信息">${http}${tableTime(u.last_verified_at)}</td>
<td data-label="UDP / WebRTC / 指纹">${udp}</td>
<td data-label="话题">${topic}</td>
<td data-label="标签 / 备注"><div class="clamp clamp-4">${h(u.note || "-")}</div></td>
<td data-label="操作">
<form class="note-form" method="post" action="/users/${u.user_id}/note"><label class="sr-only" for="note-${u.user_id}">用户 ${u.user_id} 的标签或备注</label><input id="note-${u.user_id}" name="note" value="${h(u.note || "")}" placeholder="标签 / 备注"><button type="submit">保存</button></form>
<div class="row-actions">${userActionGrid(u)}</div>
</td>
</tr>`;
    }).join("");
    return html(layout("用户管理", `<div class="card"><h2>用户管理</h2><p class="muted">展示已私聊过 Bot 的用户、验证状态、IPv4/IPv6、UDP WebRTC、设备系统、话题绑定、封禁与静默隔离状态和标签 / 备注。封禁与隔离的原因记录见「名单管理」页。</p><div class="table-wrap responsive-wrap" style="--table-min:1420px" tabindex="0" aria-label="机器人用户管理，可横向滚动"><table class="users-table responsive-table"><caption class="sr-only">机器人用户管理</caption><thead><tr><th scope="col">用户</th><th scope="col">状态</th><th scope="col">公网 HTTP 信息</th><th scope="col">UDP / WebRTC / 指纹</th><th scope="col">话题</th><th scope="col">标签 / 备注</th><th scope="col">操作</th></tr></thead><tbody>${bodyRows || '<tr><td data-span="full" colspan="7" class="muted">暂无用户记录。</td></tr>'}</tbody></table></div></div>`));
}

async function userNoteSave(request, env, userId) {
    const form = await request.formData();
    await env.DB.prepare("UPDATE users SET note=?, updated_at=? WHERE user_id=?")
        .bind(String(form.get("note") || "").trim(), nowIso(), userId)
        .run();
    return redirect("/users", request);
}

async function userBlockSet(request, env, userId, blocked) {
    await ensureVerificationSchema(env);
    const fromModeration = new URL(request.url).pathname.startsWith("/moderation");
    let reason = "";
    if (blocked) {
        const form = await request.formData().catch(() => null);
        reason = String(form?.get("reason") || "").trim();
    }
    await setBlock(env, userId, blocked, reason || (blocked ? (fromModeration ? "名单管理页手动封禁" : "Web 用户管理页手动封禁") : ""));
    return redirect(fromModeration ? "/moderation" : "/users", request);
}

async function userMuteSet(request, env, userId, muted) {
    await ensureVerificationSchema(env);
    const fromModeration = new URL(request.url).pathname.startsWith("/moderation");
    let reason = "";
    if (muted) {
        const form = await request.formData().catch(() => null);
        reason = String(form?.get("reason") || "").trim();
    }
    await setInboundMuted(env, userId, muted, reason || (muted ? (fromModeration ? "名单管理页手动隔离" : "Web 用户管理页手动隔离") : ""));
    return redirect(fromModeration ? "/moderation" : "/users", request);
}

async function userVerifyCancel(request, env, userId) {
    await setUserVerified(env, userId, false, "cancelled");
    return redirect("/users", request);
}

async function userFingerprintsPage(request, env, userId) {
    await ensureVerificationSchema(env);
    const [user, latest, labels, confirmed] = await Promise.all([
        getUserWithIdentity(env, userId),
        latestFingerprintProfile(env, userId),
        env.DB.prepare(
            "SELECT l.*,COUNT(r.id) AS reference_count FROM fingerprint_labels_v2 l " +
            "LEFT JOIN fingerprint_reference_profiles_v2 r ON r.label_id=l.id WHERE l.source_user_id=? AND l.active=1 " +
            "GROUP BY l.id ORDER BY l.updated_at DESC LIMIT 20",
        ).bind(userId).all(),
        env.DB.prepare(
            "SELECT l.label_name,l.state,ul.weighted_score,ul.match_method,ul.confirmed_at FROM fingerprint_user_labels_v2 ul " +
            "JOIN fingerprint_labels_v2 l ON l.id=ul.label_id WHERE ul.user_id=? LIMIT 1",
        ).bind(userId).first(),
    ]);
    if (!user) return html(layout("用户不存在", `<div class="card"><p>找不到用户 ${h(userId)}。</p></div>`), 404);
    const current = latest?.profile;
    const currentText = current ? `<dl class="kv"><dt>完整指纹</dt><dd><code>${h(current.exactHash)}</code></dd><dt>档案槽位</dt><dd>${latest.row.slot}</dd><dt>质量</dt><dd>${current.qualityScore}%</dd><dt>设备</dt><dd>${h(current.summary?.model || "-")} / ${h(current.summary?.performanceClass || "-")}</dd></dl>` : `<p class="muted">当前还没有V2指纹，请让用户重新完成验证。</p>`;
    const rows = (labels.results || []).map((row) => `<tr><td data-label="ID"><span class="table-id">#${h(row.id)}</span></td><td data-label="标签"><div class="clamp clamp-2">${h(row.label_name)}</div></td><td data-label="状态">${row.state === "blacklist" ? '<span class="badge red">指纹黑名单</span>' : '<span class="badge green">观察</span>'}</td><td data-label="参考档案"><span class="num">${Number(row.reference_count || 0)}</span></td><td data-label="更新时间">${tableTime(row.updated_at)}</td><td data-label="操作"><div class="row-actions" style="grid-template-columns:minmax(0,1fr);margin-top:0"><form method="post" action="/fingerprint-labels/${row.id}/delete" onsubmit="return confirm('确定删除该指纹标签和全部参考档案吗？')"><button class="danger" type="submit">删除</button></form></div></td></tr>`).join("");
    const mark = current ? `<div class="actions"><form method="post" action="/users/${userId}/fingerprints/mark"><button class="primary" type="submit">使用当前备注标记指纹</button></form><a class="btn" href="/users">返回用户管理</a></div>` : `<div class="actions"><a class="btn" href="/users">返回用户管理</a></div>`;
    const confirmedText = confirmed ? `${h(confirmed.label_name)} · ${confirmed.weighted_score}% · ${h(confirmed.match_method)} · ${h(confirmed.confirmed_at)}` : "无";
    return html(layout("指纹标签", `<div class="card"><h2>${h(user.full_name || userId)} · 指纹 V2</h2><p class="muted">完整哈希相同为 100%；其余结果只作为人工候选，不会自动封禁。</p>${currentText}<p><b>当前人工确认：</b>${confirmedText}</p>${mark}</div><div class="card"><h2>直接标记的标签</h2><div class="table-wrap responsive-wrap" style="--table-min:820px" tabindex="0" aria-label="指纹标签列表，可横向滚动"><table class="fingerprints-table responsive-table"><caption class="sr-only">直接标记的指纹标签</caption><thead><tr><th scope="col">ID</th><th scope="col">标签</th><th scope="col">状态</th><th scope="col">参考档案</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead><tbody>${rows || '<tr><td data-span="full" colspan="6" class="muted">暂无标签。</td></tr>'}</tbody></table></div></div>`));
}

async function userFingerprintMark(request, env, userId) {
    await ensureVerificationSchema(env);
    const result = await markFingerprintLabel(env, userId, 0);
    if (result.error) return html(layout("标记失败", `<div class="card"><h2>标记失败</h2><p>${h(result.error)}</p><a class="btn" href="/users/${userId}/fingerprints">返回</a></div>`), 400);
    return redirect(`/users/${userId}/fingerprints`, request);
}

async function fingerprintLabelDeleteWeb(request, env, labelId) {
    await ensureVerificationSchema(env);
    const label = await deleteFingerprintLabel(env, labelId);
    return redirect(label ? `/users/${label.source_user_id}/fingerprints` : "/users", request);
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

async function userDelete(request, env, userId) {
    await ensureVerificationSchema(env);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM fingerprint_reference_lookup_v2 WHERE reference_id IN (SELECT id FROM fingerprint_reference_profiles_v2 WHERE source_user_id=?)").bind(userId),
        env.DB.prepare("UPDATE fingerprint_user_labels_v2 SET reference_id=NULL WHERE reference_id IN (SELECT id FROM fingerprint_reference_profiles_v2 WHERE source_user_id=?)").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_reference_profiles_v2 WHERE source_user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_reference_lookup_v2 WHERE reference_id IN (SELECT r.id FROM fingerprint_reference_profiles_v2 r JOIN fingerprint_labels_v2 l ON l.id=r.label_id WHERE l.source_user_id=?)").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_user_labels_v2 WHERE label_id IN (SELECT id FROM fingerprint_labels_v2 WHERE source_user_id=?)").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_reference_profiles_v2 WHERE label_id IN (SELECT id FROM fingerprint_labels_v2 WHERE source_user_id=?)").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_labels_v2 WHERE source_user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_user_labels_v2 WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM fingerprint_profiles_v2 WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM webrtc_identity_confirmations WHERE label_id IN (SELECT id FROM webrtc_identity_labels WHERE source_user_id=?)").bind(userId),
        env.DB.prepare("DELETE FROM webrtc_identity_labels WHERE source_user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM webrtc_identity_confirmations WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM message_map WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM rate_events WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM verification_sessions WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM ip_verifications WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM inbox_messages WHERE user_id=?").bind(userId),
        env.DB.prepare("DELETE FROM users WHERE user_id=?").bind(userId),
    ]);
    return redirect("/users", request);
}

// 名单管理：集中查看封禁与静默隔离名单、原因、时间，并直接处理。
async function moderationPage(request, env) {
    await ensureVerificationSchema(env);
    const [blockedRows, mutedRows] = await Promise.all([
        env.DB.prepare(
            "SELECT user_id, username, full_name, note, blocked, block_reason, blocked_at, inbound_muted, " +
            "topic_thread_id, last_http_ipv4, last_http_ipv6, last_device_os, updated_at " +
            "FROM users WHERE blocked=1 ORDER BY (CASE WHEN blocked_at='' THEN updated_at ELSE blocked_at END) DESC LIMIT 300",
        ).all(),
        env.DB.prepare(
            "SELECT user_id, username, full_name, note, blocked, inbound_muted, mute_reason, muted_at, " +
            "topic_thread_id, last_http_ipv4, last_http_ipv6, last_device_os, updated_at " +
            "FROM users WHERE inbound_muted=1 ORDER BY (CASE WHEN muted_at='' THEN updated_at ELSE muted_at END) DESC LIMIT 300",
        ).all(),
    ]);

    const buildRow = (u, kind) => {
        const reason = kind === "block" ? u.block_reason : u.mute_reason;
        const at = kind === "block" ? u.blocked_at : u.muted_at;
        const badges = [
            u.blocked ? '<span class="badge red">已封禁</span>' : "",
            u.inbound_muted ? '<span class="badge warn">已隔离</span>' : "",
        ].filter(Boolean).join("");
        const releasePath = kind === "block" ? "unblock" : "unmute";
        const releaseText = kind === "block" ? "解除封禁" : "解除隔离";
        const other = kind === "block"
            ? (u.inbound_muted
                ? `<form method="post" action="/moderation/${u.user_id}/unmute"><button class="ok" type="submit">解除隔离</button></form>`
                : `<form method="post" action="/moderation/${u.user_id}/mute"><button type="submit">追加隔离</button></form>`)
            : (u.blocked
                ? `<form method="post" action="/moderation/${u.user_id}/unblock"><button class="ok" type="submit">解除封禁</button></form>`
                : `<form method="post" action="/moderation/${u.user_id}/block"><button class="danger" type="submit">追加封禁</button></form>`);
        return `<tr>
<td data-label="用户">${identityCell(u.full_name, u.user_id, u.username)}</td>
<td data-label="状态"><div class="cell">${badges || '<span class="badge">正常</span>'}</div></td>
<td data-label="${kind === "block" ? "封禁原因" : "隔离原因"}" data-span="full"><div class="clamp clamp-3">${h(reason || "未记录原因（可能是旧数据或在本次升级前处理）")}</div></td>
<td data-label="时间">${tableTime(at || u.updated_at)}</td>
<td data-label="操作"><div class="row-actions" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:0"><form method="post" action="/moderation/${u.user_id}/${releasePath}"><button class="ok" type="submit">${releaseText}</button></form>${other}<a class="btn" href="/users">用户管理</a><a class="btn" href="/users/${u.user_id}/fingerprints">指纹标签</a></div></td>
</tr>`;
    };

    const blockedBody = (blockedRows.results || []).map((u) => buildRow(u, "block")).join("");
    const mutedBody = (mutedRows.results || []).map((u) => buildRow(u, "mute")).join("");
    const table = (title, rows, kind) => `<div class="table-wrap responsive-wrap" style="--table-min:1080px" tabindex="0" aria-label="${h(title)}，可横向滚动"><table class="moderation-table responsive-table"><caption class="sr-only">${h(title)}</caption><thead><tr><th scope="col">用户</th><th scope="col">状态</th><th scope="col">${kind === "block" ? "封禁原因" : "隔离原因"}</th><th scope="col">时间</th><th scope="col">操作</th></tr></thead><tbody>${rows || `<tr><td data-span="full" colspan="5" class="muted">${kind === "block" ? "当前没有被封禁的用户。" : "当前没有被静默隔离的用户。"}</td></tr>`}</tbody></table></div>`;

    const body = `<div class="grid metrics-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
<div class="card metric-card"><div class="muted">封禁名单</div><div class="metric">${(blockedRows.results || []).length}</div></div>
<div class="card metric-card"><div class="muted">静默隔离名单</div><div class="metric">${(mutedRows.results || []).length}</div></div>
</div>
<div class="card"><h2>两种处理方式的区别</h2>
<dl class="kv">
<dt>封禁</dt><dd>用户消息不再转发给管理员，机器人会明确告知用户「已被加入黑名单」。管理员在话题或后台仍能看到该用户的历史记录。适合处理广告号、骚扰账号。命中广告关键词时系统会自动封禁并写入命中的关键词作为原因。</dd>
<dt>静默隔离</dt><dd>用户的私聊消息在进入系统之前就被丢弃，不写入消息记录、不回复任何提示、不占用去重记录。用户完全感知不到异常，会以为消息已经发出。适合处理脚本刷屏号，避免对方发现被处理后换号重来。</dd>
<dt>两者可叠加</dt><dd>同一个用户可以同时处于封禁与隔离状态。隔离在最外层生效，此时封禁提示也不会发出。</dd>
<dt>原因来源</dt><dd>原因由执行入口自动写入，包括 Web 后台手动操作、Telegram 话题管理按钮、验证通知按钮、<code>/block</code> 命令以及广告关键词自动拉黑。解除时原因与时间会一并清空。</dd>
</dl></div>
<div class="card"><h2>封禁名单</h2><p class="muted">消息不再转发，用户会收到明确提示。共 ${(blockedRows.results || []).length} 人。</p>${table("封禁名单", blockedBody, "block")}</div>
<div class="card"><h2>静默隔离名单</h2><p class="muted">消息在入口处直接丢弃，用户无感知。共 ${(mutedRows.results || []).length} 人。</p>${table("静默隔离名单", mutedBody, "mute")}</div>`;
    return html(layout("名单管理", body));
}

async function rulesPage(request, env) {
    const keywords = await getSpamKeywords(env);
    const autoBlock = await getSetting(env, "spam_auto_block", "true");
    const body = `<div class="card"><h2>私聊广告拦截</h2><p class="muted">只拦截用户私聊 Bot 的消息。命中后可自动封禁，并通知管理员。</p>
<form method="post"><label class="check-row" for="auto-block"><input id="auto-block" type="checkbox" name="auto_block" ${autoBlock !== "false" ? "checked" : ""}> 命中后自动封禁</label>
<label for="spam-keywords">关键词（一行一个）</label><textarea id="spam-keywords" name="keywords">${h(keywords.join("\n"))}</textarea>
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
        const http = lineCell([
            `HTTP: ${r.http_ip || r.ip || "-"}`,
            `类型: ${r.http_ip_version || "-"}`,
            `IPv4: ${r.http_ipv4 || "-"}`,
            `IPv6: ${r.http_ipv6 || "-"}`,
            `ASN: ${r.asn || "-"}`,
            `运营商: ${r.as_organization || "-"}`,
            `地区: ${[r.country, r.colo].filter(Boolean).join(" · ") || "-"}`,
        ]);
        const udp = lineCell([
            `UDP IPv4: ${r.webrtc_ipv4 || "-"}`,
            `UDP IPv6: ${r.webrtc_ipv6 || "-"}`,
            `协议: ${r.webrtc_protocol || "-"}`,
            `类型: ${r.webrtc_candidate_type || "-"}`,
            `状态: ${r.udp_status || "-"}`,
        ]);
        const user = r.user_id ? identityCell(r.full_name, r.user_id, r.username) : '<span class="muted">-</span>';
        return `<tr>
<td data-label="ID"><div class="cell"><span class="table-id">#${h(r.id)}</span><span class="badge green">通过</span></div></td>
<td data-label="用户">${user}</td>
<td data-label="公网 HTTP">${http}</td>
<td data-label="UDP / WebRTC">${udp}</td>
<td data-label="设备 / User-Agent" data-span="full"><div class="cell"><b>${h(r.device_os || "-")}</b><span class="ua-text">${h(r.user_agent || "-")}</span></div></td>
<td data-label="时间">${tableTime(r.created_at)}</td>
</tr>`;
    }).join("");
    return html(layout("CF 验证记录", `<div class="card"><h2>CF 验证记录</h2><p class="muted">访客通过 Cloudflare Turnstile 后会记录 HTTP IPv4/IPv6、UDP WebRTC IPv4/IPv6、ASN、设备系统和 User-Agent。验证入口使用一次性 token 关联 Telegram 用户。</p><div class="table-wrap responsive-wrap" style="--table-min:1300px" tabindex="0" aria-label="Cloudflare 验证记录，可横向滚动"><table class="verifications-table responsive-table"><caption class="sr-only">Cloudflare 验证记录</caption><thead><tr><th scope="col">ID</th><th scope="col">用户</th><th scope="col">公网 HTTP</th><th scope="col">UDP / WebRTC</th><th scope="col">设备 / User-Agent</th><th scope="col">时间</th></tr></thead><tbody>${bodyRows || '<tr><td data-span="full" colspan="6" class="muted">暂无验证记录。</td></tr>'}</tbody></table></div></div>`));
}

async function settingsPage(request, env) {
    const adminIds = await adminChatIds(env);
    const welcome = await getSetting(env, "welcome_message", "已连接机器人后台。你的消息会转交给管理员。");
    const mode = await controlMode(env);
    const groupId = await topicGroupId(env);
    const createPolicy = await topicCreatePolicy(env);
    const syncWebReplies = await topicSyncWebReplies(env);
    const weakSuspect = await weakSuspectEnabled(env);
    const autoBlock = await autoBlockEnabled(env);
    const autoBlockScore = await autoBlockMinScore(env);
    const base = publicBaseUrl(env, request);
    const option = (value, label, selected) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`;
    const body = `<div class="card"><h2>后台设置</h2><form method="post">
<label for="admin-chat-ids">管理员 Telegram Chat ID（最多 3 个，逗号分隔）</label><input id="admin-chat-ids" name="admin_chat_ids" value="${h(adminIds.join(","))}">
<label for="welcome-message">用户 /start 欢迎语</label><textarea id="welcome-message" name="welcome_message">${h(welcome)}</textarea>
<div class="grid"><div><label for="control-mode">控制模式</label><select id="control-mode" name="control_mode">${option("web", "仅 Web 后台", mode)}${option("topic", "仅 Telegram 话题", mode)}${option("both", "Web 后台 + Telegram 话题", mode)}</select></div><div><label for="topic-group-id">Telegram 话题群 ID</label><input id="topic-group-id" name="topic_group_id" value="${h(groupId || "")}" placeholder="-1001234567890"></div></div>
<div class="grid"><div><label for="topic-create-policy">话题创建策略</label><select id="topic-create-policy" name="topic_create_policy">${option("after_verify", "验证通过后创建", createPolicy)}${option("first_message", "用户首条消息时创建", createPolicy)}</select></div><div><label class="check-row" for="topic-sync-web"><input id="topic-sync-web" type="checkbox" name="topic_sync_web_replies" ${syncWebReplies ? "checked" : ""}> Web/私聊回复同步到话题</label></div></div>
<div class="grid"><div><label for="public-base-url">公开地址</label><input id="public-base-url" value="${h(base)}" readonly></div><div><label for="verify-entry">验证入口</label><input id="verify-entry" value="${h(`${base}/verify/{token}`)}" readonly></div></div>
<div class="actions"><button class="primary" type="submit">保存设置</button></div>
<h2 style="margin-top:22px">指纹识别开关</h2>
<p class="muted">两个开关默认关闭。关闭状态下的行为与升级前完全一致：指纹只做人工候选提示，绝不自动封禁。</p>
<div class="grid">
<div><label class="check-row" for="fp-weak-suspect"><input id="fp-weak-suspect" type="checkbox" name="fp_weak_suspect_enabled" ${weakSuspect ? "checked" : ""}> 启用弱证据档（规则 6）</label>
<small class="muted">开启后，「同设备换浏览器又换网络」这类只剩稳定不变量一致的情况也会列为候选（62~74 分）。代价是同型号的另一台设备也可能进入这一档，因为两者信号分布完全相同。</small></div>
<div><label class="check-row" for="fp-auto-block"><input id="fp-auto-block" type="checkbox" name="fp_auto_block_enabled" ${autoBlock ? "checked" : ""}> 启用指纹自动拉黑</label>
<small class="muted">仅当命中的标签状态为「指纹黑名单」且分数达到下方阈值时才自动封禁，命中「观察标签」永不自动处理。</small>
<label for="fp-auto-block-score" style="margin-top:10px">自动拉黑最低分数（60~100）</label>
<input id="fp-auto-block-score" name="fp_auto_block_min_score" type="number" min="60" max="100" step="1" value="${h(autoBlockScore)}"></div>
</div>
<div class="actions"><button class="primary" type="submit">保存设置</button></div></form></div>
<div class="card"><h2>Cloudflare Secrets 状态</h2>
<div class="table-wrap responsive-wrap" style="--table-min:620px" tabindex="0" aria-label="Cloudflare Secrets 配置状态，可横向滚动"><table class="secrets-table responsive-table"><caption class="sr-only">Cloudflare Secrets 配置状态</caption><thead><tr><th scope="col">名称</th><th scope="col">状态</th><th scope="col">说明</th></tr></thead><tbody>
${secretRow("BOT_TOKEN", env.BOT_TOKEN, "Telegram Bot Token，调用 Bot API 必需", true)}
${secretRow("PANEL_PASSWORD", env.PANEL_PASSWORD, "Web 后台登录密码，未配置时使用默认值，务必设置", true)}
${secretRow("PANEL_SECRET", env.PANEL_SECRET, "登录 Cookie 的签名密钥，修改后所有登录会话失效", true)}
${secretRow("TELEGRAM_SECRET_TOKEN", env.TELEGRAM_SECRET_TOKEN, "Telegram Webhook 校验令牌，防止伪造 Webhook 请求", false)}
${secretRow("TURNSTILE_SECRET_KEY", env.TURNSTILE_SECRET_KEY, "Cloudflare Turnstile 服务端密钥，验证门禁必需", true)}
${secretRow("FINGERPRINT_HMAC_KEY", env.FINGERPRINT_HMAC_KEY, "V2 指纹派生密钥（可选）。配置后 IP、ASN、运营商、Canvas、WebGL、Audio 等特征改用 HMAC-SHA256 派生，D1 泄露也无法反推明文；未配置时退化为带域隔离前缀的 SHA-256，功能完全正常。一旦设置请勿更换，否则已有指纹参考档案会失效。", false)}
${secretRow("TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY, "Cloudflare Turnstile 前端站点密钥，可放在 vars 中", true)}
${secretRow("CONTROL_MODE", mode, "控制通道：web 仅后台、topic 仅话题、both 两者同时", false)}
${secretRow("TOPIC_GROUP_ID", groupId, "已开启 Topics 的 Telegram 超级群 ID，话题模式必填", false)}
</tbody></table></div></div>`;
    return html(layout("设置", body));
}

// required 为 true 时未配置显示红色「必填未配置」，为 false 时显示灰色「可选未配置」。
function secretRow(name, value, note, required = false) {
    const state = value
        ? '<span class="badge green">已配置</span>'
        : required ? '<span class="badge red">必填未配置</span>' : '<span class="badge">可选未配置</span>';
    return `<tr><td data-label="名称"><code>${name}</code></td><td data-label="状态">${state}</td><td data-label="说明" data-span="full">${h(note)}</td></tr>`;
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
    await setSetting(env, "fp_weak_suspect_enabled", form.get("fp_weak_suspect_enabled") ? "true" : "false");
    await setSetting(env, "fp_auto_block_enabled", form.get("fp_auto_block_enabled") ? "true" : "false");
    const minScore = Number(String(form.get("fp_auto_block_min_score") || "").trim());
    await setSetting(env, "fp_auto_block_min_score", String(
        Number.isFinite(minScore) && minScore >= 60 && minScore <= 100 ? Math.round(minScore) : FP_AUTO_BLOCK_DEFAULT_SCORE,
    ));
    return redirect("/settings", request);
}

// 日志分类（按类型切页）。键是 logEvent 的 message，值是类型键；未收录的一律归入 other，
// 保证旧版本写入、现在代码里已不存在的历史日志也能在“全部”里看到而不丢。
const LOG_MESSAGE_GROUPS = {
    "broadcast created": "broadcast",
    "broadcast preview sent": "broadcast",
    "broadcast cancelled": "broadcast",
    "broadcast send failed": "broadcast",
    "broadcast cursor already advanced": "broadcast",
    "failed to relay user message": "relay",
    "partial relay failure": "relay",
    "failed to notify admin": "relay",
    "failed to notify user": "relay",
    "failed to relay topic message": "relay",
    "failed to create topic from web": "topic",
    "failed to send topic intro": "topic",
    "failed to send current WebRTC identity label": "topic",
    "failed to sync outbox to topic": "topic",
    "failed to post notice to user topic": "topic",
    "failed to complete topic verification": "topic",
    "turnstile verification failed": "verify",
    "fingerprint v2 processing failed": "verify",
    "fingerprint auto block": "verify",
    "failed to handle Telegram command": "command",
    "failed to execute Telegram command": "command",
    "unhandled request error": "system",
    "BOT_TOKEN is missing": "system",
    "failed to run broadcast batch": "system",
    "repetitive spam blocked": "system",
};

// 标签顺序即页面上的展示顺序：先看业务（群发、转发、话题），再看校验与系统。
const LOG_GROUP_ORDER = ["broadcast", "relay", "topic", "verify", "command", "system"];

const LOG_GROUP_LABELS = {
    broadcast: "群发",
    relay: "消息转发",
    topic: "话题",
    verify: "验证与指纹",
    command: "命令",
    system: "系统",
    other: "其他",
};

// 每个类型的一句话说明，显示在列表上方。
const LOG_GROUP_HINTS = {
    broadcast: "任务创建、进度推进与逐条发送结果。",
    relay: "用户入站消息与话题回复转发失败的记录。",
    topic: "用户专属话题的创建、说明发送与同步失败。",
    verify: "Turnstile 校验、指纹比对与自动拉黑。",
    command: "Telegram 命令执行失败。",
    system: "未捕获异常、配置缺失与 Cron 批次失败。",
    other: "尚未归类的日志。",
};

// 反查表：类型键 → 该类型的全部 message，用于按类型过滤查询。
const LOG_GROUP_MESSAGES = LOG_GROUP_ORDER.reduce((acc, key) => {
    acc[key] = Object.keys(LOG_MESSAGE_GROUPS).filter((message) => LOG_MESSAGE_GROUPS[message] === key);
    return acc;
}, {});

// 已收录的 message 全集，用于「其他」标签的反向过滤。
const LOG_KNOWN_MESSAGES = Object.keys(LOG_MESSAGE_GROUPS);

// 计数只统计最近这些条。日志表只增不删，用固定窗口统计可以避免每次打开页面都全表扫描。
const LOG_STATS_WINDOW = 500;
const LOG_PAGE_LIMIT_STEP = 100;
const LOG_PAGE_LIMIT_MAX = 500;

const LOG_MESSAGE_TRANSLATIONS = {
    "repetitive spam blocked": {
        title: "重复内容刷屏已拦截",
        reason: "同一用户在短时间内反复发送同一段内容，已停止转发并自动拉黑。",
    },
    "unhandled request error": {
        title: "请求处理异常",
        reason: "Worker 处理请求时出现了未捕获异常。",
    },
    "failed to create topic from web": {
        title: "后台创建 Telegram 话题失败",
        reason: "从用户管理页面创建或重建话题时失败。",
    },
    "turnstile verification failed": {
        title: "Cloudflare Turnstile 验证失败",
        reason: "用户提交的人机验证未通过 Cloudflare 校验。",
    },
    "BOT_TOKEN is missing": {
        title: "缺少 Telegram Bot Token",
        reason: "Worker 当前没有读取到 BOT_TOKEN。",
    },
    "failed to relay topic message": {
        title: "话题消息转发给用户失败",
        reason: "管理员在 Telegram 话题中发送的消息未能转发给对应用户。",
    },
    "partial relay failure": {
        title: "部分消息转发失败",
        reason: "Web 后台或 Telegram 话题通道中至少有一个失败，其他通道可能已经成功。",
    },
    "failed to send topic intro": {
        title: "发送话题说明失败",
        reason: "话题已经创建，但机器人未能发送用户说明消息。",
    },
    "failed to send current WebRTC identity label": {
        title: "发送 WebRTC 标签信息失败",
        reason: "机器人未能把当前 WebRTC 人工标签发送到 Telegram 话题。",
    },
    "failed to complete topic verification": {
        title: "验证完成后的话题处理失败",
        reason: "用户验证已经处理，但创建话题或发送验证信息时失败。",
    },
    "failed to relay user message": {
        title: "用户消息转发失败",
        reason: "用户消息已经进入系统，但未能转发到管理员通道。",
    },
    "failed to sync outbox to topic": {
        title: "后台回复同步到话题失败",
        reason: "消息已发送给用户，但同步显示到 Telegram 话题时失败。",
    },
    "failed to notify admin": {
        title: "通知管理员失败",
        reason: "机器人未能向某个管理员账号发送通知。",
    },
    "broadcast created": {
        title: "群发任务已创建",
        reason: "已创建群发任务，第一批立刻发送，其余由 Cron 每分钟推进一批。",
    },
    "broadcast preview sent": {
        title: "群发预览已发送",
        reason: "预览内容已发到管理员私聊，没有创建正式任务。",
    },
    "broadcast cancelled": {
        title: "群发任务已取消",
        reason: "管理员取消了进行中的群发任务，已经发出的消息无法撤回。",
    },
    "broadcast send failed": {
        title: "群发单条发送失败",
        reason: "该用户这一条没有发出去，其余用户不受影响。",
    },
    "broadcast cursor already advanced": {
        title: "群发游标已被其他实例推进",
        reason: "本批没有抢到乐观锁，说明同一时刻有另一个 Cron 实例在推进同一个任务。",
    },
    "failed to run broadcast batch": {
        title: "群发批次执行失败",
        reason: "Cron 推进群发任务时整体出错，本批没有发出，任务仍停留在进行中。",
    },
    "failed to notify user": {
        title: "通知用户失败",
        reason: "机器人向用户发送提示消息时失败，通常是对方屏蔽了机器人或已删除会话。",
    },
    "failed to post notice to user topic": {
        title: "向用户话题补发通知失败",
        reason: "该用户的话题当前不可用，通知没能补发进话题里。",
    },
    "failed to handle Telegram command": {
        title: "Telegram 命令处理异常",
        reason: "命令在分发阶段抛出了未捕获的错误。",
    },
    "failed to execute Telegram command": {
        title: "Telegram 命令执行失败",
        reason: "命令已经识别，但执行过程中出错，多为参数不对或目标用户不存在。",
    },
    "fingerprint v2 processing failed": {
        title: "指纹 V2 处理失败",
        reason: "本次验证的设备或网络指纹没能完成计算与落库，验证本身仍然通过。",
    },
    "fingerprint auto block": {
        title: "命中指纹并自动拉黑",
        reason: "该用户当前指纹命中了状态为“指纹黑名单”的标签，且分数达到自动拉黑阈值。",
    },
};

// 每条日志要展示的上下文字段。日志页只显示 message 会看不出是哪条任务、哪个用户触发的，
// 这里给每种日志指定要从 data 里取出的字段和中文标签，渲染时拼成一行来源信息。
const LOG_MESSAGE_CONTEXT = {
    "broadcast send failed": [["broadcastId", "任务"], ["userId", "用户"]],
    "broadcast created": [["broadcastId", "任务"], ["audience", "范围"], ["targetTotal", "目标数"]],
    "broadcast cancelled": [["broadcastId", "任务"]],
    "broadcast preview sent": [["chatId", "收件人"], ["messageId", "消息"]],
    "broadcast cursor already advanced": [["broadcastId", "任务"], ["cursor", "游标"]],
    "failed to relay user message": [["inboxId", "收件箱"]],
    "partial relay failure": [["inboxId", "收件箱"]],
    "failed to create topic from web": [["userId", "用户"]],
    "failed to send topic intro": [["userId", "用户"]],
    "failed to send current WebRTC identity label": [["userId", "用户"]],
    "failed to complete topic verification": [["userId", "用户"]],
    "failed to sync outbox to topic": [["userId", "用户"], ["source", "来源"]],
    "failed to post notice to user topic": [["userId", "用户"]],
    "failed to notify user": [["userId", "用户"], ["stage", "阶段"]],
    "failed to notify admin": [["id", "管理员"]],
    "failed to relay topic message": [["threadId", "话题"]],
    "failed to execute Telegram command": [["command", "命令"], ["chatId", "发起者"]],
    "failed to handle Telegram command": [["command", "命令"], ["chatId", "发起者"]],
    "fingerprint v2 processing failed": [["userId", "用户"]],
    "fingerprint auto block": [["userId", "用户"]],
    "repetitive spam blocked": [["userId", "用户"], ["repeatCount", "重复次数"]],
};

// 把 data 里指定的字段拼成「任务 #1 · 用户 24680」这样的来源行；字段全空时返回空串。
function logEntryContext(message, parsed) {
    const fields = LOG_MESSAGE_CONTEXT[String(message || "")];
    if (!fields || !parsed || typeof parsed !== "object") return "";
    const parts = [];
    for (const [key, label] of fields) {
        const value = parsed[key];
        if (value === undefined || value === null || value === "") continue;
        const text = typeof value === "boolean" ? String(value) : String(value);
        parts.push(`${label} ${text}`);
    }
    return parts.join(" · ");
}

function prettyLogData(value) {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
    if (!raw) return "";
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
        return raw;
    }
}

export function localizeLogEntry(message, data = "") {
    const rawMessage = String(message || "");
    const rawData = typeof data === "string" ? data : JSON.stringify(data ?? "");
    const base = LOG_MESSAGE_TRANSLATIONS[rawMessage] || {};
    const combined = (rawMessage + "\n" + rawData).toLowerCase();
    let reason = base.reason || "这条日志暂未匹配到专用翻译，请结合下方原始日志排查。";
    let suggestion = "";

    if (combined.includes("message thread not found")) {
        reason = "Telegram 找不到保存的话题 ID；该话题可能已被删除、关闭后重建，或数据库仍绑定旧话题。";
        suggestion = "在用户管理中点击“重建话题”，并停止使用旧话题。";
    } else if (/message thread is closed|topic_closed/.test(combined)) {
        reason = "目标 Telegram 话题已经关闭，当前无法继续发送消息。";
        suggestion = "重新开启该话题，或者在用户管理中点击“重建话题”。";
    } else if (/chat is not a forum|not a forum/.test(combined)) {
        reason = "配置的目标群组没有开启 Topics/Forum，或者 TOPIC_GROUP_ID 指向了错误群组。";
        suggestion = "确认目标是已开启话题功能的超级群，并重新核对 TOPIC_GROUP_ID。";
    } else if (combined.includes("chat not found")) {
        reason = "Telegram 找不到目标群组或聊天；当前 BOT_TOKEN 对应的机器人无法访问 TOPIC_GROUP_ID 指向的群。";
        suggestion = "确认话题群 ID 属于当前超级群（通常以 -100 开头），并确认当前机器人已加入该群且拥有管理话题和发送消息权限；同群多个 Bot 时要分别核对各自配置。";
    } else if (/bot is not a member|bot was kicked|user not found/.test(combined)) {
        reason = "当前机器人不在目标群组中，或目标用户/聊天已不可访问。";
        suggestion = "重新把当前 BOT_TOKEN 对应的机器人加入目标群，并检查是否被移除或封禁。";
    } else if (/not enough rights|need administrator rights|not an administrator|have no rights/.test(combined)) {
        reason = "机器人已经找到目标群组，但管理员权限不足。";
        suggestion = "把机器人设为管理员，并允许管理话题、发送消息和查看话题。";
    } else if (combined.includes("bot was blocked by the user")) {
        reason = "目标用户已经屏蔽机器人，因此机器人无法向其发送消息。";
        suggestion = "让用户重新打开机器人并点击 /start，解除屏蔽后再发送。";
    } else if (combined.includes("user is deactivated")) {
        // 和「屏蔽」同为 403，但原因完全不同：账号已注销，用户自己也没法恢复。
        // 缺这条映射时页面会退回兜底文案，看日志的人分不清是屏蔽、注销还是配置问题。
        reason = "目标用户的 Telegram 账号已经注销，机器人无法再向该账号发送任何消息。";
        suggestion = "账号已不存在，无需处理；想让名单干净可以在用户管理里清理这类账号。";
    } else if (combined.includes("can't initiate conversation")) {
        reason = "用户尚未主动启动机器人，Telegram 不允许 Bot 主动发起私聊。";
        suggestion = "让用户先打开机器人并发送 /start。";
    } else if (/can't parse entities|message is too long|button_data_invalid/.test(combined)) {
        reason = "发送给 Telegram 的消息格式、长度或按钮数据不符合限制。";
        suggestion = "检查 HTML/Markdown 转义、消息长度以及 callback_data 是否超过 64 字节。";
    } else if (combined.includes("immutable headers")) {
        reason = "旧版本登录或退出流程尝试修改不可变的 HTTP 响应头。";
        suggestion = "重新部署当前最新版；当前源码已改为使用可修改的 Response 构造重定向。";
    } else if (combined.includes("bot_token is missing")) {
        reason = "Cloudflare Worker 中没有配置 BOT_TOKEN Secret。";
        suggestion = "在 Worker 的 Variables and Secrets 中添加正确的 BOT_TOKEN，然后重新部署。";
    } else if (/invalid-input-secret|missing-input-secret/.test(combined)) {
        reason = "Turnstile Secret Key 缺失或无效。";
        suggestion = "检查 TURNSTILE_SECRET_KEY 是否使用当前 Turnstile 站点对应的密钥，而不是站点密钥。";
    } else if (/invalid-input-response|missing-input-response|timeout-or-duplicate/.test(combined)) {
        reason = "Turnstile 验证令牌无效、缺失、超时或已被重复使用。";
        suggestion = "让用户刷新验证页重新完成验证；如果持续出现，再检查站点域名和 Turnstile 配置。";
    } else if (combined.includes("no such column")) {
        reason = "D1 表结构版本较旧，缺少当前代码需要的字段。";
        suggestion = "执行尚未运行的数据库迁移，并确认 Worker 的 DB Binding 指向正确数据库。";
    } else if (combined.includes("no such table")) {
        reason = "D1 缺少代码需要的数据表，或数据库迁移尚未执行。";
        suggestion = "对当前绑定的 D1 执行对应 migrations 升级文件，不要新建另一套数据库。";
    } else if (/unique constraint failed|foreign key constraint failed|check constraint failed|not null constraint failed/.test(combined)) {
        reason = "D1 写入的数据违反了唯一性、关联关系或字段取值约束。";
        suggestion = "查看原始日志中的表名和字段名，确认是否重复写入、关联记录已删除或输入值不符合迁移定义。";
    } else if (/database is locked|database busy/.test(combined)) {
        reason = "D1 数据库暂时繁忙或发生写入竞争。";
        suggestion = "稍后重试；如果频繁发生，需要检查是否存在高频重复写入。";
    } else if (/d1_error|database or disk is full|maximum database size|quota exceeded/.test(combined)) {
        reason = "D1 返回数据库错误或资源限制错误。";
        suggestion = "查看原始 D1 错误内容，并检查数据库绑定、迁移状态、容量和账户配额。";
    } else if (/too many requests|retry after|error_code["':\s]+429/.test(combined)) {
        reason = "Telegram 或外部服务触发了请求频率限制。";
        suggestion = "按照 retry_after 等待后再试，并减少短时间内的重复发送。";
    } else if (/timeout|timed out/.test(combined)) {
        reason = "请求在规定时间内没有完成，可能是 Telegram、Turnstile 或网络暂时超时。";
        suggestion = "稍后重试，并查看相邻日志确认是哪个外部服务超时。";
    }

    // rawMessage/rawData 在下面会被格式化，来源标注要在格式化之前解析原始 JSON。
    let parsed = null;
    try {
        parsed = rawData ? JSON.parse(rawData) : null;
    } catch (parseError) {
        parsed = null;
    }

    return {
        title: base.title || rawMessage || "未命名日志",
        reason,
        suggestion,
        context: logEntryContext(rawMessage, parsed),
        // 分类键用于日志页按类型切页；未收录的 message 归入 other。
        category: LOG_MESSAGE_GROUPS[rawMessage] || "other",
        rawMessage,
        rawData: prettyLogData(rawData),
    };
}

// 日志页：顶部按类型切换，一次只显示一类，每类独立取自己的条数，
// 因此高频事件（例如一次群发产生的几十条发送失败）不会把其他类型挤出去。
async function logsPage(request, env) {
    const url = new URL(request.url);
    const requested = String(url.searchParams.get("type") || "").toLowerCase();
    const activeType = requested === "all" || requested === "other" || LOG_GROUP_ORDER.includes(requested) ? requested : "all";
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.round(requestedLimit), LOG_PAGE_LIMIT_MAX)
        : LOG_PAGE_LIMIT_STEP;

    // 计数只在固定窗口内统计，避免日志表长期增长后每次打开页面都全表扫描。
    const statRows = await env.DB.prepare(
        "SELECT message, COUNT(*) AS c FROM (SELECT message FROM event_logs ORDER BY id DESC LIMIT ?) GROUP BY message",
    ).bind(LOG_STATS_WINDOW).all();
    const counts = { all: 0, other: 0 };
    for (const key of LOG_GROUP_ORDER) counts[key] = 0;
    for (const row of (statRows.results || [])) {
        const category = LOG_MESSAGE_GROUPS[String(row.message || "")] || "other";
        const value = Number(row.c || 0);
        counts.all += value;
        counts[category] += value;
    }
    const activeCount = activeType === "all" ? counts.all : (counts[activeType] || 0);

    // 列表与计数共用同一个窗口，保证“共 X 条”和实际列出的条数对得上。
    let listSql = `SELECT * FROM (SELECT * FROM event_logs ORDER BY id DESC LIMIT ${LOG_STATS_WINDOW})`;
    const listBindings = [];
    if (activeType === "other") {
        // 历史遗留、当前代码已不再写入的 message 落在这里，用反向过滤取出。
        listSql += ` WHERE message NOT IN (${LOG_KNOWN_MESSAGES.map(() => "?").join(",")})`;
        listBindings.push(...LOG_KNOWN_MESSAGES);
    } else {
        const messages = LOG_GROUP_MESSAGES[activeType];
        if (messages) {
            listSql += ` WHERE message IN (${messages.map(() => "?").join(",")})`;
            listBindings.push(...messages);
        }
    }
    listBindings.push(limit);
    const rows = await env.DB.prepare(listSql + " ORDER BY id DESC LIMIT ?").bind(...listBindings).all();
    const entries = rows.results || [];

    const bodyRows = entries.map((r) => {
        const translated = localizeLogEntry(r.message, r.data);
        const level = String(r.level || "").toLowerCase();
        const levelText = level === "error" ? "错误" : level === "warn" ? "警告" : level === "info" ? "信息" : (r.level || "日志");
        const levelClass = level === "error" ? "red" : level === "warn" ? "warn" : "";
        const original = [translated.rawMessage, translated.rawData].filter(Boolean).join("\n");
        // 无处理建议时也渲染同高度的占位块，让每行高度一致。
        const suggestion = translated.suggestion
            ? `<div class="log-hint"><b>处理建议：</b>${h(translated.suggestion)}</div>`
            : '<div class="log-hint empty">这条日志没有对应的处理建议，请查看下方原始日志。</div>';
        // 来源标注：没有它的话，几十条同名日志看不出是哪个任务、哪个用户触发的。
        const contextLine = translated.context
            ? `<div class="log-context">${h(translated.context)}</div>`
            : "";
        return `<tr>
<td data-label="级别"><div class="cell"><span class="table-id">#${h(r.id)}</span><span class="badge ${levelClass}">${h(levelText)}</span></div></td>
<td data-label="事件"><div class="log-body"><b>${h(translated.title)}</b>${contextLine}<div class="log-msg"><b>中文说明：</b>${h(translated.reason)}</div><details><summary>查看原始日志</summary><pre>${h(original)}</pre></details></div></td>
<td data-label="说明与处理建议">${suggestion}</td>
<td data-label="时间">${tableTime(r.created_at)}</td>
</tr>`;
    }).join("");

    const tab = (key, label, count) => {
        const href = key === "all" ? "/logs" : `/logs?type=${key}`;
        return `<a class="tab${activeType === key ? " on" : ""}" href="${href}">${h(label)}<span class="num">${Number(count || 0)}</span></a>`;
    };
    // 「其他」只在窗口内真的存在未收录日志时才出现，避免常驻一个永远为 0 的空标签。
    const tabs = [
        tab("all", "全部", counts.all),
        ...LOG_GROUP_ORDER.map((key) => tab(key, LOG_GROUP_LABELS[key], counts[key])),
        ...(counts.other > 0 ? [tab("other", LOG_GROUP_LABELS.other, counts.other)] : []),
    ].join("");
    const activeLabel = activeType === "all" ? "全部类型" : LOG_GROUP_LABELS[activeType];
    const more = entries.length >= limit && limit < LOG_PAGE_LIMIT_MAX
        ? `<a class="btn" href="/logs?type=${activeType}&limit=${limit + LOG_PAGE_LIMIT_STEP}">加载更多</a>`
        : "";

    const body = `<div class="card"><h2>按类型切换查看</h2><p class="muted">顶部标签一次只显示一类，每类独立取最近 ${limit} 条，不会被高频事件挤掉。计数基于最近 ${LOG_STATS_WINDOW} 条日志。原始日志完整保留在“查看原始日志”中。</p>
<div class="tabs">${tabs}</div></div>
<div class="card"><div class="toolbar"><div><h2>${h(activeLabel)}</h2><p class="muted">${h(LOG_GROUP_HINTS[activeType] || "")}共 ${activeCount} 条，当前显示 ${entries.length} 条。</p></div>${more}</div>
<div class="table-wrap responsive-wrap" style="--table-min:1180px" tabindex="0" aria-label="系统日志，可横向滚动"><table class="logs-table responsive-table"><caption class="sr-only">系统日志</caption><thead><tr><th scope="col">级别</th><th scope="col">事件</th><th scope="col">说明与处理建议</th><th scope="col">时间</th></tr></thead><tbody>${bodyRows || '<tr><td data-span="full" colspan="4" class="muted">这一类暂时没有日志记录。</td></tr>'}</tbody></table></div></div>`;
    return html(layout("日志", body));
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
    if (session.status === "processing" && Date.parse(session.verified_at || "") > Date.now() - VERIFY_PROCESSING_STALE_MS) {
        return verifyMessagePage("正在处理验证", '<p class="muted">验证结果正在写入，请稍候返回 Telegram；无需重复提交。</p>');
    }
    if (!env.TURNSTILE_SITE_KEY) {
        return verifyMessagePage("CF 验证未配置", `<p>请先配置 <code>TURNSTILE_SITE_KEY</code> 和 <code>TURNSTILE_SECRET_KEY</code>。</p>`);
    }
    const tokenJson = JSON.stringify(token);
    const fingerprintFontsJson = JSON.stringify(FINGERPRINT_FONT_CATALOG);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>继续聊天前需要验证</title>${verifyStyle()}<script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><main><form id="verifyForm" class="card" method="post" action="/verify/${h(token)}">
<h1>继续聊天前需要验证</h1><p class="muted">此页面使用 Cloudflare Turnstile 进行人机验证。验证通过后，机器人会为你建立独立话题并转发后续消息。</p>${error ? `<div class="error">${h(error)}</div>` : ""}
<input type="hidden" id="client_data" name="client_data" value="">
<div class="cf-turnstile" data-sitekey="${h(env.TURNSTILE_SITE_KEY)}"></div>
<button id="submitBtn" type="submit">完成验证</button></form></main><script>
const VERIFY_TOKEN = ${tokenJson};
const FINGERPRINT_FONTS = ${fingerprintFontsJson};
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
        document.getElementById("client_data").value = serializeClientData(data);
    } catch (error) {
        document.getElementById("client_data").value = JSON.stringify({ error: String(error && error.message || error).slice(0, 500) });
    }
    button.textContent = "正在提交验证...";
    form.submit();
});
function compactClientText(value, max) {
    return String(value || "").slice(0, max);
}
function serializeClientData(data) {
    const probe = data && data.probe && typeof data.probe === "object" ? data.probe : {};
    const webrtc = data && data.webrtc && typeof data.webrtc === "object" ? data.webrtc : {};
    const device = data && data.device && typeof data.device === "object" ? data.device : {};
    const cpu = device.cpu && typeof device.cpu === "object" ? device.cpu : {};
    const screen = device.screen && typeof device.screen === "object" ? device.screen : {};
    const webgl = device.webgl && typeof device.webgl === "object" ? device.webgl : {};
    const client = device.client && typeof device.client === "object" ? device.client : {};
    const safe = {
        probe: {
            http_ip: compactClientText(probe.http_ip, 128),
            http_ip_version: compactClientText(probe.http_ip_version, 16),
            http_ipv4: compactClientText(probe.http_ipv4, 64),
            http_ipv6: compactClientText(probe.http_ipv6, 128),
            country: compactClientText(probe.country, 16),
            colo: compactClientText(probe.colo, 32),
            asn: compactClientText(probe.asn, 32),
            as_organization: compactClientText(probe.as_organization, 200),
            error: compactClientText(probe.error, 300),
        },
        webrtc: {
            udp_status: compactClientText(webrtc.udp_status, 40),
            webrtc_ipv4: compactClientText(webrtc.webrtc_ipv4, 64),
            webrtc_ipv6: compactClientText(webrtc.webrtc_ipv6, 128),
            webrtc_protocol: compactClientText(webrtc.webrtc_protocol, 20),
            webrtc_candidate_type: compactClientText(webrtc.webrtc_candidate_type, 80),
            error: compactClientText(webrtc.error, 300),
            candidates: Array.isArray(webrtc.candidates) ? webrtc.candidates.slice(0, 4).map((item) => ({
                ip: compactClientText(item && item.ip, 128),
                version: compactClientText(item && item.version, 16),
                protocol: compactClientText(item && item.protocol, 20),
                type: compactClientText(item && item.type, 20),
            })) : [],
        },
        device: {
            canvas: compactClientText(device.canvas, 128),
            audio: compactClientText(device.audio, 128),
            fonts: Array.isArray(device.fonts) ? device.fonts.slice(0, FINGERPRINT_FONTS.length).map((item) => compactClientText(item, 80)) : [],
            performanceClass: compactClientText(device.performanceClass, 24),
            cpu: {
                hardwareConcurrency: Number(cpu.hardwareConcurrency) || null,
                deviceMemory: Number(cpu.deviceMemory) || null,
                maxTouchPoints: Number(cpu.maxTouchPoints) || 0,
                architecture: compactClientText(cpu.architecture, 40),
                bitness: compactClientText(cpu.bitness, 16),
            },
            screen: {
                width: Number(screen.width) || null,
                height: Number(screen.height) || null,
                availWidth: Number(screen.availWidth) || null,
                availHeight: Number(screen.availHeight) || null,
                colorDepth: Number(screen.colorDepth) || null,
                pixelDepth: Number(screen.pixelDepth) || null,
                dpr: Number(screen.dpr) || null,
            },
            webgl: {
                vendor: compactClientText(webgl.vendor, 160),
                renderer: compactClientText(webgl.renderer, 240),
                version: compactClientText(webgl.version, 120),
                shadingLanguageVersion: compactClientText(webgl.shadingLanguageVersion, 120),
                maxTextureSize: Number(webgl.maxTextureSize) || null,
                maxRenderbufferSize: Number(webgl.maxRenderbufferSize) || null,
                maxViewportWidth: Number(webgl.maxViewportWidth) || null,
                maxViewportHeight: Number(webgl.maxViewportHeight) || null,
                maxVertexAttribs: Number(webgl.maxVertexAttribs) || null,
            },
            client: {
                os: compactClientText(client.os, 80),
                platform: compactClientText(client.platform, 80),
                model: compactClientText(client.model, 120),
                platformVersion: compactClientText(client.platformVersion, 80),
                browserEngine: compactClientText(client.browserEngine, 40),
                language: compactClientText(client.language, 32),
                languages: Array.isArray(client.languages) ? client.languages.slice(0, 8).map((item) => compactClientText(item, 32)) : [],
                timezone: compactClientText(client.timezone, 80),
                telegramPlatform: compactClientText(client.telegramPlatform, 40),
                telegramVersion: compactClientText(client.telegramVersion, 40),
            },
        },
    };
    let jsonValue = JSON.stringify(safe);
    if (jsonValue.length <= 6000) return jsonValue;
    safe.webrtc.candidates = safe.webrtc.candidates.slice(0, 3);
    safe.webrtc.error = safe.webrtc.error.slice(0, 100);
    safe.probe.error = safe.probe.error.slice(0, 100);
    jsonValue = JSON.stringify(safe);
    if (jsonValue.length <= 6000) return jsonValue;
    safe.webrtc.candidates = [];
    safe.device.fonts = safe.device.fonts.slice(0, 32);
    return JSON.stringify(safe);
}
function withClientTimeout(promise, timeoutMs, fallback) {
    return Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
}
async function collectClientData() {
    const data = {
        probe: null,
        webrtc: null,
        device: null,
    };
    const tasks = [
        withClientTimeout(httpProbe(), 4000, { error: "timeout" }),
        withClientTimeout(collectWebRtcCandidates(), 4500, { udp_status: "failed", error: "timeout", candidates: [] }),
        withClientTimeout(collectFingerprintSignals(), 3500, { error: "timeout" }),
    ];
    const results = await Promise.allSettled(tasks);
    data.probe = results[0].status === "fulfilled" ? results[0].value : { error: String(results[0].reason || "failed").slice(0, 300) };
    data.webrtc = results[1].status === "fulfilled" ? results[1].value : { udp_status: "failed", error: String(results[1].reason || "failed").slice(0, 300) };
    data.device = results[2].status === "fulfilled" ? results[2].value : { error: String(results[2].reason || "failed").slice(0, 300) };
    return data;
}

async function httpProbe() {
    const response = await fetch("/verify/ip-probe?token=" + encodeURIComponent(VERIFY_TOKEN) + "&t=" + Date.now(), { cache: "no-store" });
    return response.json();
}
async function hashClientText(value) {
    if (!value || !window.crypto || !window.crypto.subtle) return "";
    const buffer = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(buffer)).map((item) => item.toString(16).padStart(2, "0")).join("");
}
function detectClientOs() {
    const ua = String(navigator.userAgent || "").toLowerCase();
    if (ua.includes("android")) return "Android";
    if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "iOS";
    if (ua.includes("windows")) return "Windows";
    if (ua.includes("mac os") || ua.includes("macintosh")) return "macOS";
    if (ua.includes("linux")) return "Linux";
    return "Unknown";
}
function detectBrowserEngine() {
    const ua = String(navigator.userAgent || "");
    // 这段脚本整体位于模板字符串内，正则里的斜杠必须写成 \\/ 才能在浏览器里得到 \/。
    // 只写 \/ 会被模板字符串求值成 /，渲染出去变成 /Firefox//i.test(ua)——
    // 语法仍合法（正则除以标识符 i），但一执行就抛 ReferenceError，
    // 连带整个设备指纹采集一起失败，所以这里不能写成单反斜杠。
    if (/Firefox\\//i.test(ua)) return "Gecko";
    if (/Edg\\//i.test(ua) || /Chrome\\//i.test(ua) || /Chromium\\//i.test(ua)) return "Blink";
    if (/Safari\\//i.test(ua) && !/Chrome\\//i.test(ua)) return "WebKit";
    return "Unknown";
}
function collectCanvasDigest() {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 90;
        const context = canvas.getContext("2d");
        if (!context) return Promise.resolve("");
        context.textBaseline = "top";
        context.font = "16px Arial";
        context.fillStyle = "#f60";
        context.fillRect(12, 10, 118, 46);
        context.fillStyle = "#069";
        context.fillText("tg-dualbot-fp-v2", 16, 22);
        context.strokeStyle = "rgba(120,30,200,.8)";
        context.beginPath();
        context.arc(210, 42, 24, 0, Math.PI * 2);
        context.stroke();
        return hashClientText(canvas.toDataURL());
    } catch (error) {
        return Promise.resolve("");
    }
}
async function collectAudioDigest() {
    try {
        const OfflineAudio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OfflineAudio) return "";
        const context = new OfflineAudio(1, 22050, 22050);
        const oscillator = context.createOscillator();
        const compressor = context.createDynamicsCompressor();
        oscillator.type = "triangle";
        oscillator.frequency.value = 1000;
        oscillator.connect(compressor);
        compressor.connect(context.destination);
        oscillator.start(0);
        const rendered = await context.startRendering();
        const samples = Array.from(rendered.getChannelData(0).slice(0, 128));
        return hashClientText(samples.join(","));
    } catch (error) {
        return "";
    }
}
function collectFontSet() {
    if (!document.body) return [];
    const bases = ["monospace", "sans-serif", "serif"];
    const probe = document.createElement("span");
    probe.textContent = "mmmmmmmmmmlli";
    probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;font-size:72px;visibility:hidden";
    const baseline = {};
    for (const base of bases) {
        probe.style.fontFamily = base;
        document.body.appendChild(probe);
        baseline[base] = [probe.offsetWidth, probe.offsetHeight];
        probe.remove();
    }
    return FINGERPRINT_FONTS.filter((font) => bases.some((base) => {
        probe.style.fontFamily = "'" + font.replace(/'/g, "") + "'," + base;
        document.body.appendChild(probe);
        const found = probe.offsetWidth !== baseline[base][0] || probe.offsetHeight !== baseline[base][1];
        probe.remove();
        return found;
    }));
}
function collectWebGlSignals() {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return {};
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [];
        return {
            vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            version: gl.getParameter(gl.VERSION),
            shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
            maxViewportWidth: Number(viewport[0]) || null,
            maxViewportHeight: Number(viewport[1]) || null,
            maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        };
    } catch (error) {
        return {};
    }
}
function classifyPerformance(cpu, webgl) {
    const cores = Number(cpu.hardwareConcurrency) || 1;
    const memory = Number(cpu.deviceMemory) || 1;
    const texture = Number(webgl.maxTextureSize) || 2048;
    const score = Math.log2(Math.max(cores, 1)) * 2 + Math.log2(Math.max(memory, 1)) + Math.log2(Math.max(texture, 1024)) / 2;
    if (score >= 14) return "very-high";
    if (score >= 11) return "high";
    if (score >= 8) return "medium";
    return "low";
}
async function collectFingerprintSignals() {
    let hints = {};
    try {
        if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
            hints = await navigator.userAgentData.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion"]);
        }
    } catch (error) {}
    const cpu = {
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemory: navigator.deviceMemory || null,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        architecture: hints.architecture || "",
        bitness: hints.bitness || "",
    };
    const webgl = collectWebGlSignals();
    const results = await Promise.allSettled([collectCanvasDigest(), collectAudioDigest()]);
    return {
        canvas: results[0].status === "fulfilled" ? results[0].value : "",
        audio: results[1].status === "fulfilled" ? results[1].value : "",
        fonts: collectFontSet(),
        webgl,
        cpu,
        screen: {
            width: window.screen && window.screen.width,
            height: window.screen && window.screen.height,
            availWidth: window.screen && window.screen.availWidth,
            availHeight: window.screen && window.screen.availHeight,
            colorDepth: window.screen && window.screen.colorDepth,
            pixelDepth: window.screen && window.screen.pixelDepth,
            dpr: window.devicePixelRatio || null,
        },
        client: {
            os: detectClientOs(),
            platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
            model: hints.model || "",
            platformVersion: hints.platformVersion || "",
            browserEngine: detectBrowserEngine(),
            language: navigator.language || "",
            languages: Array.isArray(navigator.languages) ? navigator.languages : [],
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
            telegramPlatform: telegramWebApp && telegramWebApp.platform || "",
            telegramVersion: telegramWebApp && telegramWebApp.version || "",
        },
        performanceClass: classifyPerformance(cpu, webgl),
    };
}
function collectWebRtcCandidates() {
    return new Promise(async (resolve) => {
        if (!window.RTCPeerConnection) {
            resolve({ udp_status: "unsupported", candidates: [] });
            return;
        }
        const candidates = new Map();
        let settled = false;
        let timer = 0;
        let iceError = "";
        let pc;
        try {
            pc = new RTCPeerConnection({
                iceServers: [
                    { urls: "stun:stun.cloudflare.com:3478" },
                    { urls: "stun:stun.l.google.com:19302" },
                ],
            });
        } catch (error) {
            resolve({ udp_status: "failed", error: String(error && error.message || error).slice(0, 200), candidates: [] });
            return;
        }
        const finish = (forcedStatus, errorText) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { pc.close(); } catch (error) {}
            const parsed = Array.from(candidates.values());
            const udp = parsed.filter((item) => item.protocol === "udp" && item.type === "srflx" && !isPrivateIp(item.ip));
            const ipv4Candidates = udp.filter((item) => item.version === "IPv4").sort((left, right) => left.ip.localeCompare(right.ip)).slice(0, 2);
            const ipv6Candidates = udp.filter((item) => item.version === "IPv6").sort((left, right) => left.ip.localeCompare(right.ip)).slice(0, 2);
            const selected = [...ipv4Candidates, ...ipv6Candidates];
            const ipv4 = ipv4Candidates[0]?.ip || "";
            const ipv6 = ipv6Candidates[0]?.ip || "";
            const status = selected.length ? "success" : (forcedStatus || "empty");
            resolve({
                udp_status: status,
                webrtc_ipv4: ipv4,
                webrtc_ipv6: ipv6,
                webrtc_protocol: selected.length ? "udp" : "",
                webrtc_candidate_type: selected.length ? "srflx" : "",
                error: status === "success" || status === "empty" ? "" : String(errorText || iceError || status).slice(0, 200),
                candidates: selected,
            });
        };
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                const parsed = parseCandidate(event.candidate);
                if (parsed && parsed.protocol === "udp" && parsed.type === "srflx" && !isPrivateIp(parsed.ip)) {
                    const key = [parsed.ip, parsed.protocol, parsed.type].join("|");
                    const familyCount = Array.from(candidates.values()).filter((item) => item.version === parsed.version).length;
                    if (!candidates.has(key) && familyCount < 2) candidates.set(key, parsed);
                }
                return;
            }
            finish("", "");
        };
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") finish("", "");
        };
        pc.onicecandidateerror = (event) => {
            iceError = "ice-error-" + String(event && event.errorCode || "unknown");
        };
        try {
            pc.createDataChannel("probe");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (!settled) timer = setTimeout(() => finish("timeout", "timeout"), 3500);
        } catch (error) {
            finish("failed", String(error && error.message || error));
        }
    });
}
function parseCandidate(candidate) {
    const raw = typeof candidate === "string" ? candidate : String(candidate && candidate.candidate || "");
    const parts = raw.split(/\\s+/);
    const typIndex = parts.indexOf("typ");
    const ip = String(candidate && candidate.address || parts[4] || "").replace(/^\\[|\\]$/g, "");
    const protocol = String(candidate && candidate.protocol || parts[2] || "").toLowerCase();
    const type = String(candidate && candidate.type || (typIndex >= 0 ? parts[typIndex + 1] || "" : "")).toLowerCase();
    if (!ip || ip.endsWith(".local")) return null;
    return { ip, version: ip.includes(":") ? "IPv6" : "IPv4", protocol, type };
}
function isPrivateIp(ip) {
    const value = String(ip || "").toLowerCase();
    if (value.includes(":")) {
        if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value) || value === "::" || value === "::1" || /^2001:db8:/i.test(value)) return true;
        const groups = value.split(":");
        const firstGroup = Number.parseInt(groups[0] || "0", 16);
        const secondGroup = Number.parseInt(groups[1] || "0", 16);
        return !Number.isFinite(firstGroup) || firstGroup < 0x2000 || firstGroup > 0x3fff
            || firstGroup === 0x3ffe || (firstGroup === 0x3fff && secondGroup <= 0x0fff);
    }
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
        || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2))
        || (parts[0] === 192 && parts[1] === 88 && parts[2] === 99)
        || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100)))
        || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}
</script></body></html>`;
}

function verifyMessagePage(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${h(title)}</title>${verifyStyle()}</head><body><main><div class="card"><h1>${h(title)}</h1>${body}</div></main></body></html>`;
}

function verifySuccessPage() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>验证成功</title>${verifyStyle()}</head><body><main><div class="card"><h1>验证成功</h1><p>验证已通过，请回到 Telegram 继续聊天。</p></div></main></body></html>`;
}

function verifyStyle() {
    return `<style>*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body{margin:0;min-height:100%;background:#f4f0e8;color:#111827;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",Roboto,sans-serif}main{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))}.card{width:min(520px,100%);background:#fffaf3;border:1px solid #e5d5bf;border-radius:22px;padding:clamp(20px,6vw,30px);box-shadow:0 22px 70px rgba(86,64,38,.16)}h1{margin:0 0 14px;font-size:clamp(26px,7vw,30px);line-height:1.2}.muted{color:#4b5563;line-height:1.65}.small{font-size:13px}.error{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:10px;padding:10px;margin:12px 0}button{width:100%;min-height:48px;margin-top:20px;border:0;border-radius:999px;background:linear-gradient(90deg,#de6b22,#9f430f);color:white;font-weight:900;padding:14px 18px;cursor:pointer;touch-action:manipulation;font-size:16px}button:focus-visible{outline:3px solid #2563eb;outline-offset:3px}button:disabled{opacity:.65;cursor:wait}.cf-turnstile{max-width:100%;margin:20px 0 8px;overflow:hidden}code,pre{max-width:100%;background:#f3f4f6;border-radius:8px;padding:2px 5px;overflow-wrap:anywhere}@media(max-height:620px){main{place-items:start center}.card{margin-block:auto}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}</style>`;
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
    if (session.status === "verified") return html(verifySuccessPage());
    if (session.status === "processing" && Date.parse(session.verified_at || "") > Date.now() - VERIFY_PROCESSING_STALE_MS) {
        return html(verifyMessagePage("正在处理验证", '<p class="muted">验证结果正在写入，请稍候返回 Telegram；无需重复提交。</p>'), 409);
    }
    if (session.status !== "pending" && session.status !== "processing") {
        return html(await verifyPage(request, env, "", "当前验证链接状态无效，请从 Telegram 重新获取。"), 409);
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

    const claimTs = nowIso();
    const staleBefore = new Date(Date.now() - VERIFY_PROCESSING_STALE_MS).toISOString();
    const claim = await env.DB.prepare(
        "UPDATE verification_sessions SET status='processing', verified_at=? WHERE token=? AND " +
        "(status='pending' OR (status='processing' AND (verified_at IS NULL OR verified_at<?)))",
    ).bind(claimTs, token, staleBefore).run();
    if (Number(claim.meta?.changes || 0) !== 1) {
        const current = await getVerificationSession(env, token);
        if (current?.status === "verified") return html(verifySuccessPage());
        return html(verifyMessagePage("正在处理验证", '<p class="muted">另一个请求正在写入验证结果，请稍候返回 Telegram。</p>'), 409);
    }

    const ts = nowIso();
    const cfInfo = requestCfInfo(request);
    const userAgent = request.headers.get("User-Agent") || "";
    const network = extractClientNetwork(clientData, ip);
    const deviceOs = detectDeviceOs(userAgent);
    const rawClientData = JSON.stringify(clientDataForVerificationStorage(clientData, network)).slice(0, 6000);
    const userId = Number(session.user_id);
    let webrtcIdentity = { hash: "" };
    let fingerprintProfile = null;
    let fingerprintState = null;
    let fingerprintMatches = [];
    let webRtcNetworkMeta = [];
    try {
        webrtcIdentity = await buildWebRtcIdentity(network);
        try {
            const metadata = await fingerprintNetworkMetadata(request, network, cfInfo);
            webRtcNetworkMeta = metadata.webrtc || [];
            fingerprintProfile = await buildFingerprintProfile({
                clientData,
                network,
                metadata,
                secret: String(env.FINGERPRINT_HMAC_KEY || ""),
            });
            fingerprintState = await saveRollingFingerprintProfile(env, userId, fingerprintProfile);
            fingerprintMatches = await findFingerprintMatches(env, fingerprintProfile);
        } catch (error) {
            await logEvent(env, "warn", "fingerprint v2 processing failed", { userId, error: String(error?.message || error) }).catch(() => {});
        }
        await env.DB.prepare(`INSERT INTO ip_verifications(user_id, ip, country, colo, user_agent, passed, turnstile_action, http_ip, http_ip_version, http_ipv4, http_ipv6, webrtc_ipv4, webrtc_ipv6, webrtc_protocol, webrtc_candidate_type, udp_status, asn, as_organization, device_os, token, raw_client_data, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(userId, ip || "", cfInfo.country, cfInfo.colo, userAgent.slice(0, 500), 1, String(result.action || ""), ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.webrtc_protocol, network.webrtc_candidate_type, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, token, rawClientData, ts)
            .run();
        await env.DB.prepare(`UPDATE users SET verified=1, verification_status='verified', verification_token=?, language_code=COALESCE(NULLIF(language_code,''), ?), last_verified_ip=?, last_verified_at=?, last_cf_country=?, last_http_ip=?, last_http_ip_version=?, last_http_ipv4=?, last_http_ipv6=?, last_webrtc_ipv4=?, last_webrtc_ipv6=?, last_udp_status=?, last_asn=?, last_as_organization=?, last_device_os=?, last_user_agent=?, updated_at=? WHERE user_id=?`)
            .bind(token, session.language_code || "", ip || "", ts, cfInfo.country, ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, userAgent.slice(0, 500), ts, userId)
            .run();
        await env.DB.prepare("UPDATE verification_sessions SET status='verified', verified_at=? WHERE token=? AND status='processing'")
            .bind(ts, token)
            .run();
    } catch (error) {
        await env.DB.prepare("UPDATE verification_sessions SET status='pending', verified_at=NULL WHERE token=? AND status='processing'")
            .bind(token)
            .run()
            .catch(() => {});
        throw error;
    }
    const webrtcIdentityMatch = await findWebRtcIdentityLabel(env, userId, network);
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
        webRtcAsn: webRtcNetworkMeta.map((item) => item.asn).filter(Boolean).join(", "),
        webRtcIsp: webRtcNetworkMeta.map((item) => item.isp).filter(Boolean).join(" / "),
        fingerprintHash: String(fingerprintProfile?.exactHash || ""),
        fingerprintSlot: Number(fingerprintState?.row?.slot || 0),
        fingerprintQuality: Number(fingerprintProfile?.qualityScore || 0),
        fingerprintSummary: fingerprintProfile?.summary || {},
        fingerprintMatches,
        webrtcIdentityHash: String(webrtcIdentity.hash || ""),
        webrtcIdentityIpVersion: String(webrtcIdentityMatch.ipVersion || ""),
        webrtcIdentityLabelId: Number(webrtcIdentityMatch.label?.id || 0),
        webrtcIdentityLabelName: String(webrtcIdentityMatch.label?.label_name || "").slice(0, 80),
        webrtcIdentitySourceUserId: Number(webrtcIdentityMatch.label?.source_user_id || 0),
        webrtcIdentityConfirmed: Boolean(webrtcIdentityMatch.label?.confirmed),
    };
    // 自动拉黑在通知之前执行，这样话题与私聊消息里能直接带上「已自动封禁」的结论。
    verificationInfo.autoBlocked = await maybeAutoBlockByFingerprint(env, userId, fingerprintMatches);
    const topicVerificationDelivered = await completeTopicVerification(env, userId, verificationInfo);
    await notifyVerificationSuccess(env, userId, token, verificationInfo, topicVerificationDelivered);
    await tgSendMessage(env, userId, verificationInfo.autoBlocked
        ? "验证已通过，但你的账号已被管理员规则限制，消息不会被转发。"
        : "验证已通过，现在可以回到 Telegram 继续聊天。").catch(() => {});
    return html(verifySuccessPage());
}

// 只处理「指纹黑名单」状态的标签，且要求分数达到设定阈值。
// 命中「观察标签」永不自动处理，避免把待观察对象直接封掉。
async function maybeAutoBlockByFingerprint(env, userId, matches = []) {
    if (!matches.length) return null;
    if (!(await autoBlockEnabled(env))) return null;
    const minScore = await autoBlockMinScore(env);
    const hit = matches.find((match) => match.state === "blacklist" && Number(match.score || 0) >= minScore);
    if (!hit) return null;
    const reason = `指纹自动拉黑：${hit.labelName}（${hit.score}%，${hit.tierLabel || "指纹匹配"}）`;
    await setBlock(env, userId, true, reason);
    await logEvent(env, "warn", "fingerprint auto block", {
        userId, labelId: hit.labelId, labelName: hit.labelName, score: hit.score, tier: hit.tier, minScore,
    });
    return { labelName: hit.labelName, score: hit.score, tier: hit.tier, tierLabel: hit.tierLabel, reason };
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

export async function handleTelegramUpdate(env, update) {
    if (await isSilentlyIsolatedPrivateUpdate(env, update)) return;
    const updateId = Number(update?.update_id);
    const trackUpdate = update?.update_id !== undefined && Number.isSafeInteger(updateId);
    if (trackUpdate && !(await claimTelegramUpdate(env, updateId))) return;
    try {
        await processTelegramUpdate(env, update);
    } catch (error) {
        if (trackUpdate) await releaseTelegramUpdate(env, updateId).catch(() => {});
        throw error;
    }
}

async function isSilentlyIsolatedPrivateUpdate(env, update) {
    const message = update?.message || update?.edited_message;
    if (!message || message.chat?.type !== "private") return false;
    const chatId = Number(message.chat.id);
    if (await isAdminChat(env, chatId)) return false;
    const senderId = Number(message.from?.id);
    return Number.isFinite(senderId) && await isInboundMuted(env, senderId);
}

async function processTelegramUpdate(env, update) {
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
        try {
            await handleCommand(env, message, command, admin);
        } catch (error) {
            await logEvent(env, "error", "failed to handle Telegram command", {
                chatId,
                command: command.name,
                error: String(error?.message || error),
            });
        }
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

// 规则6：跨浏览器且换网络时只剩「稳定不变量」一致，此时同型号的另一台设备
// 与真正的同一人无法区分，因此默认不列为候选。开启后会以「弱证据」列出。
async function weakSuspectEnabled(env) {
    const raw = await getSetting(env, "fp_weak_suspect_enabled", env.FP_WEAK_SUSPECT_ENABLED ?? "false");
    return String(raw || "false").toLowerCase() === "true";
}

// 自动拉黑：命中「指纹黑名单」状态的标签且分数达到 FP_AUTO_BLOCK_MIN_SCORE 时自动封禁。
// 默认关闭，因为「WebRTC IP 一致但设备不同」也会给到 92 分，自动化有误伤风险。
async function autoBlockEnabled(env) {
    const raw = await getSetting(env, "fp_auto_block_enabled", env.FP_AUTO_BLOCK_ENABLED ?? "false");
    return String(raw || "false").toLowerCase() === "true";
}

async function autoBlockMinScore(env) {
    const raw = await getSetting(env, "fp_auto_block_min_score", env.FP_AUTO_BLOCK_MIN_SCORE ?? "");
    const value = Number(String(raw || "").trim());
    return Number.isFinite(value) && value >= 60 && value <= 100 ? Math.round(value) : FP_AUTO_BLOCK_DEFAULT_SCORE;
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
    // 同一个超级群可以放置多个 Bot；不属于当前 D1 的话题必须静默忽略。
    if (!user) return;
    if (user.blocked) return;
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
        const rawError = String(error?.message || error);
        await logEvent(env, "error", "failed to relay topic message", { threadId: message.message_thread_id, error: rawError });
        const translated = localizeLogEntry("failed to relay topic message", JSON.stringify({ error: rawError }));
        const lines = [`回复用户失败：${translated.reason}`];
        if (translated.suggestion) lines.push(`处理建议：${translated.suggestion}`);
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(message.message_thread_id),
            text: lines.join("\n"),
        }).catch(() => {});
    }
}

async function handleTopicAdminCommand(env, message) {
    const groupId = await topicGroupId(env);
    if (!groupId || Number(message.chat?.id) !== groupId || !message.message_thread_id) return;
    const user = await getUserWithIdentityByTopicThreadId(env, groupId, Number(message.message_thread_id));
    if (!user) {
        // 共享群组中可能是其他 Bot 拥有的话题，不回应可避免跨 Bot 干扰。
        return;
    }
    if (!(await isAdminChat(env, message.from?.id))) {
        await tgCall(env, "sendMessage", {
            chat_id: groupId,
            message_thread_id: Number(message.message_thread_id),
            text: "无权限。",
        }).catch(() => {});
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
        `消息接收：${user.inbound_muted ? "已静默隔离" : "正常"}`,
        `话题：${user.topic_thread_id || "无"}`,
        `备注：${user.note || "无"}`,
        "人工确认标签：" + (user.identity_label_name || "无"),
        "V2人工确认：" + (user.fingerprint_label_name || "无"),
        "V2完整指纹：" + (user.latest_fingerprint_hash ? String(user.latest_fingerprint_hash).slice(0, 20) : "无"),
    ].join("\n");
}

function topicAdminKeyboard(user) {
    const verifyButton = user.verified
        ? { text: "取消验证", callback_data: `topicadmin:cancel:${user.user_id}` }
        : { text: "通过验证", callback_data: `topicadmin:approve:${user.user_id}` };
    const blockButton = user.blocked
        ? { text: "取消拉黑", callback_data: `topicadmin:unban:${user.user_id}` }
        : { text: "拉黑", callback_data: `topicadmin:ban:${user.user_id}` };
    const muteButton = user.inbound_muted
        ? { text: "解除隔离", callback_data: `topicadmin:unmute:${user.user_id}` }
        : { text: "静默隔离", callback_data: `topicadmin:mute:${user.user_id}` };
    return {
        inline_keyboard: [
            [verifyButton],
            [blockButton],
            [muteButton],
            [{ text: "获取用户信息", callback_data: `topicadmin:who:${user.user_id}` }],
            [{ text: "重建话题", callback_data: `topicadmin:rebuild:${user.user_id}` }],
            [
                { text: "标记 WebRTC", callback_data: "rtcmark:" + user.user_id },
                { text: "WebRTC 标签", callback_data: "rtclabels:" + user.user_id },
            ],
            [
                { text: "标记指纹", callback_data: `fpmark:${user.user_id}:${user.latest_fingerprint_slot || 0}:${String(user.latest_fingerprint_hash || "").slice(0, 12)}` },
                { text: "指纹标签", callback_data: `fplabels:${user.user_id}` },
            ],
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
    const user = await getUserWithIdentity(env, userId);
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
        await setBlock(env, userId, true, `Telegram 话题按钮拉黑（管理员 ${adminId}）`);
        await tgSendMessage(env, userId, "管理员已将你加入黑名单，后续消息不会被转发。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已拉黑");
    } else if (action === "unban") {
        await setBlock(env, userId, false);
        await tgSendMessage(env, userId, "管理员已取消你的拉黑状态。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已取消拉黑");
    } else if (action === "mute") {
        await setInboundMuted(env, userId, true, `Telegram 话题按钮隔离（管理员 ${adminId}）`);
        await answerCallbackQuery(env, query.id, "已开启静默隔离");
    } else if (action === "unmute") {
        await setInboundMuted(env, userId, false);
        await answerCallbackQuery(env, query.id, "已解除静默隔离");
    } else if (action === "who") {
        const threadId = Number(query.message?.message_thread_id || user.topic_thread_id || 0);
        await answerCallbackQuery(env, query.id, "已发送用户信息");
        if (groupId && threadId) {
            await tgCall(env, "sendMessage", { chat_id: groupId, message_thread_id: threadId, text: formatUserInfo(await getUserWithIdentity(env, userId)) });
        }
    } else if (action === "rebuild") {
        await ensureUserTopic(env, userId, { forceNew: true, reason: "topicadmin:rebuild" });
        await answerCallbackQuery(env, query.id, "已重建话题");
    } else {
        await answerCallbackQuery(env, query.id, "未知操作");
        return;
    }
    if (groupId && query.message?.message_thread_id && action !== "rebuild") {
        const latest = await getUserWithIdentity(env, userId);
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
        if (options.reason !== "verify") {
            await sendCurrentWebRtcIdentityToTopic(env, user, { chatId: groupId, threadId }).catch((error) => (
                logEvent(env, "warn", "failed to send current WebRTC identity label", { userId, error: String(error?.message || error) })
            ));
        }
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

async function sendCurrentWebRtcIdentityToTopic(env, user, topic) {
    const latestUser = await getUser(env, Number(user.user_id));
    if (!latestUser) return;
    const match = await findWebRtcIdentityLabel(env, Number(latestUser.user_id), {
        webrtc_ipv4: latestUser.last_webrtc_ipv4,
        webrtc_ipv6: latestUser.last_webrtc_ipv6,
    });
    if (!match.label) return;
    const payload = {
        chat_id: topic.chatId,
        message_thread_id: topic.threadId,
        text: [
            match.label.confirmed ? "WebRTC 标签（管理员已确认）" : "WebRTC 标签命中（待人工确认）",
            "标签：" + (match.label.label_name || "未设置"),
            "来源用户 ID：" + (match.label.source_user_id || "-"),
            "匹配依据：WebRTC " + (match.ipVersion || "-") + " 完全相同",
        ].join("\n"),
    };
    if (!match.label.confirmed) {
        payload.reply_markup = {
            inline_keyboard: [[{
                text: "确认同一人",
                callback_data: "rtcconfirm:" + latestUser.user_id + ":" + match.label.id,
            }]],
        };
    }
    await tgCall(env, "sendMessage", payload);
}

function topicVerificationText(info) {
    const lines = [
        "本次验证信息",
        `HTTP IP：${info.httpIp || "-"}`,
        `公网 IPv4：${info.httpIpv4 || "-"}`,
        `公网 IPv6：${info.httpIpv6 || "-"}`,
        `WebRTC IPv4：${info.webrtcIpv4 || "-"}`,
        `WebRTC IPv6：${info.webrtcIpv6 || "-"}`,
        `WebRTC ASN：${info.webRtcAsn || "-"}`,
        `WebRTC ISP：${info.webRtcIsp || "-"}`,
        `UDP 状态：${info.udpStatus || "-"}`,
        `ASN：${info.asn || "-"}`,
        `运营商：${info.asOrganization || "-"}`,
        `国家/地区：${info.country || "-"}`,
        `设备系统：${info.deviceOs || "-"}`,
        `完整指纹：${info.fingerprintHash ? info.fingerprintHash.slice(0, 20) : "-"}`,
        `指纹质量：${info.fingerprintQuality || 0}%`,
    ];
    if (info.fingerprintSummary?.model || info.fingerprintSummary?.performanceClass || info.fingerprintSummary?.telegramPlatform) {
        lines.push(
            `设备型号：${info.fingerprintSummary.model || "-"}`,
            `性能等级：${info.fingerprintSummary.performanceClass || "-"}`,
            `时区：${info.fingerprintSummary.timezone || "-"}`,
            `语言：${info.fingerprintSummary.language || "-"}`,
            `Telegram 客户端：${[info.fingerprintSummary.telegramPlatform, info.fingerprintSummary.telegramVersion].filter(Boolean).join(" ") || "-"}`,
        );
    }
    if (info.autoBlocked) {
        lines.push(
            "",
            "已按指纹自动拉黑",
            `标签：${info.autoBlocked.labelName}`,
            `分数：${info.autoBlocked.score}%`,
            `依据：${info.autoBlocked.tierLabel || "指纹匹配"}`,
        );
    }
    if (info.webrtcIdentityLabelId) {
        lines.push(
            "",
            info.webrtcIdentityConfirmed ? "WebRTC 标签（管理员已确认）" : "WebRTC 标签命中（待人工确认）",
            "标签：" + (info.webrtcIdentityLabelName || "未设置"),
            "来源用户 ID：" + (info.webrtcIdentitySourceUserId || "-"),
            "匹配依据：WebRTC " + (info.webrtcIdentityIpVersion || "-") + " 完全相同",
        );
    }
    if (info.fingerprintMatches?.length) lines.push("", fingerprintMatchText(info.fingerprintMatches));
    return lines.join("\n");
}

// 返回值表示验证详情是否已经送进话题；未送达时由 notifyVerificationSuccess 走私聊兜底。
async function completeTopicVerification(env, userId, info) {
    if (!(await topicEnabled(env))) return false;
    if ((await topicCreatePolicy(env)) !== "after_verify") return false;
    try {
        const topic = await ensureUserTopic(env, userId, { reason: "verify" });
        if (!topic) return false;
        const payload = {
            chat_id: topic.chatId,
            message_thread_id: topic.threadId,
            text: topicVerificationText(info),
            disable_web_page_preview: true,
        };
        const confirmationRows = [];
        if (info.webrtcIdentityLabelId && !info.webrtcIdentityConfirmed) {
            confirmationRows.push([{
                text: "确认同一人（WebRTC）",
                callback_data: "rtcconfirm:" + userId + ":" + info.webrtcIdentityLabelId,
            }]);
        }
        const fingerprintPrefix = String(info.fingerprintHash || "").slice(0, 12);
        const fingerprintSlot = Number(info.fingerprintSlot || 0);
        const firstMatch = info.fingerprintMatches?.[0];
        if (firstMatch && fingerprintPrefix && fingerprintSlot) {
            confirmationRows.push(fingerprintMatchButtons(userId, firstMatch, fingerprintSlot, fingerprintPrefix, Boolean(info.autoBlocked)));
        }
        if (fingerprintPrefix && fingerprintSlot) {
            confirmationRows.push([
                { text: "标记指纹", callback_data: `fpmark:${userId}:${fingerprintSlot}:${fingerprintPrefix}` },
                { text: "指纹标签", callback_data: `fplabels:${userId}` },
            ]);
        }
        if (confirmationRows.length) {
            payload.reply_markup = {
                inline_keyboard: confirmationRows,
            };
        }
        await tgCall(env, "sendMessage", payload);
        return true;
    } catch (error) {
        await logEvent(env, "error", "failed to complete topic verification", { userId, error: String(error?.message || error) });
        return false;
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

async function getUserWithIdentityByTopicThreadId(env, chatId, threadId) {
    return env.DB.prepare(USER_WITH_IDENTITY_SELECT + " WHERE u.topic_chat_id=? AND u.topic_thread_id=?")
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
            const extra = String(command.args || "").trim().slice(String(uid).length).trim();
            await setBlock(env, uid, true, extra || `Telegram /block 命令（管理员 ${chatId}）`);
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
            const row = await getUserWithIdentity(env, uid);
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
        await logEvent(env, "error", "failed to execute Telegram command", {
            chatId,
            command: command.name,
            error: String(error?.message || error),
        });
        await sendUserNoticeSafely(env, chatId, `命令执行失败：${String(error?.message || error)}`, { command: command.name });
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
    return `用户信息\nuser_id: ${row.user_id}\nusername: @${row.username || ""}\nfull_name: ${row.full_name || ""}\nblocked: ${Boolean(row.blocked)}\ninbound_muted: ${Boolean(row.inbound_muted)}\nverified: ${Boolean(row.verified)}\nstatus: ${row.verification_status || "-"}\nnote: ${row.note || ""}\nwebrtc_identity_label: ${row.identity_label_name || "-"}\nHTTP IPv4: ${row.last_http_ipv4 || "-"}\nHTTP IPv6: ${row.last_http_ipv6 || "-"}\nUDP IPv4: ${row.last_webrtc_ipv4 || "-"}\nUDP IPv6: ${row.last_webrtc_ipv6 || "-"}\nASN: ${row.last_asn || "-"}\ntopic_thread_id: ${row.topic_thread_id || "-"}\ntopic_status: ${row.topic_status || "-"}\nupdated_at: ${row.updated_at}`;
}

async function relayUserMessage(env, message) {
    const user = message.from || {};
    await upsertUser(env, user);
    if (await isBlocked(env, user.id)) return;
    if (!(await isVerified(env, user.id))) {
        await sendVerificationPrompt(env, message.chat.id, user, "请先完成验证后再开始聊天。验证通过前，你发送的消息不会被转发。")
            .catch((error) => logEvent(env, "warn", "failed to notify user", { userId: user.id, stage: "verification", error: String(error?.message || error) }));
        return;
    }
    if (await rateLimited(env, user.id)) {
        await sendUserNoticeSafely(env, message.chat.id, "发送太快了，请稍后再试。", { userId: user.id, stage: "rate-limit" });
        return;
    }
    const textValue = messageText(message);
    // 重复内容闸。慢速刷屏（每条隔一两分钟）能躲开所有按速率设的闸门，
    // 但躲不开「内容是同一句」这个特征，所以这一闸按内容判而不是按频率判。
    const repeatCount = await repetitiveSpamCount(env, user.id, textValue);
    if (repeatCount) {
        await setBlock(env, user.id, true, `重复刷屏：${repeatCount} 次相同内容`);
        const repeatNotice = `[重复刷屏已拉黑]\nuser_id: <code>${user.id}</code>\n重复次数：${repeatCount}\n内容：${h(textValue.slice(0, 300))}`;
        await notifyAdmins(env, repeatNotice);
        // 纯 topic 模式下 notifyAdmins 会跳过，改往该用户已有话题补一条，避免自动拉黑无人知情。
        if (!(await webRelayEnabled(env))) {
            const posted = await postToExistingUserTopic(env, Number(user.id), `[重复刷屏已拉黑]\nuser_id: ${user.id}\n重复次数：${repeatCount}\n内容：${textValue.slice(0, 300)}`);
            if (!posted) await notifyAdmins(env, repeatNotice, {}, { force: true });
        }
        await logEvent(env, "warn", "repetitive spam blocked", { userId: Number(user.id), repeatCount });
        await sendUserNoticeSafely(env, message.chat.id, "检测到重复内容刷屏，已停止转发。", { userId: user.id, stage: "repeat-spam" });
        return;
    }
    const inboxId = await createInboxMessage(env, message);
    const hits = await spamHits(env, textValue);
    const autoBlock = await getSetting(env, "spam_auto_block", "true");
    if (hits.length && autoBlock !== "false") {
        await setBlock(env, user.id, true, `广告关键词自动拉黑：${hits.join("、")}`);
        await markInboxError(env, inboxId, `spam: ${hits.join(", ")}`);
        const spamNotice = `[垃圾消息已拉黑]\nuser_id: <code>${user.id}</code>\n命中：${h(hits.join(", "))}\n内容：${h(textValue.slice(0, 300))}`;
        await notifyAdmins(env, spamNotice);
        // 纯 topic 模式下 notifyAdmins 会跳过，改往该用户已有话题补一条，避免自动拉黑无人知情。
        if (!(await webRelayEnabled(env))) {
            const posted = await postToExistingUserTopic(env, Number(user.id), `[垃圾消息已拉黑]\nuser_id: ${user.id}\n命中：${hits.join(", ")}\n内容：${textValue.slice(0, 300)}`);
            if (!posted) await notifyAdmins(env, spamNotice, {}, { force: true });
        }
        await sendUserNoticeSafely(env, message.chat.id, "消息已被系统拦截。", { userId: user.id, stage: "spam" });
        return;
    }
    const row = await getInboxMessage(env, inboxId);
    try {
        await relayInboxByMode(env, row, message);
    } catch (error) {
        await markInboxError(env, inboxId, String(error));
        await logEvent(env, "error", "failed to relay user message", { inboxId, error: String(error) });
        await sendUserNoticeSafely(env, message.chat.id, "已收到消息，但转发管理员暂时失败。", { userId: user.id, inboxId, stage: "relay-failed" });
        return;
    }
    // 转发成功后不再给用户发送自动回执，全部回复由管理员真人发出。
}

async function relayStoredInboxToAdmins(env, row, originalMessage = null) {
    const ids = await adminChatIds(env);
    if (!ids.length) throw new Error("未配置管理员 ADMIN_CHAT_IDS");
    const user = await getUserWithIdentity(env, Number(row.user_id));
    const note = user?.note || "";
    const identityLabel = user?.identity_label_name || "";
    let firstHeaderId = null;
    let firstCopyId = null;
    let sentAny = false;
    for (const adminId of ids) {
        const header = `[用户消息 #${row.id}]\nuser_id: <code>${row.user_id}</code>\nname: ${h(row.full_name || "")}\nusername: @${h(row.username || "")}\nnote: ${h(note)}\n人工确认标签: ${h(identityLabel || "-")}\ntime: ${h(nowIso())}`;
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

async function notifyAdmins(env, textValue, extraPayload = {}, options = {}) {
    if (!options.force && !(await webRelayEnabled(env))) return;
    const ids = await adminChatIds(env);
    for (const id of ids) {
        try {
            await tgCall(env, "sendMessage", { chat_id: id, text: textValue, parse_mode: "HTML", disable_web_page_preview: true, ...extraPayload });
        } catch (error) {
            await logEvent(env, "error", "failed to notify admin", { id, error: String(error) });
        }
    }
}

// 只往已经存在的话题发通知；不创建、不重建、不解绑任何话题，也不写入消息记录表。
async function postToExistingUserTopic(env, userId, textValue) {
    if (!(await topicEnabled(env))) return false;
    const user = await getUser(env, userId);
    const chatId = Number(user?.topic_chat_id || 0);
    const threadId = Number(user?.topic_thread_id || 0);
    if (!chatId || !threadId) return false;
    try {
        await tgCall(env, "sendMessage", {
            chat_id: chatId,
            message_thread_id: threadId,
            text: String(textValue || "").slice(0, 3900),
            disable_web_page_preview: true,
        });
        return true;
    } catch (error) {
        await logEvent(env, "warn", "failed to post notice to user topic", { userId, error: String(error?.message || error) });
        return false;
    }
}

async function tgSendMessage(env, chatId, textValue) {
    return tgCall(env, "sendMessage", { chat_id: chatId, text: textValue });
}

async function sendUserNoticeSafely(env, chatId, textValue, context = {}) {
    try {
        return await tgSendMessage(env, chatId, textValue);
    } catch (error) {
        await logEvent(env, "warn", "failed to notify user", {
            ...context,
            chatId: Number(chatId),
            error: String(error?.message || error),
        });
        return null;
    }
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

async function getUserWithIdentity(env, userId) {
    return env.DB.prepare(USER_WITH_IDENTITY_SELECT + " WHERE u.user_id=?").bind(userId).first();
}

async function isBlocked(env, userId) {
    const row = await getUser(env, userId);
    return Boolean(row?.blocked);
}

// reason 只在置为封禁时写入；解封会一并清空原因和时间，避免旧原因残留误导。
async function setBlock(env, userId, blocked, reason = "") {
    const ts = nowIso();
    if (blocked) {
        await env.DB.prepare("UPDATE users SET blocked=1, block_reason=?, blocked_at=?, updated_at=? WHERE user_id=?")
            .bind(String(reason || "").slice(0, 300), ts, ts, userId)
            .run();
        return;
    }
    await env.DB.prepare("UPDATE users SET blocked=0, block_reason='', blocked_at='', updated_at=? WHERE user_id=?")
        .bind(ts, userId)
        .run();
}

async function isInboundMuted(env, userId) {
    const row = await getUser(env, userId);
    return Boolean(row?.inbound_muted);
}

async function setInboundMuted(env, userId, muted, reason = "") {
    const ts = nowIso();
    if (muted) {
        await env.DB.prepare("UPDATE users SET inbound_muted=1, mute_reason=?, muted_at=?, updated_at=? WHERE user_id=?")
            .bind(String(reason || "").slice(0, 300), ts, ts, userId)
            .run();
        return;
    }
    await env.DB.prepare("UPDATE users SET inbound_muted=0, mute_reason='', muted_at='', updated_at=? WHERE user_id=?")
        .bind(ts, userId)
        .run();
}

async function claimTelegramUpdate(env, updateId) {
    const result = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id, received_at) VALUES(?, ?)")
        .bind(Number(updateId), nowIso())
        .run();
    return Number(result.meta?.changes || 0) > 0;
}

async function releaseTelegramUpdate(env, updateId) {
    await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=?").bind(Number(updateId)).run();
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

// 两档限流。只做短窗口时，每 90 秒发一条的骚扰永远落在 10 秒窗口之外，
// 能连续刷十几个小时不被拦，所以长窗口这一档是必需的。
// 表按长窗口清理、短窗口计数带 ts 条件筛，否则短窗口的清理会把长窗口的记录一起删掉。
async function rateLimited(env, userId) {
    const windowSeconds = Number(await getSetting(env, "rate_window_seconds", "10"));
    const maxMessages = Number(await getSetting(env, "rate_max_messages", "4"));
    const longWindowSeconds = Number(await getSetting(env, "rate_long_window_seconds", "3600"));
    const longMaxMessages = Number(await getSetting(env, "rate_long_max_messages", "30"));
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM rate_events WHERE user_id=? AND ts<?").bind(userId, now - longWindowSeconds).run();
    await env.DB.prepare("INSERT INTO rate_events(user_id, ts) VALUES(?, ?)").bind(userId, now).run();
    const count = await scalar(env, "SELECT COUNT(*) FROM rate_events WHERE user_id=? AND ts>=?", userId, now - windowSeconds);
    if (count > maxMessages) return true;
    const longCount = await scalar(env, "SELECT COUNT(*) AS long_hits FROM rate_events WHERE user_id=? AND ts>=?", userId, now - longWindowSeconds);
    return longCount > longMaxMessages;
}

// 同一段文本反复发。调用点在写入 inbox 之前，所以这里查到的是「之前已经发过几次」，
// 达到上限就说明当前这条又是同一句，直接拦掉。
async function repetitiveSpamCount(env, userId, textValue) {
    const text = String(textValue || "").trim();
    if (text.length < 2) return 0;
    const windowMinutes = Number(await getSetting(env, "repeat_window_minutes", "60"));
    const maxRepeat = Number(await getSetting(env, "repeat_max_messages", "5"));
    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const count = await scalar(env, "SELECT COUNT(*) AS repeat_hits FROM inbox_messages WHERE user_id=? AND text=? AND created_at>=?", userId, text, since);
    return count >= maxRepeat ? count : 0;
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
        text: `${h(textValue)}\n\n如无法打开 Telegram 内验证，请使用 <a href="${h(link)}">浏览器备用验证</a>。`,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: "打开验证界面", web_app: { url: link } }]],
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
    const parts = data.split(":");
    const [action, rawUserId, rawLabelId, rawSlot, rawPrefix] = parts;
    if (action === "fpmark") {
        const userId = Number(rawUserId);
        if (!Number.isFinite(userId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const result = await markFingerprintLabel(env, userId, adminId, String(rawSlot || ""));
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        await answerCallbackQuery(env, query.id, "指纹标签已保存");
        await sendCallbackContextMessage(env, query, `已标记指纹\n用户 ID：${userId}\n标签：${result.label.label_name}\n完整指纹：${result.latest.profile.exactHash.slice(0, 20)}\n该用户已记为管理员确认。`);
        return;
    }
    if (action === "fplabels") {
        const userId = Number(rawUserId);
        if (!Number.isFinite(userId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        await answerCallbackQuery(env, query.id, "已发送指纹标签");
        await sendFingerprintLabels(env, query, userId);
        return;
    }
    if (action === "fpdelete") {
        const labelId = Number(rawUserId);
        if (!Number.isFinite(labelId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const deleted = await deleteFingerprintLabel(env, labelId);
        await answerCallbackQuery(env, query.id, deleted ? "指纹标签已删除" : "标签不存在");
        if (deleted) await sendCallbackContextMessage(env, query, `已删除指纹标签 #${labelId}：${deleted.label_name}`);
        return;
    }
    if (action === "fpconfirm") {
        const userId = Number(rawUserId);
        const labelId = Number(rawLabelId);
        if (!Number.isFinite(userId) || !Number.isFinite(labelId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const result = await confirmFingerprintMatch(env, userId, labelId, adminId, String(rawPrefix || ""));
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        await answerCallbackQuery(env, query.id, "已人工确认同一人");
        await sendCallbackContextMessage(env, query, `已人工确认\n用户 ID：${userId}\n标签：${result.label.label_name}\n相似度：${result.match.score}%\n判定：${result.match.tierLabel || "相似指纹"}\n依据：${result.match.evidence?.join("、") || "相似指纹"}`);
        return;
    }
    // 确认同一人并立即拉黑，一步完成。封禁原因自动写入标签与分数。
    if (action === "fpban") {
        const userId = Number(rawUserId);
        const labelId = Number(rawLabelId);
        if (!Number.isFinite(userId) || !Number.isFinite(labelId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const result = await confirmFingerprintMatch(env, userId, labelId, adminId, String(rawPrefix || ""));
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        const reason = `指纹匹配拉黑：${result.label.label_name}（${result.match.score}%，${result.match.tierLabel || "指纹匹配"}）`;
        await setBlock(env, userId, true, reason);
        await tgSendMessage(env, userId, "管理员已将你加入黑名单，后续消息不会被转发。").catch(() => {});
        await answerCallbackQuery(env, query.id, "已确认并拉黑");
        await sendCallbackContextMessage(env, query, `已确认并拉黑\n用户 ID：${userId}\n标签：${result.label.label_name}\n相似度：${result.match.score}%\n判定：${result.match.tierLabel || "指纹匹配"}\n封禁原因：${reason}`);
        return;
    }
    if (action === "rtcmark") {
        const userId = Number(rawUserId);
        const user = Number.isFinite(userId) ? await getUser(env, userId) : null;
        if (!user) {
            await answerCallbackQuery(env, query.id, "找不到用户");
            return;
        }
        const result = await markWebRtcIdentityLabel(env, user, adminId, String(rawLabelId || ""));
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        await answerCallbackQuery(env, query.id, "WebRTC 标签已保存");
        await sendCallbackContextMessage(
            env,
            query,
            "已标记 WebRTC\n用户 ID：" + userId + "\n标签：" + result.labelName + "\n地址类型：" + result.identity.ipVersion + "\n该用户已记为管理员确认。",
        );
        return;
    }
    if (action === "rtclabels") {
        const userId = Number(rawUserId);
        if (!Number.isFinite(userId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        await answerCallbackQuery(env, query.id, "已发送 WebRTC 标签");
        await sendWebRtcIdentityLabels(env, query, userId);
        return;
    }
    if (action === "rtcdelete") {
        const labelId = Number(rawUserId);
        if (!Number.isFinite(labelId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const deleted = await deleteWebRtcIdentityLabel(env, labelId);
        await answerCallbackQuery(env, query.id, deleted ? "标签已删除" : "标签不存在");
        if (deleted) await sendCallbackContextMessage(env, query, "已删除 WebRTC 标签 #" + labelId + "：" + deleted.label_name);
        return;
    }
    if (action === "rtcconfirm") {
        const userId = Number(rawUserId);
        const labelId = Number(rawLabelId);
        if (!Number.isFinite(userId) || !Number.isFinite(labelId)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const result = await confirmWebRtcIdentityLabel(env, userId, labelId, adminId);
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        await answerCallbackQuery(env, query.id, "已人工确认同一人");
        await sendCallbackContextMessage(env, query, "已人工确认\n用户 ID：" + userId + "\n标签：" + result.label.label_name + "\n依据：当前 WebRTC 完全相同。");
        return;
    }
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
        await setBlock(env, userId, true, `Telegram 验证通知按钮拉黑（管理员 ${adminId}）`);
        await answerCallbackQuery(env, query.id, "已拉黑");
        await tgSendMessage(env, adminId, `已拉黑用户 ${userId}。`);
        return;
    }
    if (action === "who") {
        const row = await getUserWithIdentity(env, userId);
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

async function notifyVerificationSuccess(env, userId, token, info, topicDelivered = false) {
    const username = info.username ? `@${h(info.username)}` : "无";
    const identityText = info.webrtcIdentityLabelId
        ? `\n\n${info.webrtcIdentityConfirmed ? "WebRTC 标签（管理员已确认）" : "WebRTC 标签命中（待人工确认）"}\n标签：${h(info.webrtcIdentityLabelName || "未设置")}\n来源用户 ID：<code>${info.webrtcIdentitySourceUserId || "-"}</code>\n匹配依据：WebRTC ${h(info.webrtcIdentityIpVersion || "-")} 完全相同`
        : "";
    const fingerprintMatchesText = (info.fingerprintMatches || []).length
        ? "\n\n" + h(fingerprintMatchText(info.fingerprintMatches))
        : "";
    const autoBlockText = info.autoBlocked
        ? `\n\n已按指纹自动拉黑\n标签：${h(info.autoBlocked.labelName)}\n分数：${info.autoBlocked.score}%\n依据：${h(info.autoBlocked.tierLabel || "指纹匹配")}`
        : "";
    const fingerprintText = `\n\n指纹 V2\n完整哈希：<code>${h(info.fingerprintHash ? info.fingerprintHash.slice(0, 24) : "-")}</code>\n质量：${Number(info.fingerprintQuality || 0)}%\n设备型号：${h(info.fingerprintSummary?.model || "-")}\n性能等级：${h(info.fingerprintSummary?.performanceClass || "-")}\n时区：${h(info.fingerprintSummary?.timezone || "-")}\n语言：${h(info.fingerprintSummary?.language || "-")}\nTelegram 客户端：${h([info.fingerprintSummary?.telegramPlatform, info.fingerprintSummary?.telegramVersion].filter(Boolean).join(" ") || "-")}${autoBlockText}${fingerprintMatchesText}`;
    const textValue = `新用户验证通过\n用户 ID：<code>${userId}</code>\n昵称：${h(info.fullName || "-")}\n用户名：${username}\n语言：${h(info.languageCode || "-")}\n\n本次验证信息\n设备系统：${h(info.deviceOs || "-")}\nHTTP IP：<code>${h(info.httpIp || "-")}</code>\nHTTP IP 类型：${h(info.httpIpVersion || "-")}\n公网 IPv4：<code>${h(info.httpIpv4 || "-")}</code>\n公网 IPv6：<code>${h(info.httpIpv6 || "-")}</code>\n公网 ASN：${h(info.asn || "-")}\n运营商：${h(info.asOrganization || "-")}\n国家/地区：${h(info.country || "-")}\nCloudflare 机房：${h(info.colo || "-")}\n\nUDP / WebRTC 信息\nWebRTC IPv4：<code>${h(info.webrtcIpv4 || "-")}</code>\nWebRTC IPv6：<code>${h(info.webrtcIpv6 || "-")}</code>\nWebRTC ASN：${h(info.webRtcAsn || "-")}\nWebRTC ISP：${h(info.webRtcIsp || "-")}\nUDP 状态：${h(info.udpStatus || "-")}\nCandidate 类型：${h(info.candidateType || "-")}${identityText}${fingerprintText}`;
    const keyboard = [];
    if (info.webrtcIdentityLabelId && !info.webrtcIdentityConfirmed) {
        keyboard.push([{ text: "确认同一人（WebRTC）", callback_data: "rtcconfirm:" + userId + ":" + info.webrtcIdentityLabelId }]);
    }
    const fingerprintPrefix = String(info.fingerprintHash || "").slice(0, 12);
    const fingerprintSlot = Number(info.fingerprintSlot || 0);
    const firstMatch = info.fingerprintMatches?.[0];
    if (firstMatch && fingerprintPrefix && fingerprintSlot) {
        keyboard.push(fingerprintMatchButtons(userId, firstMatch, fingerprintSlot, fingerprintPrefix, Boolean(info.autoBlocked)));
    }
    if (fingerprintPrefix && fingerprintSlot) {
        keyboard.push([
            { text: "标记指纹", callback_data: `fpmark:${userId}:${fingerprintSlot}:${fingerprintPrefix}` },
            { text: "指纹标签", callback_data: `fplabels:${userId}` },
        ]);
    }
    const rtcActions = [{ text: "WebRTC 标签", callback_data: "rtclabels:" + userId }];
    if (info.webrtcIdentityHash) {
        rtcActions.unshift({ text: "标记 WebRTC", callback_data: "rtcmark:" + userId + ":" + info.webrtcIdentityHash });
    }
    keyboard.push(rtcActions);
    keyboard.push(
        [{ text: "取消验证", callback_data: `unverify:${userId}` }],
        [{ text: "拉黑", callback_data: `block:${userId}` }],
        [{ text: "获取用户名", callback_data: `who:${userId}` }],
    );
    const replyMarkup = { reply_markup: { inline_keyboard: keyboard } };
    await notifyAdmins(env, textValue, replyMarkup);
    // 纯 topic 模式下 notifyAdmins 会跳过；若验证详情也没能进话题（例如 first_message 策略下
    // 话题尚未创建），就强制走管理员私聊，保证这次验证的网络与指纹信息不会无声丢失。
    if (!topicDelivered && !(await webRelayEnabled(env))) {
        await notifyAdmins(env, textValue, replyMarkup, { force: true });
    }
}

function parseClientData(value) {
    const raw = String(value || "");
    if (!raw) return {};
    if (raw.length > 6000) return { parse_error: "client_data_too_large" };
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        return { parse_error: String(error.message || error) };
    }
}

export function extractClientNetwork(clientData, httpIp) {
    const webrtc = clientData?.webrtc && typeof clientData.webrtc === "object" ? clientData.webrtc : {};
    const trustedHttpIp = cleanIp(httpIp);
    const httpIpv4 = ipVersion(trustedHttpIp) === "IPv4" ? trustedHttpIp : "";
    const httpIpv6 = ipVersion(trustedHttpIp) === "IPv6" ? trustedHttpIp : "";
    const rawCandidates = Array.isArray(webrtc.candidates) ? webrtc.candidates : [];
    const candidateBuckets = { IPv4: [], IPv6: [] };
    const seenCandidates = new Set();
    for (const candidate of rawCandidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const protocol = String(candidate.protocol || "").trim().toLowerCase();
        const type = String(candidate.type || "").trim().toLowerCase();
        if (protocol !== "udp" || type !== "srflx") continue;
        const ip = cleanIp(candidate.ip);
        if (!ip || !isPublicWebRtcIp(ip)) continue;
        const version = ipVersion(ip);
        const bucket = candidateBuckets[version];
        if (!bucket || bucket.length >= 2) continue;
        const key = `${ip}|udp|srflx`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        bucket.push({ ip, version, protocol: "udp", type: "srflx" });
        if (candidateBuckets.IPv4.length >= 2 && candidateBuckets.IPv6.length >= 2) break;
    }
    candidateBuckets.IPv4.sort((left, right) => left.ip.localeCompare(right.ip));
    candidateBuckets.IPv6.sort((left, right) => left.ip.localeCompare(right.ip));
    const validCandidates = [...candidateBuckets.IPv4, ...candidateBuckets.IPv6];
    const webrtcIpv4Candidates = candidateBuckets.IPv4.map((candidate) => candidate.ip);
    const webrtcIpv6Candidates = candidateBuckets.IPv6.map((candidate) => candidate.ip);
    const webrtcIpv4 = webrtcIpv4Candidates[0] || "";
    const webrtcIpv6 = webrtcIpv6Candidates[0] || "";
    const reportedStatus = String(webrtc.udp_status || "").trim().toLowerCase();
    const udpStatus = validCandidates.length
        ? "success"
        : (["unsupported", "failed", "timeout", "empty"].includes(reportedStatus) ? reportedStatus : "empty");
    return {
        http_ipv4: httpIpv4,
        http_ipv6: httpIpv6,
        webrtc_ipv4: webrtcIpv4,
        webrtc_ipv6: webrtcIpv6,
        webrtc_protocol: validCandidates.length ? "udp" : "",
        webrtc_candidate_type: validCandidates.length ? "srflx" : "",
        udp_status: udpStatus,
        webrtc_candidates: validCandidates,
        webrtc_ipv4_candidates: webrtcIpv4Candidates,
        webrtc_ipv6_candidates: webrtcIpv6Candidates,
    };
}

function cleanIp(value, version = "") {
    const raw = String(value || "").trim().replace(/^\[|\]$/g, "");
    if (!raw || raw.length > 80) return "";
    const detected = ipVersion(raw);
    if (!detected || (version && detected !== version)) return "";
    if (detected === "IPv4") return raw.split(".").map(Number).join(".");
    return normalizeIpv6Address(raw);
}

function ipVersion(ip) {
    const value = String(ip || "").trim();
    if (!value) return "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        const octets = value.split(".").map(Number);
        if (octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return "IPv4";
    }
    if (value.includes(":") && normalizeIpv6Address(value)) return "IPv6";
    return "";
}

export function isPublicWebRtcIp(value) {
    const ip = cleanIp(value);
    const version = ipVersion(ip);
    if (version === "IPv4") {
        const parts = ip.split(".").map(Number);
        if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224) return false;
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;
        if (parts[0] === 169 && parts[1] === 254) return false;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
        if (parts[0] === 192 && parts[1] === 168) return false;
        if (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
        if (parts[0] === 192 && parts[1] === 88 && parts[2] === 99) return false;
        if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) return false;
        if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return false;
        return true;
    }
    if (version === "IPv6") {
        const normalized = normalizeIpv6Address(ip);
        if (!normalized || normalized.startsWith("2001:0db8:")) return false;
        const groups = normalized.split(":").map((part) => Number.parseInt(part, 16));
        if (groups[0] === 0x3ffe) return false;
        if (groups[0] === 0x3fff && groups[1] <= 0x0fff) return false;
        const firstGroup = Number.parseInt(normalized.slice(0, 4), 16);
        return firstGroup >= 0x2000 && firstGroup <= 0x3fff;
    }
    return false;
}

function requestCfInfo(request) {
    return {
        country: String(request.cf?.country || request.headers.get("CF-IPCountry") || ""),
        colo: String(request.cf?.colo || ""),
        asn: request.cf?.asn ? String(request.cf.asn) : "",
        asOrganization: String(request.cf?.asOrganization || ""),
    };
}

function detectDeviceOs(userAgent) {
    const ua = String(userAgent || "");
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    if (/Windows/i.test(ua)) return "Windows";
    if (/Mac OS|Macintosh/i.test(ua)) return "macOS";
    if (/Linux/i.test(ua)) return "Linux";
    return "Unknown";
}

async function ensureFingerprintV2Schema(env, schemaObjects) {
    const tables = [
        ["fingerprint_profiles_v2", `CREATE TABLE IF NOT EXISTS fingerprint_profiles_v2 (
            user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
            algorithm_version INTEGER NOT NULL DEFAULT 2 CHECK(algorithm_version BETWEEN 1 AND 255),
            exact_hash TEXT NOT NULL CHECK(length(exact_hash) IN (43,64)),
            device_simhash TEXT NOT NULL CHECK(length(device_simhash)=16 AND device_simhash NOT GLOB '*[^0-9a-f]*'),
            device_feature_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_feature_mask BETWEEN 0 AND 2147483647),
            font_bits TEXT NOT NULL CHECK(length(font_bits)=16 AND font_bits NOT GLOB '*[^0-9a-f]*'),
            font_minhash TEXT NOT NULL DEFAULT '[]' CHECK(length(font_minhash)<=2048 AND json_valid(font_minhash) AND json_type(font_minhash)='array'),
            device_vector TEXT NOT NULL DEFAULT '[]' CHECK(length(device_vector)<=2048 AND json_valid(device_vector) AND json_type(device_vector)='array'),
            device_vector_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_vector_mask BETWEEN 0 AND 2147483647),
            canvas_key TEXT NOT NULL DEFAULT '' CHECK(length(canvas_key) IN (0,43,64)),
            webgl_key TEXT NOT NULL DEFAULT '' CHECK(length(webgl_key) IN (0,43,64)),
            audio_key TEXT NOT NULL DEFAULT '' CHECK(length(audio_key) IN (0,43,64)),
            webrtc_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_keys)<=1024 AND json_valid(webrtc_keys) AND json_type(webrtc_keys)='array'),
            webrtc_asn_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_asn_keys)<=1024 AND json_valid(webrtc_asn_keys) AND json_type(webrtc_asn_keys)='array'),
            webrtc_isp_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_isp_keys)<=1024 AND json_valid(webrtc_isp_keys) AND json_type(webrtc_isp_keys)='array'),
            http_key TEXT NOT NULL DEFAULT '' CHECK(length(http_key) IN (0,43,64)),
            http_asn_key TEXT NOT NULL DEFAULT '' CHECK(length(http_asn_key) IN (0,43,64)),
            http_isp_key TEXT NOT NULL DEFAULT '' CHECK(length(http_isp_key) IN (0,43,64)),
            quality_score INTEGER NOT NULL DEFAULT 0 CHECK(quality_score BETWEEN 0 AND 100),
            summary_json TEXT NOT NULL DEFAULT '{}' CHECK(length(summary_json)<=4096 AND json_valid(summary_json) AND json_type(summary_json)='object'),
            seen_count INTEGER NOT NULL DEFAULT 1 CHECK(seen_count BETWEEN 1 AND 2147483647),
            first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(user_id,slot), UNIQUE(user_id,exact_hash)
        ) WITHOUT ROWID`],
        ["fingerprint_labels_v2", `CREATE TABLE IF NOT EXISTS fingerprint_labels_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label_name TEXT NOT NULL CHECK(length(label_name) BETWEEN 1 AND 80),
            note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=1000),
            state TEXT NOT NULL DEFAULT 'watch' CHECK(state IN ('watch','blacklist')),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, created_by_user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`],
        ["fingerprint_reference_profiles_v2", `CREATE TABLE IF NOT EXISTS fingerprint_reference_profiles_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, label_id INTEGER NOT NULL REFERENCES fingerprint_labels_v2(id) ON DELETE CASCADE,
            source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            source_slot INTEGER NOT NULL CHECK(source_slot BETWEEN 1 AND 3),
            algorithm_version INTEGER NOT NULL DEFAULT 2 CHECK(algorithm_version BETWEEN 1 AND 255),
            exact_hash TEXT NOT NULL CHECK(length(exact_hash) IN (43,64)),
            device_simhash TEXT NOT NULL CHECK(length(device_simhash)=16 AND device_simhash NOT GLOB '*[^0-9a-f]*'),
            device_feature_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_feature_mask BETWEEN 0 AND 2147483647),
            font_bits TEXT NOT NULL CHECK(length(font_bits)=16 AND font_bits NOT GLOB '*[^0-9a-f]*'),
            font_minhash TEXT NOT NULL DEFAULT '[]' CHECK(length(font_minhash)<=2048 AND json_valid(font_minhash) AND json_type(font_minhash)='array'),
            device_vector TEXT NOT NULL DEFAULT '[]' CHECK(length(device_vector)<=2048 AND json_valid(device_vector) AND json_type(device_vector)='array'),
            device_vector_mask INTEGER NOT NULL DEFAULT 0 CHECK(device_vector_mask BETWEEN 0 AND 2147483647),
            canvas_key TEXT NOT NULL DEFAULT '' CHECK(length(canvas_key) IN (0,43,64)),
            webgl_key TEXT NOT NULL DEFAULT '' CHECK(length(webgl_key) IN (0,43,64)),
            audio_key TEXT NOT NULL DEFAULT '' CHECK(length(audio_key) IN (0,43,64)),
            webrtc_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_keys)<=2048 AND json_valid(webrtc_keys) AND json_type(webrtc_keys)='array'),
            webrtc_asn_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_asn_keys)<=2048 AND json_valid(webrtc_asn_keys) AND json_type(webrtc_asn_keys)='array'),
            webrtc_isp_keys TEXT NOT NULL DEFAULT '[]' CHECK(length(webrtc_isp_keys)<=2048 AND json_valid(webrtc_isp_keys) AND json_type(webrtc_isp_keys)='array'),
            http_key TEXT NOT NULL CHECK(length(http_key) IN (43,64)),
            http_asn_key TEXT NOT NULL DEFAULT '' CHECK(length(http_asn_key) IN (0,43,64)),
            http_isp_key TEXT NOT NULL DEFAULT '' CHECK(length(http_isp_key) IN (0,43,64)),
            quality_score INTEGER NOT NULL DEFAULT 63 CHECK(quality_score BETWEEN 63 AND 100),
            summary_json TEXT NOT NULL DEFAULT '{}' CHECK(length(summary_json)<=4096 AND json_valid(summary_json) AND json_type(summary_json)='object'),
            created_by_user_id INTEGER NOT NULL, created_at TEXT NOT NULL, last_matched_at TEXT,
            match_count INTEGER NOT NULL DEFAULT 0 CHECK(match_count BETWEEN 0 AND 2147483647), UNIQUE(label_id,exact_hash)
        )`],
        ["fingerprint_reference_lookup_v2", `CREATE TABLE IF NOT EXISTS fingerprint_reference_lookup_v2 (
            kind INTEGER NOT NULL CHECK(kind BETWEEN 0 AND 4),
            band INTEGER NOT NULL CHECK((kind IN (0,1,2) AND band=0) OR (kind IN (3,4) AND band BETWEEN 0 AND 3)),
            lookup_key TEXT NOT NULL CHECK(length(lookup_key) BETWEEN 1 AND 256),
            reference_id INTEGER NOT NULL REFERENCES fingerprint_reference_profiles_v2(id) ON DELETE CASCADE,
            PRIMARY KEY(kind,band,lookup_key,reference_id)
        ) WITHOUT ROWID`],
        ["fingerprint_user_labels_v2", `CREATE TABLE IF NOT EXISTS fingerprint_user_labels_v2 (
            user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
            label_id INTEGER NOT NULL REFERENCES fingerprint_labels_v2(id) ON DELETE CASCADE,
            reference_id INTEGER REFERENCES fingerprint_reference_profiles_v2(id) ON DELETE SET NULL,
            confirmed_by_user_id INTEGER NOT NULL,
            match_method TEXT NOT NULL CHECK(length(match_method) BETWEEN 1 AND 32),
            weighted_score INTEGER NOT NULL CHECK(weighted_score BETWEEN 0 AND 100),
            evidence_mask INTEGER NOT NULL DEFAULT 0 CHECK(evidence_mask BETWEEN 0 AND 2147483647),
            confirmed_at TEXT NOT NULL
        ) WITHOUT ROWID`],
    ];
    for (const [name, sql] of tables) {
        if (!schemaObjects.has(`table:${name}`)) await env.DB.prepare(sql).run();
    }
    const indexes = [
        ["idx_fingerprint_labels_v2_state", "CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_state ON fingerprint_labels_v2(active,state,updated_at DESC)"],
        ["idx_fingerprint_labels_v2_source", "CREATE INDEX IF NOT EXISTS idx_fingerprint_labels_v2_source ON fingerprint_labels_v2(source_user_id,updated_at DESC)"],
        ["idx_fingerprint_reference_profiles_v2_label", "CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_profiles_v2_label ON fingerprint_reference_profiles_v2(label_id,created_at DESC)"],
        ["idx_fingerprint_reference_lookup_v2_reference", "CREATE INDEX IF NOT EXISTS idx_fingerprint_reference_lookup_v2_reference ON fingerprint_reference_lookup_v2(reference_id)"],
        ["idx_fingerprint_user_labels_v2_label", "CREATE INDEX IF NOT EXISTS idx_fingerprint_user_labels_v2_label ON fingerprint_user_labels_v2(label_id,confirmed_at DESC)"],
    ];
    for (const [name, sql] of indexes) {
        if (!schemaObjects.has(`index:${name}`)) await env.DB.prepare(sql).run();
    }
}

async function ensureVerificationSchema(env) {
    if (verificationSchemaReady) return;
    const schemaRows = await env.DB.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index')").all();
    const schemaObjects = new Set((schemaRows.results || []).map((row) => `${row.type}:${row.name}`));
    if (!schemaObjects.has("table:verification_sessions")) {
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
    }
    if (!schemaObjects.has("table:webrtc_identity_labels")) {
        await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS webrtc_identity_labels (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "webrtc_hash TEXT NOT NULL UNIQUE CHECK(length(webrtc_hash)=32), " +
            "label_name TEXT NOT NULL CHECK(length(label_name) BETWEEN 1 AND 80), " +
            "source_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, " +
            "created_by_user_id INTEGER NOT NULL, " +
            "ip_version TEXT NOT NULL CHECK(ip_version IN ('IPv4','IPv6')), " +
            "slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5), " +
            "created_at TEXT NOT NULL, " +
            "updated_at TEXT NOT NULL, " +
            "UNIQUE(source_user_id, slot))",
        ).run();
    }
    if (!schemaObjects.has("table:webrtc_identity_confirmations")) {
        await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS webrtc_identity_confirmations (" +
            "user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE, " +
            "label_id INTEGER NOT NULL REFERENCES webrtc_identity_labels(id) ON DELETE CASCADE, " +
            "confirmed_by_user_id INTEGER NOT NULL, " +
            "confirmed_at TEXT NOT NULL)",
        ).run();
    }
    if (!schemaObjects.has("table:telegram_updates")) {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_updates (
            update_id INTEGER PRIMARY KEY,
            received_at TEXT NOT NULL
        )`).run();
    }
    if (!schemaObjects.has("table:broadcasts")) {
        await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS broadcasts (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "content TEXT NOT NULL, " +
            "audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all','verified')), " +
            "target_total INTEGER NOT NULL DEFAULT 0, " +
            "cursor_user_id INTEGER NOT NULL DEFAULT 0, " +
            "sent_count INTEGER NOT NULL DEFAULT 0, " +
            "failed_count INTEGER NOT NULL DEFAULT 0, " +
            "status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','cancelled')), " +
            "preview_sent INTEGER NOT NULL DEFAULT 0, " +
            "created_by_user_id INTEGER NOT NULL DEFAULT 0, " +
            "created_at TEXT NOT NULL, " +
            "updated_at TEXT NOT NULL, " +
            "finished_at TEXT)",
        ).run();
    }
    if (!schemaObjects.has("table:broadcast_recipients")) {
        await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS broadcast_recipients (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE, " +
            "user_id INTEGER NOT NULL, " +
            "status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','failed')), " +
            "message_id INTEGER, " +
            "error TEXT DEFAULT '', " +
            "sent_at TEXT, " +
            "UNIQUE(broadcast_id, user_id))",
        ).run();
    }
    await ensureFingerprintV2Schema(env, schemaObjects);
    const userColumns = [
        "language_code TEXT DEFAULT ''",
        "inbound_muted INTEGER DEFAULT 0",
        "block_reason TEXT DEFAULT ''",
        "blocked_at TEXT DEFAULT ''",
        "mute_reason TEXT DEFAULT ''",
        "muted_at TEXT DEFAULT ''",
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
    await ensureColumns(env, "users", userColumns);
    await ensureColumns(env, "inbox_messages", inboxColumns);
    await ensureColumns(env, "ip_verifications", verificationColumns);
    const indexes = [
        { name: "idx_users_topic", sql: "CREATE INDEX IF NOT EXISTS idx_users_topic ON users(topic_chat_id, topic_thread_id)" },
        { name: "idx_users_inbound_muted", sql: "CREATE INDEX IF NOT EXISTS idx_users_inbound_muted ON users(inbound_muted, updated_at DESC)" },
        { name: "idx_users_blocked", sql: "CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked, updated_at DESC)" },
        { name: "idx_webrtc_identity_labels_source", sql: "CREATE INDEX IF NOT EXISTS idx_webrtc_identity_labels_source ON webrtc_identity_labels(source_user_id, updated_at DESC)" },
        { name: "idx_webrtc_identity_confirmations_label", sql: "CREATE INDEX IF NOT EXISTS idx_webrtc_identity_confirmations_label ON webrtc_identity_confirmations(label_id)" },
        { name: "idx_inbox_topic_created", sql: "CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at)" },
        { name: "idx_verification_sessions_user_created", sql: "CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at)" },
        { name: "idx_verification_sessions_status", sql: "CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status)" },
        { name: "idx_broadcasts_status", sql: "CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status, id)" },
        { name: "idx_broadcast_recipients_broadcast_status", sql: "CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_status ON broadcast_recipients(broadcast_id, status)" },
    ];
    for (const index of indexes) {
        if (!schemaObjects.has(`index:${index.name}`)) await env.DB.prepare(index.sql).run();
    }
    verificationSchemaReady = true;
}

async function ensureColumns(env, table, columns) {
    const rows = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const existing = new Set((rows.results || []).map((row) => String(row.name)));
    for (const columnSql of columns) {
        const columnName = String(columnSql).trim().split(/\s+/, 1)[0];
        if (!existing.has(columnName)) await addColumnIfMissing(env, table, columnSql);
    }
}

async function addColumnIfMissing(env, table, columnSql) {
    try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run();
    } catch (error) {
        const message = String(error?.message || error).toLowerCase();
        if (!message.includes("duplicate") && !message.includes("exists") && !message.includes("duplicate column")) throw error;
    }
}

// ---------- 全体通知（群发） ----------

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 目标人群恒定是「私聊过 Bot 的全部用户」，即 users 表。
// 已封禁用户始终排除：封禁是管理员主动踢掉的，不该收到通知。
// 静默隔离不排除：隔离的语义是管理员不看他的消息，和是否要通知他无关。
// verified 只是把范围收窄到活跃用户，不是身份门槛。
function broadcastAudienceFilter(audience) {
    return audience === "verified" ? " AND verified=1" : "";
}

function broadcastAudienceLabel(audience) {
    return audience === "verified" ? "仅已验证用户" : "全部用户";
}

async function broadcastAudienceCount(env, audience) {
    await ensureVerificationSchema(env);
    return scalar(env, "SELECT COUNT(*) FROM users WHERE blocked=0" + broadcastAudienceFilter(audience));
}

async function getBroadcast(env, id) {
    return env.DB.prepare("SELECT * FROM broadcasts WHERE id=?").bind(Number(id)).first();
}

async function getRunningBroadcast(env) {
    await ensureVerificationSchema(env);
    return env.DB.prepare("SELECT * FROM broadcasts WHERE status='running' ORDER BY id DESC LIMIT 1").first();
}

async function broadcastHistory(env, limit = 10) {
    await ensureVerificationSchema(env);
    const rows = await env.DB.prepare(
        "SELECT b.*, (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status='failed') AS failed_rows " +
        "FROM broadcasts b ORDER BY b.id DESC LIMIT ?",
    ).bind(Number(limit)).all();
    return (rows.results || []).map((row) => ({ ...row, failed: Math.max(Number(row.failed_count || 0), Number(row.failed_rows || 0)) }));
}

async function broadcastFailedSamples(env, broadcastId, limit = 5) {
    const rows = await env.DB.prepare(
        "SELECT user_id, error FROM broadcast_recipients WHERE broadcast_id=? AND status='failed' ORDER BY user_id LIMIT ?",
    ).bind(Number(broadcastId), Number(limit)).all();
    return (rows.results || []).map((row) => row);
}

async function recordBroadcastRecipient(env, broadcastId, userId, status, messageId, error) {
    await env.DB.prepare(
        "INSERT OR REPLACE INTO broadcast_recipients(broadcast_id, user_id, status, message_id, error, sent_at) VALUES(?,?,?,?,?,?)",
    ).bind(Number(broadcastId), Number(userId), status, messageId || null, String(error || "").slice(0, 500), nowIso()).run();
}

// 单条失败不中断整批。用户屏蔽 Bot 或删除对话会返回 403，这是常态不是异常。
async function sendBroadcastToUser(env, broadcastId, userId, content) {
    try {
        const sent = await tgCall(env, "sendMessage", {
            chat_id: Number(userId),
            text: content,
            disable_web_page_preview: true,
        });
        await recordBroadcastRecipient(env, broadcastId, userId, "sent", sent.result.message_id, "");
        return true;
    } catch (error) {
        const raw = String(error?.message || error);
        await recordBroadcastRecipient(env, broadcastId, userId, "failed", null, raw);
        await logEvent(env, "warn", "broadcast send failed", { broadcastId: Number(broadcastId), userId: Number(userId), error: raw });
        return false;
    }
}

// Cron 入口：只推进还没发完的任务，没有进行中的任务时直接返回，几乎零成本。
export async function runPendingBroadcastBatch(env) {
    try {
        await ensureVerificationSchema(env);
        const pending = await env.DB.prepare("SELECT * FROM broadcasts WHERE status='running' ORDER BY id LIMIT 1").first();
        if (!pending) return;
        await runBroadcastBatch(env, pending);
    } catch (error) {
        await logEvent(env, "error", "failed to run broadcast batch", { error: String(error?.message || error) });
    }
}

async function runBroadcastBatch(env, broadcast) {
    const cursor = Number(broadcast.cursor_user_id || 0);
    const rows = await env.DB.prepare(
        "SELECT user_id FROM users WHERE user_id > ? AND blocked=0" + broadcastAudienceFilter(broadcast.audience) +
        " ORDER BY user_id LIMIT ?",
    ).bind(cursor, BROADCAST_BATCH_SIZE).all();
    const targets = (rows.results || []).map((row) => Number(row.user_id));

    if (!targets.length) {
        await finishBroadcast(env, broadcast);
        return;
    }

    // 先认领这一批，再发送：把游标推进到本批最后一人，条件是游标仍是我们刚刚读到的值。
    // 抢不到说明另一个执行体已经在处理同一批（创建时 waitUntil 与 Cron 会撞在一起），
    // 这时必须一条都不发 —— 2026-10-11 与 10-16 两次群发就是这样把同一批人各发了一遍，
    // 用户收到两条同样的通知；而且旧写法把计数和游标写在同一条 UPDATE 里，抢不到时计数一并被丢弃，
    // 那两次任务的失败数分别少报了 2 条和 3 条。
    const claimed = await env.DB.prepare(
        "UPDATE broadcasts SET cursor_user_id=?, updated_at=? WHERE id=? AND cursor_user_id=? AND status='running'",
    ).bind(targets[targets.length - 1], nowIso(), broadcast.id, cursor).run();

    if (!claimed?.meta?.changes) {
        await logEvent(env, "warn", "broadcast cursor already advanced", { broadcastId: Number(broadcast.id), cursor });
        return;
    }

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += 1) {
        if (await sendBroadcastToUser(env, broadcast.id, targets[i], broadcast.content)) sent += 1;
        else failed += 1;
        if (i < targets.length - 1) await sleep(BROADCAST_BATCH_INTERVAL_MS);
    }

    // 计数独立累加，不再带游标条件：认领之后这一批的成败只归本次执行，不会再被并发判断丢掉。
    await env.DB.prepare(
        "UPDATE broadcasts SET sent_count=sent_count+?, failed_count=failed_count+?, updated_at=? WHERE id=?",
    ).bind(sent, failed, nowIso(), broadcast.id).run();

    if (targets.length < BROADCAST_BATCH_SIZE) await finishBroadcast(env, broadcast);
}

async function finishBroadcast(env, broadcast) {
    await env.DB.prepare("UPDATE broadcasts SET status='done', finished_at=?, updated_at=? WHERE id=? AND status='running'")
        .bind(nowIso(), nowIso(), broadcast.id).run();
    const row = await getBroadcast(env, broadcast.id);
    const failedCount = Number(row?.failed_count || broadcast.failed_count || 0);
    const lines = [
        `群发通知 #${broadcast.id} 已完成`,
        `范围：${broadcastAudienceLabel(broadcast.audience)}`,
        `目标：${Number(row?.target_total || 0)} 人`,
        `成功：${Number(row?.sent_count || 0)}`,
        `失败：${failedCount}`,
    ];
    if (failedCount > 0) {
        const samples = await broadcastFailedSamples(env, broadcast.id);
        if (samples.length) lines.push("失败示例：\n" + samples.map((row2) => `${row2.user_id}：${h(String(row2.error || "").slice(0, 80))}`).join("\n"));
        lines.push(`完整名单在后台「群发通知」页查看。`);
    }
    await notifyAdmins(env, lines.join("\n"), {}, { force: true });
}

async function broadcastFailureCell(env, row) {
    const failed = Number(row.failed || 0);
    if (!failed) return '<span class="muted">-</span>';
    const samples = await broadcastFailedSamples(env, row.id);
    // 用 wrap 让长错误换行显示，否则 112px 的列会把 Telegram 返回的错误整行省略掉。
    const detail = samples.map((sample) => `<span class="wrap">${h(String(sample.user_id))}：${h(String(sample.error || "").slice(0, 160))}</span>`).join("");
    return `<details><summary><span class="badge red">${failed}</span></summary><div class="cell-lines">${detail || '<span class="muted">无明细</span>'}</div></details>`;
}

async function broadcastPage(request, env) {
    await ensureVerificationSchema(env);
    const running = await getRunningBroadcast(env);
    const history = await broadcastHistory(env);
    const [allCount, verifiedCount] = await Promise.all([
        broadcastAudienceCount(env, "all"),
        broadcastAudienceCount(env, "verified"),
    ]);
    const url = new URL(request.url);
    const error = url.searchParams.get("error");
    const done = url.searchParams.get("done");
    const previewed = url.searchParams.get("preview");

    const option = (value, label, selected) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`;
    const disabled = running ? " disabled" : "";
    const disabledAttr = running ? "disabled" : "";

    const runningCard = running
        ? `<div class="card"><h2>进行中的群发 #${h(String(running.id))}</h2>
<p class="muted">范围：${h(broadcastAudienceLabel(running.audience))}，目标 ${Number(running.target_total || 0)} 人。由 Cron 每分钟推进一批，关掉本页不影响发送。</p>
<dl class="kv"><dt>内容</dt><dd class="clamp clamp-2">${h(String(running.content || ""))}</dd>
<dt>已处理</dt><dd>${Number(running.sent_count || 0) + Number(running.failed_count || 0)} / ${Number(running.target_total || 0)}</dd>
<dt>成功</dt><dd>${Number(running.sent_count || 0)}</dd>
<dt>失败</dt><dd>${Number(running.failed_count || 0)}</dd></dl>
<div class="actions" style="margin-top:12px"><form method="post" action="/broadcast/cancel" onsubmit="return confirm('确定取消这次群发吗？已经发出去的消息无法撤回。')"><button class="danger" type="submit">取消这次群发</button></form></div></div>`
        : `<div class="card"><h2>发送群发通知</h2>
<p class="muted">发给私聊过 Bot 的用户。发送过程由 Cron 每分钟推进一批，约 0.7 条/秒，几百人需要十来分钟。单条失败不影响其他人，失败名单事后可查。</p>
<form method="post" action="/broadcast">
<label for="broadcast-content">通知内容</label><textarea id="broadcast-content" name="content" required maxlength="${BROADCAST_MAX_CONTENT}" placeholder="要发给所有用户的一段文字"></textarea>
<div class="grid"><div><label for="broadcast-audience">发送范围</label><select id="broadcast-audience" name="audience">
${option("all", `全部用户（${allCount} 人）`, "all")}${option("verified", `仅已验证用户（${verifiedCount} 人）`, "verified")}</select></div>
<div><label for="broadcast-hint">预计耗时</label><input id="broadcast-hint" value="每分钟一批 40 人，400 人约 12 分钟" readonly></div></div>
<div class="actions"><button class="primary" type="submit" onclick="return confirm('确定发送给全部目标用户吗？消息发出后无法撤回。')">发送给目标用户</button>
<button type="submit" formaction="/broadcast/preview">试发到我的私聊</button></div>
</form>
<p class="muted" style="margin-top:10px">「试发到我的私聊」用的是同一份内容，先发一条给你自己确认排版和措辞，不会影响正式群发。</p></div>`;

    const historyRows = [];
    for (const row of history) {
        const statusBadge = row.status === "done"
            ? '<span class="badge green">已完成</span>'
            : row.status === "cancelled" ? '<span class="badge red">已取消</span>' : '<span class="badge warn">进行中</span>';
        historyRows.push(`<tr>
<td data-label="任务"><span class="table-id">#${h(String(row.id))}</span></td>
<td data-label="内容"><div class="clamp clamp-2">${h(String(row.content || ""))}</div></td>
<td data-label="范围">${h(broadcastAudienceLabel(row.audience))}</td>
<td data-label="目标"><span class="num">${Number(row.target_total || 0)}</span></td>
<td data-label="成功"><span class="num">${Number(row.sent_count || 0)}</span></td>
<td data-label="失败">${await broadcastFailureCell(env, row)}</td>
<td data-label="状态"><div class="cell">${statusBadge}${tableTime(row.finished_at || row.updated_at)}</div></td>
</tr>`);
    }

    const messages = [
        error ? `<div class="msg">出错：${h(error)}</div>` : "",
        done ? `<div class="msg">群发任务 #${h(String(done))} 已创建，第一批正在发送。剩下的批次由 Cron 每分钟推进，关掉本页不影响。</div>` : "",
        previewed ? `<div class="msg">预览已发到你的私聊。确认内容无误后回到这里点「发送给目标用户」。</div>` : "",
    ].join("");

    const body = `${messages}${runningCard}
<div class="card"><h2>群发记录</h2><p class="muted">只记录群发任务本身，不会写进收件箱，因此不会污染用户往来记录。失败数可点开看前几条明细。</p>
<div class="table-wrap responsive-wrap" style="--table-min:1120px" tabindex="0" aria-label="群发记录，可横向滚动"><table class="broadcast-table responsive-table"><caption class="sr-only">群发通知记录</caption><thead><tr>
<th scope="col">任务</th><th scope="col">内容</th><th scope="col">范围</th><th scope="col">目标</th><th scope="col">成功</th><th scope="col">失败</th><th scope="col">状态</th>
</tr></thead><tbody>${historyRows.length ? historyRows.join("") : '<tr><td data-span="full" colspan="7" class="muted">还没有群发记录。</td></tr>'}</tbody></table></div></div>`;

    return html(layout("群发通知", body));
}

async function broadcastSave(request, env, ctx) {
    const form = await request.formData();
    const content = String(form.get("content") || "").trim();
    if (!content) return redirect("/broadcast?error=通知内容不能为空。", request);
    if (content.length > BROADCAST_MAX_CONTENT) {
        return redirect(`/broadcast?error=${encodeURIComponent(`通知内容超过 ${BROADCAST_MAX_CONTENT} 字，请精简后再发。`)}`, request);
    }
    const audience = String(form.get("audience") || "all").trim().toLowerCase();
    const safeAudience = audience === "verified" ? "verified" : "all";

    await ensureVerificationSchema(env);
    const running = await env.DB.prepare("SELECT id FROM broadcasts WHERE status='running' ORDER BY id LIMIT 1").first();
    if (running) {
        return redirect(`/broadcast?error=${encodeURIComponent(`已有群发任务 #${running.id} 进行中，请先等它完成或取消。`)}`, request);
    }

    const targetTotal = await broadcastAudienceCount(env, safeAudience);
    if (!targetTotal) return redirect("/broadcast?error=当前范围内没有可发送的用户。", request);

    const admins = await adminChatIds(env);
    const ts = nowIso();
    const result = await env.DB.prepare(
        "INSERT INTO broadcasts(content, audience, target_total, cursor_user_id, sent_count, failed_count, status, preview_sent, created_by_user_id, created_at, updated_at) " +
        "VALUES(?,?,?,0,0,0,'running',0,?,?,?)",
    ).bind(content, safeAudience, targetTotal, Number(admins[0] || 0), ts, ts).run();

    const broadcastId = result?.meta?.last_row_id || 0;
    await logEvent(env, "info", "broadcast created", { broadcastId, audience: safeAudience, targetTotal });
    // 立刻发第一批，剩下的交给 Cron。用 waitUntil 而不是 await：第一批要发几十条消息，
    // 等它跑完浏览器会一直转圈，而后面的批次本来就是 Cron 的活。
    if (ctx?.waitUntil) ctx.waitUntil(runPendingBroadcastBatch(env));
    return redirect(`/broadcast?done=${encodeURIComponent(String(broadcastId))}`, request);
}

async function broadcastPreview(request, env) {
    const form = await request.formData();
    // 预览按钮和正式发送共用同一个表单（formaction 切换端点），所以读的是同一份内容。
    const content = String(form.get("content") || "").trim();
    if (!content) {
        return redirect(`/broadcast?error=${encodeURIComponent("要试发的内容不能为空。")}`, request);
    }
    if (content.length > BROADCAST_MAX_CONTENT) {
        return redirect(`/broadcast?error=${encodeURIComponent(`通知内容超过 ${BROADCAST_MAX_CONTENT} 字，请精简。`)}`, request);
    }
    const admins = await adminChatIds(env);
    const target = Number(admins[0] || 0);
    if (!target) {
        return redirect(`/broadcast?error=${encodeURIComponent("没有配置管理员 Chat ID，无法试发。请先到设置页填写。")}`, request);
    }

    try {
        const sent = await tgCall(env, "sendMessage", { chat_id: target, text: content, disable_web_page_preview: true });
        await logEvent(env, "info", "broadcast preview sent", { chatId: target, messageId: sent.result.message_id });
        return redirect("/broadcast?preview=1", request);
    } catch (error) {
        return redirect(`/broadcast?error=${encodeURIComponent(`试发失败：${String(error?.message || error).slice(0, 200)}`)}`, request);
    }
}

async function broadcastCancel(request, env) {
    await ensureVerificationSchema(env);
    const row = await env.DB.prepare("SELECT * FROM broadcasts WHERE status='running' ORDER BY id LIMIT 1").first();
    if (!row) return redirect("/broadcast", request);
    await env.DB.prepare("UPDATE broadcasts SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status='running'")
        .bind(nowIso(), nowIso(), row.id).run();
    await logEvent(env, "warn", "broadcast cancelled", { broadcastId: Number(row.id) });
    return redirect("/broadcast", request);
}
