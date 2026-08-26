export const FINGERPRINT_ALGORITHM_VERSION = 2;
export const FINGERPRINT_CANDIDATE_THRESHOLD = 60;
export const FINGERPRINT_MIN_EXACT_QUALITY = 63;

// 四向量权重：A WebRTC 30% + B 公网 IP 20% + C 渲染指纹 25% + D 稳定不变量 25%。
// 拆分 C/D 的原因：换浏览器时 Canvas/WebGL/Audio 全变（C 归零），
// 但 OS/CPU/屏幕/字体/时区/语言这些稳定不变量仍然保留（D 维持高分），
// 因此 D 是「同设备换浏览器」的唯一识别依据。
export const FINGERPRINT_VECTOR_WEIGHTS = { rtc: 30, http: 20, render: 25, stable: 25 };

// 各判定档位。tier 决定消息措辞与提供的按钮，不只是一个数字。
export const FINGERPRINT_TIERS = {
    exact: { label: "完整指纹一致", floor: 100, confirm: true },
    rtcRender: { label: "WebRTC 与渲染指纹双重一致", floor: 98, confirm: true },
    rtcOnly: { label: "WebRTC IP 一致", floor: 92, confirm: true },
    rtcWeakDevice: { label: "WebRTC IP 一致但设备层偏低", floor: 92, confirm: true },
    httpFull: { label: "公网 IP、ASN、ISP 全部一致", floor: 90, confirm: true },
    render: { label: "渲染指纹三项一致", floor: 90, confirm: true },
    stableNet: { label: "稳定不变量一致且网络层支撑", floor: 82, confirm: true },
    stableOnly: { label: "稳定不变量一致但网络层无交集", floor: 62, cap: 74, confirm: false },
    weighted: { label: "加权相似度达阈值", confirm: false },
    networkOnly: { label: "仅网络相近，不构成同一人", cap: 55, confirm: false },
    none: { label: "相似度不足", confirm: false },
};

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

function jaccard(left, right) {
    if (!/^[0-9a-f]{16}$/i.test(left || "") || !/^[0-9a-f]{16}$/i.test(right || "")) return null;
    const a = BigInt(`0x${left}`), b = BigInt(`0x${right}`), union = popBig(a | b);
    return union < 4 ? null : Math.round(popBig(a & b) / union * 100);
}

function overlaps(left, right) {
    const set = new Set(Array.isArray(right) ? right.filter(Boolean) : []);
    return (Array.isArray(left) ? left : []).some((value) => value && set.has(value));
}

// ===== 向量距离度量 =====
// 全部返回 [0,1] 的相似度，或 null 表示双方数据不足、该维度不参与计分。
// 用连续距离而不是布尔相等，是为了让「换浏览器后屏幕/CPU 只轻微偏移」这类情况
// 拿到 0.86 而不是 0，否则跨浏览器识别会因为哈希类信号归零而整体失效。

// 精确相等：适用于哈希与派生 key，只能相等或不等。
function simExact(left, right) {
    if (!left || !right) return null;
    return String(left) === String(right) ? 1 : 0;
}

// 两个集合的重叠：适用于 webrtcKeys 这类多值数组。
function simOverlap(left, right) {
    const a = (Array.isArray(left) ? left : []).filter(Boolean);
    const b = (Array.isArray(right) ? right : []).filter(Boolean);
    if (!a.length || !b.length) return null;
    return overlaps(a, b) ? 1 : 0;
}

// 归一化欧氏距离：适用于 CPU、屏幕这类数值向量。indexes 指定参与的维度。
function simNumericVector(left, right, leftMask, rightMask, indexes, ranges) {
    if (!Array.isArray(left) || !Array.isArray(right)) return null;
    const mask = Number(leftMask || 0) & Number(rightMask || 0);
    let used = 0;
    let sum = 0;
    for (let position = 0; position < indexes.length; position += 1) {
        const index = indexes[position];
        if (!(mask & (1 << index))) continue;
        const a = left[index];
        const b = right[index];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const normalized = Math.min(1, Math.abs(a - b) / ranges[position]);
        sum += normalized * normalized;
        used += 1;
    }
    if (used < 2) return null;
    return Math.max(0, Math.min(1, 1 - Math.sqrt(sum / used)));
}

