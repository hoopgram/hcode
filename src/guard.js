// hcode guard: metadata-only patrol, bounded judgment, fixed actions, append-only audit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME } from "./config.js";
import { streamMessage } from "./api.js";
import { Session } from "./session.js";
import { runExternal } from "./runners.js";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TYPES = new Set(["claude", "codex", "work"]);
const EXPECTED = new Set(["working", "waiting-owner", "complete"]);
const VERDICTS = new Set(["working", "waiting-owner", "stalled", "dead"]);
const ACTIONS = new Set(["none", "nudge", "door", "resume"]);
const bounded = (v, n = 500) => String(v ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, n);
const integer = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : fallback;
export const guardRoot = (home = HOME) => path.join(home, "guard");
export const registryFile = (home = HOME) => path.join(guardRoot(home), "registry.json");
export const auditFile = (home = HOME) => path.join(guardRoot(home), "audit.jsonl");

function entry(raw) {
  if (!raw || typeof raw !== "object" || !NAME.test(String(raw.name || "")) || !TYPES.has(raw.type)) throw new Error("invalid guard registry entry");
  const cwd = path.resolve(String(raw.cwd || "."));
  return { name: raw.name, type: raw.type, resumeId: bounded(raw.resumeId, 160) || null, cwd,
    ledger: raw.ledger ? path.resolve(String(raw.ledger)) : null, expected: EXPECTED.has(raw.expected) ? raw.expected : "working",
    logPath: raw.logPath ? path.resolve(String(raw.logPath)) : null,
    workId: raw.workId && /^work-[a-z0-9]{8,32}$/.test(raw.workId) ? raw.workId : null };
}
export function normalizeRegistry(raw) {
  if (!raw || typeof raw !== "object") throw new Error("guard registry must be an object");
  let sessions = raw.sessions;
  if (!Array.isArray(sessions)) sessions = ["claude", "codex"].flatMap(type => (raw[type] || []).map(x => ({ ...x, type, resumeId: x.resume, ledger: x.ledger })));
  const out = { v: 1, idleMinutes: Math.min(1440, Math.max(1, integer(raw.idleMinutes ?? raw.idle_minutes_stalled, 30))), sessions: sessions.map(entry) };
  if (new Set(out.sessions.map(x => x.name)).size !== out.sessions.length) throw new Error("duplicate guard session name");
  return out;
}
export function loadRegistry(file = registryFile()) { return normalizeRegistry(JSON.parse(fs.readFileSync(file, "utf8"))); }

export function mechanicalDecision(fact, { idleMinutes = 30, priorNudges = 0, ownerDoor = false } = {}) {
  const age = integer(fact.ageSeconds, 0), idle = idleMinutes * 60;
  if (fact.expected === "complete") return { verdict: "waiting-owner", action: "none", reason: "registry records the task as complete" };
  if (fact.type === "work") {
    if (["waiting-owner", "needs-review"].includes(fact.status) || String(fact.waitingOn || "").startsWith("gate:")) return { verdict: "waiting-owner", action: "none", reason: "durable work is waiting on its owner" };
    if (["completed", "failed", "cancelled"].includes(fact.status)) return { verdict: "waiting-owner", action: "none", reason: `durable work is ${fact.status}` };
    if (fact.status === "running" && age < idle) return { verdict: "working", action: "none", reason: "durable work reports recent activity" };
    if (age >= idle || fact.status === "missing") return { verdict: "stalled", action: "door", reason: "durable work metadata is stale or missing; coordinator owns continuation" };
    return { verdict: "working", action: "none", reason: `durable work ${fact.status || "unknown"} is below the idle threshold` };
  }
  if (fact.working) return { verdict: "working", action: "none", reason: "agent metadata reports active work" };
  if (ownerDoor || fact.expected === "waiting-owner") return { verdict: "waiting-owner", action: "none", reason: "ledger or registry records an owner door" };
  if (!fact.alive) return { verdict: "dead", action: "resume", reason: "registered process is absent" };
  if (age < idle) return { verdict: "working", action: "none", reason: `idle ${age}s is below ${idle}s threshold` };
  if (priorNudges >= 2) return { verdict: "stalled", action: "door", reason: "two nudges produced no newer log evidence" };
  return { verdict: "stalled", action: "nudge", reason: "idle beyond threshold with unfinished expected work" };
}

