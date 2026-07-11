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

console.log("verification client script render test passed");