// 字体位图的 Jaccard 交并比，返回 [0,1]。
function simFontBits(left, right) {
    const value = jaccard(left, right);
    return value === null ? null : value / 100;
}

// 按可用维度归一的加权平均。缺失维度既不白送分也不硬扣分，
// 只从分母里剔除，并通过 coverage 反映采集完整度。
function vectorScore(parts) {
    const available = parts.filter((part) => part.value !== null && part.value !== undefined);
    const fullWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    if (!available.length || !fullWeight) return { score: null, coverage: 0, parts };
    const usedWeight = available.reduce((sum, part) => sum + part.weight, 0);
    return {
        score: Math.round(available.reduce((sum, part) => sum + part.weight * part.value, 0) / usedWeight * 100),
        coverage: Math.round(usedWeight / fullWeight * 100),
        parts,
    };
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
        net.http.ip ? keyedHash("fingerprint-http-ip-v1", net.http.ip) : "",
        net.http.asn ? keyedHash("fingerprint-http-asn-v1", net.http.asn) : "",
        net.http.isp ? keyedHash("fingerprint-http-isp-v1", net.http.isp) : "",
        device.canvas ? keyedHash("fingerprint-canvas-v1", device.canvas) : "",
        device.webgl.vendor || device.webgl.renderer ? keyedHash("fingerprint-webgl-v1", stableFingerprintJson(device.webgl)) : "",
        device.audio ? keyedHash("fingerprint-audio-v1", device.audio) : "",
    ]);
    const webrtcKeys = await Promise.all(net.webrtc.map((item) => keyedHash("fingerprint-webrtc-ip-v1", item.ip)));
    const webrtcAsnKeys = await Promise.all(net.webrtc.filter((item) => item.asn).map((item) => keyedHash("fingerprint-webrtc-asn-v1", item.asn)));
    const webrtcIspKeys = await Promise.all(net.webrtc.filter((item) => item.isp).map((item) => keyedHash("fingerprint-webrtc-isp-v1", item.isp)));
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
            // 时区与语言是跨浏览器仍然保留的稳定不变量，向量 D 需要它们独立参与比较。
            timezone: device.client.timezone,
            language: device.client.language,
            engine: device.client.engine,
        },
    };
}

