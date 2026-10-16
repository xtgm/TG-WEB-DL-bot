import assert from "node:assert/strict";
import { handleRequest } from "../worker.js";

function statementFor(sql) {
    return {
        bind() {
            return this;
        },
        async all() {
            return { results: [] };
        },
        async first() {
            if (sql.includes("FROM verification_sessions WHERE token=?")) {
                return {
                    token: "test-token",
                    user_id: 42,
                    status: "pending",
                    expires_at: "2999-01-01T00:00:00.000Z",
                };
            }
            return null;
        },
        async run() {
            return { meta: { changes: 0 } };
        },
    };
}

const env = {
    TURNSTILE_SITE_KEY: "test-site-key",
    DB: {
        prepare(sql) {
            return statementFor(String(sql));
        },
    },
};

const response = await handleRequest(new Request("https://example.test/verify/test-token"), env, {});
assert.equal(response.status, 200);
const html = await response.text();
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
const clientScript = scripts.find((script) => script.includes("const VERIFY_TOKEN"));
assert.ok(clientScript, "verification client script not found");
assert.doesNotThrow(() => new Function(clientScript));
assert.match(clientScript, /stun:stun\.cloudflare\.com:3478/);
assert.match(clientScript, /stun:stun\.l\.google\.com:19302/);
assert.match(clientScript, /item\.type === "srflx"/);
assert.match(clientScript, /const ipv4Candidates = udp[\s\S]*?\.slice\(0, 2\)/);
assert.match(clientScript, /const ipv6Candidates = udp[\s\S]*?\.slice\(0, 2\)/);
assert.match(clientScript, /candidates: selected/);
assert.doesNotMatch(clientScript, /candidates\.size < 20/);
assert.doesNotMatch(clientScript, /udp\.slice\(0, 20\)/);
assert.match(clientScript, /const FINGERPRINT_FONTS = \[/);
assert.match(clientScript, /withClientTimeout\(collectFingerprintSignals\(\), 3500/);
assert.match(clientScript, /await collectClientData\(\)/);
assert.match(clientScript, /collectCanvasDigest[\s\S]*?canvas\.toDataURL\(\)/);
assert.match(clientScript, /OfflineAudioContext \|\| window\.webkitOfflineAudioContext/);
assert.match(clientScript, /collectFontSet[\s\S]*?probe\.offsetWidth/);
assert.match(clientScript, /WEBGL_debug_renderer_info/);
assert.match(clientScript, /getHighEntropyValues\(\["architecture", "bitness", "model", "platformVersion"\]\)/);
assert.match(clientScript, /telegramPlatform: telegramWebApp && telegramWebApp\.platform/);
assert.match(clientScript, /telegramVersion: telegramWebApp && telegramWebApp\.version/);
assert.match(clientScript, /performanceClass: classifyPerformance\(cpu, webgl\)/);
assert.match(clientScript, /fonts: Array\.isArray\(device\.fonts\) \? device\.fonts\.slice\(0, FINGERPRINT_FONTS\.length\)/);
assert.match(clientScript, /canvas: compactClientText\(device\.canvas, 128\)/);
assert.match(clientScript, /audio: compactClientText\(device\.audio, 128\)/);

// 浏览器引擎识别必须真的能跑起来。这段客户端脚本外层是 JS 模板字符串，
// 正则里的斜杠少写一个反斜杠，渲染出来就变成 /Firefox//i.test(ua)：
// 语法仍然合法（正则除以标识符 i），但一执行就抛 ReferenceError，
// 而设备指纹采集是在同一函数里返回值，于是整块设备层采集（Canvas/WebGL/音频/
// 字体/CPU/屏幕/时区）会一起丢掉，页面却看不出任何异常。
const engineSource = clientScript.match(/function detectBrowserEngine\(\)\s*\{[\s\S]*?\n\}/);
assert.ok(engineSource, "verification client engine detector not found");
assert.ok(clientScript.includes("/Firefox\\//i.test(ua)"), "浏览器引擎正则的转义必须保留，不能被模板字符串吃掉");
const detectEngine = (ua) => new Function("navigator", engineSource[0] + "\nreturn detectBrowserEngine();")({ userAgent: ua });
assert.equal(detectEngine("Mozilla/5.0 (Windows NT 10.0; rv:121.0) Gecko/20100101 Firefox/121.0"), "Gecko");
assert.equal(detectEngine("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"), "Blink");
assert.equal(detectEngine("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"), "Blink");
assert.equal(detectEngine("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), "WebKit");
assert.equal(detectEngine("curl/8.4.0"), "Unknown");

// 端到端：设备指纹采集函数必须能跑完并返回设备信息，不能中途抛错。
// 截取渲染脚本里的函数定义区（跳过顶层的 DOM 绑定代码），用最小的 DOM 替身调用它。
const functionsSource = clientScript.slice(clientScript.indexOf("function compactClientText"));
const collectFingerprintSignals = new Function(
    "navigator", "window", "document", "Intl", "FINGERPRINT_FONTS", "VERIFY_TOKEN", "telegramWebApp",
    functionsSource + "\nreturn collectFingerprintSignals;",
)(
    {
        userAgent: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        platform: "Win32", language: "zh-CN", languages: ["zh-CN"],
        hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
    },
    {},
    { body: null, createElement() { return { getContext() { return null; }, style: {}, appendChild() {}, remove() {} }; } },
    Intl,
    JSON.parse(clientScript.match(/const FINGERPRINT_FONTS = (\[[\s\S]*?\]);/)[1]),
    "test-token",
    null,
);
const collectedFingerprint = await collectFingerprintSignals();
assert.equal(collectedFingerprint.client.os, "Windows");
assert.equal(collectedFingerprint.client.browserEngine, "Blink");
assert.equal(collectedFingerprint.performanceClass, "very-high");
assert.equal(collectedFingerprint.client.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);

console.log("verification client script render test passed");
