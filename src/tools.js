// The tool belt: read_file, write_file, edit_file, list_dir, glob, grep, bash, ask_user, update_plan and delegate_agent — with the
// tool contract of CONTRACTS-V027 §2: every tool declares input/output schema, risk and idempotency.
// Threat model (see README "Security"):
//   * every path is resolved against the project root (cwd); writes/edits never leave it and are atomic
//     (tmp + rename: a failure never leaves a half-written file);
//   * reads may leave the root but never touch secret-shaped files (~/.ssh, ~/.secrets, ~/.hoopgram, ~/.hcode,
//     ~/.codex/auth.json, ~/.claude/settings*.json, .env*, *.pem, *.key, id_*) — the model does not need them;
//   * bash runs as you, in the project root, inside the OS sandbox (sandbox.js) with the network off unless the
//     broker allowed it; its risk is labelled by the command classifier (policy.js). `read` mode refuses it,
//     `ask` mode confirms it unless policy allows the pattern, `auto` runs it. No tool escalates privileges or
//     edits hcode's own config. There is no tool that takes an arbitrary URL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { headTail } from "./session.js";
import { SUBAGENT_KINDS } from "./subagents.js";
import { globToRegex, allowed, classifyCommand, setPathJudge } from "./policy.js";
import * as sandbox from "./sandbox.js";
import { AGENCY_KINDS, decideEscalation } from "./agency.js";
import { searchWeb } from "./web-search.js";
export { allowed };

const MAX_READ = 200_000;
const CAP_HALF = 50_000;                       // bash output: 50k head + 50k tail, the middle is counted, never silently dropped
export const BASH_TIMEOUT_MARKER = "[hcode: the command was killed after its timeout; its whole process tree is gone]";
export const SANDBOX_RUNTIME_MARKER = "[hcode: the OS sandbox wrapper failed before the command could run]";
const SECRET_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.secrets(\/|$)/, /(^|\/)\.hoopgram(\/|$)/, /(^|\/)\.hcode(\/|$)/, /(^|\/)\.npmrc$/,
  /(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.netrc$/, /(^|\/)\.config\/gh(\/|$)/, /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.codex\/auth\.json$/, /(^|\/)\.claude\/settings[^/]*\.json$/, /(^|\/)\.claude\/\.credentials/, /(^|\/)\.codex\/config\.toml$/,
  /(^|\/)id_[a-z0-9]+(\.pub)?$/, /\.p12$/, /\.pfx$/, /\.keychain(-db)?$/, /(^|\/)\.password-store(\/|$)/, /(^|\/)\.docker\/config\.json$/,
];

export function isSecretPath(p) {
  const norm = p.replace(/\\/g, "/");
  return SECRET_PATTERNS.some(re => re.test(norm));
}

// realpath of the deepest existing ancestor + the rest: a symlink can never smuggle a path past the ruler,
// and a path that does not exist yet is still judged by where it would really land.
export function realResolve(p) {
  let cur = path.resolve(p); const rest = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* does not exist yet: step up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur)); cur = parent;
  }
  return path.resolve(p);
}

// One ruler for every path in hcode — the file tools and the paths named inside a bash command all come here.
// Returns { abs, real, inside, secret }. `judgePath` never throws; `resolveInside` is the throwing wrapper.
setPathJudge((root, p, cwd) => judgePath(root, p, cwd));
export function judgePath(root, p, cwd = null) {
  const base = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  const abs = path.resolve(cwd || root, base);
  const real = realResolve(abs);
  const realRoot = realResolve(root);
  const rel = path.relative(realRoot, real);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return { abs, real, inside, secret: isSecretPath(abs) || isSecretPath(real) };
}

export function resolveInside(root, p, { allowOutside = false } = {}) {
  if (typeof p !== "string" || !p.length) throw new Error("path required");
  if (p.includes("\0")) throw new Error("bad path");
  const { abs, real, inside, secret } = judgePath(root, p);
  if (!inside && !allowOutside) throw new Error(`refused: ${p} is outside the project root ${root}`);
  if (secret) throw new Error(`refused: ${p}${real !== abs ? ` → ${real}` : ""} looks like a secret; hcode never reads or writes those`);
  return abs;
}