// 四向量比较。相比旧版最大的区别：不再用 Math.max 取单侧最高分，
// 而是加权求和后按判定档位设下限与上限，避免「同一个 WiFi 出口的两个陌生人」
// 因为网络层满分而被直接判成同一人。
export function scoreFingerprintProfiles(current, reference, options = {}) {
    const empty = {
        score: 0, weightedScore: 0, networkScore: 0, deviceScore: 0, deviceCoverage: 0,
        exact: false, qualifies: false, evidence: [], evidenceMask: 0,
        tier: "none", tierLabel: FINGERPRINT_TIERS.none.label, vectors: null, webrtcIpExact: false,
    };
    if (!current || !reference) return empty;

    const summaryA = current.summary || {};
    const summaryB = reference.summary || {};

    // 向量 A：WebRTC 向量（IP 15 / ASN 5 / ISP 15）
    const vectorRtc = vectorScore([
        { name: "WebRTC IP", weight: 15, value: simOverlap(current.webrtcKeys, reference.webrtcKeys) },
        { name: "WebRTC ASN", weight: 5, value: simOverlap(current.webrtcAsnKeys, reference.webrtcAsnKeys) },
        { name: "WebRTC ISP", weight: 15, value: simOverlap(current.webrtcIspKeys, reference.webrtcIspKeys) },
    ]);
    // 向量 B：公网 IP 向量（IP 12 / ASN 6 / ISP 7）
    const vectorHttp = vectorScore([
        { name: "公网 IP", weight: 12, value: simExact(current.httpKey, reference.httpKey) },
        { name: "IP ASN", weight: 6, value: simExact(current.httpAsnKey, reference.httpAsnKey) },
        { name: "IP ISP", weight: 7, value: simExact(current.httpIspKey, reference.httpIspKey) },
    ]);
    // 向量 C：渲染指纹（换浏览器会整体失效）
    const vectorRender = vectorScore([
        { name: "Canvas", weight: 10, value: simExact(current.canvasKey, reference.canvasKey) },
        { name: "WebGL", weight: 8, value: simExact(current.webglKey, reference.webglKey) },
        { name: "Audio", weight: 7, value: simExact(current.audioKey, reference.audioKey) },
    ]);
    // 向量 D：稳定不变量（换浏览器仍然保留，是跨浏览器识别的唯一依据）
    // deviceVector 索引：0 核数 1 内存 2 屏长边 3 屏短边 4 宽高比 5 dpr 6 色深 7 触点 8/9 GPU 上限
    const vectorStable = vectorScore([
        { name: "系统", weight: 4, value: simExact(summaryA.os, summaryB.os) },
        { name: "CPU", weight: 5, value: simNumericVector(current.deviceVector, reference.deviceVector, current.deviceVectorMask, reference.deviceVectorMask, [0, 1, 7], [8, 9, 64]) },
        { name: "屏幕", weight: 5, value: simNumericVector(current.deviceVector, reference.deviceVector, current.deviceVectorMask, reference.deviceVectorMask, [2, 3, 4, 6], [7360, 4080, 4, 127]) },
        { name: "字体", weight: 6, value: simFontBits(current.fontBits, reference.fontBits) },
        { name: "时区", weight: 4, value: simExact(summaryA.timezone, summaryB.timezone) },
        { name: "语言", weight: 3, value: simExact(summaryA.language, summaryB.language) },
        { name: "性能等级", weight: 2, value: simExact(summaryA.performanceClass, summaryB.performanceClass) },
        { name: "机型", weight: 2, value: simExact(summaryA.model, summaryB.model) },
    ]);

    const vectors = { rtc: vectorRtc, http: vectorHttp, render: vectorRender, stable: vectorStable };
    const weighted = [
        [vectorRtc, FINGERPRINT_VECTOR_WEIGHTS.rtc],
        [vectorHttp, FINGERPRINT_VECTOR_WEIGHTS.http],
        [vectorRender, FINGERPRINT_VECTOR_WEIGHTS.render],
        [vectorStable, FINGERPRINT_VECTOR_WEIGHTS.stable],
    ].filter(([vector]) => vector.score !== null);
    const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
    const rawScore = totalWeight
        ? Math.round(weighted.reduce((sum, [vector, weight]) => sum + vector.score * weight, 0) / totalWeight)
        : 0;

    const exactQuality = Math.min(Number(current.qualityScore || 0), Number(reference.qualityScore || 0));
    const exactSame = current.algorithmVersion === reference.algorithmVersion
        && current.exactHash && current.exactHash === reference.exactHash
        && current.httpKey && reference.httpKey && exactQuality >= FINGERPRINT_MIN_EXACT_QUALITY;
    const webrtcIpExact = overlaps(current.webrtcKeys, reference.webrtcKeys);
    const renderAllSame = vectorRender.score === 100 && vectorRender.coverage === 100;
    const httpAllSame = vectorHttp.score === 100 && vectorHttp.coverage === 100;
    const stableHigh = vectorStable.score !== null && vectorStable.score >= 85 && vectorStable.coverage >= 70;
    const networkSupport = (vectorRtc.score !== null && vectorRtc.score >= 50)
        || (vectorHttp.score !== null && vectorHttp.score >= 50);
    const deviceWeak = (vectorRender.score === null || vectorRender.score < 35)
        && (vectorStable.score === null || vectorStable.score < 45);

    // 档位判定按证据强度从高到低，命中即停。
    let tier = "none";
    if (exactSame) tier = "exact";
    else if (webrtcIpExact && renderAllSame) tier = "rtcRender";
    else if (webrtcIpExact && deviceWeak) tier = "rtcWeakDevice";
    else if (webrtcIpExact) tier = "rtcOnly";
    else if (renderAllSame) tier = "render";
    else if (httpAllSame) tier = "httpFull";
    else if (stableHigh && networkSupport) tier = "stableNet";
    else if (stableHigh) tier = "stableOnly";
    else if (deviceWeak) tier = "networkOnly";
    else if (rawScore >= FINGERPRINT_CANDIDATE_THRESHOLD) tier = "weighted";

    const spec = FINGERPRINT_TIERS[tier] || FINGERPRINT_TIERS.none;
    let score = rawScore;
    if (spec.floor !== undefined) score = Math.max(score, spec.floor);
    if (spec.cap !== undefined) score = Math.min(score, spec.cap);
    score = Math.max(0, Math.min(tier === "exact" ? 100 : 99, score));

    // 逐项证据：只列出真正命中的维度，供管理员核对判定依据。
    const evidence = [];
    let evidenceMask = 0;
    if (exactSame) { evidence.push("完整指纹完全一致"); evidenceMask |= 1; }
    const pushEvidence = (part, bit) => {
        if (part.value === null || part.value === undefined) return;
        if (part.value >= 0.999) { evidence.push(`${part.name}一致`); evidenceMask |= bit; return; }
        if (part.value >= 0.6) evidence.push(`${part.name} ${Math.round(part.value * 100)}%`);
    };
    vectorRtc.parts.forEach((part, index) => pushEvidence(part, 2 << index));
    vectorHttp.parts.forEach((part, index) => pushEvidence(part, 16 << index));
    vectorRender.parts.forEach((part, index) => pushEvidence(part, 128 << index));
    vectorStable.parts.forEach((part, index) => pushEvidence(part, 1024 << index));

    // 兼容旧字段名，话题消息与后台页面仍在使用。
    const networkScore = vectorRtc.score !== null || vectorHttp.score !== null
        ? Math.round(((vectorRtc.score ?? 0) * FINGERPRINT_VECTOR_WEIGHTS.rtc + (vectorHttp.score ?? 0) * FINGERPRINT_VECTOR_WEIGHTS.http)
            / ((vectorRtc.score !== null ? FINGERPRINT_VECTOR_WEIGHTS.rtc : 0) + (vectorHttp.score !== null ? FINGERPRINT_VECTOR_WEIGHTS.http : 0)))
        : 0;
    const deviceScore = vectorRender.score !== null || vectorStable.score !== null
        ? Math.round(((vectorRender.score ?? 0) * FINGERPRINT_VECTOR_WEIGHTS.render + (vectorStable.score ?? 0) * FINGERPRINT_VECTOR_WEIGHTS.stable)
            / ((vectorRender.score !== null ? FINGERPRINT_VECTOR_WEIGHTS.render : 0) + (vectorStable.score !== null ? FINGERPRINT_VECTOR_WEIGHTS.stable : 0)))
        : 0;
    const deviceCoverage = Math.round(((vectorRender.coverage * FINGERPRINT_VECTOR_WEIGHTS.render)
        + (vectorStable.coverage * FINGERPRINT_VECTOR_WEIGHTS.stable))
        / (FINGERPRINT_VECTOR_WEIGHTS.render + FINGERPRINT_VECTOR_WEIGHTS.stable));

    // stableOnly 档（跨浏览器且换网络）默认不作为候选，由 allowWeakSuspect 开关控制。
    const weakSuspect = tier === "stableOnly";
    const qualifies = spec.confirm
        || (score >= FINGERPRINT_CANDIDATE_THRESHOLD && (!weakSuspect || options.allowWeakSuspect === true));

    return {
        score, weightedScore: rawScore, rawScore, networkScore, deviceScore, deviceCoverage,
        tier, tierLabel: spec.label, confirmTier: Boolean(spec.confirm), weakSuspect,
        vectors, exact: exactSame, webrtcIpExact, renderAllSame, httpAllSame, stableHigh, deviceWeak,
        qualifies, evidence: evidence.slice(0, 10), evidenceMask,
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
