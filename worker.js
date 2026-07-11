const COOKIE_NAME = "tg_dualbot_session";
const DEFAULT_PANEL_USER = "admin";
const VERIFY_SESSION_HOURS = 24;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_CONTROL_MODE = "web";
const DEFAULT_TOPIC_CREATE_POLICY = "after_verify";
const DEVICE_FINGERPRINT_VERSION = "tg-dualbot-fp-v1";
const DEVICE_FINGERPRINT_PROFILE_VERSION = "tg-dualbot-fp-profile-v2";
const WEBRTC_IDENTITY_VERSION = "tg-dualbot-webrtc-v1";
const MAX_WEBRTC_LABELS_PER_USER = 5;
const MAX_FINGERPRINT_PROFILES_PER_USER = 3;
const FINGERPRINT_SIMILARITY_THRESHOLD = 75;
const FINGERPRINT_CANDIDATE_LIMIT = 10;
const USER_WITH_IDENTITY_SELECT = "SELECT u.*, c.label_id AS confirmed_identity_label_id, c.confirmed_at AS identity_confirmed_at, l.label_name AS identity_label_name, l.source_user_id AS identity_label_source_user_id FROM users u LEFT JOIN webrtc_identity_confirmations c ON c.user_id=u.user_id LEFT JOIN webrtc_identity_labels l ON l.id=c.label_id";

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

function nowIso() {
    return new Date().toISOString();
}

async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret, input) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(String(secret || "")),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(input || "")));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedFingerprintNumber(value, max, precision = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const bounded = Math.max(0, Math.min(max, number));
    const factor = 10 ** precision;
    return Math.round(bounded * factor) / factor;
}

function normalizedClientHash(value) {
    const hash = String(value || "").trim().toLowerCase();
    return /^[0-9a-f]{32}$/.test(hash) ? hash : "";
}

async function buildDeviceFingerprint(clientData = {}) {
    const fingerprint = clientData?.fingerprint && typeof clientData.fingerprint === "object" ? clientData.fingerprint : {};
    const hardware = fingerprint.hardware && typeof fingerprint.hardware === "object" ? fingerprint.hardware : {};
    const screenInfo = clientData?.screen && typeof clientData.screen === "object" ? clientData.screen : {};
    const canvasHash = normalizedClientHash(fingerprint.canvas?.hash);
    const webglHash = normalizedClientHash(fingerprint.webgl?.hash);
    if (!canvasHash && !webglHash) return "";
    const width = boundedFingerprintNumber(screenInfo.width, 32768);
    const height = boundedFingerprintNumber(screenInfo.height, 32768);
    const payload = JSON.stringify([
        DEVICE_FINGERPRINT_VERSION,
        String(clientData.platform || "").trim().toLowerCase().slice(0, 80),
        String(clientData.language || "").trim().toLowerCase().slice(0, 32),
        Array.isArray(clientData.languages) ? clientData.languages.map((value) => String(value).toLowerCase().slice(0, 32)).slice(0, 5).join(",") : "",
        String(clientData.timezone || "").trim().slice(0, 64),
        Math.min(width, height),
        Math.max(width, height),
        boundedFingerprintNumber(screenInfo.pixel_ratio, 16, 3),
        boundedFingerprintNumber(screenInfo.color_depth, 64),
        boundedFingerprintNumber(hardware.cores, 64),
        boundedFingerprintNumber(hardware.memory_gb, 64, 1),
        boundedFingerprintNumber(hardware.touch_points, 32),
        canvasHash,
        webglHash,
    ]);
    return (await sha256Hex(payload)).slice(0, 32);
}

function normalizedFingerprintText(value, max = 80) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, max);
}

function fingerprintRangeBucket(value, boundaries) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "";
    for (const boundary of boundaries) {
        if (number <= boundary) return String(boundary);
    }
    return String(boundaries[boundaries.length - 1]) + "+";
}

async function fingerprintFeatureHash(name, value) {
    const normalized = String(value || "");
    if (!normalized) return "";
    return (await sha256Hex(JSON.stringify([DEVICE_FINGERPRINT_PROFILE_VERSION, name, normalized]))).slice(0, 32);
}

async function buildFingerprintProfile(clientData = {}, deviceOs = "", webrtcIdentity = {}) {
    const fingerprint = clientData?.fingerprint && typeof clientData.fingerprint === "object" ? clientData.fingerprint : {};
    const hardware = fingerprint.hardware && typeof fingerprint.hardware === "object" ? fingerprint.hardware : {};
    const screenInfo = clientData?.screen && typeof clientData.screen === "object" ? clientData.screen : {};
    const canvasHash = normalizedClientHash(fingerprint.canvas?.hash);
    const webglHash = normalizedClientHash(fingerprint.webgl?.hash);
    const rendererHash = normalizedClientHash(fingerprint.webgl?.renderer_hash) || webglHash;
    const limitsHash = normalizedClientHash(fingerprint.webgl?.limits_hash);
    if (!canvasHash && !rendererHash && !limitsHash) return null;

    const width = boundedFingerprintNumber(screenInfo.width, 32768);
    const height = boundedFingerprintNumber(screenInfo.height, 32768);
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    const screenBucketValue = shortSide > 0 && longSide > 0
        ? `${Math.round(shortSide / 50) * 50}x${Math.round(longSide / 50) * 50}`
        : "";
    const pixelRatio = boundedFingerprintNumber(screenInfo.pixel_ratio, 16, 3);
    const colorDepth = boundedFingerprintNumber(screenInfo.color_depth, 64);
    const dprDepthValue = colorDepth > 0 ? `${Math.round(pixelRatio * 4) / 4}|${colorDepth}` : "";
    const coresBucket = fingerprintRangeBucket(hardware.cores, [1, 2, 4, 6, 8, 12, 16, 32, 64]);
    const memoryBucket = fingerprintRangeBucket(hardware.memory_gb, [1, 2, 4, 8, 16, 32, 64]);
    const hardwareValue = coresBucket || memoryBucket ? `${coresBucket}|${memoryBucket}` : "";
    const touchNumber = Number(hardware.touch_points);
    const touchValue = Number.isFinite(touchNumber) ? (touchNumber > 0 ? "touch" : "no-touch") : "";
    const osValue = normalizedFingerprintText(deviceOs || clientData.platform || "", 32);
    const timezoneValue = normalizedFingerprintText(clientData.timezone, 64);
    const languageValue = normalizedFingerprintText(clientData.language, 32).split("-")[0];

    const [osHash, screenHash, dprDepthHash, hardwareHash, touchHash, timezoneHash, languageHash] = await Promise.all([
        fingerprintFeatureHash("os", osValue),
        fingerprintFeatureHash("screen", screenBucketValue),
        fingerprintFeatureHash("dpr-depth", dprDepthValue),
        fingerprintFeatureHash("hardware", hardwareValue),
        fingerprintFeatureHash("touch", touchValue),
        fingerprintFeatureHash("timezone", timezoneValue),
        fingerprintFeatureHash("language", languageValue),
    ]);
    const profileHash = (await sha256Hex(JSON.stringify([
        DEVICE_FINGERPRINT_PROFILE_VERSION,
        canvasHash,
        rendererHash,
        limitsHash,
        osHash,
        screenHash,
        dprDepthHash,
        hardwareHash,
        touchHash,
        timezoneHash,
        languageHash,
    ]))).slice(0, 32);
    const stableHash = osHash && rendererHash && (limitsHash || hardwareHash)
        ? (await sha256Hex(JSON.stringify([DEVICE_FINGERPRINT_PROFILE_VERSION, "stable", osHash, rendererHash, limitsHash, hardwareHash]))).slice(0, 32)
        : "";
    let featureMask = 0;
    if (canvasHash) featureMask |= 1;
    if (rendererHash) featureMask |= 2;
    if (limitsHash) featureMask |= 4;
    if (osHash) featureMask |= 8;
    if (screenHash) featureMask |= 16;
    if (dprDepthHash) featureMask |= 32;
    if (hardwareHash) featureMask |= 64;
    if (touchHash) featureMask |= 128;
    if (timezoneHash) featureMask |= 256;
    if (languageHash) featureMask |= 512;
    return {
        profileHash,
        webrtcIpv4Hash: normalizedClientHash(webrtcIdentity.ipv4Hash),
        webrtcIpv4Hash2: normalizedClientHash(webrtcIdentity.ipv4Hash2),
        webrtcIpv6Hash: normalizedClientHash(webrtcIdentity.ipv6Hash),
        webrtcIpv6Hash2: normalizedClientHash(webrtcIdentity.ipv6Hash2),
        stableHash,
        canvasHash,
        rendererHash,
        limitsHash,
        osHash,
        screenHash,
        dprDepthHash,
        hardwareHash,
        touchHash,
        timezoneHash,
        languageHash,
        featureMask,
    };
}