function resolveReadable(root, p, allowedRoots) {
  const abs = resolveInside(root, p, { allowOutside: true });
  const judged = judgePath(root, p);
  if (judged.inside) return abs;
  const allowed = allowedRoots.some(grant => {
    const rel = path.relative(grant, judged.real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!allowed) throw new Error(`refused: ${p} is outside the project root and is not in policy.json allowedRoots`);
  return abs;
}

// Writable scratch declared in policy.json allowedTempRoots: write_file/edit_file may land there
// exactly as far as bash may (mv into the scratch dir is the self-verification move). Everything
// else outside the root still refuses — one rule for the tool belt and the shell, no seams.
function resolveWritable(root, p, writeRoots) {
  const judged = judgePath(root, p);
  const allowed = writeRoots.some(grant => {
    const rel = path.relative(grant, judged.real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  // .hcode is normally a secret path. The only writable carve-out is a policy-loaded
  // .hcode/tmp root; loadPolicy enforces that shape before it reaches this tool layer.
  if (judged.secret && !allowed) throw new Error(`refused: ${p} looks like a secret; hcode never writes it outside the declared .hcode/tmp scratch`);
  if (judged.inside || allowed) return judged.abs;
  if (!allowed) throw new Error(`refused: ${p} is outside the project root and is not in policy.json allowedTempRoots`);
  return judged.abs;
}

const STR = { type: "string" }; const BOOL = { type: "boolean" }; const INT = { type: "integer", minimum: 1 };
const PLAN_STEPS = { type: "array", maxItems: 8, items: { type: "object", properties: {
  label: STR, status: { type: "string", enum: ["pending", "in_progress", "completed"] },
}, required: ["label", "status"], additionalProperties: false } };
const OUT_TEXT = { type: "string", description: "text for the model" };
// The tool contract (CONTRACTS-V027 §2). `hcode tools --json` prints this table; the Hoop's Code UI renders risk from it.
export const TOOL_CONTRACT = [
  { name: "read_file", description: "Read a UTF-8 text file. Returns numbered lines. Use offset/limit for big files.",
    input: { type: "object", properties: { path: STR, offset: INT, limit: INT }, required: ["path"], additionalProperties: false },
    output: OUT_TEXT, risk: ["read"], idempotent: true },
  { name: "write_file", description: "Create or overwrite a file inside the project with the given content (atomic).",
    input: { type: "object", properties: { path: STR, content: STR }, required: ["path", "content"], additionalProperties: false },
    output: { type: "string", description: "created|overwrote <path> (<bytes> bytes)" }, risk: ["write"], idempotent: true },
  { name: "edit_file", description: "Exact-string replacement inside a project file (atomic). old_string must occur exactly once (or set replace_all).",
    input: { type: "object", properties: { path: STR, old_string: STR, new_string: STR, replace_all: BOOL }, required: ["path", "old_string", "new_string"], additionalProperties: false },
    output: { type: "string", description: "edited <path> (<n> replacements)" }, risk: ["write"], idempotent: false },
  { name: "list_dir", description: "List a directory (names; directories end with /).",
    input: { type: "object", properties: { path: STR }, required: [], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true },
  { name: "glob", description: "Find files by glob pattern (e.g. src/**/*.js) under the project root. Returns up to 500 paths.",
    input: { type: "object", properties: { pattern: STR, path: STR }, required: ["pattern"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true },
  { name: "grep", description: "Search file contents with a regular expression under a directory. Returns path:line:text, up to 200 hits.",
    input: { type: "object", properties: { pattern: STR, path: STR, glob: STR, ignore_case: BOOL }, required: ["pattern"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true },
  { name: "web_search", description: "Search the public web through hcode's fixed search provider. Returns titles, snippets and source URLs; it never opens result pages or accepts an arbitrary URL.",
    input: { type: "object", properties: { query: STR, max_results: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false },
    leanOmit: ["max_results"], output: OUT_TEXT, risk: ["read", "network"], idempotent: true },
  { name: "bash", description: "Run a shell command in the project root (sandboxed, network off unless approved) and return stdout+stderr (timeout applies). Prefer the file tools for reading/editing.",
    input: { type: "object", properties: { command: STR, timeout_ms: INT }, required: ["command"], additionalProperties: false },
    output: { type: "string", description: "stdout+stderr then [exit <code>]" }, risk: ["write", "network?", "destructive?"], idempotent: false },
  { name: "ask_user", description: "Ask the human a question and wait for their answer. Use sparingly, only when you are blocked.",
    input: { type: "object", properties: { question: STR }, required: ["question"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: false },
  { name: "update_plan", description: "Show or update a concise live work plan. Use before multi-step work and whenever its goal, checkpoint, or step status changes.",
    input: { type: "object", properties: { goal: STR, checkpoint: STR, steps: PLAN_STEPS }, required: ["goal", "checkpoint", "steps"], additionalProperties: false },
    output: { type: "string", description: "plan updated" }, risk: ["read"], idempotent: true },
  { name: "delegate_agent", description: "Ask an owner-installed Codex or Claude Code subagent to investigate one bounded task read-only. Its report returns to hcode; hcode remains the coordinator and final speaker. Always say which brain it runs on: either model (any id that CLI accepts) or kind — search for searching, scanning and reading logs, mechanical for repetitive edits, implement for designing and writing code. A flagship brain is refused as a subagent unless the owner asked for it and you pass allow_flagship.",
    input: { type: "object", properties: { agent: { type: "string", enum: ["codex", "claude"] }, task: STR, model: STR, kind: { type: "string", enum: SUBAGENT_KINDS }, allow_flagship: BOOL }, required: ["agent", "task"], additionalProperties: false },
    leanOmit: ["model", "kind", "allow_flagship"],
    output: { type: "string", description: "the subagent report for hcode to evaluate and integrate" }, risk: ["external"], idempotent: false },
];
export const AGENCY_TOOL_CONTRACT = [{
  name: "escalate_hard_gate",
  description: "Submit machine facts to the Full Agency broker. Only a proven exact 4+1 hard gate is persisted upward; ordinary uncertainty returns to you to decide, and missing evidence is UNOBSERVED.",
  input: { type: "object", properties: {
    kind: { type: "string", enum: AGENCY_KINDS }, summary: STR, proposed_action: STR, recommendation: STR,
    spend_cents: { type: "integer", minimum: 0 }, authorized_cents: { type: "integer", minimum: 0 },
    target: STR, target_class: { type: "string", enum: ["owner_data", "other"] }, operation: STR,
    public_before: BOOL, public_after: BOOL, owner_intent_id: STR, owner_intent_digest: STR, conflict_evidence: STR,
  }, required: ["kind", "summary", "proposed_action", "recommendation"], additionalProperties: false },
  output: { type: "string", description: "STOP with durable outbox path, CONTINUE, or UNOBSERVED" }, risk: ["read"], idempotent: false,
}];
// A connected Hoop is a separate, read-only world. These tools are only shown to the
// model when hcode is on a Hoop or `hcode connect` opened the owner SSH tunnel.
export const HOOP_TOOL_CONTRACT = [
  { name: "hoop_status", description: "Read system health from the connected Hoop, not from this computer.",
    input: { type: "object", properties: {}, required: [], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
  { name: "hoop_finance", description: "Read the connected Hoop's trading account summary, positions, and today's and yesterday's P&L. Never places a trade.",
    input: { type: "object", properties: { account: { type: "string", enum: ["active", "test", "real"] } }, required: [], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
  { name: "hoop_chats", description: "List the connected Hoop's chat conversations or read one conversation's recent history. This is not local hcode history.",
    input: { type: "object", properties: { operation: { type: "string", enum: ["list", "history"] }, id: STR, limit: INT }, required: ["operation"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
  { name: "hoop_files", description: "List or read owner files stored in the connected Hoop. This is not the current computer's filesystem.",
    input: { type: "object", properties: { operation: { type: "string", enum: ["list", "read"] }, path: STR }, required: ["operation"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
  { name: "hoop_calendar", description: "Read calendar events from the connected Hoop. Never changes the calendar.",
    input: { type: "object", properties: {}, required: [], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
  { name: "hoop_memory", description: "Search the connected Hoop's harvested memory. This is separate from local project files.",
    input: { type: "object", properties: { query: STR, limit: INT }, required: ["query"], additionalProperties: false }, output: OUT_TEXT, risk: ["read"], idempotent: true, scope: "hoop" },
];
export const ALL_TOOL_CONTRACT = [...TOOL_CONTRACT, ...AGENCY_TOOL_CONTRACT, ...HOOP_TOOL_CONTRACT];
// What the model sees (Anthropic tool format).
export const TOOL_DEFS = TOOL_CONTRACT.map(t => ({ name: t.name, description: t.description, input_schema: t.input }));
// Lean variant for small local brains: one-sentence descriptions, no examples, minimal schema (< 1.5k tokens with the lean system prompt).
// `leanOmit` fields are optional refinements a 4B brain has no window to spend on; the code that runs the
// tool must still work when they are absent (delegate_agent: agent.js picks the smallest subagent tier).
const LEAN_DESCRIPTIONS = Object.freeze({
  read_file: "Read text file.", write_file: "Write project file.", edit_file: "Replace exact project text.", list_dir: "List directory.",
  glob: "Find files by glob.", grep: "Search text by regex.", web_search: "Search web.", bash: "Run project shell command.", ask_user: "Ask owner when blocked.",
  update_plan: "Update live plan.", delegate_agent: "Delegate one bounded read-only task.",
});
const leanDescription = tool => LEAN_DESCRIPTIONS[tool.name] || tool.description.split(/(?<=\.)\s/)[0].replace(/\s*\(.*?\)/g, "");
const leanProperty = (value, withEnum) => value.type === "array"
  ? { type: "array", maxItems: value.maxItems, items: { type: "object", properties: Object.fromEntries(Object.entries(value.items.properties).map(([key, shape]) => [key, { type: shape.type, ...(withEnum && shape.enum ? { enum: shape.enum } : {}) }])), required: value.items.required } }
  : { type: value.type, ...(withEnum && value.enum ? { enum: value.enum } : {}) };
const leanProperties = (t, withEnum) => Object.fromEntries(Object.entries(t.input.properties)
  .filter(([k]) => !(t.leanOmit || []).includes(k))
  .map(([k, v]) => [k, leanProperty(v, withEnum)]));
export const TOOL_DEFS_LEAN = TOOL_CONTRACT.map(t => ({ name: t.name, description: leanDescription(t),
  input_schema: { type: "object", properties: leanProperties(t, false), required: t.input.required } }));
export function toolDefs({ hoop = false, lean = false, agency = false } = {}) {
  const contracts = [...TOOL_CONTRACT, ...(agency ? AGENCY_TOOL_CONTRACT : []), ...(hoop ? HOOP_TOOL_CONTRACT : [])];
  return contracts.map(t => lean
    ? { name: t.name, description: leanDescription(t), input_schema: { type: "object", properties: leanProperties(t, true), required: t.input.required } }
    : { name: t.name, description: t.description, input_schema: t.input });
}
export const TOOL_BY_NAME = Object.fromEntries(ALL_TOOL_CONTRACT.map(t => [t.name, t]));

// Concrete risk of one call (bash is classified per command; "?" risks resolve here).
export function risksOf(name, input = {}, root = null, policy = null) {
  const t = TOOL_BY_NAME[name]; if (!t) return ["write", "destructive"];
  if (name === "bash") return classifyCommand(input.command, { root, readRoots: policy?.allowedRoots || [], writeRoots: policy?.allowedTempRoots || [] }).risk;
  return t.risk;
}

// Schema check without a library: types + required + no unknown keys (contract: unknown fields are rejected).
export function validateInput(name, input) {
  const t = TOOL_BY_NAME[name]; if (!t) return `unknown tool ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  for (const k of t.input.required) if (input[k] === undefined) return `missing required field "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = t.input.properties[k]; if (!p) return `unknown field "${k}"`;
    if (p.type === "string" && typeof v !== "string") return `"${k}" must be a string`;
    if (p.type === "boolean" && typeof v !== "boolean") return `"${k}" must be a boolean`;
    if (p.type === "integer" && (!Number.isInteger(v) || v < (p.minimum ?? -Infinity))) return `"${k}" must be an integer ≥ ${p.minimum ?? 0}`;
    if (p.type === "integer" && p.maximum !== undefined && v > p.maximum) return `"${k}" must be an integer ≤ ${p.maximum}`;
    if (p.type === "array") {
      if (!Array.isArray(v)) return `"${k}" must be an array`;
      if (p.maxItems && v.length > p.maxItems) return `"${k}" may contain at most ${p.maxItems} items`;
      for (const [index, item] of v.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return `"${k}[${index}]" must be an object`;
        for (const required of p.items?.required || []) if (item[required] === undefined) return `"${k}[${index}]" is missing "${required}"`;
        for (const [field, value] of Object.entries(item)) {
          const shape = p.items?.properties?.[field];
          if (!shape) return `unknown field "${k}[${index}].${field}"`;
          if (shape.type === "string" && typeof value !== "string") return `"${k}[${index}].${field}" must be a string`;
          if (shape.enum && !shape.enum.includes(value)) return `"${k}[${index}].${field}" must be one of ${shape.enum.join("|")}`;
        }
      }
    }
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join("|")}`;
  }
  return null;
}

export const MUTATING = new Set(["write_file", "edit_file", "bash", "delegate_agent"]);

const IGNORED_DIRS = new Set([".git", "node_modules", ".hcode", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"]);

function* walk(dir, root, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, root, depth + 1);
    else if (e.isFile()) yield path.relative(root, full).split(path.sep).join("/");
  }
}

// Atomic write: <file>.hcode-tmp then rename (same directory → same filesystem → atomic on POSIX).
export function writeAtomic(abs, content) {
  const tmp = abs + ".hcode-tmp";
  try {
    let mode; try { mode = fs.statSync(abs).mode & 0o777; } catch { mode = undefined; }
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    fs.renameSync(tmp, abs);
  } catch (err) { try { fs.unlinkSync(tmp); } catch { /* nothing half-written survives */ } throw err; }
}

export function createTools(ctx) {
  const { root, bashTimeoutMs = 120000, askUser, updatePlan, delegateAgent, webSearch = searchWeb, fullAgency = false, agencyOutbox, sandboxWant = "auto", sandboxStatus = null, allowedRoots = [], allowedTempRoots = [], hoopUrl = "", hoopName = "Hoop", hoopToken = "" } = ctx;
  const readRoots = allowedRoots.map(realResolve);
  const writeRoots = allowedTempRoots.map(realResolve);
  const source = organ => `[source: Hoop ${hoopName} · ${organ}]`;
  const remote = async (pathname, { text = false } = {}) => {
    if (!hoopUrl) throw new Error("no Hoop data channel is connected; use `hcode connect <hoop>` or run hcode on a Hoop");
    // Keep an authenticated gateway prefix (for example /api/hcode/data/) instead of
    // letting an absolute tool path jump back to the host root. Local http://...:8095 is unchanged.
    const target = new URL(String(pathname).replace(/^\/+/, ""), hoopUrl.replace(/\/+$/, "") + "/");
    if (!/^https?:$/.test(target.protocol)) throw new Error("bad Hoop data channel");
    const transport = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.get(target, { timeout: 10000, headers: { "x-pa-actor": "owner", accept: text ? "text/plain, application/json" : "application/json", ...(hoopToken ? { authorization: `Bearer ${hoopToken}` } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_READ) { req.destroy(new Error("Hoop response is larger than 200 KB")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if ((res.statusCode || 500) >= 400) return reject(new Error(`Hoop answered ${res.statusCode}: ${body.toString("utf8").slice(0, 300)}`));
          const type = String(res.headers["content-type"] || "");
          if (text && !/^text\/(plain|csv|markdown)|application\/json/i.test(type)) return reject(new Error(`Hoop file is not readable text (${type || "unknown type"})`));
          if (body.includes(0)) return reject(new Error("Hoop file is binary, not readable text"));
          resolve(body.toString("utf8"));
        });
      });
      req.on("timeout", () => req.destroy(new Error("Hoop data channel timed out")));
      req.on("error", reject);
    });
  };
  const jsonView = async (organ, pathname) => {
    const raw = await remote(pathname);
    try { return `${source(organ)}\n${JSON.stringify(JSON.parse(raw), null, 2)}`; }
    catch { throw new Error("Hoop returned invalid JSON"); }
  };
  return {
    async escalate_hard_gate(input) {
      if (!fullAgency) throw new Error("refused: escalation broker is available only in --full-agency mode");
      return JSON.stringify(decideEscalation(input, agencyOutbox ? { root: agencyOutbox } : {}));
    },
    async read_file({ path: p, offset = 1, limit }) {
      const abs = resolveReadable(root, p, readRoots);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error(`${p} is a directory (use list_dir)`);
      if (st.size > 5_000_000) throw new Error(`${p} is ${st.size} bytes; too large`);
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      const start = Math.max(1, offset); const end = limit ? Math.min(lines.length, start + limit - 1) : lines.length;
      const out = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join("\n");
      const cut = headTail(out, MAX_READ);
      return (cut.truncated ? cut.text + "\n(use offset/limit to read the middle)" : cut.text) || "(empty file)";
    },
    async write_file({ path: p, content }) {
      const abs = resolveWritable(root, p, writeRoots);
      if (typeof content !== "string") throw new Error("content must be a string");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      writeAtomic(abs, content);
      return `${existed ? "overwrote" : "created"} ${path.relative(root, abs)} (${Buffer.byteLength(content)} bytes)`;
    },
    async edit_file({ path: p, old_string, new_string, replace_all = false }) {
      const abs = resolveWritable(root, p, writeRoots);
      if (typeof old_string !== "string" || typeof new_string !== "string") throw new Error("old_string/new_string must be strings");
      if (old_string === "") throw new Error("old_string must not be empty");
      if (old_string === new_string) throw new Error("old_string and new_string are identical");
      const src = fs.readFileSync(abs, "utf8");
      const count = src.split(old_string).length - 1;
      if (count === 0) throw new Error("old_string not found (must match exactly, including whitespace)");
      if (count > 1 && !replace_all) throw new Error(`old_string occurs ${count} times; make it unique or set replace_all`);
      const out = replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string);
      writeAtomic(abs, out);
      return `edited ${path.relative(root, abs)} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})`;
    },
    async list_dir({ path: p = "." }) {
      const abs = resolveReadable(root, p, readRoots);
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => !isSecretPath(path.join(abs, e.name)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => e.isDirectory() ? e.name + "/" : e.name);
      return entries.join("\n") || "(empty)";
    },
    async glob({ pattern, path: p = "." }) {
      const base = resolveReadable(root, p, readRoots);
      const re = globToRegex(pattern);
      const hits = [];
      for (const rel of walk(base, base)) { if (re.test(rel)) { hits.push(path.relative(root, path.join(base, rel)) || rel); if (hits.length >= 500) break; } }
      return hits.join("\n") || "(no matches)";
    },
    async grep({ pattern, path: p = ".", glob: g, ignore_case = false }) {
      const base = resolveReadable(root, p, readRoots);
      let re; try { re = new RegExp(pattern, ignore_case ? "i" : ""); } catch (e) { throw new Error(`bad regex: ${e.message}`); }
      const fileRe = g ? globToRegex(g) : null;
      const hits = [];
      outer: for (const rel of walk(base, base)) {
        if (fileRe && !fileRe.test(rel)) continue;
        const abs = path.join(base, rel);
        if (isSecretPath(abs)) continue;
        let text; try { if (fs.statSync(abs).size > 2_000_000) continue; text = fs.readFileSync(abs, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) { hits.push(`${path.relative(root, abs)}:${i + 1}:${lines[i].slice(0, 300)}`); if (hits.length >= 200) break outer; }
        }
      }
      return hits.join("\n") || "(no matches)";
    },
    async web_search({ query, max_results = 5 }, { signal = null } = {}) {
      return webSearch(query, { maxResults: max_results, signal });
    },
    bash({ command, timeout_ms }, { network = false, signal = null } = {}) {
      if (typeof command !== "string" || !command.trim()) throw new Error("command required");
      const timeout = Math.min(Number(timeout_ms) || bashTimeoutMs, 600000);
      const sb = sandboxStatus || sandbox.detect(sandboxWant);
      const realRoot = realResolve(root);     // same root the path ruler uses, so `..` means the same thing everywhere
      if (sb.degraded && !classifyCommand(command, { root: realRoot }).readOnly) {
        throw Object.assign(new Error(`sandbox unavailable: refusing a mutating command (${sb.reason || "OS sandbox degraded"})`), { code: "sandbox_degraded" });
      }
      const [bin, args] = sandbox.wrap(["bash", "-lc", command], { root: realRoot, network: Boolean(network), adapter: sb.adapter });
      // the child never inherits model credentials: keys stay in the broker (keyproxy / tunnel), not in tool env
      const env = { ...process.env, HCODE: "1", HCODE_SANDBOX: sb.adapter };
      for (const k of Object.keys(env)) if (/^(HCODE_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|DEEPSEEK_API_KEY|HCODE_BASE_URL)$/.test(k)) delete env[k];
      return new Promise(resolve => {
        // detached: the command gets its own process group, so a timeout kills the whole tree — a grandchild
        // holding the pipe can never hang hcode (it used to: kill() hit only the direct shell and `close` never fired).
        const child = spawn(bin, args, { cwd: realRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        const head = []; let headLen = 0; const tail = []; let tailLen = 0; let dropped = 0;
        const cap = str => {                                   // keep the head AND the tail, count what fell out
          if (headLen < CAP_HALF) { const take = str.slice(0, CAP_HALF - headLen); head.push(take); headLen += take.length; str = str.slice(take.length); if (!str) return; }
          tail.push(str); tailLen += str.length;
          while (tailLen - tail[0].length >= CAP_HALF) { const gone = tail.shift(); tailLen -= gone.length; dropped += gone.length; }
          if (tailLen > CAP_HALF) { const excess = tailLen - CAP_HALF; tail[0] = tail[0].slice(excess); tailLen -= excess; dropped += excess; }
        };
        const text = () => head.join("") + (dropped ? `\n… [hcode: ${dropped} bytes of output omitted from the middle] …\n` : "") + tail.join("");   // head + tail, never the middle only
        let done = false; let killed = null;
        const killTree = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
        const finish = code => {
          if (done) return; done = true; clearTimeout(timer);
          const out = text();
          const wrapperFailed = !killed && sb.adapter === "systemd-run" && code === 226;
          resolve(`${out}${out && !out.endsWith("\n") ? "\n" : ""}[exit ${killed ? `killed: ${killed}` : code}]${killed === "timeout" ? " " + BASH_TIMEOUT_MARKER : ""}${wrapperFailed ? " " + SANDBOX_RUNTIME_MARKER : ""}`);
        };
        child.stdout.on("data", d => cap(d.toString())); child.stderr.on("data", d => cap(d.toString()));
        // the deadline resolves the call itself: hcode never waits for a pipe a grandchild refuses to close
        const timer = setTimeout(() => { killed = "timeout"; killTree(); setTimeout(() => finish(null), 50).unref?.(); }, timeout);
        if (signal) { const onAbort = () => { killed = "cancelled"; killTree(); setTimeout(() => finish(null), 50).unref?.(); }; if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
        child.on("close", code => finish(code));
        child.on("error", err => { if (done) return; done = true; clearTimeout(timer); resolve(`[spawn error: ${err.message}]`); });
      });
    },
    async ask_user({ question }) {
      if (!askUser) return "(no human available in this mode; decide on your own and continue)";
      return (await askUser(String(question))) || "(no answer)";
    },
    async update_plan({ goal, checkpoint, steps }) {
      const plan = { goal: String(goal), checkpoint: String(checkpoint), steps: steps.map(step => ({ label: String(step.label), status: String(step.status) })) };
      updatePlan?.(plan);
      return "plan updated";
    },
    async delegate_agent({ agent, task, model = "", kind = "", allow_flagship = false }) {
      if (!delegateAgent) throw new Error("subagent delegation is unavailable in this session");
      return delegateAgent({ agent, task, model, kind, allowFlagship: allow_flagship });
    },
    async hoop_status() { return jsonView("System", "/status"); },
    async hoop_finance({ account = "active" } = {}) {
      return jsonView("Finance", `/finance/summary?account=${encodeURIComponent(account)}`);
    },
    async hoop_chats({ operation, id = "", limit = 60 }) {
      if (operation === "list") return jsonView("Chats", "/conversations");
      if (operation === "history") {
        if (!id) throw new Error("conversation id required for history");
        return jsonView("Chats", `/history?conv=${encodeURIComponent(id)}&n=${Math.min(limit, 500)}`);
      }
      throw new Error("operation must be list or history");
    },
    async hoop_files({ operation, path: p = "" }) {
      const clean = String(p || "");
      if (operation === "list") return jsonView("Files", `/files/list?dir=${encodeURIComponent(clean)}`);
      if (operation === "read") return `${source("Files")}\n${await remote(`/files/get?path=${encodeURIComponent(clean)}`, { text: true })}`;
      throw new Error("operation must be list or read");
    },
    async hoop_calendar() { return jsonView("Calendar", "/calendar"); },
    async hoop_memory({ query, limit = 20 }) {
      return jsonView("Memory", `/memory/hub?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}`);
    },
  };
}
