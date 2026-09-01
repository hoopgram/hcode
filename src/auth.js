// HoopGram browser/device sign-in. The website owns identity and subscription state; hcode stores only
// a revocable device session (never the provider API key) in a 0600 file on this machine.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME } from "./config.js";

const FILE = path.join(HOME, "auth.json");
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function authBase(env = process.env) {
  const value = String(env.HCODE_AUTH_URL || "https://hoopgram.ai").replace(/\/+$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("HCODE_AUTH_URL must use HTTPS");
  return value;
}
function readStore() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { v: 1, sessions: {} }; } }
function writeStore(store) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const temp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, FILE); fs.chmodSync(FILE, 0o600);
}
function validateName(name) {
  const value = String(name || "").toLowerCase();
  if (!NAME.test(value)) throw new Error("invalid Hoop name");
  return value;
}
function safeEndpoint(value, name, { brain = false } = {}) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("HoopGram returned a non-HTTPS endpoint");
  const allowed = url.hostname === `${name}.hoopgram.ai` || brain && ["api.hoopgram.ai", "hoopgram.ai"].includes(url.hostname);
  if (!allowed) throw new Error("HoopGram returned an endpoint for another host");
  return url.toString().replace(/\/+$/, "");
}
async function json(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) } });
  let body = {}; try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.error || `HoopGram login answered ${response.status}`), { status: response.status });
  return body;
}

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawnImpl(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref?.();
}

export async function loginHoop(name, { fetchImpl = fetch, env = process.env, onCode = () => {}, open = openBrowser, now = Date.now, wait = sleep } = {}) {
  name = validateName(name); const base = authBase(env);
  const started = await json(fetchImpl, `${base}/api/hcode/device/start`, { method: "POST", body: JSON.stringify({ hoop: name }) });
  if (!started.deviceCode || !started.userCode || !started.verificationUri) throw new Error("HoopGram returned an incomplete device login");
  const verification = new URL(started.verificationUri);
  if (verification.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(verification.hostname)) throw new Error("HoopGram returned an unsafe login URL");
  onCode({ userCode: String(started.userCode), verificationUri: verification.toString(), hoop: name });
  open(verification.toString());
  const deadline = now() + Math.min(15 * 60_000, Math.max(30_000, Number(started.expiresIn || 600) * 1000));
  const interval = Math.max(1000, Math.min(10_000, Number(started.interval || 3) * 1000));
  for (;;) {
    if (now() >= deadline) throw new Error("HoopGram login expired; run `hcode login` again");
    await wait(interval);
    let token;
    try { token = await json(fetchImpl, `${base}/api/hcode/device/token`, { method: "POST", body: JSON.stringify({ deviceCode: started.deviceCode }) }); }
    catch (error) { if (error.status === 428 || error.status === 429) continue; throw error; }
    if (token.status === "pending") continue;
    const expiresAt = Number(token.expiresAt);
    if (!token.accessToken || !Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("HoopGram returned an invalid device session");
    const session = { hoop: name, accessToken: String(token.accessToken), expiresAt, issuedAt: now(),
      brainUrl: safeEndpoint(token.brainUrl, name, { brain: true }), dataUrl: safeEndpoint(token.dataUrl, name), model: String(token.model || "deepseek-v4-pro"), authBase: base };
    const store = readStore(); store.v = 1; store.sessions ||= {}; store.sessions[name] = session; writeStore(store);
    return session;
  }
}

export function loadHoopSession(name, { now = Date.now } = {}) {
  name = validateName(name); const session = readStore().sessions?.[name];
  if (!session || Number(session.expiresAt) <= now() + 60_000) return null;
  try { return { ...session, brainUrl: safeEndpoint(session.brainUrl, name, { brain: true }), dataUrl: safeEndpoint(session.dataUrl, name) }; }
  catch { return null; }
}

// For `hcode status`/`hcode account`: what this machine can say about a Hoop login without asking the
// server again. Never returns accessToken. "active"/"expired" come from the locally cached expiresAt
// (set by the server at sign-in, not reconfirmed live here); "unknown" means the local record itself
// cannot be trusted (missing/corrupt fields), not that the server was asked and did not know.
export function describeHoopSession(name, { now = Date.now } = {}) {
  name = validateName(name);
  const session = readStore().sessions?.[name];
  if (!session) return { hoop: name, connected: false };
  let source = null;
  try { source = new URL(safeEndpoint(session.brainUrl, name, { brain: true })).hostname; } catch { source = null; }
  const expiresAt = Number(session.expiresAt);
  const validExpiry = Number.isFinite(expiresAt);
  const issuedAt = Number(session.issuedAt);
  const entitlement = !validExpiry || !source ? "unknown" : expiresAt <= now() ? "expired" : "active";
  return {
    hoop: name, connected: true, entitlement,
    expiresAt: validExpiry ? expiresAt : null,
    issuedAt: Number.isFinite(issuedAt) ? issuedAt : null,
    source, authBase: session.authBase || null,
  };
}

export async function logoutHoop(name, { fetchImpl = fetch } = {}) {
  name = validateName(name); const store = readStore(); const session = store.sessions?.[name];
  if (session?.accessToken && session.authBase) {
    try { await json(fetchImpl, `${session.authBase}/api/hcode/device/revoke`, { method: "POST", headers: { authorization: `Bearer ${session.accessToken}` }, body: "{}" }); } catch { /* local logout must still complete */ }
  }
  if (store.sessions) delete store.sessions[name]; writeStore(store);
  return Boolean(session);
}

export function applyHoopSession(cfg, session) {
  cfg.baseUrl = session.brainUrl; cfg.apiKey = session.accessToken;
  cfg.hoopUrl = session.dataUrl; cfg.hoopToken = session.accessToken; cfg.hoopName = session.hoop;
  cfg.model = session.model || cfg.model; cfg.authKind = "hoopgram-device";
  return cfg;
}
