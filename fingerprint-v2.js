export const FINGERPRINT_ALGORITHM_VERSION = 2;
export const FINGERPRINT_CANDIDATE_THRESHOLD = 60;
export const FINGERPRINT_MIN_EXACT_QUALITY = 63;

export const FINGERPRINT_FONT_CATALOG = [
    "Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Courier New",
    "Georgia", "Helvetica", "Impact", "Lucida Console", "Microsoft Sans Serif", "Microsoft YaHei", "Palatino Linotype", "Segoe UI",
    "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "PingFang SC", "Heiti SC", "Songti SC", "STHeiti",
    "Noto Sans", "Noto Sans CJK SC", "Noto Serif", "Roboto", "Roboto Mono", "Ubuntu", "Droid Sans", "Droid Serif",
    "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "Menlo", "Monaco", "SF Pro Display", "SF Pro Text",
    "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "WenQuanYi Micro Hei", "SimHei", "SimSun", "KaiTi", "FangSong",
    "Source Han Sans SC", "Source Han Serif SC", "HarmonyOS Sans SC", "MiSans", "OPPO Sans", "vivo Sans", "HONOR Sans", "Sarasa Gothic SC",
    "Aptos", "Aptos Display", "Book Antiqua", "Franklin Gothic Medium", "Gill Sans", "Century Gothic", "Rockwell", "Garamond",
];

const MASK64 = (1n << 64n) - 1n;
const FONT_INDEX = new Map(FINGERPRINT_FONT_CATALOG.map((font, index) => [font.normalize("NFKC").trim().toLowerCase(), index]));

function clean(value, max = 200) {
    return value === null || value === undefined ? "" : String(value).normalize("NFKC").trim().toLowerCase().slice(0, max);
}

function number(value, min, max) {
    const result = Number(value);
    return Number.isFinite(result) && result >= min && result <= max ? result : null;
}

function unique(values, limit = 64, max = 200) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, max)).filter(Boolean))].sort().slice(0, limit);
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = stable(value[key]);
    return output;
}

export function stableFingerprintJson(value) {
    return JSON.stringify(stable(value));
}

function hex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(input) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(input))));
}

async function createKeyedHasher(secret) {
    const normalizedSecret = String(secret || "");
    const key = normalizedSecret
        ? await crypto.subtle.importKey("raw", new TextEncoder().encode(normalizedSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
        : null;
    return async (namespace, input) => {
        const payload = `${namespace}\0${input}`;
        if (!key) return hex(await digest(`sha256-fallback\0${payload}`));
        return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    };
}

function fnv64(input) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(String(input))) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & MASK64;
    }
    return hash;
}

