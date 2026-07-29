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
const sameDevice = scoreFingerprintProfiles(base, changedNetwork);
assert.equal(sameDevice.exact, false);
assert.equal(sameDevice.score, 99);
assert.equal(sameDevice.deviceScore, 99);

const changedDevice = structuredClone(device);
Object.assign(changedDevice, { canvas: "canvas-b", audio: "audio-b", fonts: ["SimHei", "SimSun", "KaiTi", "FangSong"], performanceClass: "low" });
Object.assign(changedDevice.cpu, { hardwareConcurrency: 2, deviceMemory: 1, maxTouchPoints: 0, architecture: "arm", bitness: "32" });
Object.assign(changedDevice.screen, { width: 800, height: 600, dpr: 1, colorDepth: 16 });
Object.assign(changedDevice.webgl, { vendor: "vendor-b", renderer: "gpu-b", maxTextureSize: 2048, maxRenderbufferSize: 2048 });
Object.assign(changedDevice.client, { os: "Android", platform: "Linux armv8", model: "phone-b", browserEngine: "WebKit", timezone: "UTC" });
const sameNetworkProfile = await buildFingerprintProfile({ ...baseInput, clientData: { device: changedDevice } });
const sameNetwork = scoreFingerprintProfiles(base, sameNetworkProfile);
assert.equal(sameNetwork.exact, false);
assert.equal(sameNetwork.score, 99);
assert.equal(sameNetwork.networkScore, 99);
assert.ok(sameNetwork.weightedScore <= 99 && sameNetwork.deviceScore <= 99);

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

console.log("fingerprint V2 algorithm tests passed");
