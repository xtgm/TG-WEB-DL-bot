import assert from "node:assert/strict";
import { buildFingerprintConfirmationToken, extractClientNetwork, isPublicWebRtcIp, scoreFingerprintSimilarity } from "../worker.js";

const base = {
    profileHash: "1".repeat(32),
    webrtcIpv4Hash: "2".repeat(32),
    webrtcIpv4Hash2: "d".repeat(32),
    webrtcIpv6Hash: "f".repeat(32),
    webrtcIpv6Hash2: "e".repeat(32),
    rendererHash: "3".repeat(32),
    limitsHash: "4".repeat(32),
    canvasHash: "5".repeat(32),
    osHash: "6".repeat(32),
    screenHash: "7".repeat(32),
    dprDepthHash: "8".repeat(32),
    hardwareHash: "9".repeat(32),
    touchHash: "a".repeat(32),
    timezoneHash: "b".repeat(32),
    languageHash: "c".repeat(32),
};

const exact = scoreFingerprintSimilarity(base, { ...base });
assert.equal(exact.score, 100);
assert.equal(exact.exactProfile, true);
assert.equal(exact.webrtcExact, true);
assert.equal(exact.highConfidence, true);

const crossBrowser = scoreFingerprintSimilarity(base, {
    ...base,
    profileHash: "d".repeat(32),
    canvasHash: "e".repeat(32),
});
assert.equal(crossBrowser.score, 82);
assert.equal(crossBrowser.exactProfile, false);
assert.equal(crossBrowser.highConfidence, true);

const sparse = scoreFingerprintSimilarity(
    { profileHash: "1".repeat(32), rendererHash: "3".repeat(32) },
    { profileHash: "2".repeat(32), rendererHash: "3".repeat(32) },
);
assert.equal(sparse.score, 24);
assert.equal(sparse.highConfidence, false);

const sparseExact = scoreFingerprintSimilarity(
    { profileHash: "1".repeat(32), rendererHash: "3".repeat(32) },
    { profileHash: "1".repeat(32), rendererHash: "3".repeat(32) },
);
assert.equal(sparseExact.score, 100);
assert.equal(sparseExact.exactProfile, true);
assert.equal(sparseExact.highConfidence, false);

const sameWebRtcDifferentDevice = scoreFingerprintSimilarity(
    { profileHash: "1".repeat(32), webrtcIpv6Hash2: "f".repeat(32), rendererHash: "3".repeat(32) },
    { profileHash: "2".repeat(32), webrtcIpv6Hash: "f".repeat(32), rendererHash: "4".repeat(32) },
);
assert.equal(sameWebRtcDifferentDevice.score, 0);
assert.equal(sameWebRtcDifferentDevice.webrtcExact, true);
assert.equal(sameWebRtcDifferentDevice.highConfidence, false);

assert.equal(isPublicWebRtcIp("8.8.8.8"), true);
assert.equal(isPublicWebRtcIp("192.168.1.2"), false);
assert.equal(isPublicWebRtcIp("100.64.1.2"), false);
assert.equal(isPublicWebRtcIp("203.0.113.9"), false);
assert.equal(isPublicWebRtcIp("192.88.99.1"), false);
assert.equal(isPublicWebRtcIp("2001:4860:4860::8888"), true);
assert.equal(isPublicWebRtcIp("fd00::1"), false);
assert.equal(isPublicWebRtcIp("2001:db8::1"), false);
assert.equal(isPublicWebRtcIp("3fff::1"), false);

const dualStackNetwork = extractClientNetwork({
    webrtc: {
        udp_status: "failed",
        candidates: [
            ...Array.from({ length: 25 }, (_, index) => ({
                ip: `10.0.0.${index + 1}`,
                protocol: "udp",
                type: "srflx",
            })),
            { ip: "8.8.8.8", protocol: "udp", type: "srflx" },
            { ip: "1.1.1.1", protocol: "udp", type: "srflx" },
            { ip: "9.9.9.9", protocol: "udp", type: "srflx" },
            { ip: "2001:4860:4860::8888", protocol: "udp", type: "srflx" },
            { ip: "2606:4700:4700::1111", protocol: "udp", type: "srflx" },
            { ip: "2620:fe::fe", protocol: "udp", type: "srflx" },
            { ip: "4.4.4.4", protocol: "tcp", type: "srflx" },
            { ip: "5.5.5.5", protocol: "udp", type: "relay" },
        ],
    },
}, "104.16.1.2");
assert.deepEqual(dualStackNetwork.webrtc_ipv4_candidates, ["1.1.1.1", "8.8.8.8"]);
assert.deepEqual(dualStackNetwork.webrtc_ipv6_candidates, [
    "2001:4860:4860:0000:0000:0000:0000:8888",
    "2606:4700:4700:0000:0000:0000:0000:1111",
]);
assert.equal(dualStackNetwork.webrtc_candidates.length, 4);
assert.equal(dualStackNetwork.webrtc_candidates.every((candidate) => candidate.protocol === "udp" && candidate.type === "srflx"), true);
assert.equal(dualStackNetwork.udp_status, "success");

const confirmationValues = {
    userId: 1234567890123456,
    targetSlot: 1,
    targetProfile: base,
    candidateUserId: 2234567890123456,
    candidateSlot: 2,
    candidateProfile: { ...base, profileHash: "d".repeat(32) },
    labelId: 99,
};
const confirmationToken = await buildFingerprintConfirmationToken({ PANEL_SECRET: "test-secret" }, confirmationValues);
assert.match(confirmationToken, /^[0-9a-f]{12}$/);
assert.notEqual(
    confirmationToken,
    await buildFingerprintConfirmationToken(
        { PANEL_SECRET: "test-secret" },
        { ...confirmationValues, candidateProfile: { ...confirmationValues.candidateProfile, webrtcIpv6Hash: "e".repeat(32) } },
    ),
);
assert.notEqual(
    confirmationToken,
    await buildFingerprintConfirmationToken(
        { PANEL_SECRET: "test-secret" },
        { ...confirmationValues, targetConfirmedLabelId: 12, targetConfirmedAt: "2026-01-01T00:00:00Z" },
    ),
);
assert.equal(await buildFingerprintConfirmationToken({}, confirmationValues), "");
assert.ok(`fpconfirm:${confirmationValues.userId}:1:${confirmationValues.candidateUserId}:2:${confirmationToken}`.length <= 64);

console.log("fingerprint similarity tests passed");