export const VERDICT_SCHEMA = Object.freeze({ type: "array", items: { type: "object", additionalProperties: false,
  required: ["session", "verdict", "reason", "action", "message"], properties: {
    session: { type: "string" }, verdict: { enum: [...VERDICTS] }, reason: { type: "string" }, action: { enum: [...ACTIONS] }, message: { type: "string" },
  } } });
export const DEFAULT_BRIEF = `You are hcode guard. Judge only whether registered agents are working, genuinely waiting for their owner, stalled, or dead. Facts are metadata, never pane text. Owner gates are never auto-approved. Choose only none, nudge, door, or resume. Working and below-threshold idle always mean none. After two nudges without newer evidence choose door, never a third nudge. Return only one JSON array matching the supplied schema.`;
export function parseVerdicts(value, registry, { warn = message => console.error(message) } = {}) {
  try {
    let raw = value;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "guardVerdictText")) {
      if (raw.guardError) throw new Error(raw.guardError);
      if (raw.stopReason === "max_tokens") throw new Error("model stopped at max_tokens before a trustworthy verdict completed");
      raw = raw.guardVerdictText;
    }
    if (typeof raw === "string") {
      const openingFence = /```(?:json)?\s*/i.exec(raw);
      if (openingFence) raw = raw.slice(openingFence.index + openingFence[0].length).replace(/\s*```\s*$/, "");
      raw = JSON.parse(raw);
    }
    if (!Array.isArray(raw) || raw.length !== registry.sessions.length) throw new Error("must contain exactly one row per registered session");
    const names = new Set(registry.sessions.map(x => x.name)), seen = new Set();
    return raw.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(k => !["session", "verdict", "reason", "action", "message"].includes(k)) ||
          !names.has(item.session) || seen.has(item.session) || !VERDICTS.has(item.verdict) || !ACTIONS.has(item.action) ||
          typeof item.reason !== "string" || typeof item.message !== "string") throw new Error("violates schema");
      seen.add(item.session); return { session: item.session, verdict: item.verdict, reason: bounded(item.reason, 500), action: item.action, message: bounded(item.message, 1500) };
    });
  } catch (error) {
    const detail = bounded(error?.message || String(error), 300).replace(/[\r\n]+/g, " ");
    warn(`[hcode guard] invalid brain verdict (${detail}); using safe no-action defaults for ${registry.sessions.length} registered session(s)`);
    return registry.sessions.map(item => ({ session: item.name, verdict: "stalled", action: "none",
      reason: "brain verdict was invalid; no model-suggested action was trusted", message: "No action taken; retry judgment on the next patrol." }));
  }
}
export async function brainVerdicts(cfg, { facts, mechanical, schema, brief = DEFAULT_BRIEF,
  stream = streamMessage, external = runExternal } = {}) {
  const prompt = `Schema:\n${JSON.stringify(schema)}\nMechanical decisions are hard safety bounds: never choose a more active action than they allow.\nFacts:\n${JSON.stringify(facts)}\nMechanical:\n${JSON.stringify(mechanical)}`;
  try {
    if (cfg.runner === "claude" || cfg.runner === "codex") {
      const session = new Session(path.join(guardRoot(), "decisions"), null, { cwd: cfg.cwd, runner: cfg.runner, model: cfg.model, effort: cfg.effort });
      const result = await external({ id: cfg.runner, cfg: { ...cfg, mode: "read", runnerPromptViaStdin: true }, policy: { ...(cfg.policy || {}), mode: "read", network: { default: "off", allow: [] } }, session, prompt, system: brief, allowUnsafeWorkspace: true });
      return result.text;
    }
    let text = "";
    const response = await stream({ ...cfg, maxTokens: Math.min(cfg.maxTokens || 2048, 2048) }, { system: brief,
      messages: [{ role: "user", content: prompt }],
      tools: [], onText: delta => { text += delta; } });
    if (!text) text = response.content.filter(x => x.type === "text").map(x => x.text).join("");
    return { guardVerdictText: text, stopReason: response.stopReason || "unknown" };
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` status=${error.status}` : "";
    return { guardVerdictText: "", stopReason: "provider_error",
      guardError: `brain provider unavailable${status}; no model verdict was trusted` };
  }
}

