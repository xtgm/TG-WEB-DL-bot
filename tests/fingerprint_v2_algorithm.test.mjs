import assert from "node:assert/strict";
import {
    FINGERPRINT_MIN_EXACT_QUALITY,
    buildFingerprintProfile,
    fingerprintLookupEntries,
    fingerprintProfileDatabaseValues,
    profileFromDatabaseRow,
    scoreFingerprintProfiles,
} from "../fingerprint-v2.js";

const device = {
    canvas: "canvas-a",
    audio: "audio-a",
    fonts: ["Arial", "Calibri", "Consolas", "Segoe UI", "Tahoma", "Verdana"],
    performanceClass: "high",
    cpu: { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5, architecture: "x86", bitness: "64" },
    screen: { width: 1920, height: 1080, dpr: 2, colorDepth: 24 },
    webgl: {
        vendor: "vendor-a", renderer: "gpu-a", version: "webgl 2", shadingLanguageVersion: "glsl 3",
        maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewportWidth: 32768,
        maxViewportHeight: 32768, maxVertexAttribs: 16,
    },
    client: {
        os: "Windows", platform: "Win32", model: "desktop-a", platformVersion: "10",
        browserEngine: "Chromium", language: "zh-CN", languages: ["zh-CN", "en-US"],
        timezone: "Asia/Shanghai", telegramPlatform: "tdesktop", telegramVersion: "10.0",
    },
};

const webrtcIps = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"];
const baseInput = {
    clientData: { device },
    network: {
        webrtc_ipv4: webrtcIps[0], webrtc_ipv6: webrtcIps[2],
        webrtc_ipv4_candidates: webrtcIps.slice(0, 2), webrtc_ipv6_candidates: webrtcIps.slice(2),
    },
    metadata: {
        http: { ip: "9.9.9.9", asn: "19281", isp: "Quad9" },
        webrtc: webrtcIps.map((ip, index) => ({ ip, asn: String(1000 + index), isp: "ISP-" + index })),
    },
    secret: "test-fingerprint-secret",
};

const base = await buildFingerprintProfile(baseInput);
const repeated = await buildFingerprintProfile(baseInput);
assert.equal(base.exactHash, repeated.exactHash);
assert.equal(base.qualityScore, 100);
assert.equal(scoreFingerprintProfiles(base, repeated).score, 100);
assert.equal(scoreFingerprintProfiles(base, repeated).exact, true);
assert.ok(fingerprintLookupEntries(base).length <= 14);
assert.deepEqual(fingerprintLookupEntries(base), fingerprintLookupEntries(repeated));
const fullLookupProfile = {
    exactHash: "exact", webrtcKeys: ["w1", "w2", "w3", "w4"], httpKey: "http",
    deviceSimhash: "0123456789abcdef", deviceFeatureMask: 15,
    fontBits: "000000000000000f", fontBands: ["f1", "f2", "f3", "f4"],
};
assert.equal(fingerprintLookupEntries(fullLookupProfile).length, 14);

const otherSecret = await buildFingerprintProfile({ ...baseInput, secret: "different-secret" });
assert.notEqual(base.exactHash, otherSecret.exactHash);
const fallbackA = await buildFingerprintProfile({ ...baseInput, secret: "" });
const fallbackB = await buildFingerprintProfile({ ...baseInput, secret: "" });
assert.equal(fallbackA.exactHash, fallbackB.exactHash);

const changedNetwork = await buildFingerprintProfile({
    ...baseInput,
    network: { webrtc_ipv4: "4.4.4.4", webrtc_ipv4_candidates: ["4.4.4.4"] },
    metadata: {
        http: { ip: "208.67.222.222", asn: "36692", isp: "OpenDNS" },
        webrtc: [{ ip: "4.4.4.4", asn: "3356", isp: "Level3" }],
    },
});
// 同一台设备换了网络：渲染指纹三项全同 → render 档，分数 ≥90 且列为候选。
const sameDevice = scoreFingerprintProfiles(base, changedNetwork);
assert.equal(sameDevice.exact, false);
assert.equal(sameDevice.tier, "render");
assert.ok(sameDevice.score >= 90, `换网络后应 ≥90，实际 ${sameDevice.score}`);
assert.equal(sameDevice.qualifies, true);
assert.equal(sameDevice.vectors.render.score, 100);

