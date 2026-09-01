// /handoff and /continue (0.8 C): a handoff is a work contract someone else can pick up, not a
// compressed history.
//
// Three things follow from that. It is **structured**: six numbered sections in a fixed order, with a
// machine-readable first line — `0. 模式: … | 状态: …` — that /continue reads with nothing more than the
// head of the file, so a ledger can be filed, archived and restored without parsing prose. It is
// **evidence-only**: every fact in it comes from this thread's own event log or from the process itself
// (no brain call, no cost, the same file for the same log). And it **carries its own way back**: the
// restart line is generated from the running process — its cwd, its launcher, the session-shaping flags
// and the environment variables that are not secrets — because a session already knows how it was
// started, and a handoff that makes the owner reconstruct that has handed over half the work.
//
// Ledgers live in `<project>/交接/hcode/active/hcode-<task>.md`. `状态: done` files are moved to
// `archive/YYYY-MM/` by the next /continue — the only thing that ever files a ledger away, so a
// finished task cannot sit in active/ forever and an unfinished one is never touched however old.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { VERSION } from "./config.js";
import { isNativeRuntime, runtimeLabel } from "./runtime.js";
import { currentMode } from "./modes.js";
import { runFixedCommand } from "./fixed-command.js";

export const LEDGER_ROOT = "交接";
export const AGENT_KIND = "hcode";
export const STATUSES = ["active", "done"];
const CONTEXT_FILES = ["HCODE.md", "AGENTS.md", "CLAUDE.md"];
// Carried into the restart line so a resumed session lands on the same brain and store. Anything that
// smells like a credential is refused below even if it were listed here: a handoff file is a document
// the owner shares, and a secret must never be able to reach one.
const CARRY_ENV = ["HCODE_HOME", "HCODE_SESSIONS", "HCODE_MODEL", "HCODE_BASE_URL", "HCODE_MODE", "HCODE_EFFORT",
  "HCODE_TOKEN_BUDGET", "HCODE_DEFAULT_HOOP", "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL"];
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH/i;
const SAFE_ENV_VALUE = /^[A-Za-z0-9._:/@=+,~-]{1,200}$/;

const firstLine = value => String(value ?? "").split("\n").map(line => line.trim()).find(Boolean) || "";
const short = (target, home = os.homedir()) => (home && target.startsWith(home + path.sep) ? "~" + target.slice(home.length) : target);
// A `~` only expands unquoted, so a path that needs quoting is written against $HOME instead of
// losing its shorthand — the restart line has to survive a space in a directory name.
const quote = value => {
  const text = String(value);
  if (/^[A-Za-z0-9._:/@=+,~-]+$/.test(text)) return text;
  if (text.startsWith("~/")) return `"$HOME/${text.slice(2).replace(/(["$`\\])/g, "\\$1")}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
};

// A task name is what a ledger is addressed by, so it has to survive a filename and a shell argument.
export function slugTask(value, fallback = "session") {
  const slug = String(value || "").trim().toLowerCase()
    .replace(/[\s_/\\]+/g, "-")
    .replace(/[^a-z0-9一-鿿.-]/g, "")
    .replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return slug || fallback;
}

export function ledgerRoot(cwd, settings = {}) {
  const configured = String(process.env.HCODE_HANDOFF_DIR || settings.handoffDir || "").trim();
  if (configured) return path.resolve(cwd, configured);
  return path.join(cwd, LEDGER_ROOT, AGENT_KIND);
}
export const activeDir = root => path.join(root, "active");
export const archiveDir = (root, now = Date.now()) => {
  const d = new Date(now);
  return path.join(root, "archive", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
};

// ---- the restart line ---------------------------------------------------------------------------
// One line, one paste: cd there and continue. It never carries a credential — CARRY_ENV is filtered a
// second time by name and by value shape, so a variable that was renamed into the list cannot leak.
export function restartCommand({ cwd, task, argv = process.argv, env = process.env, flags = [], home = os.homedir(), lookup = null, native = isNativeRuntime(), execPath = process.execPath } = {}) {
  const script = String(argv[1] || "");
  const base = path.basename(script).replace(/\.js$/, "");
  const onPath = typeof lookup === "function" ? lookup("hcode", env) : null;
  const launcher = base === "hcode" && onPath ? "hcode" : native ? quote(short(path.resolve(execPath), home)) : base === "hcode" ? `node ${quote(short(path.resolve(script), home))}` : "hcode";
  const carried = CARRY_ENV
    .filter(name => !SECRET_ENV.test(name) && env[name] && SAFE_ENV_VALUE.test(String(env[name])))
    .map(name => `${name}=${quote(short(String(env[name]), home))}`);
  const parts = [...carried, launcher, ...flags.map(String), `"/continue ${slugTask(task)}"`];
  return `cd ${quote(short(path.resolve(cwd), home))} && ${parts.join(" ")}`;
}

// Flags worth repeating: only the ones this session actually moved away from what a plain `hcode`
// would give it, so the line stays short enough to read.
export function restartFlags(cfg, baseline = {}) {
  const flags = [];
  for (const [flag, key] of [["--model", "model"], ["--mode", "mode"], ["--effort", "effort"]]) {
    if (cfg[key] && cfg[key] !== baseline[key]) flags.push(flag, String(cfg[key]));
  }
  return flags;
}

// ---- evidence -----------------------------------------------------------------------------------
const sha = text => "sha256:" + crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);