export function scoreFingerprintSimilarity(current, candidate) {
    const fields = [
        ["rendererHash", 24, "WebGL 显卡", true],
        ["limitsHash", 14, "WebGL 能力", true],
        ["canvasHash", 18, "Canvas", true],
        ["osHash", 10, "设备系统", false],
        ["screenHash", 8, "屏幕尺寸", false],
        ["dprDepthHash", 5, "像素比例/色深", false],
        ["hardwareHash", 10, "CPU/内存", false],
        ["touchHash", 3, "触控能力", false],
        ["timezoneHash", 5, "时区", false],
        ["languageHash", 3, "语言", false],
    ];
    let score = 0;
    let strongMatches = 0;
    const matchedFields = [];
    const matchedKeys = new Set();
    for (const [key, weight, label, strong] of fields) {
        if (current?.[key] && candidate?.[key] && current[key] === candidate[key]) {
            score += weight;
            matchedFields.push(label);
            matchedKeys.add(key);
            if (strong) strongMatches += 1;
        }
    }
    const exactProfile = Boolean(current?.profileHash && candidate?.profileHash && current.profileHash === candidate.profileHash);
    if (exactProfile) score = 100;
    const currentIpv4Hashes = [current?.webrtcIpv4Hash, current?.webrtcIpv4Hash2].filter(Boolean);
    const candidateIpv4Hashes = new Set([candidate?.webrtcIpv4Hash, candidate?.webrtcIpv4Hash2].filter(Boolean));
    const currentIpv6Hashes = [current?.webrtcIpv6Hash, current?.webrtcIpv6Hash2].filter(Boolean);
    const candidateIpv6Hashes = new Set([candidate?.webrtcIpv6Hash, candidate?.webrtcIpv6Hash2].filter(Boolean));
    const webrtcIpv4Exact = currentIpv4Hashes.some((hash) => candidateIpv4Hashes.has(hash));
    const webrtcIpv6Exact = currentIpv6Hashes.some((hash) => candidateIpv6Hashes.has(hash));
    const webrtcExact = webrtcIpv4Exact || webrtcIpv6Exact;
    const highConfidence = (
        score >= FINGERPRINT_SIMILARITY_THRESHOLD
        && strongMatches >= 2
        && matchedKeys.has("osHash")
        && (matchedKeys.has("rendererHash") || matchedKeys.has("canvasHash"))
    );
    return {
        score: Math.min(100, score),
        exactProfile,
        webrtcExact,
        webrtcIpv4Exact,
        webrtcIpv6Exact,
        highConfidence,
        strongMatches,
        matchedFields: exactProfile && !matchedFields.length ? ["完整指纹"] : matchedFields,
    };
}

function fingerprintMatchIsActionable(evidence) {
    return Boolean(evidence?.webrtcExact || evidence?.highConfidence);
}

function fingerprintMatchIsDisplayable(evidence) {
    return Boolean(evidence?.webrtcExact || evidence?.exactProfile || evidence?.highConfidence);
}

function fingerprintProfileFromRow(row = {}) {
    return {
        profileHash: String(row.profile_hash || ""),
        webrtcIpv4Hash: String(row.webrtc_ipv4_hash || ""),
        webrtcIpv4Hash2: String(row.webrtc_ipv4_hash2 || ""),
        webrtcIpv6Hash: String(row.webrtc_ipv6_hash || ""),
        webrtcIpv6Hash2: String(row.webrtc_ipv6_hash2 || ""),
        stableHash: String(row.stable_hash || ""),
        canvasHash: String(row.canvas_hash || ""),
        rendererHash: String(row.renderer_hash || ""),
        limitsHash: String(row.limits_hash || ""),
        osHash: String(row.os_hash || ""),
        screenHash: String(row.screen_hash || ""),
        dprDepthHash: String(row.dpr_depth_hash || ""),
        hardwareHash: String(row.hardware_hash || ""),
        touchHash: String(row.touch_hash || ""),
        timezoneHash: String(row.timezone_hash || ""),
        languageHash: String(row.language_hash || ""),
        featureMask: Number(row.feature_mask || 0),
    };
}

