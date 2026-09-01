import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_THRESHOLD = 3;

export function classifyFailure(output, rc) {
  if (rc === 0) return "none";
  const text = String(output || "");
  // The structured line printed by bin/hcode.js on fatal exit states the disease directly.
  // It wins over every regex below: mixed output (e.g. a 429 followed by a 403 capability
  // probe) must be classified by the terminal cause, not by whichever keyword appears first —
  // classifying an auth failure as "quota" makes the supervisor wait for a reset that never comes.
  const structured = /hcode-failure:\s*class=(\w+)/.exec(text);
  if (structured) {
    const cls = structured[1];
    if (cls === "out_of_budget" || cls === "rate_limited") return "quota";
    if (cls === "auth_failed") return "deterministic";
    if (cls === "transient") return "transient";
    if (cls === "fatal") return "deterministic";
  }
  // Order matters: a capability probe can fail because its provider returned
  // 429.  That says nothing about the capability declaration's correctness.
  if (/\b(?:HTTP\s*)?429\b|rate.?limit|out[_ -]?of[_ -]?budget|quota/i.test(text)) return "quota";
  if (/\b(?:HTTP\s*)?5\d\d\b|timed?\s*out|timeout|ECONN(?:RESET|REFUSED|ABORTED)|ENETUNREACH|EHOSTUNREACH|network (?:error|unreachable)|connection (?:reset|refused)/i.test(text)) return "transient";
  if (/model_fallback_below_minimum|below (?:the )?(?:agentic|context|capability) (?:floor|minimum)|capabilit(?:y|ies).*(?:missing|invalid|mismatch|does not match)|(?:invalid|missing) (?:configuration|config)|authentication.*(?:invalid|expired)|\bHTTP\s*40[13]\b/i.test(text)) return "deterministic";
  return "unknown";
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function errorFingerprint(output, rc) {
  const cleaned = String(output || "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const diagnostic = [...cleaned].reverse().find(line => /UNOBSERVED:|model_fallback_unobserved|attention brain unreachable|candidate capability|out.of.budget/i.test(line))
    || cleaned.slice(-3).join(" | ") || `exit:${rc}`;
  const stable = diagnostic.replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, "<time>").replace(/retry\s+\d+\/\d+/ig, "retry <n>/<n>");
  return crypto.createHash("sha256").update(`rc=${rc}\n${stable}`).digest("hex");
}

export function recordAttempt(file, { rc, output, now = Date.now(), threshold = DEFAULT_THRESHOLD } = {}) {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (rc === 0) {
    const state = { v: 1, state: "running", failureClass: "none", consecutive: 0, fingerprint: null, updatedAt: now };
    atomicJson(file, state); return state;
  }
  const failureClass = classifyFailure(output, rc);
  const fingerprint = errorFingerprint(output, rc);
  const consecutive = old.fingerprint === fingerprint && old.failureClass === failureClass ? Number(old.consecutive || 0) + 1 : 1;
  const next = failureClass === "deterministic" ? (consecutive >= threshold ? "circuit-open" : "retrying")
    : failureClass === "quota" ? "waiting-quota" : failureClass === "transient" ? "waiting-transient" : "unobserved";
  const state = { v: 1, state: next, failureClass, consecutive, threshold, fingerprint, rc, updatedAt: now };
  atomicJson(file, state); return state;
}

export function publishCircuitStatus(file, state, { session, resumeCommand } = {}) {
  const open = state.state === "circuit-open";
  const unknown = state.state === "unobserved";
  const waiting = state.state === "waiting-quota" || state.state === "waiting-transient";
  const reason = open ? `same deterministic error ${state.fingerprint} repeated ${state.consecutive}/${state.threshold}; automatic retries stopped`
    : state.state === "waiting-quota" ? `provider quota/rate limit observed; waiting with bounded backoff (attempt ${state.consecutive}); session/objective preserved`
    : state.state === "waiting-transient" ? `temporary provider/network failure observed; waiting with bounded backoff (attempt ${state.consecutive}); session/objective preserved`
    : unknown ? `failure cannot be classified; automatic retry stopped as UNOBSERVED (${state.fingerprint})` : `retry ${state.consecutive}/${state.threshold}`;
  atomicJson(file, { v: 1, session, state: open ? "blocked" : unknown ? "UNOBSERVED" : waiting ? "waiting" : state.state,
    severity: open || unknown ? "red" : "yellow", failureClass: state.failureClass, reason,
    errorFingerprint: state.fingerprint, consecutive: state.consecutive, resumeCommand, observedAt: state.updatedAt });
}

export function resetCircuit(stateFile, statusFile, { now = Date.now() } = {}) {
  atomicJson(stateFile, { v: 1, state: "running", failureClass: "none", consecutive: 0, fingerprint: null, updatedAt: now, resumedAt: now });
  atomicJson(statusFile, { v: 1, state: "running", severity: "green", failureClass: "none", reason: "supervised process is running", consecutive: 0, observedAt: now });
}