// The hashes are the point of section 3: next session skips re-reading a file whose hash still matches.
export function contextHashes(cwd) {
  const rows = [];
  for (const name of CONTEXT_FILES) {
    try { const text = fs.readFileSync(path.join(cwd, name), "utf8"); rows.push(`${name} · ${sha(text)} · ${text.length} characters`); }
    catch { /* absent is not a fact worth recording */ }
  }
  return rows;
}

// The one fact worth a subprocess: which commit and branch the next session must be standing on.
// Fixed arguments, bounded output, and a workspace with no git is simply not a fact — never an error.
export async function collectFacts(cwd, { env = process.env, timeoutMs = 4000, git = "git" } = {}) {
  const facts = [];
  try {
    const [head, dirty] = await Promise.all([
      runFixedCommand(git, ["log", "-1", "--format=%h %D — %s"], { cwd, env, timeoutMs, maxBytes: 4000 }),
      runFixedCommand(git, ["status", "--porcelain"], { cwd, env, timeoutMs, maxBytes: 20_000 }),
    ]);
    if (head.ok && head.output.trim()) facts.push(`git HEAD ${firstLine(head.output).slice(0, 160)}`);
    if (dirty.ok) {
      const count = dirty.output.split("\n").filter(line => line.trim()).length;
      facts.push(count ? `working tree: ${count} uncommitted path(s)` : "working tree: clean");
    }
  } catch { /* no git, no repo, no fact */ }
  return facts;
}

// Everything /handoff knows, read once from the append-only log. Pure: same log, same object.
export function threadEvidence(session) {
  const goals = []; const changed = new Set(); const commands = []; const calls = new Map();
  const questions = []; const errors = []; const delegations = [];
  const usage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
  let note = "";
  for (const event of session.events || []) {
    if (event.type === "turn.start") goals.push(firstLine(event.prompt).slice(0, 160));
    else if (event.type === "turn.end") for (const key of Object.keys(usage)) usage[key] += Number(event.usage?.[key] || 0);
    else if (event.type === "error") errors.push(`${event.code}: ${firstLine(event.message).slice(0, 140)}`);
    else if (event.type === "child.spawn") delegations.push(`${event.childId} ${event.runner}${event.model ? " " + event.model : ""} — ${firstLine(event.task).slice(0, 90)}`);
    else if (event.type !== "item") continue;
    else if (event.item.kind === "tool_call") calls.set(event.item.id, { ...calls.get(event.item.id), ...event.item });
    else if (event.item.kind === "message" && event.item.role === "assistant") {
      const text = (Array.isArray(event.item.content) ? event.item.content.filter(b => b.type === "text").map(b => b.text).join("") : String(event.item.content)).trim();
      if (text) note = text.slice(0, 600);
    }
  }
  const pending = [];
  for (const call of calls.values()) {
    if (call.tool === "ask_user" && !["done", "cancelled"].includes(call.state)) questions.push(firstLine(call.input?.question || "").slice(0, 140));
    if (["write_file", "edit_file"].includes(call.tool) && call.state === "done") changed.add(String(call.input?.path || ""));
    else if (call.tool === "bash" && call.state === "done") commands.push(String(call.input?.command || "").replace(/\n/g, " ").slice(0, 140));
    if (!["done", "cancelled"].includes(call.state)) pending.push(`${call.tool} ${String(call.input?.path || call.input?.command || "").slice(0, 90)} — ${call.state || "pending"}`.trim());
  }
  return { goals, changed: [...changed].filter(Boolean), commands, pending, questions: questions.filter(Boolean), errors, delegations, usage, note };
}

// A thread with nothing unfinished and nothing left to answer is done; anything else is still active.
// The owner overrides it either way (`/handoff done`, `/handoff active`), because only a person can
// say that the remaining item is somebody else's problem.
export function suggestStatus(evidence) {
  return evidence.pending.length || evidence.questions.length ? "active" : "done";
}

