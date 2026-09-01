import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-auth-"));
process.env.HCODE_HOME = home;
const { loginHoop, loadHoopSession, logoutHoop, applyHoopSession, describeHoopSession } = await import("../src/auth.js");

const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("browser device login stores only a revocable session and applies the two channels", async () => {
  const calls = []; let poll = 0, opened = "", shown = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/start")) return answer(200, { deviceCode: "d".repeat(32), userCode: "ABCD-1234", verificationUri: "http://localhost:9999/hcode/approve?code=ABCD-1234", expiresIn: 600, interval: 1 });
    if (url.endsWith("/token") && poll++ === 0) return answer(428, { error: "authorization_pending" });
    if (url.endsWith("/token")) return answer(200, { accessToken: "s".repeat(32), expiresAt: Date.now() + 3600_000,
      brainUrl: "https://api.hoopgram.ai", dataUrl: "https://lumi.hoopgram.ai/api/hcode/data", model: "deepseek-v4-pro" });
    if (url.endsWith("/revoke")) return answer(200, { ok: true });
    return answer(404, { error: "no" });
  };
  const session = await loginHoop("lumi", { fetchImpl, env: { HCODE_AUTH_URL: "http://localhost:9999" }, open: url => { opened = url; }, onCode: value => { shown = value; }, wait: async () => {} });
  assert.equal(opened, shown.verificationUri); assert.equal(session.hoop, "lumi"); assert.equal(poll, 2);
  const file = path.join(home, "auth.json"); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const disk = fs.readFileSync(file, "utf8"); assert.doesNotMatch(disk, /api[_-]?key|anthropic|deepseek.*key/i);
  const cfg = applyHoopSession({ model: "old" }, loadHoopSession("lumi"));
  assert.equal(cfg.baseUrl, "https://api.hoopgram.ai"); assert.equal(cfg.hoopUrl, "https://lumi.hoopgram.ai/api/hcode/data"); assert.equal(cfg.apiKey, "s".repeat(32));
  assert.equal(await logoutHoop("lumi", { fetchImpl }), true); assert.equal(loadHoopSession("lumi"), null);
  assert.match(calls.at(-1).options.headers.authorization, /^Bearer /);
});

test("describeHoopSession states account facts for `hcode status`/`hcode account` without ever including the accessToken", async () => {
  const fetchImpl = async url => url.endsWith("/start")
    ? answer(200, { deviceCode: "d".repeat(32), userCode: "ABCD-1234", verificationUri: "http://localhost:9999/hcode/approve?code=ABCD-1234", expiresIn: 600, interval: 1 })
    : answer(200, { accessToken: "s".repeat(32), expiresAt: Date.now() + 3600_000, brainUrl: "https://api.hoopgram.ai", dataUrl: "https://lumi.hoopgram.ai/api/hcode/data", model: "deepseek-v4-pro" });
  await loginHoop("lumi", { fetchImpl, env: { HCODE_AUTH_URL: "http://localhost:9999" }, open: () => {}, wait: async () => {} });

  const active = describeHoopSession("lumi");
  assert.equal(active.connected, true);
  assert.equal(active.entitlement, "active");
  assert.equal(active.hoop, "lumi");
  assert.equal(active.source, "api.hoopgram.ai");
  assert.equal(active.authBase, "http://localhost:9999");
  assert.equal(typeof active.expiresAt, "number");
  assert.equal(typeof active.issuedAt, "number");
  assert.ok(!("accessToken" in active), "must never carry the token");
  assert.doesNotMatch(JSON.stringify(active), /s{32}/, "must never carry the token value");

  const expired = describeHoopSession("lumi", { now: () => Date.now() + 3600_000 + 120_000 });
  assert.equal(expired.entitlement, "expired");

  assert.deepEqual(describeHoopSession("no-such-hoop"), { hoop: "no-such-hoop", connected: false });
});

test("describeHoopSession reports unknown entitlement for a session record it cannot trust", async () => {
  const fetchImpl = async url => url.endsWith("/start")
    ? answer(200, { deviceCode: "d".repeat(32), userCode: "ABCD-1234", verificationUri: "http://localhost:9999/hcode/approve?code=ABCD-1234", expiresIn: 600, interval: 1 })
    // brainUrl points at an unrelated host; loginHoop itself would reject this (see the rejection test below),
    // so simulate a record that was tampered with or corrupted after being written to disk.
    : answer(200, { accessToken: "s".repeat(32), expiresAt: Date.now() + 3600_000, brainUrl: "https://api.hoopgram.ai", dataUrl: "https://lumi.hoopgram.ai/api/hcode/data", model: "deepseek-v4-pro" });
  await loginHoop("lumi", { fetchImpl, env: { HCODE_AUTH_URL: "http://localhost:9999" }, open: () => {}, wait: async () => {} });
  const file = path.join(home, "auth.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.sessions.lumi.brainUrl = "https://evil.example/v1";
  fs.writeFileSync(file, JSON.stringify(store));
  assert.equal(describeHoopSession("lumi").entitlement, "unknown");
});

test("device login rejects cross-Hoop and insecure service endpoints", async () => {
  const fetchImpl = async url => url.endsWith("/start")
    ? answer(200, { deviceCode: "d".repeat(32), userCode: "ABCD-1234", verificationUri: "http://localhost:9999/ok", expiresIn: 60, interval: 1 })
    : answer(200, { accessToken: "s".repeat(32), expiresAt: Date.now() + 3600_000, brainUrl: "https://evil.example/v1", dataUrl: "http://lumi.hoopgram.ai/data" });
  await assert.rejects(loginHoop("lumi", { fetchImpl, env: { HCODE_AUTH_URL: "http://localhost:9999" }, open: () => {}, wait: async () => {} }), /endpoint|HTTPS/);
});