export async function buildFingerprintConfirmationToken(env, values = {}) {
    if (!env.PANEL_SECRET || !values.targetProfile?.profileHash || !values.candidateProfile?.profileHash || !values.labelId) return "";
    const payload = JSON.stringify([
        "tg-dualbot-fp-confirm-v1",
        Number(values.userId),
        Number(values.targetSlot),
        values.targetProfile.profileHash,
        values.targetProfile.webrtcIpv4Hash || "",
        values.targetProfile.webrtcIpv4Hash2 || "",
        values.targetProfile.webrtcIpv6Hash || "",
        values.targetProfile.webrtcIpv6Hash2 || "",
        Number(values.candidateUserId),
        Number(values.candidateSlot),
        values.candidateProfile.profileHash,
        values.candidateProfile.webrtcIpv4Hash || "",
        values.candidateProfile.webrtcIpv4Hash2 || "",
        values.candidateProfile.webrtcIpv6Hash || "",
        values.candidateProfile.webrtcIpv6Hash2 || "",
        Number(values.labelId),
        Number(values.targetConfirmedLabelId || 0),
        String(values.targetConfirmedAt || ""),
    ]);
    return (await hmacSha256Hex(env.PANEL_SECRET, payload)).slice(0, 12);
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

function clientDataForVerificationStorage(clientData = {}, network = {}) {
    const screenInfo = clientData?.screen && typeof clientData.screen === "object" ? clientData.screen : {};
    const probe = clientData?.probe && typeof clientData.probe === "object" ? clientData.probe : {};
    return {
        language: String(clientData.language || "").slice(0, 32),
        platform: String(clientData.platform || "").slice(0, 80),
        user_agent: String(clientData.user_agent || "").slice(0, 500),
        timezone: String(clientData.timezone || "").slice(0, 64),
        screen: {
            width: Number(screenInfo.width) || 0,
            height: Number(screenInfo.height) || 0,
            pixel_ratio: Number(screenInfo.pixel_ratio) || 1,
        },
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

async function getIdentityConfirmationState(env, userId) {
    const row = await env.DB.prepare("SELECT label_id, confirmed_at FROM webrtc_identity_confirmations WHERE user_id=?")
        .bind(Number(userId))
        .first();
    return {
        labelId: Number(row?.label_id || 0),
        confirmedAt: String(row?.confirmed_at || ""),
    };
}

async function upsertFingerprintProfile(env, userId, profile) {
    if (!profile?.profileHash) return 0;
    const slots = Array.from({ length: MAX_FINGERPRINT_PROFILES_PER_USER }, (_, index) => `(${index + 1})`).join(",");
    const ts = nowIso();
    await env.DB.prepare(`WITH slots(slot) AS (VALUES${slots}),
chosen AS (
    SELECT s.slot
    FROM slots s
    LEFT JOIN device_fingerprint_profiles p ON p.user_id=? AND p.slot=s.slot
    ORDER BY CASE
        WHEN p.profile_hash=? THEN 0
        WHEN p.user_id IS NULL THEN 1
        ELSE 2
    END, p.last_seen_at ASC, s.slot ASC
    LIMIT 1
)
INSERT INTO device_fingerprint_profiles(
    user_id, slot, profile_hash, webrtc_ipv4_hash, webrtc_ipv4_hash2, webrtc_ipv6_hash, webrtc_ipv6_hash2, stable_hash, canvas_hash, renderer_hash, limits_hash,
    os_hash, screen_hash, dpr_depth_hash, hardware_hash, touch_hash, timezone_hash, language_hash,
    feature_mask, seen_count, first_seen_at, last_seen_at
)
SELECT ?, slot, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? FROM chosen WHERE 1
ON CONFLICT(user_id, slot) DO UPDATE SET
    first_seen_at=CASE WHEN device_fingerprint_profiles.profile_hash=excluded.profile_hash THEN device_fingerprint_profiles.first_seen_at ELSE excluded.first_seen_at END,
    seen_count=CASE WHEN device_fingerprint_profiles.profile_hash=excluded.profile_hash THEN MIN(device_fingerprint_profiles.seen_count+1, 2147483647) ELSE 1 END,
    profile_hash=excluded.profile_hash,
    webrtc_ipv4_hash=excluded.webrtc_ipv4_hash,
    webrtc_ipv4_hash2=excluded.webrtc_ipv4_hash2,
    webrtc_ipv6_hash=excluded.webrtc_ipv6_hash,
    webrtc_ipv6_hash2=excluded.webrtc_ipv6_hash2,
    stable_hash=excluded.stable_hash,
    canvas_hash=excluded.canvas_hash,
    renderer_hash=excluded.renderer_hash,
    limits_hash=excluded.limits_hash,
    os_hash=excluded.os_hash,
    screen_hash=excluded.screen_hash,
    dpr_depth_hash=excluded.dpr_depth_hash,
    hardware_hash=excluded.hardware_hash,
    touch_hash=excluded.touch_hash,
    timezone_hash=excluded.timezone_hash,
    language_hash=excluded.language_hash,
    feature_mask=excluded.feature_mask,
    last_seen_at=excluded.last_seen_at`)
        .bind(
            Number(userId), profile.profileHash,
            Number(userId), profile.profileHash, profile.webrtcIpv4Hash, profile.webrtcIpv4Hash2, profile.webrtcIpv6Hash, profile.webrtcIpv6Hash2, profile.stableHash, profile.canvasHash,
            profile.rendererHash, profile.limitsHash, profile.osHash, profile.screenHash, profile.dprDepthHash,
            profile.hardwareHash, profile.touchHash, profile.timezoneHash, profile.languageHash,
            Number(profile.featureMask || 0), ts, ts,
        )
        .run();
    const row = await env.DB.prepare("SELECT slot FROM device_fingerprint_profiles WHERE user_id=? AND profile_hash=? LIMIT 1")
        .bind(Number(userId), profile.profileHash)
        .first();
    return Number(row?.slot || 0);
}

function fingerprintCandidateSql(column) {
    return `SELECT p.*, u.username, u.full_name, u.note
FROM device_fingerprint_profiles p
JOIN users u ON u.user_id=p.user_id
WHERE p.user_id<>? AND p.${column}=? AND p.${column}<>''
ORDER BY p.last_seen_at DESC
LIMIT ${FINGERPRINT_CANDIDATE_LIMIT}`;
}

function fingerprintWebRtcCandidateSql(column) {
    return `SELECT p.*, u.username, u.full_name, u.note
FROM device_fingerprint_profiles p
JOIN users u ON u.user_id=p.user_id
WHERE p.user_id<>? AND p.${column}=? AND p.${column}<>''
ORDER BY p.last_seen_at DESC
LIMIT ${FINGERPRINT_CANDIDATE_LIMIT}`;
}

async function findFingerprintSimilarityMatch(env, userId, profile, legacyFingerprint = "") {
    if (!profile?.profileHash) return null;
    const branches = [];
    const addBranch = (column, value) => {
        if (!value) return;
        branches.push({
            kind: column,
            statement: env.DB.prepare(fingerprintCandidateSql(column)).bind(Number(userId), value),
        });
    };
    addBranch("profile_hash", profile.profileHash);
    const addWebRtcBranches = (version, firstHash, secondHash) => {
        const prefix = version === "IPv4" ? "webrtc_ipv4" : "webrtc_ipv6";
        const hashes = [...new Set([firstHash, secondHash].filter(Boolean))];
        for (const hash of hashes) {
            for (const column of [`${prefix}_hash`, `${prefix}_hash2`]) {
                branches.push({
                    kind: column,
                    statement: env.DB.prepare(fingerprintWebRtcCandidateSql(column)).bind(Number(userId), hash),
                });
            }
        }
    };
    addWebRtcBranches("IPv4", profile.webrtcIpv4Hash, profile.webrtcIpv4Hash2);
    addWebRtcBranches("IPv6", profile.webrtcIpv6Hash, profile.webrtcIpv6Hash2);
    addBranch("stable_hash", profile.stableHash);
    addBranch("renderer_hash", profile.rendererHash);
    addBranch("canvas_hash", profile.canvasHash);
    if (legacyFingerprint) {
        branches.push({
            kind: "legacy",
            statement: env.DB.prepare(`SELECT user_id, username, full_name, note, updated_at
FROM users
WHERE user_id<>? AND last_device_fingerprint=? AND last_device_fingerprint<>''
ORDER BY updated_at DESC
LIMIT ${FINGERPRINT_CANDIDATE_LIMIT}`).bind(Number(userId), legacyFingerprint),
        });
    }
    if (!branches.length) return null;
    const results = await env.DB.batch(branches.map((branch) => branch.statement));
    const candidates = new Map();
    const legacyRows = [];
    for (let index = 0; index < results.length; index += 1) {
        const rows = results[index]?.results || [];
        if (branches[index].kind === "legacy") {
            legacyRows.push(...rows);
            continue;
        }
        for (const row of rows) {
            const key = `${row.user_id}:${row.slot}`;
            if (candidates.has(key)) continue;
            const candidateProfile = fingerprintProfileFromRow(row);
            const evidence = scoreFingerprintSimilarity(profile, candidateProfile);
            if (!fingerprintMatchIsDisplayable(evidence)) continue;
            candidates.set(key, {
                userId: Number(row.user_id),
                slot: Number(row.slot),
                username: String(row.username || ""),
                fullName: String(row.full_name || ""),
                note: String(row.note || "").trim().slice(0, 200),
                lastSeenAt: String(row.last_seen_at || ""),
                profile: candidateProfile,
                evidence,
            });
        }
    }
    const profileUsers = new Set([...candidates.values()].map((candidate) => candidate.userId));
    for (const row of legacyRows) {
        const candidateUserId = Number(row.user_id);
        if (!candidateUserId || profileUsers.has(candidateUserId)) continue;
        candidates.set(`legacy:${candidateUserId}`, {
            userId: candidateUserId,
            slot: 0,
            username: String(row.username || ""),
            fullName: String(row.full_name || ""),
            note: String(row.note || "").trim().slice(0, 200),
            lastSeenAt: String(row.updated_at || ""),
            profile: null,
            evidence: {
                score: 100,
                exactProfile: true,
                webrtcExact: false,
                highConfidence: false,
                strongMatches: 0,
                matchedFields: ["旧版完整指纹"],
            },
        });
    }
    const ranked = [...candidates.values()].sort((left, right) => {
        const leftRank = left.evidence.webrtcExact ? 3 : left.evidence.highConfidence ? 2 : 1;
        const rightRank = right.evidence.webrtcExact ? 3 : right.evidence.highConfidence ? 2 : 1;
        if (leftRank !== rightRank) return rightRank - leftRank;
        if (left.evidence.score !== right.evidence.score) return right.evidence.score - left.evidence.score;
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });
    const best = ranked[0];
    if (!best) return null;
    const label = await getIdentityLabelForUser(env, best.userId);
    return {
        ...best,
        labelId: Number(label?.id || 0),
        labelName: String(label?.label_name || best.note || "").slice(0, 80),
        labelSourceUserId: Number(label?.source_user_id || 0),
        canConfirm: Boolean(label?.id && best.slot && fingerprintMatchIsActionable(best.evidence)),
    };
}

async function getFingerprintProfile(env, userId, slot) {
    const row = await env.DB.prepare("SELECT * FROM device_fingerprint_profiles WHERE user_id=? AND slot=?")
        .bind(Number(userId), Number(slot))
        .first();
    return row ? { row, profile: fingerprintProfileFromRow(row) } : null;
}

async function confirmFingerprintIdentity(env, userId, targetSlot, candidateUserId, candidateSlot, evidenceToken, adminId) {
    if (Number(userId) === Number(candidateUserId)) return { error: "不能把用户与自己重复确认。" };
    const [targetEntry, candidateEntry, user, label, confirmationState] = await Promise.all([
        getFingerprintProfile(env, userId, targetSlot),
        getFingerprintProfile(env, candidateUserId, candidateSlot),
        getUser(env, Number(userId)),
        getIdentityLabelForUser(env, candidateUserId),
        getIdentityConfirmationState(env, userId),
    ]);
    if (!user) return { error: "找不到用户。" };
    if (!targetEntry || !candidateEntry) return { error: "指纹档案已更新，请使用最新验证通知重新判断。" };
    if (!label) return { error: "匹配用户尚未建立人工标签，请先设置备注并标记其 WebRTC。" };
    const evidence = scoreFingerprintSimilarity(targetEntry.profile, candidateEntry.profile);
    if (!fingerprintMatchIsActionable(evidence)) {
        return { error: "当前证据已不足，不能使用旧通知确认。" };
    }
    const expectedToken = await buildFingerprintConfirmationToken(env, {
        userId,
        targetSlot,
        targetProfile: targetEntry.profile,
        candidateUserId,
        candidateSlot,
        candidateProfile: candidateEntry.profile,
        labelId: label.id,
        targetConfirmedLabelId: confirmationState.labelId,
        targetConfirmedAt: confirmationState.confirmedAt,
    });
    if (!expectedToken || !/^[0-9a-f]{12}$/.test(String(evidenceToken || "")) || !constantTimeEqual(expectedToken, evidenceToken)) {
        return { error: "确认凭证或证据已变化，请使用最新验证通知。" };
    }
    const ts = nowIso();
    const result = await env.DB.prepare(`INSERT INTO webrtc_identity_confirmations(user_id, label_id, confirmed_by_user_id, confirmed_at)
SELECT u.user_id, ?, ?, ? FROM users u
WHERE u.user_id=?
  AND EXISTS (SELECT 1 FROM device_fingerprint_profiles p WHERE p.user_id=? AND p.slot=? AND p.profile_hash=? AND p.webrtc_ipv4_hash=? AND p.webrtc_ipv4_hash2=? AND p.webrtc_ipv6_hash=? AND p.webrtc_ipv6_hash2=?)
  AND EXISTS (SELECT 1 FROM device_fingerprint_profiles p WHERE p.user_id=? AND p.slot=? AND p.profile_hash=? AND p.webrtc_ipv4_hash=? AND p.webrtc_ipv4_hash2=? AND p.webrtc_ipv6_hash=? AND p.webrtc_ipv6_hash2=?)
  AND (
      (?=0 AND NOT EXISTS (SELECT 1 FROM webrtc_identity_confirmations current_confirmation WHERE current_confirmation.user_id=u.user_id))
      OR
      (?<>0 AND EXISTS (
          SELECT 1 FROM webrtc_identity_confirmations current_confirmation
          WHERE current_confirmation.user_id=u.user_id AND current_confirmation.label_id=? AND current_confirmation.confirmed_at=?
      ))
  )
  AND EXISTS (
      SELECT 1 FROM webrtc_identity_labels l
      WHERE l.id=? AND (
          l.source_user_id=? OR EXISTS (
              SELECT 1 FROM webrtc_identity_confirmations c WHERE c.user_id=? AND c.label_id=l.id
          )
      )
  )
ON CONFLICT(user_id) DO UPDATE SET
    label_id=excluded.label_id,
    confirmed_by_user_id=excluded.confirmed_by_user_id,
    confirmed_at=excluded.confirmed_at`)
        .bind(
            Number(label.id), Number(adminId), ts, Number(userId),
            Number(userId), Number(targetSlot), targetEntry.profile.profileHash, targetEntry.profile.webrtcIpv4Hash, targetEntry.profile.webrtcIpv4Hash2, targetEntry.profile.webrtcIpv6Hash, targetEntry.profile.webrtcIpv6Hash2,
            Number(candidateUserId), Number(candidateSlot), candidateEntry.profile.profileHash, candidateEntry.profile.webrtcIpv4Hash, candidateEntry.profile.webrtcIpv4Hash2, candidateEntry.profile.webrtcIpv6Hash, candidateEntry.profile.webrtcIpv6Hash2,
            confirmationState.labelId, confirmationState.labelId, confirmationState.labelId, confirmationState.confirmedAt,
            Number(label.id), Number(candidateUserId), Number(candidateUserId),
        )
        .run();
    if (Number(result.meta?.changes || 0) < 1) {
        return { error: "指纹档案或人工标签刚刚发生变化，请重新验证后再确认。" };
    }
    return { user, label, evidence };
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
*,*::before,*::after{box-sizing:border-box}
:root{--ink:#142033;--muted:#667085;--line:#d9e0ea;--blue:#1d4ed8;--blue-dark:#173f9f}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 12% 12%,#dbeafe 0,transparent 34%),radial-gradient(circle at 88% 82%,#e0f2fe 0,transparent 30%),#eef2f7;color:var(--ink);font-family:"Noto Sans SC","Microsoft YaHei",Segoe UI,sans-serif}
.card{width:min(430px,100%);background:rgba(255,255,255,.96);border:1px solid rgba(203,213,225,.9);border-radius:18px;padding:clamp(22px,6vw,34px);box-shadow:0 24px 70px rgba(15,23,42,.14)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;color:var(--blue);font-size:12px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.eyebrow::before{content:"";width:28px;height:3px;border-radius:999px;background:var(--blue)}
h1{margin:0 0 8px;font-size:clamp(26px,7vw,32px);letter-spacing:-.03em}.muted{color:var(--muted);margin:0 0 24px;line-height:1.65}label{display:block;font-weight:800;margin:15px 0 7px}
input{width:100%;min-height:46px;padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;transition:border-color .18s,box-shadow .18s}
input:focus{outline:0;border-color:#60a5fa;box-shadow:0 0 0 4px rgba(37,99,235,.12)}
button{width:100%;min-height:47px;margin-top:22px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--blue-dark));color:white;font:inherit;font-weight:900;cursor:pointer;box-shadow:0 10px 24px rgba(29,78,216,.22);transition:transform .18s,box-shadow .18s}button:hover{transform:translateY(-1px);box-shadow:0 14px 30px rgba(29,78,216,.28)}button:focus-visible{outline:3px solid rgba(37,99,235,.28);outline-offset:3px}
.error{background:#fff1f2;color:#9f1239;border:1px solid #fecdd3;border-radius:10px;padding:11px 13px;margin-bottom:14px;line-height:1.5}
</style></head><body><form class="card" method="post" action="/login">
<div class="eyebrow">Cloudflare Control</div><h1>TG DualBot</h1><p class="muted">登录双向机器人管理后台，集中管理用户、消息、验证和 Telegram 话题。</p>
${error ? `<div class="error" role="alert">${h(error)}</div>` : ""}
<label for="panel-username">用户名</label><input id="panel-username" name="username" autocomplete="username" required>
<label for="panel-password">密码</label><input id="panel-password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">登录</button></form></body></html>`;
}

function layout(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · TG DualBot</title><style>
:root{--bg:#eef2f7;--panel:#fff;--line:#d9e0ea;--ink:#172033;--muted:#667085;--nav:#0b1324;--nav-soft:#17233b;--blue:#1d4ed8;--blue-soft:#eff6ff;--red:#dc2626;--green:#15803d;--amber:#b45309;--shadow:0 12px 34px rgba(15,23,42,.07)}
*,*::before,*::after{box-sizing:border-box}html{max-width:100%;overflow-x:clip;background:var(--bg)}body{margin:0;max-width:100%;overflow-x:clip;background:linear-gradient(180deg,#f7f9fc 0,var(--bg) 260px);color:var(--ink);font-family:"Noto Sans SC","Microsoft YaHei",Segoe UI,sans-serif;font-size:15px}
.shell{display:grid;grid-template-columns:252px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 18px;background:linear-gradient(180deg,#0b1324,#101a30);color:#fff;border-right:1px solid rgba(148,163,184,.14)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:26px;padding:0 7px;font-size:19px;font-weight:900;letter-spacing:-.02em}.brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:linear-gradient(145deg,#2563eb,#0ea5e9);box-shadow:0 10px 26px rgba(37,99,235,.3);font-size:14px;letter-spacing:.04em}.brand small{display:block;color:#93a4bf;font-size:12px;font-weight:700;letter-spacing:.02em;margin-top:3px}
nav{display:grid;gap:5px}nav a{display:flex;align-items:center;min-height:43px;color:#dbe7f8;text-decoration:none;padding:10px 12px;border:1px solid transparent;border-radius:10px;font-weight:800;transition:background .16s,border-color .16s,transform .16s}nav a:hover,nav a:focus-visible{background:var(--nav-soft);border-color:rgba(148,163,184,.16);transform:translateX(2px);outline:0}nav a:last-child{margin-top:12px;color:#fecaca;border-top:1px solid rgba(148,163,184,.14);border-radius:0;padding-top:18px}
main{min-width:0;width:100%;max-width:1540px;margin-inline:auto;padding:clamp(18px,2.4vw,34px)}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}.top h1{margin:0;font-size:clamp(25px,3vw,32px);letter-spacing:-.035em}.top>.badge{background:#e8eef7;color:#344054}
.card{min-width:0;max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:clamp(15px,1.7vw,22px);margin:16px 0;box-shadow:var(--shadow)}.card h2{margin:0 0 8px;font-size:19px;letter-spacing:-.015em}.card p:last-child{margin-bottom:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.grid>.card{margin:0}.metrics-grid{grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:16px}.metric-card{position:relative;overflow:hidden;min-height:116px}.metric-card::after{content:"";position:absolute;right:-22px;bottom:-34px;width:92px;height:92px;border-radius:999px;background:var(--blue-soft)}.metric{position:relative;z-index:1;margin-top:12px;font-size:31px;font-weight:950;letter-spacing:-.04em}.muted,small{color:var(--muted);line-height:1.6}
.toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.toolbar h2,.toolbar p{margin-top:0}.actions,.row-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row-actions{margin-top:10px}.row-actions form{display:inline-flex;margin:0}.note-form{display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:8px;align-items:center}
.btn,button{display:inline-flex;align-items:center;justify-content:center;min-height:38px;border:1px solid transparent;border-radius:9px;background:#e8edf4;color:#1e293b;padding:8px 12px;font:inherit;font-weight:850;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s}.btn:hover,button:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(15,23,42,.1)}.btn:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid rgba(37,99,235,.22);outline-offset:2px}
.btn.primary,button.primary{background:var(--blue);color:#fff}.btn.danger,button.danger{background:var(--red);color:#fff}.btn.ok,button.ok{background:var(--green);color:#fff}
input,textarea,select{width:100%;min-height:42px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:var(--ink);padding:9px 11px;font:inherit;transition:border-color .16s,box-shadow .16s}input:focus,textarea:focus,select:focus{border-color:#60a5fa;box-shadow:0 0 0 3px rgba(37,99,235,.1)}textarea{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}input[readonly]{background:#f8fafc;color:#475569}input[type="checkbox"]{width:18px;min-height:18px;height:18px;margin:0;accent-color:var(--blue)}
label{display:block;margin:11px 0 6px;font-weight:850}.check-row{display:flex;align-items:center;gap:9px;min-height:42px;margin:11px 0 6px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#f8fafc;font-weight:800}
.table-wrap{display:block;width:100%;max-width:100%;min-width:0;contain:inline-size;overflow-x:auto;border:1px solid var(--line);border-radius:11px;background:#fff;-webkit-overflow-scrolling:touch}.table-wrap table{min-width:var(--table-min,760px)}table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;font-size:14px}thead th{position:sticky;top:0;z-index:1;background:#f6f8fb;color:#475467;font-size:12px;font-weight:900;letter-spacing:.02em}th,td{border-bottom:1px solid #e6ebf2;text-align:left;padding:12px;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfdff}td .actions{min-width:max-content}.users-table td{min-width:140px}.users-table td:last-child{min-width:280px}.logs-table td:nth-child(2){min-width:460px}
.badge{display:inline-flex;align-items:center;border-radius:999px;background:#e8edf4;color:#1f2937;padding:4px 9px;font-size:12px;font-weight:900;white-space:nowrap}.badge.red{background:#fee2e2;color:#991b1b}.badge.green{background:#dcfce7;color:#166534}.badge.warn{background:#fef3c7;color:#92400e}
pre{max-width:100%;max-height:360px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;background:#0d1729;color:#e5edf8;border-radius:10px;padding:13px;line-height:1.55}.msg{background:#eff6ff;border:1px solid #bfdbfe;border-radius:9px;padding:10px 12px;color:#1e3a8a;font-weight:750;line-height:1.55}details summary{cursor:pointer;font-weight:800}code{overflow-wrap:anywhere;color:#1d4ed8}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1180px){.metrics-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width: 900px){
.users-wrap{border:0;background:transparent;overflow:visible}
.users-wrap .users-table{display:block!important;min-width:0!important;background:transparent}
.users-wrap .users-table thead{display:none}
.users-wrap .users-table tbody{display:grid;gap:12px}
.users-wrap .users-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#fff;box-shadow:0 8px 22px rgba(15,23,42,.05)}
.users-wrap .users-table td{display:block;min-width:0!important;padding:12px 14px;border:0;border-bottom:1px solid #edf1f6}
.users-wrap .users-table td::before{content:attr(data-label);display:block;margin-bottom:5px;color:#667085;font-size:11px;font-weight:900;letter-spacing:.04em}
.users-wrap .users-table td:first-child,.users-wrap .users-table td:last-child{grid-column:1/-1}
.users-wrap .users-table td:last-child{border-bottom:0}
.users-wrap .users-table tbody tr:hover{background:#fff}
}
@media(max-width:800px){.shell{grid-template-columns:1fr}.side{position:relative;height:auto;padding:13px 14px}.brand{margin-bottom:12px}.brand-mark{width:36px;height:36px}nav{display:flex;gap:7px;overflow-x:auto;padding-bottom:3px;scrollbar-width:thin}nav a{flex:0 0 auto;min-height:40px;padding:8px 11px}nav a:last-child{margin:0;border-top:1px solid rgba(248,113,113,.25);border-radius:9px;padding-top:8px}main{padding:16px}.top{align-items:flex-start;margin-bottom:12px}.top h1{font-size:25px}.card{padding:15px;margin:12px 0}.note-form{grid-template-columns:1fr}.btn,button{min-height:42px}.table-wrap{border-radius:9px}}
@media(max-width:560px){.metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.metric-card{min-height:104px}.metric{font-size:27px}.top>.badge{display:none}.grid{grid-template-columns:1fr}.users-table tr{grid-template-columns:1fr}.users-table td{grid-column:1/-1}.row-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.row-actions form,.row-actions button{width:100%}}
</style></head><body><div class="shell"><aside class="side"><div class="brand"><span class="brand-mark">TG</span><span>TG DualBot<small>Cloudflare 控制台</small></span></div><nav aria-label="后台主导航">
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
    const body = `<div class="grid metrics-grid">
<div class="card metric-card"><div class="muted">用户数</div><div class="metric">${stats[0]}</div></div>
<div class="card metric-card"><div class="muted">封禁用户</div><div class="metric">${stats[1]}</div></div>
<div class="card metric-card"><div class="muted">已验证用户</div><div class="metric">${stats[2]}</div></div>
<div class="card metric-card"><div class="muted">消息记录</div><div class="metric">${stats[3]}</div></div>
<div class="card metric-card"><div class="muted">CF 验证通过</div><div class="metric">${stats[4]}</div></div>
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
    return html(layout("收件箱", `<div class="card"><div class="toolbar"><div><h2>双向消息记录</h2><p class="muted">用户入站消息、Telegram 管理员回复、Web 后台回复都会记录在这里。</p></div></div><div class="table-wrap" style="--table-min:900px"><table><caption class="sr-only">双向消息记录</caption><thead><tr><th scope="col">ID/状态</th><th scope="col">用户</th><th scope="col">方向/来源</th><th scope="col">内容/错误</th><th scope="col">操作</th></tr></thead><tbody>${bodyRows}</tbody></table></div></div>`));
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

async function usersPage(request, env) {
    await ensureVerificationSchema(env);
    const rows = await env.DB.prepare(USER_WITH_IDENTITY_SELECT + " ORDER BY u.updated_at DESC LIMIT 300").all();
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
            u.last_device_fingerprint ? `指纹: ${h(String(u.last_device_fingerprint).slice(0, 32))}` : "指纹: -",
            u.identity_label_name ? "人工确认标签: " + h(u.identity_label_name) : "人工确认标签: -",
        ].join("<br>");
        const topic = [
            u.topic_thread_id ? `话题 ID: ${h(u.topic_thread_id)}` : "话题 ID: -",
            `状态: ${h(u.topic_status || "-")}`,
            u.topic_title ? `标题: ${h(u.topic_title)}` : "标题: -",
            u.topic_last_error ? `错误: ${h(u.topic_last_error)}` : "",
        ].filter(Boolean).join("<br>");
        const unverify = u.verified ? `<form method="post" action="/users/${u.user_id}/unverify"><button type="submit">取消验证</button></form>` : "";
        const topicActions = `<form method="post" action="/users/${u.user_id}/topic/create"><button type="submit">创建话题</button></form><form method="post" action="/users/${u.user_id}/topic/rebuild"><button type="submit">重建话题</button></form><form method="post" action="/users/${u.user_id}/topic/unbind"><button type="submit">解除话题绑定</button></form>`;
        const deleteAction = `<form method="post" action="/users/${u.user_id}/delete" onsubmit="return confirm('确定要永久删除该用户及其全部消息和验证记录吗？此操作无法恢复。')"><button class="danger" type="submit">删除用户</button></form>`;
        return `<tr><td data-label="用户"><b>${h(u.full_name || u.user_id)}</b><br><small>${u.user_id} @${h(u.username || "")}<br>语言: ${h(u.language_code || "-")}</small></td><td data-label="状态">${status}<br><small>${h(u.verification_status || "")}<br>${h(u.updated_at)}</small></td><td data-label="公网 HTTP 信息">${http}<br><small>${h(u.last_verified_at || "")}</small></td><td data-label="UDP / WebRTC / 指纹">${udp}</td><td data-label="话题">${topic}</td><td data-label="标签 / 备注">${h(u.note || "-")}</td><td data-label="操作"><form class="note-form" method="post" action="/users/${u.user_id}/note"><label class="sr-only" for="note-${u.user_id}">用户 ${u.user_id} 的标签或备注</label><input id="note-${u.user_id}" name="note" value="${h(u.note || "")}" placeholder="标签 / 备注"><button type="submit">保存备注</button></form><div class="row-actions"><form method="post" action="/users/${u.user_id}/${actionPath}"><button class="${actionClass}" type="submit">${actionText}</button></form>${unverify}${topicActions}${deleteAction}</div></td></tr>`;
    }).join("");
    return html(layout("用户管理", `<div class="card"><h2>用户管理</h2><p class="muted">展示已私聊过 Bot 的用户、验证状态、IPv4/IPv6、UDP WebRTC、设备指纹、话题绑定、封禁状态和标签 / 备注；备注同时作为精确指纹命中的标签。</p><div class="table-wrap users-wrap" style="--table-min:1320px"><table class="users-table"><caption class="sr-only">机器人用户管理</caption><thead><tr><th scope="col">用户</th><th scope="col">状态</th><th scope="col">公网 HTTP 信息</th><th scope="col">UDP / WebRTC / 指纹</th><th scope="col">话题</th><th scope="col">标签 / 备注</th><th scope="col">操作</th></tr></thead><tbody>${bodyRows}</tbody></table></div></div>`));
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

async function userDelete(request, env, userId) {
    await ensureVerificationSchema(env);
    await env.DB.batch([
        env.DB.prepare("DELETE FROM device_fingerprint_profiles WHERE user_id=?").bind(userId),
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
    return html(layout("CF 验证记录", `<div class="card"><h2>CF 验证记录</h2><p class="muted">访客通过 Cloudflare Turnstile 后会记录 HTTP IPv4/IPv6、UDP WebRTC IPv4/IPv6、ASN、设备系统和 User-Agent。验证入口使用一次性 token 关联 Telegram 用户。</p><div class="table-wrap" style="--table-min:1080px"><table><caption class="sr-only">Cloudflare 验证记录</caption><thead><tr><th scope="col">ID</th><th scope="col">用户</th><th scope="col">公网 HTTP</th><th scope="col">UDP / WebRTC</th><th scope="col">设备/User-Agent</th><th scope="col">时间</th></tr></thead><tbody>${bodyRows}</tbody></table></div></div>`));
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
<label for="admin-chat-ids">管理员 Telegram Chat ID（最多 3 个，逗号分隔）</label><input id="admin-chat-ids" name="admin_chat_ids" value="${h(adminIds.join(","))}">
<label for="welcome-message">用户 /start 欢迎语</label><textarea id="welcome-message" name="welcome_message">${h(welcome)}</textarea>
<div class="grid"><div><label for="control-mode">控制模式</label><select id="control-mode" name="control_mode">${option("web", "仅 Web 后台", mode)}${option("topic", "仅 Telegram 话题", mode)}${option("both", "Web 后台 + Telegram 话题", mode)}</select></div><div><label for="topic-group-id">Telegram 话题群 ID</label><input id="topic-group-id" name="topic_group_id" value="${h(groupId || "")}" placeholder="-1001234567890"></div></div>
<div class="grid"><div><label for="topic-create-policy">话题创建策略</label><select id="topic-create-policy" name="topic_create_policy">${option("after_verify", "验证通过后创建", createPolicy)}${option("first_message", "用户首条消息时创建", createPolicy)}</select></div><div><label class="check-row" for="topic-sync-web"><input id="topic-sync-web" type="checkbox" name="topic_sync_web_replies" ${syncWebReplies ? "checked" : ""}> Web/私聊回复同步到话题</label></div></div>
<div class="grid"><div><label for="public-base-url">公开地址</label><input id="public-base-url" value="${h(base)}" readonly></div><div><label for="verify-entry">验证入口</label><input id="verify-entry" value="${h(`${base}/verify/{token}`)}" readonly></div></div>
<div class="actions"><button class="primary" type="submit">保存设置</button></div></form></div>
<div class="card"><h2>Cloudflare Secrets 状态</h2>
<div class="table-wrap" style="--table-min:620px"><table><caption class="sr-only">Cloudflare Secrets 配置状态</caption><thead><tr><th scope="col">名称</th><th scope="col">状态</th><th scope="col">说明</th></tr></thead><tbody>
${secretRow("BOT_TOKEN", env.BOT_TOKEN, "Telegram Bot Token")}
${secretRow("PANEL_PASSWORD", env.PANEL_PASSWORD, "后台登录密码")}
${secretRow("PANEL_SECRET", env.PANEL_SECRET, "Cookie session secret")}
${secretRow("TELEGRAM_SECRET_TOKEN", env.TELEGRAM_SECRET_TOKEN, "Telegram webhook secret token")}
${secretRow("TURNSTILE_SECRET_KEY", env.TURNSTILE_SECRET_KEY, "Cloudflare Turnstile secret")}
${secretRow("TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY, "Cloudflare Turnstile site key，可放 vars")}
${secretRow("CONTROL_MODE", mode, "web / topic / both")}
${secretRow("TOPIC_GROUP_ID", groupId, "开启 Topics 的 Telegram 超级群 ID")}
</tbody></table></div></div>`;
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

const LOG_MESSAGE_TRANSLATIONS = {
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
};

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

    return {
        title: base.title || rawMessage || "未命名日志",
        reason,
        suggestion,
        rawMessage,
        rawData: prettyLogData(rawData),
    };
}

async function logsPage(request, env) {
    const rows = await env.DB.prepare("SELECT * FROM event_logs ORDER BY id DESC LIMIT 200").all();
    const bodyRows = (rows.results || []).map((r) => {
        const translated = localizeLogEntry(r.message, r.data);
        const level = String(r.level || "").toLowerCase();
        const levelText = level === "error" ? "错误" : level === "warn" ? "警告" : level === "info" ? "信息" : (r.level || "日志");
        const levelClass = level === "error" ? "red" : level === "warn" ? "warn" : "";
        const original = [translated.rawMessage, translated.rawData].filter(Boolean).join("\n");
        const suggestion = translated.suggestion
            ? `<div class="msg" style="margin-top:10px"><b>处理建议：</b>${h(translated.suggestion)}</div>`
            : "";
        return `<tr><td>#${r.id}<br><span class="badge ${levelClass}">${h(levelText)}</span></td><td><b>${h(translated.title)}</b><div class="muted" style="margin-top:8px"><b>中文说明：</b>${h(translated.reason)}</div>${suggestion}<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:700">查看原始日志</summary><pre>${h(original)}</pre></details></td><td>${h(r.created_at)}</td></tr>`;
    }).join("");
    return html(layout("日志", `<div class="card"><h2>最近日志</h2><p class="muted">系统会在页面中翻译常见错误并给出处理建议；原始日志完整保留在“查看原始日志”中。</p><div class="table-wrap" style="--table-min:780px"><table class="logs-table"><caption class="sr-only">最近系统日志</caption><thead><tr><th scope="col">ID</th><th scope="col">中文说明 / 原始日志</th><th scope="col">时间</th></tr></thead><tbody>${bodyRows}</tbody></table></div></div>`));
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
    const screenInfo = data && data.screen && typeof data.screen === "object" ? data.screen : {};
    const fingerprint = data && data.fingerprint && typeof data.fingerprint === "object" ? data.fingerprint : {};
    const hardware = fingerprint.hardware && typeof fingerprint.hardware === "object" ? fingerprint.hardware : {};
    const canvas = fingerprint.canvas && typeof fingerprint.canvas === "object" ? fingerprint.canvas : {};
    const webgl = fingerprint.webgl && typeof fingerprint.webgl === "object" ? fingerprint.webgl : {};
    const probe = data && data.probe && typeof data.probe === "object" ? data.probe : {};
    const webrtc = data && data.webrtc && typeof data.webrtc === "object" ? data.webrtc : {};
    const safe = {
        language: compactClientText(data && data.language, 32),
        languages: Array.isArray(data && data.languages) ? data.languages.map((value) => compactClientText(value, 32)).slice(0, 5) : [],
        platform: compactClientText(data && data.platform, 80),
        user_agent: compactClientText(data && data.user_agent, 500),
        timezone: compactClientText(data && data.timezone, 64),
        screen: {
            width: Number(screenInfo.width) || 0,
            height: Number(screenInfo.height) || 0,
            pixel_ratio: Number(screenInfo.pixel_ratio) || 1,
            color_depth: Number(screenInfo.color_depth) || 0,
        },
        fingerprint: {
            version: 2,
            hardware: {
                cores: Number(hardware.cores) || 0,
                memory_gb: Number(hardware.memory_gb) || 0,
                touch_points: Number(hardware.touch_points) || 0,
            },
            canvas: { status: compactClientText(canvas.status, 20), hash: compactClientText(canvas.hash, 32) },
            webgl: {
                status: compactClientText(webgl.status, 20),
                hash: compactClientText(webgl.hash, 32),
                renderer_hash: compactClientText(webgl.renderer_hash, 32),
                limits_hash: compactClientText(webgl.limits_hash, 32),
            },
        },
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
    };
    let jsonValue = JSON.stringify(safe);
    if (jsonValue.length <= 6000) return jsonValue;
    safe.webrtc.candidates = safe.webrtc.candidates.slice(0, 3);
    safe.webrtc.error = safe.webrtc.error.slice(0, 100);
    safe.probe.error = safe.probe.error.slice(0, 100);
    safe.user_agent = safe.user_agent.slice(0, 200);
    jsonValue = JSON.stringify(safe);
    if (jsonValue.length <= 6000) return jsonValue;
    safe.webrtc.candidates = [];
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
        language: navigator.language || "",
        languages: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 5) : [],
        platform: navigator.platform || "",
        user_agent: navigator.userAgent || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        screen: {
            width: screen.width || 0,
            height: screen.height || 0,
            pixel_ratio: window.devicePixelRatio || 1,
            color_depth: screen.colorDepth || 0,
        },
        fingerprint: {
            version: 2,
            hardware: {
                cores: navigator.hardwareConcurrency || 0,
                memory_gb: navigator.deviceMemory || 0,
                touch_points: navigator.maxTouchPoints || 0,
            },
            canvas: null,
            webgl: null,
        },
        probe: null,
        webrtc: null,
    };
    const tasks = [
        withClientTimeout(httpProbe(), 4000, { error: "timeout" }),
        withClientTimeout(collectWebRtcCandidates(), 4500, { udp_status: "failed", error: "timeout", candidates: [] }),
        withClientTimeout(collectCanvasSignal(), 1500, { status: "failed", hash: "" }),
        withClientTimeout(collectWebGlSignal(), 1500, { status: "failed", hash: "", renderer_hash: "", limits_hash: "" }),
    ];
    const results = await Promise.allSettled(tasks);
    data.probe = results[0].status === "fulfilled" ? results[0].value : { error: String(results[0].reason || "failed").slice(0, 300) };
    data.webrtc = results[1].status === "fulfilled" ? results[1].value : { udp_status: "failed", error: String(results[1].reason || "failed").slice(0, 300) };
    data.fingerprint.canvas = results[2].status === "fulfilled" ? results[2].value : { status: "failed", hash: "" };
    data.fingerprint.webgl = results[3].status === "fulfilled" ? results[3].value : { status: "failed", hash: "" };
    return data;
}
async function browserShortSha256(value) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return "";
    const bytes = new TextEncoder().encode(String(value || ""));
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
async function collectCanvasSignal() {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 280;
        canvas.height = 80;
        const context = canvas.getContext("2d");
        if (!context) return { status: "unsupported", hash: "" };
        context.textBaseline = "top";
        context.fillStyle = "#f97316";
        context.fillRect(4, 4, 96, 24);
        context.fillStyle = "#1d4ed8";
        context.font = "16px Arial, sans-serif";
        context.fillText("TG DualBot 指纹 v1", 8, 34);
        context.globalCompositeOperation = "multiply";
        context.fillStyle = "rgba(22,163,74,.65)";
        context.beginPath();
        context.arc(225, 35, 26, 0, Math.PI * 2);
        context.fill();
        const hash = await browserShortSha256(canvas.toDataURL("image/png"));
        return { status: hash ? "ok" : "unsupported", hash };
    } catch (error) {
        return { status: "failed", hash: "" };
    }
}
function normalizedGlValue(value) {
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return value == null ? "" : value;
}
async function collectWebGlSignal() {
    try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) return { status: "unsupported", hash: "", renderer_hash: "", limits_hash: "" };
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        const vendor = normalizedGlValue(gl.getParameter(gl.VENDOR));
        const renderer = normalizedGlValue(gl.getParameter(gl.RENDERER));
        const version = normalizedGlValue(gl.getParameter(gl.VERSION));
        const shadingVersion = normalizedGlValue(gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
        const maxTextureSize = normalizedGlValue(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const maxRenderbufferSize = normalizedGlValue(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        const maxVertexAttribs = normalizedGlValue(gl.getParameter(gl.MAX_VERTEX_ATTRIBS));
        const maxCombinedTextures = normalizedGlValue(gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS));
        const lineWidthRange = normalizedGlValue(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE));
        const unmaskedVendor = debugInfo ? normalizedGlValue(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : "";
        const unmaskedRenderer = debugInfo ? normalizedGlValue(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : "";
        const legacyValues = [
            vendor, renderer, version, shadingVersion, maxTextureSize, maxRenderbufferSize,
            maxVertexAttribs, maxCombinedTextures, lineWidthRange, unmaskedVendor, unmaskedRenderer,
        ];
        const rendererValues = [vendor, renderer, unmaskedVendor, unmaskedRenderer];
        const limitValues = [maxTextureSize, maxRenderbufferSize, maxVertexAttribs, maxCombinedTextures, lineWidthRange];
        const hashes = await Promise.all([
            browserShortSha256(JSON.stringify(legacyValues)),
            browserShortSha256(JSON.stringify(rendererValues)),
            browserShortSha256(JSON.stringify(limitValues)),
        ]);
        const hash = hashes[0];
        const loseContext = gl.getExtension("WEBGL_lose_context");
        if (loseContext) loseContext.loseContext();
        return { status: hash ? "ok" : "unsupported", hash, renderer_hash: hashes[1], limits_hash: hashes[2] };
    } catch (error) {
        return { status: "failed", hash: "", renderer_hash: "", limits_hash: "" };
    }
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
    const rawClientData = JSON.stringify(clientDataForVerificationStorage(clientData, network)).slice(0, 6000);
    const userId = Number(session.user_id);
    const deviceFingerprint = await buildDeviceFingerprint(clientData);
    const webrtcIdentity = await buildWebRtcIdentity(network);
    const fingerprintProfile = await buildFingerprintProfile(clientData, deviceOs, webrtcIdentity);
    await env.DB.prepare("UPDATE verification_sessions SET status='verified', verified_at=? WHERE token=?")
        .bind(ts, token)
        .run();
    await env.DB.prepare(`INSERT INTO ip_verifications(user_id, ip, country, colo, user_agent, passed, turnstile_action, http_ip, http_ip_version, http_ipv4, http_ipv6, webrtc_ipv4, webrtc_ipv6, webrtc_protocol, webrtc_candidate_type, udp_status, asn, as_organization, device_os, token, raw_client_data, created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, ip || "", cfInfo.country, cfInfo.colo, userAgent.slice(0, 500), 1, String(result.action || ""), ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.webrtc_protocol, network.webrtc_candidate_type, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, token, rawClientData, ts)
        .run();
    await env.DB.prepare(`UPDATE users SET verified=1, verification_status='verified', verification_token=?, language_code=COALESCE(NULLIF(language_code,''), ?), last_verified_ip=?, last_verified_at=?, last_cf_country=?, last_http_ip=?, last_http_ip_version=?, last_http_ipv4=?, last_http_ipv6=?, last_webrtc_ipv4=?, last_webrtc_ipv6=?, last_udp_status=?, last_asn=?, last_as_organization=?, last_device_os=?, last_user_agent=?, last_device_fingerprint=COALESCE(NULLIF(?,''), last_device_fingerprint), updated_at=? WHERE user_id=?`)
        .bind(token, session.language_code || "", ip || "", ts, cfInfo.country, ip || "", ipVersion(ip), network.http_ipv4, network.http_ipv6, network.webrtc_ipv4, network.webrtc_ipv6, network.udp_status, cfInfo.asn, cfInfo.asOrganization, deviceOs, userAgent.slice(0, 500), deviceFingerprint, ts, userId)
        .run();
    const fingerprintProfileSlot = await upsertFingerprintProfile(env, userId, fingerprintProfile);
    const [fingerprintMatch, webrtcIdentityMatch] = await Promise.all([
        findFingerprintSimilarityMatch(env, userId, fingerprintProfile, deviceFingerprint),
        findWebRtcIdentityLabel(env, userId, network),
    ]);
    const fingerprintConfirmationState = fingerprintMatch?.canConfirm && fingerprintProfileSlot
        ? await getIdentityConfirmationState(env, userId)
        : { labelId: 0, confirmedAt: "" };
    const fingerprintConfirmationToken = fingerprintMatch?.canConfirm && fingerprintProfileSlot
        ? await buildFingerprintConfirmationToken(env, {
            userId,
            targetSlot: fingerprintProfileSlot,
            targetProfile: fingerprintProfile,
            candidateUserId: fingerprintMatch.userId,
            candidateSlot: fingerprintMatch.slot,
            candidateProfile: fingerprintMatch.profile,
            labelId: fingerprintMatch.labelId,
            targetConfirmedLabelId: fingerprintConfirmationState.labelId,
            targetConfirmedAt: fingerprintConfirmationState.confirmedAt,
        })
        : "";
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
        deviceFingerprint,
        fingerprintMatchedUserId: Number(fingerprintMatch?.userId || 0),
        fingerprintMatchedUsername: String(fingerprintMatch?.username || ""),
        fingerprintLabel: String(fingerprintMatch?.labelName || fingerprintMatch?.note || "").trim().slice(0, 200),
        fingerprintSimilarity: Number(fingerprintMatch?.evidence?.score || 0),
        fingerprintMatchedFields: Array.isArray(fingerprintMatch?.evidence?.matchedFields) ? fingerprintMatch.evidence.matchedFields.slice(0, 10) : [],
        fingerprintWebRtcExact: Boolean(fingerprintMatch?.evidence?.webrtcExact),
        fingerprintExactProfile: Boolean(fingerprintMatch?.evidence?.exactProfile),
        fingerprintHighConfidence: Boolean(fingerprintMatch?.evidence?.highConfidence),
        fingerprintProfileSlot,
        fingerprintMatchedProfileSlot: Number(fingerprintMatch?.slot || 0),
        fingerprintMatchedLabelId: Number(fingerprintMatch?.labelId || 0),
        fingerprintConfirmationToken,
        fingerprintCanConfirm: Boolean(fingerprintConfirmationToken),
        webrtcIdentityHash: String(webrtcIdentity.hash || ""),
        webrtcIdentityIpVersion: String(webrtcIdentityMatch.ipVersion || ""),
        webrtcIdentityLabelId: Number(webrtcIdentityMatch.label?.id || 0),
        webrtcIdentityLabelName: String(webrtcIdentityMatch.label?.label_name || "").slice(0, 80),
        webrtcIdentitySourceUserId: Number(webrtcIdentityMatch.label?.source_user_id || 0),
        webrtcIdentityConfirmed: Boolean(webrtcIdentityMatch.label?.confirmed),
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

export async function handleTelegramUpdate(env, update) {
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
        `话题：${user.topic_thread_id || "无"}`,
        `备注：${user.note || "无"}`,
        "人工确认标签：" + (user.identity_label_name || "无"),
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
            [
                { text: "标记 WebRTC", callback_data: "rtcmark:" + user.user_id },
                { text: "WebRTC 标签", callback_data: "rtclabels:" + user.user_id },
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

function fingerprintConfirmCallbackData(userId, info) {
    if (!info.fingerprintCanConfirm || !/^[0-9a-f]{12}$/.test(String(info.fingerprintConfirmationToken || "")) || !info.fingerprintProfileSlot || !info.fingerprintMatchedProfileSlot || !info.fingerprintMatchedUserId) return "";
    const data = [
        "fpconfirm",
        Number(userId),
        Number(info.fingerprintProfileSlot),
        Number(info.fingerprintMatchedUserId),
        Number(info.fingerprintMatchedProfileSlot),
        info.fingerprintConfirmationToken,
    ].join(":");
    return data.length <= 64 ? data : "";
}

function fingerprintMatchTitle(info) {
    if (info.fingerprintWebRtcExact) return "WebRTC 公网地址完全一致（待人工确认）";
    if (info.fingerprintExactProfile && !info.fingerprintHighConfidence) return "设备指纹完全一致（采集字段不足，仅供参考）";
    if (info.fingerprintExactProfile) return "设备指纹完全一致（待人工确认）";
    return "跨浏览器/设备指纹相似候选（待人工确认）";
}

function topicVerificationText(info) {
    const lines = [
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
        `设备指纹：${info.deviceFingerprint ? info.deviceFingerprint.slice(0, 32) : "-"}`,
    ];
    if (info.fingerprintMatchedUserId) {
        lines.push(
            "",
            fingerprintMatchTitle(info),
            `标签：${info.fingerprintLabel || "未设置"}`,
            `指纹相似度：${Number(info.fingerprintSimilarity || 0)}%`,
            `匹配字段：${Array.isArray(info.fingerprintMatchedFields) && info.fingerprintMatchedFields.length ? info.fingerprintMatchedFields.join("、") : "无"}`,
            `匹配用户 ID：${info.fingerprintMatchedUserId}`,
            `匹配用户名：${info.fingerprintMatchedUsername ? `@${info.fingerprintMatchedUsername}` : "无"}`,
            "说明：浏览器采集线索仅供管理员人工判断。",
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
    return lines.join("\n");
}

async function completeTopicVerification(env, userId, info) {
    if (!(await topicEnabled(env))) return;
    if ((await topicCreatePolicy(env)) !== "after_verify") return;
    try {
        const topic = await ensureUserTopic(env, userId, { reason: "verify" });
        if (!topic) return;
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
        const fingerprintCallback = !info.webrtcIdentityLabelId ? fingerprintConfirmCallbackData(userId, info) : "";
        if (fingerprintCallback) {
            confirmationRows.push([{
                text: "确认同一人（指纹候选）",
                callback_data: fingerprintCallback,
            }]);
        }
        if (info.fingerprintMatchedUserId) {
            confirmationRows.push([{
                text: "查看匹配账号",
                callback_data: "who:" + info.fingerprintMatchedUserId,
            }]);
        }
        if (confirmationRows.length) {
            payload.reply_markup = {
                inline_keyboard: confirmationRows,
            };
        }
        await tgCall(env, "sendMessage", payload);
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
    return `用户信息\nuser_id: ${row.user_id}\nusername: @${row.username || ""}\nfull_name: ${row.full_name || ""}\nblocked: ${Boolean(row.blocked)}\nverified: ${Boolean(row.verified)}\nstatus: ${row.verification_status || "-"}\nnote: ${row.note || ""}\nwebrtc_identity_label: ${row.identity_label_name || "-"}\nHTTP IPv4: ${row.last_http_ipv4 || "-"}\nHTTP IPv6: ${row.last_http_ipv6 || "-"}\nUDP IPv4: ${row.last_webrtc_ipv4 || "-"}\nUDP IPv6: ${row.last_webrtc_ipv6 || "-"}\nASN: ${row.last_asn || "-"}\ndevice_fingerprint: ${row.last_device_fingerprint ? String(row.last_device_fingerprint).slice(0, 32) : "-"}\ntopic_thread_id: ${row.topic_thread_id || "-"}\ntopic_status: ${row.topic_status || "-"}\nupdated_at: ${row.updated_at}`;
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

async function getUserWithIdentity(env, userId) {
    return env.DB.prepare(USER_WITH_IDENTITY_SELECT + " WHERE u.user_id=?").bind(userId).first();
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
    const [action, rawUserId, rawLabelId] = parts;
    if (action === "fpconfirm") {
        const userId = Number(rawUserId);
        const targetSlot = Number(rawLabelId);
        const candidateUserId = Number(parts[3]);
        const candidateSlot = Number(parts[4]);
        const evidenceToken = String(parts[5] || "");
        if (![userId, targetSlot, candidateUserId, candidateSlot].every(Number.isFinite)) {
            await answerCallbackQuery(env, query.id, "参数错误");
            return;
        }
        const result = await confirmFingerprintIdentity(env, userId, targetSlot, candidateUserId, candidateSlot, evidenceToken, adminId);
        if (result.error) {
            await answerCallbackQuery(env, query.id, result.error.slice(0, 180));
            return;
        }
        const basis = result.evidence.webrtcExact
            ? "WebRTC 公网地址完全一致"
            : `设备指纹相似度 ${result.evidence.score}%`;
        await answerCallbackQuery(env, query.id, "已人工确认同一人");
        await sendCallbackContextMessage(
            env,
            query,
            "已人工确认\n用户 ID：" + userId + "\n标签：" + result.label.label_name + "\n重新计算依据：" + basis + "。",
        );
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
        await setBlock(env, userId, true);
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

async function notifyVerificationSuccess(env, userId, token, info) {
    const username = info.username ? `@${h(info.username)}` : "无";
    const fingerprintText = info.deviceFingerprint ? h(info.deviceFingerprint.slice(0, 32)) : "-";
    const matchedFields = Array.isArray(info.fingerprintMatchedFields) && info.fingerprintMatchedFields.length
        ? info.fingerprintMatchedFields.map((field) => h(field)).join("、")
        : "无";
    const matchText = info.fingerprintMatchedUserId
        ? `\n\n${h(fingerprintMatchTitle(info))}\n标签：${h(info.fingerprintLabel || "未设置")}\n指纹相似度：${Number(info.fingerprintSimilarity || 0)}%\n匹配字段：${matchedFields}\n匹配用户 ID：<code>${info.fingerprintMatchedUserId}</code>\n匹配用户名：${info.fingerprintMatchedUsername ? `@${h(info.fingerprintMatchedUsername)}` : "无"}\n说明：浏览器采集线索仅供管理员人工判断。`
        : "";
    const identityText = info.webrtcIdentityLabelId
        ? `\n\n${info.webrtcIdentityConfirmed ? "WebRTC 标签（管理员已确认）" : "WebRTC 标签命中（待人工确认）"}\n标签：${h(info.webrtcIdentityLabelName || "未设置")}\n来源用户 ID：<code>${info.webrtcIdentitySourceUserId || "-"}</code>\n匹配依据：WebRTC ${h(info.webrtcIdentityIpVersion || "-")} 完全相同`
        : "";
    const textValue = `新用户验证通过\n用户 ID：<code>${userId}</code>\n昵称：${h(info.fullName || "-")}\n用户名：${username}\n语言：${h(info.languageCode || "-")}\n\n本次验证信息\n设备系统：${h(info.deviceOs || "-")}\n设备指纹：<code>${fingerprintText}</code>\nHTTP IP：<code>${h(info.httpIp || "-")}</code>\nHTTP IP 类型：${h(info.httpIpVersion || "-")}\n公网 IPv4：<code>${h(info.httpIpv4 || "-")}</code>\n公网 IPv6：<code>${h(info.httpIpv6 || "-")}</code>\n公网 ASN：${h(info.asn || "-")}\n运营商：${h(info.asOrganization || "-")}\n国家/地区：${h(info.country || "-")}\nCloudflare 机房：${h(info.colo || "-")}\n\nUDP / WebRTC 信息\nWebRTC IPv4：<code>${h(info.webrtcIpv4 || "-")}</code>\nWebRTC IPv6：<code>${h(info.webrtcIpv6 || "-")}</code>\nUDP 状态：${h(info.udpStatus || "-")}\nCandidate 类型：${h(info.candidateType || "-")}${matchText}${identityText}`;
    const keyboard = [];
    if (info.webrtcIdentityLabelId && !info.webrtcIdentityConfirmed) {
        keyboard.push([{ text: "确认同一人（WebRTC）", callback_data: "rtcconfirm:" + userId + ":" + info.webrtcIdentityLabelId }]);
    } else if (!info.webrtcIdentityLabelId) {
        const fingerprintCallback = fingerprintConfirmCallbackData(userId, info);
        if (fingerprintCallback) {
            keyboard.push([{ text: "确认同一人（指纹候选）", callback_data: fingerprintCallback }]);
        }
    }
    if (info.fingerprintMatchedUserId) {
        keyboard.push([{ text: "查看匹配账号", callback_data: "who:" + info.fingerprintMatchedUserId }]);
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
    await notifyAdmins(env, textValue, {
        reply_markup: {
            inline_keyboard: keyboard,
        },
    });
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
    if (!schemaObjects.has("table:device_fingerprint_profiles")) {
        await env.DB.prepare(
            "CREATE TABLE IF NOT EXISTS device_fingerprint_profiles (" +
            "user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, " +
            "slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3), " +
            "profile_hash TEXT NOT NULL CHECK(length(profile_hash)=32), " +
            "webrtc_ipv4_hash TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv4_hash='' OR length(webrtc_ipv4_hash)=32), " +
            "webrtc_ipv4_hash2 TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv4_hash2='' OR length(webrtc_ipv4_hash2)=32), " +
            "webrtc_ipv6_hash TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv6_hash='' OR length(webrtc_ipv6_hash)=32), " +
            "webrtc_ipv6_hash2 TEXT NOT NULL DEFAULT '' CHECK(webrtc_ipv6_hash2='' OR length(webrtc_ipv6_hash2)=32), " +
            "stable_hash TEXT NOT NULL DEFAULT '' CHECK(stable_hash='' OR length(stable_hash)=32), " +
            "canvas_hash TEXT NOT NULL DEFAULT '' CHECK(canvas_hash='' OR length(canvas_hash)=32), " +
            "renderer_hash TEXT NOT NULL DEFAULT '' CHECK(renderer_hash='' OR length(renderer_hash)=32), " +
            "limits_hash TEXT NOT NULL DEFAULT '' CHECK(limits_hash='' OR length(limits_hash)=32), " +
            "os_hash TEXT NOT NULL DEFAULT '' CHECK(os_hash='' OR length(os_hash)=32), " +
            "screen_hash TEXT NOT NULL DEFAULT '' CHECK(screen_hash='' OR length(screen_hash)=32), " +
            "dpr_depth_hash TEXT NOT NULL DEFAULT '' CHECK(dpr_depth_hash='' OR length(dpr_depth_hash)=32), " +
            "hardware_hash TEXT NOT NULL DEFAULT '' CHECK(hardware_hash='' OR length(hardware_hash)=32), " +
            "touch_hash TEXT NOT NULL DEFAULT '' CHECK(touch_hash='' OR length(touch_hash)=32), " +
            "timezone_hash TEXT NOT NULL DEFAULT '' CHECK(timezone_hash='' OR length(timezone_hash)=32), " +
            "language_hash TEXT NOT NULL DEFAULT '' CHECK(language_hash='' OR length(language_hash)=32), " +
            "feature_mask INTEGER NOT NULL DEFAULT 0, " +
            "seen_count INTEGER NOT NULL DEFAULT 1 CHECK(seen_count BETWEEN 1 AND 2147483647), " +
            "first_seen_at TEXT NOT NULL, " +
            "last_seen_at TEXT NOT NULL, " +
            "PRIMARY KEY(user_id, slot), " +
            "UNIQUE(user_id, profile_hash)) WITHOUT ROWID",
        ).run();
    }
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
        "last_device_fingerprint TEXT NOT NULL DEFAULT '' CHECK(last_device_fingerprint='' OR length(last_device_fingerprint)=32)",
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
        { name: "idx_users_device_fingerprint", sql: "CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint ON users(last_device_fingerprint) WHERE last_device_fingerprint<>''" },
        { name: "idx_users_device_fingerprint_updated", sql: "CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint_updated ON users(last_device_fingerprint, updated_at DESC) WHERE last_device_fingerprint<>''" },
        { name: "idx_fp_profiles_profile", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_profile ON device_fingerprint_profiles(profile_hash, last_seen_at DESC)" },
        { name: "idx_fp_profiles_webrtc4", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4 ON device_fingerprint_profiles(webrtc_ipv4_hash, last_seen_at DESC) WHERE webrtc_ipv4_hash<>''" },
        { name: "idx_fp_profiles_webrtc4b", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc4b ON device_fingerprint_profiles(webrtc_ipv4_hash2, last_seen_at DESC) WHERE webrtc_ipv4_hash2<>''" },
        { name: "idx_fp_profiles_webrtc6", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6 ON device_fingerprint_profiles(webrtc_ipv6_hash, last_seen_at DESC) WHERE webrtc_ipv6_hash<>''" },
        { name: "idx_fp_profiles_webrtc6b", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_webrtc6b ON device_fingerprint_profiles(webrtc_ipv6_hash2, last_seen_at DESC) WHERE webrtc_ipv6_hash2<>''" },
        { name: "idx_fp_profiles_stable", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_stable ON device_fingerprint_profiles(stable_hash, last_seen_at DESC) WHERE stable_hash<>''" },
        { name: "idx_fp_profiles_renderer", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_renderer ON device_fingerprint_profiles(renderer_hash, last_seen_at DESC) WHERE renderer_hash<>''" },
        { name: "idx_fp_profiles_canvas", sql: "CREATE INDEX IF NOT EXISTS idx_fp_profiles_canvas ON device_fingerprint_profiles(canvas_hash, last_seen_at DESC) WHERE canvas_hash<>''" },
        { name: "idx_webrtc_identity_labels_source", sql: "CREATE INDEX IF NOT EXISTS idx_webrtc_identity_labels_source ON webrtc_identity_labels(source_user_id, updated_at DESC)" },
        { name: "idx_webrtc_identity_confirmations_label", sql: "CREATE INDEX IF NOT EXISTS idx_webrtc_identity_confirmations_label ON webrtc_identity_confirmations(label_id)" },
        { name: "idx_inbox_topic_created", sql: "CREATE INDEX IF NOT EXISTS idx_inbox_topic_created ON inbox_messages(topic_chat_id, topic_thread_id, created_at)" },
        { name: "idx_verification_sessions_user_created", sql: "CREATE INDEX IF NOT EXISTS idx_verification_sessions_user_created ON verification_sessions(user_id, created_at)" },
        { name: "idx_verification_sessions_status", sql: "CREATE INDEX IF NOT EXISTS idx_verification_sessions_status ON verification_sessions(status)" },
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