const section = (heading, rows, empty) => [`## ${heading}`, "", ...(rows.length ? rows.map(row => `- ${row}`) : [`- ${empty}`]), ""];

export function ledgerBody({ session, cfg = {}, task, status = "active", mode = "default", facts = [], now = Date.now(), restart = "" }) {
  const e = threadEvidence(session);
  const held = e.usage.in + e.usage.cacheWrite + e.usage.cacheRead;
  return [
    // The thread joins line 0 because filing a ledger away is the moment its thread gives up its claim
    // on the rewind snapshots, and /continue has to know which thread that was from the head of the file
    // alone. A ledger written before this field simply carries none, and retires nothing.
    `0. 模式: ${mode} | 状态: ${status} | 线程: ${session.id}`,
    "",
    `# ${task} — hcode handoff`,
    "",
    `written ${new Date(now).toISOString()} · session \`${session.id}\` · \`hcode --resume ${session.id}\` reopens the whole thread`,
    "",
    ...section("1. 目标与进度 / Goal and progress", [
      ...e.goals.slice(-8).map(goal => `asked: ${goal}`),
      ...(e.changed.length ? [`changed ${e.changed.length} file(s): ${e.changed.slice(-20).join(", ")}`] : []),
      ...(e.commands.length ? [`ran: ${e.commands.slice(-6).map(c => "`" + c + "`").join(" · ")}`] : []),
      ...(e.delegations.length ? [`delegated: ${e.delegations.slice(-5).join(" · ")}`] : []),
      ...(e.note ? [`last said: ${firstLine(e.note).slice(0, 200)}`] : []),
    ], "nothing was recorded on this thread yet"),
    ...section("2. 下一步 / Next steps", [
      ...e.pending.map(row => `unfinished: ${row}`),
      ...e.questions.map(row => `waiting on an answer: ${row}`),
    ], "nothing was left running — write the next step here before handing this over"),
    ...section("3. 已核实版本 / Verified versions and hashes", [
      `hcode ${VERSION} · ${runtimeLabel()} · brain ${cfg.model || session.header?.model || "unknown"} · effort ${cfg.effort || "high"} · permission ${cfg.mode || "ask"}`,
      `workspace ${cfg.cwd || session.header?.cwd || process.cwd()}`,
      ...facts.filter(Boolean),
      ...contextHashes(cfg.cwd || session.header?.cwd || process.cwd()),
      `tokens this thread: ${e.usage.in} uncached + ${e.usage.cacheWrite} cache write + ${e.usage.cacheRead} cache read = ${held} carried in, ${e.usage.out} out`,
    ], "no versions were verified"),
    ...section("4. 未决问题 / Open questions", [
      ...e.questions,
      ...e.errors.slice(-5),
    ], "none recorded — add anything the owner still has to decide"),
    "## 5. 重启脚本 / Restart",
    "",
    "```sh",
    restart,
    "```",
    "",
    "Generated from this thread's event log and this process — no brain was called. Edit any section before handing it over; only line 0 has a fixed shape.",
    "",
  ].join("\n");
}