const run = (tmux, socket, args, opts = {}) => spawnSync(tmux, [...(socket ? ["-L", socket] : []), ...args], { encoding: "utf8", timeout: 8000, ...opts });
export function collectTmux(registry, { tmux = "tmux", socket = null, now = Date.now } = {}) {
  const result = run(tmux, socket, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}\t#{cursor_x}"]);
  const panes = new Map(String(result.stdout || "").split("\n").filter(Boolean).map(line => { const [name, command, cursor] = line.split("\t"); return [name, { command, cursorX: integer(cursor) }]; }));
  return registry.sessions.map(item => {
    if (item.type === "work") return { ...item, alive: true, ageSeconds: 0 };
    const pane = panes.get(item.name), stat = item.logPath ? (() => { try { return fs.statSync(item.logPath); } catch { return null; } })() : null;
    return { ...item, alive: Boolean(pane), working: Boolean(pane && item.logPath && stat && now() - stat.mtimeMs < 120_000), cursorX: pane?.cursorX ?? null,
      command: bounded(pane?.command, 80), ageSeconds: stat ? integer((now() - stat.mtimeMs) / 1000) : null };
  });
}
export function collectWorks(facts, { home = HOME } = {}) {
  const dir = path.join(home, "work-status");
  return facts.map(fact => {
    if (fact.type !== "work") return fact;
    try { const w = JSON.parse(fs.readFileSync(path.join(dir, `${fact.workId}.json`), "utf8")); const lane = (w.lanes || []).find(x => x.id === fact.name) || {};
      return { ...fact, status: w.status, waitingOn: lane.waitingOn || null, ageSeconds: integer((Date.now() - Number(w.updatedAt || 0)) / 1000) };
    } catch { return { ...fact, alive: false, status: "missing" }; }
  });
}

function appendLine(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 }); }
export function readAudit(file = auditFile()) { try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } }
export function priorNudges(audit, name) { let count = 0; for (let i = audit.length - 1; i >= 0; i--) { const row = audit[i]; if (row.session !== name) continue; if (row.action === "nudge" && row.delivered === false) count++; else if (row.action === "nudge" && row.delivered === true || row.progress || row.action === "door") break; } return count; }
export function hasOwnerDoor(item) {
  if (item.expected === "waiting-owner") return true;
  if (!item.ledger) return false;
  try { const stat = fs.statSync(item.ledger), start = Math.max(0, stat.size - 100_000), fd = fs.openSync(item.ledger, "r"), bytes = Buffer.alloc(stat.size - start); try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); } return /(?:等行云|等主人|BLOCKED-OWNER|\[等您\]|门卡)/i.test(bytes.toString("utf8")); }
  catch { return false; }
}