const changedDevice = structuredClone(device);
Object.assign(changedDevice, { canvas: "canvas-b", audio: "audio-b", fonts: ["SimHei", "SimSun", "KaiTi", "FangSong"], performanceClass: "low" });
Object.assign(changedDevice.cpu, { hardwareConcurrency: 2, deviceMemory: 1, maxTouchPoints: 0, architecture: "arm", bitness: "32" });
Object.assign(changedDevice.screen, { width: 800, height: 600, dpr: 1, colorDepth: 16 });
Object.assign(changedDevice.webgl, { vendor: "vendor-b", renderer: "gpu-b", maxTextureSize: 2048, maxRenderbufferSize: 2048 });
Object.assign(changedDevice.client, { os: "Android", platform: "Linux armv8", model: "phone-b", browserEngine: "WebKit", timezone: "UTC" });
// 同一网络下的另一台设备：WebRTC IP 一致但设备层全异 → rtcWeakDevice 档。
// 按「WebRTC 相同即同一人」的规则仍然确认，但必须带上设备层偏低的事实。
const sameNetworkProfile = await buildFingerprintProfile({ ...baseInput, clientData: { device: changedDevice } });
const sameNetwork = scoreFingerprintProfiles(base, sameNetworkProfile);
assert.equal(sameNetwork.exact, false);
assert.equal(sameNetwork.webrtcIpExact, true);
assert.ok(["rtcOnly", "rtcWeakDevice"].includes(sameNetwork.tier), `档位应为 rtcOnly/rtcWeakDevice，实际 ${sameNetwork.tier}`);
assert.ok(sameNetwork.score >= 90 && sameNetwork.score <= 99);
assert.equal(sameNetwork.qualifies, true);
assert.ok(sameNetwork.vectors.render.score < 35, "设备层渲染指纹应显著偏低");

const sharedWebRtcOnly = await buildFingerprintProfile({
    clientData: { device: changedDevice },
    network: { webrtc_ipv4: webrtcIps[0], webrtc_ipv4_candidates: [webrtcIps[0]] },
    metadata: {
        http: { ip: "208.67.220.220", asn: "99999", isp: "Other HTTP" },
        webrtc: [{ ip: webrtcIps[0], asn: "88888", isp: "Other WebRTC" }],
    },
    secret: baseInput.secret,
});
const rtcFloor = scoreFingerprintProfiles(base, sharedWebRtcOnly);
assert.equal(rtcFloor.webrtcIpExact, true);
assert.equal(rtcFloor.qualifies, true);
assert.ok(rtcFloor.score >= 60 && rtcFloor.score <= 99);

const weak = {
    algorithmVersion: 2, exactHash: "a".repeat(64), qualityScore: 13, httpKey: "h",
    webrtcKeys: [], webrtcAsnKeys: [], webrtcIspKeys: [], httpAsnKey: "", httpIspKey: "",
    canvasKey: "", webglKey: "", audioKey: "", deviceSimhash: "0000000000000000",
    deviceFeatureMask: 0, fontBits: "0000000000000000", deviceVector: [], deviceVectorMask: 0,
};
const weakExact = scoreFingerprintProfiles(weak, { ...weak });
assert.equal(FINGERPRINT_MIN_EXACT_QUALITY, 63);
assert.equal(weakExact.exact, false);
assert.notEqual(weakExact.score, 100);

const values = fingerprintProfileDatabaseValues(base);
const restored = profileFromDatabaseRow(values);
assert.equal(restored.exactHash, base.exactHash);
assert.deepEqual(restored.webrtcKeys, base.webrtcKeys);
assert.deepEqual(restored.fontMinhash, base.fontMinhash);
assert.deepEqual(restored.deviceVector, base.deviceVector);

for (const [memory, expected] of [[0.25, -2], [0.5, -1], [1, 0]]) {
    const sample = structuredClone(baseInput);
    sample.clientData.device.cpu.deviceMemory = memory;
    const profile = await buildFingerprintProfile(sample);
    assert.equal(profile.deviceVector[1], expected);
}