export function writeLedger({ session, cfg = {}, settings = {}, task, status = "active", mode = null, facts = [], now = Date.now(), argv = process.argv, env = process.env, baseline = {}, lookup = null }) {
  if (!STATUSES.includes(status)) throw new Error(`status must be ${STATUSES.join(" or ")}`);
  const cwd = cfg.cwd || session.header?.cwd || process.cwd();
  const name = slugTask(task || firstLine(session.events?.find(ev => ev.type === "turn.start")?.prompt) || session.id);
  const root = ledgerRoot(cwd, settings);
  const dir = activeDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${AGENT_KIND}-${name}.md`);
  const restart = restartCommand({ cwd, task: name, argv, env, flags: restartFlags(cfg, baseline), lookup });
  const body = ledgerBody({ session, cfg, task: name, status, mode: mode || currentMode(session), facts, now, restart });
  // Overwritten in place on purpose: one agent + one task is one ledger, never a pile of them.
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { file, task: name, status, existed, restart, bytes: Buffer.byteLength(body) };
}

// ---- reading a ledger back ------------------------------------------------------------------------
const STATUS_LINE = /^0\.\s*模式:\s*([^|]+?)\s*\|\s*状态:\s*(\S+)/;
// Read separately, and deliberately narrow: a thread id names a file beside the sessions, so a
// hand-edited ledger must never be able to put a path separator into one.
const THREAD_LINE = /\|\s*线程:\s*([A-Za-z0-9._-]+)/;

export function parseLedger(text, file = "") {
  const lines = String(text).split("\n");
  const match = STATUS_LINE.exec(lines[0] || "");
  const ledger = { file, mode: "default", status: "", parsed: Boolean(match), goal: "", next: "", open: "", thread: "", task: path.basename(file, ".md").replace(/^hcode-/, "") };
  if (match) { ledger.mode = match[1].trim(); ledger.status = match[2].trim(); }
  ledger.thread = (THREAD_LINE.exec(lines[0] || "") || ["", ""])[1];
  let current = 0;
  const buckets = new Map();
  for (const line of lines) {
    const heading = /^##\s*(\d)\./.exec(line);
    if (heading) { current = Number(heading[1]); buckets.set(current, []); continue; }
    if (current && line.trim().startsWith("- ")) buckets.get(current).push(line.trim().slice(2).trim());
  }
  ledger.goal = (buckets.get(1) || [])[0] || "";
  ledger.next = (buckets.get(2) || [])[0] || "";
  ledger.open = (buckets.get(4) || [])[0] || "";
  ledger.sections = buckets;
  return ledger;
}

const readHead = file => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };

export function listLedgers(root, { filter = "" } = {}) {
  const dir = activeDir(root);
  let names; try { names = fs.readdirSync(dir).filter(f => f.endsWith(".md")); } catch { return []; }
  const want = String(filter || "").trim().split(/\s+/)[0].toLowerCase();
  const rows = names.map(name => {
    const file = path.join(dir, name);
    let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { /* raced with a mv */ }
    return { ...parseLedger(readHead(file), file), name, mtime };
  }).filter(row => !want || row.name.toLowerCase().includes(want));
  rows.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return rows;
}

// Only `状态: done` moves, and only ever into this month's archive. A ledger with no status line, or
// one that says active, is left exactly where it is however old it looks — an unreadable first line
// must never cost the owner a file.
export function archiveDone(root, { now = Date.now() } = {}) {
  const moved = [];
  for (const row of listLedgers(root)) {
    if (row.status !== "done") continue;
    const dir = archiveDir(root, now);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let target = path.join(dir, row.name);
    if (fs.existsSync(target)) target = path.join(dir, row.name.replace(/\.md$/, `-${new Date(now).toISOString().slice(11, 19).replace(/:/g, "")}.md`));
    try { fs.renameSync(row.file, target); moved.push({ name: row.name, file: target, thread: row.thread }); } catch { /* another session filed it first */ }
  }
  return moved;
}

// The threads an archive gives up a claim on. Filing a `状态: done` ledger is the owner saying that task
// is finished, which is exactly what `retire` in rewind.js means — so the rewind snapshots those threads
// took can be collected, while the threads themselves stay resumable in `hcode sessions` (going back is
// never an erasure: the conversation survives; only the working-tree copies it could put back go).
// The live thread is never in this set. The owner can still rewind inside the session they ran /continue
// in, and a claim held by a thread that is running is not a claim anyone has given up.
export function retiredThreads(archived = [], { keep = "" } = {}) {
  const live = String(keep || "");
  return [...new Set((archived || []).map(row => String(row?.thread || "")).filter(id => id && id !== live))];
}

// /continue: file what is finished, then open the newest ledger that is still active.
export function continueFrom(root, { filter = "", now = Date.now() } = {}) {
  const archived = archiveDone(root, { now });
  const rows = listLedgers(root, { filter });
  return { archived, ledger: rows[0] || null, candidates: rows.length };
}

export function formatContinue({ archived, ledger, candidates }, { root = "", filter = "" } = {}) {
  const lines = [archived.length ? `archived: ${archived.map(row => row.name).join(", ")}` : "archived: nothing was marked done"];
  if (!ledger) {
    lines.push(filter ? `no active handoff matching "${filter}" in ${activeDir(root)}` : `no active handoff in ${activeDir(root)} — /handoff writes one.`);
    return lines.join("\n");
  }
  lines.push(`resuming ${ledger.name}${candidates > 1 ? ` (newest of ${candidates} matching)` : ""} · mode ${ledger.mode}`, "",
    `goal:  ${ledger.goal || "(section 1 is empty)"}`,
    `next:  ${ledger.next || "(section 2 is empty)"}`,
    `open:  ${ledger.open || "(section 4 is empty)"}`);
  return lines.join("\n");
}

export function formatLedgers(rows, { root = "" } = {}) {
  if (!rows.length) return `No handoff ledgers in ${activeDir(root)}. /handoff writes one.`;
  return rows.map(row => `${row.name.padEnd(34)} ${String(row.status || "?").padEnd(7)} ${String(row.mode).padEnd(10)} ${row.goal.slice(0, 60)}`).join("\n");
}