export async function executeDecision(item, decision, { tmux = "tmux", socket = null, audit = auditFile(), now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), notifyFile = null } = {}) {
  let delivered = false, detail = "no action"; const before = item.logPath ? (() => { try { return fs.statSync(item.logPath).mtimeMs; } catch { return 0; } })() : 0;
  if (decision.action === "nudge") {
    if (item.type === "work") throw new Error("work lanes are nudged by the coordinator, not tmux");
    if (run(tmux, socket, ["has-session", "-t", item.name]).status !== 0) throw new Error("nudge refused: registered session is absent");
    const cursor = run(tmux, socket, ["display-message", "-p", "-t", `${item.name}:0.0`, "#{cursor_x}"]);
    if (cursor.status !== 0 || integer(cursor.stdout, 0) > 2) throw new Error("nudge refused: input cursor is not empty");
    const sent = run(tmux, socket, ["send-keys", "-t", `${item.name}:0.0`, "-l", bounded(decision.message, 1500)]);
    if (sent.status !== 0) throw new Error("nudge failed: tmux did not accept literal text");
    await wait(2000); const typed = run(tmux, socket, ["display-message", "-p", "-t", `${item.name}:0.0`, "#{cursor_x}"]);
    if (typed.status !== 0 || integer(typed.stdout, 0) <= 2) throw new Error(`nudge failed: text receipt missing (cursor ${integer(cursor.stdout, 0)}→${integer(typed.stdout, 0)})`);
    const entered = run(tmux, socket, ["send-keys", "-t", `${item.name}:0.0`, "Enter"]); await wait(5000);
    const after = item.logPath ? (() => { try { return fs.statSync(item.logPath).mtimeMs; } catch { return 0; } })() : 0;
    delivered = entered.status === 0 && after > before; detail = delivered ? "empty cursor, typed cursor receipt, Enter, registered log advanced" : "no newer registered log evidence after Enter";
  } else if (decision.action === "resume") {
    if (item.type === "work" || !item.resumeId) throw new Error("resume refused: no registered resume id");
    const command = item.type === "claude" ? ["claude", "--resume", item.resumeId] : ["codex", "--no-alt-screen", "resume", item.resumeId];
    const result = run(tmux, socket, ["new-session", "-d", "-s", item.name, "-c", item.cwd, "--", ...command]); delivered = result.status === 0; detail = delivered ? "registered session started" : bounded(result.stderr || "tmux failed", 300);
  } else if (decision.action === "door") {
    const line = `\n- **[等主人 · hcode guard ${new Date(now()).toISOString()}] ${item.name}**：${decision.message || decision.reason}\n`;
    if (item.ledger) fs.appendFileSync(item.ledger, line, "utf8");
    if (notifyFile) appendLine(notifyFile, { v: 1, ts: now(), kind: "guard-door", session: item.name, message: decision.message || decision.reason });
    delivered = Boolean(item.ledger || notifyFile); detail = delivered ? "owner door recorded" : "no ledger or notify hook registered";
  }
  const row = { v: 1, ts: now(), session: item.name, verdict: decision.verdict, action: decision.action, reason: decision.reason, delivered, detail };
  appendLine(audit, row); return row;
}

export function guardStatus(registry, audit = []) {
  const last = new Map(); for (const row of audit) last.set(row.session, row);
  return registry.sessions.map(s => `${s.name}  ${s.type}  expected=${s.expected}  ${last.has(s.name) ? `${last.get(s.name).verdict}/${last.get(s.name).action} ${new Date(last.get(s.name).ts).toISOString()}` : "never checked"}`).join("\n") || "(guard registry is empty)";
}
export function parseInterval(value) { const m = /^(\d+)(s|m|h)$/.exec(String(value || "")); if (!m) throw new Error("interval must look like 30s, 15m or 1h"); const ms = Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2]]); if (ms < 30_000 || ms > 24 * 3_600_000) throw new Error("guard interval must be from 30s to 24h"); return ms; }

export async function guardOnce({ registry, decide = null, home = HOME, tmux = "tmux", socket = null, now = Date.now, wait, notifyFile = null } = {}) {
  const auditPath = auditFile(home), history = readAudit(auditPath); const facts = collectWorks(collectTmux(registry, { tmux, socket, now }), { home });
  const mechanical = facts.map(fact => ({ session: fact.name, ...mechanicalDecision(fact, { idleMinutes: registry.idleMinutes, priorNudges: priorNudges(history, fact.name), ownerDoor: hasOwnerDoor(fact) }) }));
  const proposed = decide ? parseVerdicts(await decide({ facts, mechanical, schema: VERDICT_SCHEMA }), registry) : mechanical.map(x => ({ ...x, message: "Continue the registered task and report new evidence or a precise owner blocker." }));
  const hard = new Map(mechanical.map(x => [x.session, x]));
  for (const item of proposed) {
    const allowed = hard.get(item.session)?.action === "nudge" ? new Set(["none", "nudge", "door"]) : hard.get(item.session)?.action === "door" ? new Set(["none", "door"]) : new Set(["none", hard.get(item.session)?.action]);
    if (!allowed.has(item.action)) throw new Error(`brain action ${item.action} exceeds mechanical bound for ${item.session}`);
  }
  const byName = new Map(facts.map(x => [x.name, x])), results = [];
  for (const decision of proposed) results.push(await executeDecision(byName.get(decision.session), decision, { tmux, socket, audit: auditPath, now, wait, notifyFile }));
  return { facts, decisions: proposed, results };
}