function fnv32(input, seed = 0) {
    let hash = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
    for (const byte of new TextEncoder().encode(String(input))) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function popBig(value) {
    let current = value;
    let count = 0;
    while (current) { current &= current - 1n; count += 1; }
    return count;
}

function pop32(value) {
    let current = Number(value) >>> 0;
    let count = 0;
    while (current) { current &= current - 1; count += 1; }
    return count;
}

function normalizeDevice(clientData = {}) {
    const source = clientData?.device && typeof clientData.device === "object" ? clientData.device : {};
    const cpu = source.cpu && typeof source.cpu === "object" ? source.cpu : {};
    const screen = source.screen && typeof source.screen === "object" ? source.screen : {};
    const webgl = source.webgl && typeof source.webgl === "object" ? source.webgl : {};
    const client = source.client && typeof source.client === "object" ? source.client : {};
    const width = number(screen.width, 100, 20000);
    const height = number(screen.height, 100, 20000);
    return {
        canvas: clean(source.canvas, 128),
        audio: clean(source.audio, 128),
        fonts: unique(source.fonts, FINGERPRINT_FONT_CATALOG.length, 80).filter((font) => FONT_INDEX.has(font)),
        performanceClass: clean(source.performanceClass, 24),
        cpu: {
            cores: number(cpu.hardwareConcurrency, 1, 256), memory: number(cpu.deviceMemory, 0.25, 128),
            touch: number(cpu.maxTouchPoints, 0, 64), architecture: clean(cpu.architecture, 40), bitness: clean(cpu.bitness, 16),
        },
        screen: {
            long: width !== null && height !== null ? Math.max(width, height) : null,
            short: width !== null && height !== null ? Math.min(width, height) : null,
            dpr: number(screen.dpr, 0.25, 10), depth: number(screen.colorDepth, 1, 128),
        },
        webgl: {
            vendor: clean(webgl.vendor, 160), renderer: clean(webgl.renderer, 240), version: clean(webgl.version, 120),
            shading: clean(webgl.shadingLanguageVersion, 120), texture: number(webgl.maxTextureSize, 256, 131072),
            renderbuffer: number(webgl.maxRenderbufferSize, 256, 131072),
            viewportWidth: number(webgl.maxViewportWidth, 256, 262144), viewportHeight: number(webgl.maxViewportHeight, 256, 262144),
            vertexAttribs: number(webgl.maxVertexAttribs, 1, 128),
        },
        client: {
            os: clean(client.os, 80), platform: clean(client.platform, 80), model: clean(client.model, 120),
            platformVersion: clean(client.platformVersion, 80), engine: clean(client.browserEngine, 40), language: clean(client.language, 32),
            languages: unique(client.languages, 8, 32), timezone: clean(client.timezone, 80),
            telegramPlatform: clean(client.telegramPlatform, 40), telegramVersion: clean(client.telegramVersion, 40),
        },
    };
}

function normalizeNetwork(network = {}, metadata = {}) {
    const ips = unique([
        ...(network.webrtc_ipv4_candidates || []), ...(network.webrtc_ipv6_candidates || []), network.webrtc_ipv4, network.webrtc_ipv6,
    ], 4, 128);
    const provided = Array.isArray(metadata.webrtc) ? metadata.webrtc : [];
    return {
        http: { ip: clean(metadata.http?.ip || network.http_ipv4 || network.http_ipv6, 128), asn: clean(metadata.http?.asn, 40), isp: clean(metadata.http?.isp, 200) },
        webrtc: ips.map((ip) => {
            const item = provided.find((entry) => clean(entry?.ip, 128) === ip) || {};
            return { ip, asn: clean(item.asn, 40), isp: clean(item.isp, 200) };
        }),
    };
}

function tokenData(device) {
    const tokens = [];
    let mask = 0;
    const add = (bit, value, weight) => { if (value) { mask |= bit; tokens.push([value, weight]); } };
    add(1, device.client.os && `os:${device.client.os}`, 3);
    add(1, device.client.platform && `platform:${device.client.platform}`, 2);
    add(2, device.client.engine && `engine:${device.client.engine}`, 2);
    add(2, device.client.telegramPlatform && `tg:${device.client.telegramPlatform}`, 1);
    add(4, device.cpu.architecture && `arch:${device.cpu.architecture}`, 5);
    add(4, device.cpu.bitness && `bits:${device.cpu.bitness}`, 2);
    add(8, device.client.model && `model:${device.client.model}`, 3);
    add(8, device.performanceClass && `performance:${device.performanceClass}`, 3);
    add(16, device.client.timezone && `timezone:${device.client.timezone}`, 1);
    add(16, device.client.language && `language:${device.client.language}`, 1);
    for (const language of device.client.languages) add(16, `language:${language}`, 1);
    return { tokens, mask };
}

function simhash(tokens) {
    if (!tokens.length) return "0000000000000000";
    const scores = Array(64).fill(0);
    for (const [token, weight] of tokens) {
        const bits = fnv64(token);
        for (let index = 0; index < 64; index += 1) scores[index] += ((bits >> BigInt(index)) & 1n) ? weight : -weight;
    }
    let result = 0n;
    scores.forEach((score, index) => { if (score >= 0) result |= 1n << BigInt(index); });
    return result.toString(16).padStart(16, "0");
}

function buildFontData(fonts) {
    let bits = 0n;
    for (const font of fonts) bits |= 1n << BigInt(FONT_INDEX.get(font));
    const signature = [];
    for (let seed = 0; seed < 16; seed += 1) {
        let minimum = 0xffffffff;
        for (const font of fonts) minimum = Math.min(minimum, fnv32(font, seed * 0x9e3779b1));
        signature.push(fonts.length ? minimum >>> 0 : 0);
    }
    const bands = [0, 1, 2, 3].map((band) => fnv32(signature.slice(band * 4, band * 4 + 4).join("|"), band).toString(16).padStart(8, "0"));
    return { bits: bits.toString(16).padStart(16, "0"), signature, bands };
}

function buildVector(device) {
    const log = (value, floor = 1) => value === null ? null : Math.log2(Math.max(floor, value));
    const values = [log(device.cpu.cores), log(device.cpu.memory, 0.25), device.screen.long, device.screen.short,
        device.screen.long && device.screen.short ? device.screen.long / device.screen.short : null,
        device.screen.dpr, device.screen.depth, device.cpu.touch, log(device.webgl.texture), log(device.webgl.renderbuffer)];
    let mask = 0;
    values.forEach((value, index) => { if (Number.isFinite(value)) mask |= 1 << index; });
    return { values, mask };
}

function hammingScore(left, right, leftMask, rightMask) {
    if (!/^[0-9a-f]{16}$/i.test(left || "") || !/^[0-9a-f]{16}$/i.test(right || "") || pop32(leftMask & rightMask) < 4) return null;
    const distance = popBig(BigInt(`0x${left}`) ^ BigInt(`0x${right}`));
    if (distance <= 4) return 100;
    if (distance > 20) return 0;
    return Math.max(0, Math.min(99, Math.round(125 - distance * 6.25)));
}

function jaccard(left, right) {
    if (!/^[0-9a-f]{16}$/i.test(left || "") || !/^[0-9a-f]{16}$/i.test(right || "")) return null;
    const a = BigInt(`0x${left}`), b = BigInt(`0x${right}`), union = popBig(a | b);
    return union < 4 ? null : Math.round(popBig(a & b) / union * 100);
}

function gower(left, right, leftMask, rightMask) {
    if (!Array.isArray(left) || !Array.isArray(right)) return null;
    const ranges = [8, 9, 7360, 4080, 4, 9.75, 127, 64, 9, 9];
    const weights = [13, 12, 13, 12, 5, 8, 7, 5, 15, 10];
    const mask = leftMask & rightMask;
    let used = 0, total = 0, distance = 0;
    for (let index = 0; index < ranges.length; index += 1) {
        if (!(mask & (1 << index)) || !Number.isFinite(left[index]) || !Number.isFinite(right[index])) continue;
        used += 1; total += weights[index]; distance += weights[index] * Math.min(1, Math.abs(left[index] - right[index]) / ranges[index]);
    }
    return used < 6 || total < 60 ? null : Math.round(100 * (1 - distance / total));
}

function overlaps(left, right) {
    const set = new Set(Array.isArray(right) ? right.filter(Boolean) : []);
    return (Array.isArray(left) ? left : []).some((value) => value && set.has(value));
}

export async function buildFingerprintProfile({ clientData = {}, network = {}, metadata = {}, secret = "" } = {}) {
    const device = normalizeDevice(clientData);
    const net = normalizeNetwork(network, metadata);
    const tokens = tokenData(device);
    const font = buildFontData(device.fonts);
    const vector = buildVector(device);
    const keyedHash = await createKeyedHasher(secret);
    const exactHash = await keyedHash(`fingerprint-exact-v${FINGERPRINT_ALGORITHM_VERSION}`, stableFingerprintJson({ version: FINGERPRINT_ALGORITHM_VERSION, net, device }));
    const [httpKey, httpAsnKey, httpIspKey, canvasKey, webglKey, audioKey] = await Promise.all([
        net.http.ip ? keyedHash(secret, "fingerprint-http-ip-v1", net.http.ip) : "",
        net.http.asn ? keyedHash(secret, "fingerprint-http-asn-v1", net.http.asn) : "",
        net.http.isp ? keyedHash(secret, "fingerprint-http-isp-v1", net.http.isp) : "",
        device.canvas ? keyedHash(secret, "fingerprint-canvas-v1", device.canvas) : "",
        device.webgl.vendor || device.webgl.renderer ? keyedHash(secret, "fingerprint-webgl-v1", stableFingerprintJson(device.webgl)) : "",
        device.audio ? keyedHash(secret, "fingerprint-audio-v1", device.audio) : "",
    ]);
    const webrtcKeys = await Promise.all(net.webrtc.map((item) => keyedHash(secret, "fingerprint-webrtc-ip-v1", item.ip)));
    const webrtcAsnKeys = await Promise.all(net.webrtc.filter((item) => item.asn).map((item) => keyedHash(secret, "fingerprint-webrtc-asn-v1", item.asn)));
    const webrtcIspKeys = await Promise.all(net.webrtc.filter((item) => item.isp).map((item) => keyedHash(secret, "fingerprint-webrtc-isp-v1", item.isp)));
    const quality = [net.http.ip, net.webrtc.length, device.canvas, device.webgl.renderer || device.webgl.vendor, device.audio,
        device.fonts.length >= 4, pop32(tokens.mask) >= 4, pop32(vector.mask) >= 6].filter(Boolean).length;
    return {
        algorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
        exactHash,
        deviceSimhash: simhash(tokens.tokens),
        deviceFeatureMask: tokens.mask,
        fontBits: font.bits,
        fontMinhash: font.signature,
        fontBands: font.bands,
        deviceVector: vector.values,
        deviceVectorMask: vector.mask,
        canvasKey,
        webglKey,
        audioKey,
        webrtcKeys: unique(webrtcKeys, 4, 80),
        webrtcAsnKeys: unique(webrtcAsnKeys, 4, 80),
        webrtcIspKeys: unique(webrtcIspKeys, 4, 80),
        httpKey,
        httpAsnKey,
        httpIspKey,
        qualityScore: Math.round(quality / 8 * 100),
        summary: {
            os: device.client.os,
            model: device.client.model,
            performanceClass: device.performanceClass,
            telegramPlatform: device.client.telegramPlatform,
            telegramVersion: device.client.telegramVersion,
        },
    };
}

export function scoreFingerprintProfiles(current, reference) {
    if (!current || !reference) return { score: 0, weightedScore: 0, networkScore: 0, deviceScore: 0, exact: false, qualifies: false, evidence: [], evidenceMask: 0 };
    const exactQuality = Math.min(Number(current.qualityScore || 0), Number(reference.qualityScore || 0));
    if (current.algorithmVersion === reference.algorithmVersion && current.exactHash && current.exactHash === reference.exactHash && current.httpKey && reference.httpKey && exactQuality >= FINGERPRINT_MIN_EXACT_QUALITY) {
        return { score: 100, weightedScore: 100, networkScore: 100, deviceScore: 100, deviceCoverage: 100, exact: true, qualifies: true, webrtcIpExact: overlaps(current.webrtcKeys, reference.webrtcKeys), evidence: ["完整指纹完全一致"], evidenceMask: 1 };
    }
    let rtc = 0, http = 0, device = 0, available = 0, evidenceMask = 0;
    const evidence = [];
    const add = (condition, points, text, bit, layer) => {
        if (!condition) return;
        if (layer === "rtc") rtc += points; else if (layer === "http") http += points; else device += points;
        evidence.push(text); evidenceMask |= bit;
    };
    const webrtcIpExact = overlaps(current.webrtcKeys, reference.webrtcKeys);
    add(webrtcIpExact, 15, "WebRTC IP一致", 2, "rtc");
    add(overlaps(current.webrtcAsnKeys, reference.webrtcAsnKeys), 5, "WebRTC ASN一致", 4, "rtc");
    add(overlaps(current.webrtcIspKeys, reference.webrtcIspKeys), 15, "WebRTC ISP一致", 8, "rtc");
    add(current.httpKey && current.httpKey === reference.httpKey, 10, "HTTP IP一致", 16, "http");
    add(current.httpAsnKey && current.httpAsnKey === reference.httpAsnKey, 5, "HTTP ASN一致", 32, "http");
    add(current.httpIspKey && current.httpIspKey === reference.httpIspKey, 10, "HTTP ISP一致", 64, "http");

    const exactParts = [
        [4, current.canvasKey && reference.canvasKey, current.canvasKey === reference.canvasKey, "Canvas一致", 128],
        [5, current.webglKey && reference.webglKey, current.webglKey === reference.webglKey, "WebGL一致", 256],
        [3, current.audioKey && reference.audioKey, current.audioKey === reference.audioKey, "Audio一致", 512],
    ];
    for (const [weight, present, matched, text, bit] of exactParts) {
        if (!present) continue;
        available += weight;
        if (matched) add(true, weight, text, bit, "device");
    }
    const simhashScore = hammingScore(current.deviceSimhash, reference.deviceSimhash, current.deviceFeatureMask, reference.deviceFeatureMask);
    if (simhashScore !== null) { available += 12; device += simhashScore * 0.12; if (simhashScore >= 60) { evidence.push(`设备SimHash ${simhashScore}%`); evidenceMask |= 1024; } }
    const fontsScore = jaccard(current.fontBits, reference.fontBits);
    if (fontsScore !== null) { available += 6; device += fontsScore * 0.06; if (fontsScore >= 60) { evidence.push(`字体Jaccard ${fontsScore}%`); evidenceMask |= 2048; } }
    const vectorScore = gower(current.deviceVector, reference.deviceVector, current.deviceVectorMask, reference.deviceVectorMask);
    if (vectorScore !== null) { available += 10; device += vectorScore * 0.10; if (vectorScore >= 60) { evidence.push(`设备向量 ${vectorScore}%`); evidenceMask |= 4096; } }

    const weightedScore = Math.min(99, Math.round(rtc + http + device));
    const networkScore = Math.min(99, Math.round((rtc + http) / 60 * 100));
    const deviceCoverage = Math.round(available / 40 * 100);
    const deviceScore = available >= 24 ? Math.min(99, Math.round(device / available * 100)) : 0;
    const score = Math.min(99, Math.max(weightedScore, networkScore, deviceScore, webrtcIpExact ? 60 : 0));
    return {
        score, weightedScore, networkScore, deviceScore, deviceCoverage,
        webRtcPoints: Math.round(rtc), httpPoints: Math.round(http), devicePoints: Math.round(device),
        simhashScore, fontsScore, vectorScore, webrtcIpExact, exact: false,
        qualifies: webrtcIpExact || score >= FINGERPRINT_CANDIDATE_THRESHOLD,
        evidence: evidence.slice(0, 8), evidenceMask,
    };
}

export function fingerprintLookupEntries(profile) {
    if (!profile) return [];
    const entries = [];
    const add = (kind, band, key) => { if (key) entries.push({ kind, band, key: String(key) }); };
    add(0, 0, profile.exactHash);
    for (const key of (profile.webrtcKeys || []).slice(0, 4)) add(1, 0, key);
    add(2, 0, profile.httpKey);
    if (/^[0-9a-f]{16}$/i.test(profile.deviceSimhash || "") && pop32(profile.deviceFeatureMask) >= 4) {
        for (let band = 0; band < 4; band += 1) add(3, band, profile.deviceSimhash.slice(band * 4, band * 4 + 4));
    }
    if (profile.fontBits && profile.fontBits !== "0000000000000000") {
        for (const [band, key] of (profile.fontBands || []).slice(0, 4).entries()) add(4, band, key);
    }
    const seen = new Set();
    return entries.filter((entry) => {
        const key = `${entry.kind}|${entry.band}|${entry.key}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}

function parseJson(value, fallback) {
    try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function minhashBands(signature) {
    return Array.isArray(signature) && signature.length === 16
        ? [0, 1, 2, 3].map((band) => fnv32(signature.slice(band * 4, band * 4 + 4).join("|"), band).toString(16).padStart(8, "0"))
        : [];
}

export function profileFromDatabaseRow(row = {}) {
    const minhash = parseJson(row.font_minhash, []);
    return {
        algorithmVersion: Number(row.algorithm_version || FINGERPRINT_ALGORITHM_VERSION), exactHash: String(row.exact_hash || ""),
        deviceSimhash: String(row.device_simhash || ""), deviceFeatureMask: Number(row.device_feature_mask || 0),
        fontBits: String(row.font_bits || ""), fontMinhash: minhash, fontBands: minhashBands(minhash),
        deviceVector: parseJson(row.device_vector, []), deviceVectorMask: Number(row.device_vector_mask || 0),
        canvasKey: String(row.canvas_key || ""), webglKey: String(row.webgl_key || ""), audioKey: String(row.audio_key || ""),
        webrtcKeys: parseJson(row.webrtc_keys, []), webrtcAsnKeys: parseJson(row.webrtc_asn_keys, []), webrtcIspKeys: parseJson(row.webrtc_isp_keys, []),
        httpKey: String(row.http_key || ""), httpAsnKey: String(row.http_asn_key || ""), httpIspKey: String(row.http_isp_key || ""),
        qualityScore: Number(row.quality_score || 0), summary: parseJson(row.summary_json, {}),
    };
}

export function fingerprintProfileDatabaseValues(profile = {}) {
    return {
        algorithm_version: Number(profile.algorithmVersion || FINGERPRINT_ALGORITHM_VERSION), exact_hash: String(profile.exactHash || ""),
        device_simhash: String(profile.deviceSimhash || "0000000000000000"), device_feature_mask: Number(profile.deviceFeatureMask || 0),
        font_bits: String(profile.fontBits || "0000000000000000"), font_minhash: JSON.stringify(profile.fontMinhash || []),
        device_vector: JSON.stringify(profile.deviceVector || []), device_vector_mask: Number(profile.deviceVectorMask || 0),
        canvas_key: String(profile.canvasKey || ""), webgl_key: String(profile.webglKey || ""), audio_key: String(profile.audioKey || ""),
        webrtc_keys: JSON.stringify((profile.webrtcKeys || []).slice(0, 4)), webrtc_asn_keys: JSON.stringify((profile.webrtcAsnKeys || []).slice(0, 4)),
        webrtc_isp_keys: JSON.stringify((profile.webrtcIspKeys || []).slice(0, 4)), http_key: String(profile.httpKey || ""),
        http_asn_key: String(profile.httpAsnKey || ""), http_isp_key: String(profile.httpIspKey || ""),
        quality_score: Number(profile.qualityScore || 0), summary_json: JSON.stringify(profile.summary || {}),
    };
}