// ===== 防回归：不同输入必须产出不同的派生 key =====
// 曾经出现过 keyedHash 多传 secret 参数导致数据被丢弃、所有用户派生值恒定的缺陷。
// 这组断言让同类参数错位无法再悄悄通过。
{
    const mkNet = (ip, asn, isp) => ({
        ...baseInput,
        network: { webrtc_ipv4: ip, webrtc_ipv4_candidates: [ip] },
        metadata: { http: { ip, asn, isp }, webrtc: [{ ip, asn, isp }] },
    });
    const left = await buildFingerprintProfile(mkNet("1.1.1.1", "13335", "Cloudflare"));
    const right = await buildFingerprintProfile(mkNet("8.8.8.8", "15169", "Google"));
    assert.notEqual(left.httpKey, right.httpKey, "不同 HTTP IP 必须产出不同 httpKey");
    assert.notEqual(left.httpAsnKey, right.httpAsnKey, "不同 ASN 必须产出不同 httpAsnKey");
    assert.notEqual(left.httpIspKey, right.httpIspKey, "不同 ISP 必须产出不同 httpIspKey");
    assert.notDeepEqual(left.webrtcKeys, right.webrtcKeys, "不同 WebRTC IP 必须产出不同 webrtcKeys");

    const deviceA = structuredClone(device);
    const deviceB = structuredClone(device);
    Object.assign(deviceB, { canvas: "canvas-diff", audio: "audio-diff" });
    Object.assign(deviceB.webgl, { vendor: "vendor-diff", renderer: "gpu-diff" });
    const profileA = await buildFingerprintProfile({ ...baseInput, clientData: { device: deviceA } });
    const profileB = await buildFingerprintProfile({ ...baseInput, clientData: { device: deviceB } });
    assert.notEqual(profileA.canvasKey, profileB.canvasKey, "不同 Canvas 必须产出不同 canvasKey");
    assert.notEqual(profileA.webglKey, profileB.webglKey, "不同 WebGL 必须产出不同 webglKey");
    assert.notEqual(profileA.audioKey, profileB.audioKey, "不同 Audio 必须产出不同 audioKey");
}

// ===== 跨浏览器 / 跨设备 / 跨平台场景 =====
{
    const IOS = ["Arial", "Helvetica", "PingFang SC", "Times New Roman", "Georgia"];
    const WIN = ["Arial", "Verdana", "Segoe UI", "Microsoft YaHei", "Tahoma", "Georgia", "Consolas"];
    const AND = ["Arial", "Roboto", "Noto Sans", "Droid Sans"];
    const mk = (o) => ({
        clientData: { device: {
            canvas: o.canvas, audio: o.audio, fonts: o.fonts, performanceClass: o.perf,
            cpu: { hardwareConcurrency: o.cores, deviceMemory: o.mem, maxTouchPoints: o.touch, architecture: o.arch, bitness: "64" },
            screen: { width: o.w, height: o.h, dpr: o.dpr, colorDepth: 24 },
            webgl: { vendor: o.glV, renderer: o.glR, maxTextureSize: o.tex, maxRenderbufferSize: o.tex },
            client: { os: o.os, platform: o.os, model: o.model, browserEngine: o.engine, language: o.lang, languages: [o.lang], timezone: o.tz },
        } },
        network: o.rtcIp ? { webrtc_ipv4: o.rtcIp, webrtc_ipv4_candidates: [o.rtcIp] } : {},
        metadata: { http: { ip: o.ip, asn: o.asn, isp: o.isp }, webrtc: o.rtcIp ? [{ ip: o.rtcIp, asn: o.rtcAsn, isp: o.rtcIsp }] : [] },
        secret: "cross-secret",
    });
    const HOME = { ip: "223.104.122.189", asn: "9808", isp: "China Mobile", rtcIp: "223.104.122.183", rtcAsn: "9808", rtcIsp: "China Mobile" };
    const AWAY = { ip: "192.144.20.11", asn: "4134", isp: "Chinanet", rtcIp: "192.144.20.11", rtcAsn: "4134", rtcIsp: "Chinanet" };
    const FAR = { ip: "71.245.178.37", asn: "701", isp: "Verizon", rtcIp: "71.245.178.37", rtcAsn: "701", rtcIsp: "Verizon" };
    const IPHONE = { canvas: "cv_safari", audio: "au_safari", glV: "Apple Inc.", glR: "Apple GPU", os: "iOS",
        cores: 6, mem: 4, touch: 5, w: 390, h: 844, dpr: 3, tex: 4096, fonts: IOS, perf: "high", arch: "arm", model: "iPhone", engine: "WebKit", lang: "zh-CN", tz: "Asia/Shanghai" };
    const CHROME = { canvas: "cv_chrome", audio: "au_chrome", glV: "Google Inc. (Apple)", glR: "ANGLE (Apple GPU)", engine: "Blink" };
    const PC = { canvas: "cv_win", audio: "au_win", glV: "Google Inc. (NVIDIA)", glR: "ANGLE (RTX 3060)", os: "Windows",
        cores: 16, mem: 32, touch: 0, w: 2560, h: 1440, dpr: 1, tex: 16384, fonts: WIN, perf: "very-high", arch: "x86", model: "", engine: "Blink" };
    const ANDROID = { canvas: "cv_and", audio: "au_and", glV: "Qualcomm", glR: "Adreno 730", os: "Android",
        cores: 8, mem: 8, touch: 10, w: 1080, h: 2400, dpr: 2.75, tex: 8192, fonts: AND, perf: "high", arch: "arm", model: "Pixel", engine: "Blink" };

    const anchor = await buildFingerprintProfile(mk({ ...HOME, ...IPHONE }));
    const at = async (o) => scoreFingerprintProfiles(anchor, await buildFingerprintProfile(mk(o)));

    // 跨浏览器（同网络）：渲染指纹归零，靠 WebRTC + 稳定不变量识别。
    const crossBrowser = await at({ ...HOME, ...IPHONE, ...CHROME });
    assert.equal(crossBrowser.vectors.render.score, 0, "换浏览器后渲染指纹应归零");
    assert.ok(crossBrowser.vectors.stable.score >= 85, "稳定不变量应保持高位");
    assert.equal(crossBrowser.qualifies, true);
    assert.ok(crossBrowser.score >= 90);

    // 跨设备 / 跨平台（同网络）：设备层无交集，靠 WebRTC IP 判定。
    for (const [name, device] of [["跨设备", PC], ["跨平台", ANDROID]]) {
        const cross = await at({ ...HOME, ...IPHONE, ...device });
        assert.equal(cross.webrtcIpExact, true, `${name} 应命中 WebRTC IP`);
        assert.equal(cross.qualifies, true, `${name} 应列为候选`);
        assert.ok(cross.score >= 90, `${name} 分数应 ≥90`);
    }

    // 跨浏览器 + 换网络：只剩稳定不变量，默认不列为候选（规则 6 关闭）。
    const weakDefault = await at({ ...AWAY, ...IPHONE, ...CHROME });
    assert.equal(weakDefault.tier, "stableOnly");
    assert.equal(weakDefault.qualifies, false, "规则 6 默认关闭时不应列为候选");
    assert.ok(weakDefault.score >= 60 && weakDefault.score <= 74);

    // 同一条比较在开启规则 6 后才成为候选。
    const weakEnabled = scoreFingerprintProfiles(anchor, await buildFingerprintProfile(mk({ ...AWAY, ...IPHONE, ...CHROME })), { allowWeakSuspect: true });
    assert.equal(weakEnabled.tier, "stableOnly");
    assert.equal(weakEnabled.qualifies, true, "开启规则 6 后应列为候选");

    // WebRTC 采集失败但公网 IP 三项全同：走 httpFull 或 render 档，仍能识别。
    const noRtc = await at({ ...HOME, ...IPHONE, rtcIp: "" });
    assert.equal(noRtc.vectors.rtc.score, null, "无 WebRTC 数据时该向量不参与计分");
    assert.equal(noRtc.qualifies, true);

    // 完全无关的人：必须排除。
    const stranger = await at({ ...FAR, ...PC, tz: "America/New_York", lang: "en-US", cores: 4, mem: 8, w: 1366, h: 768, perf: "medium" });
    assert.equal(stranger.qualifies, false, "无关用户必须被排除");
    assert.ok(stranger.score < 60, `无关用户分数应 <60，实际 ${stranger.score}`);

    // 同型号异网络：与「跨浏览器+换网络」信号分布相同，同样落在 stableOnly，默认不列出。
    const sameModel = await at({ ...FAR, ...IPHONE, canvas: "cv_other", audio: "au_other" });
    assert.equal(sameModel.qualifies, false, "同型号异网络默认不应列为候选");
}

console.log("fingerprint V2 algorithm tests passed");
