// External runners (A7): Claude Code CLI and Codex CLI as OPTIONAL executors the owner installed themselves.
//   * never part of hcode or the Hoop closure — hcode only detects a binary on PATH (or the path the owner registered);
//   * their permissions are bounded by the same policy: read → read-only flags; ask/auto → workspace writes;
//     network only when policy.network.default is "on" (there is no per-call broker inside a foreign CLI — said honestly);
//   * everything they do is written to the same v2 thread (header.runner = claude|codex), so it exports like any session;
//   * `hcode runner remove <id>` is the one command to pull one out (hcode stops offering it; the binary stays yours).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME } from "./config.js";
import { EXTERNAL_BINS, findBinary } from "./runner-bins.js";
import { isSecretPath, risksOf } from "./tools.js";
import { escapeControls } from "./ui.js";
import { attachmentMetadata, runnerPromptWithImages, userMessageContent, validateRunnerImages } from "./attachments.js";
import { presence } from "./presence.js";

export const EXTERNAL = {
  claude: { bin: EXTERNAL_BINS.claude, label: "Claude Code CLI", uninstall: "npm uninstall -g @anthropic-ai/claude-code" },
  codex: { bin: EXTERNAL_BINS.codex, label: "Codex CLI", uninstall: "npm uninstall -g @openai/codex" },
};
const REG = path.join(HOME, "runners.json");

function readReg() { try { return JSON.parse(fs.readFileSync(REG, "utf8")); } catch { return {}; } }
function writeReg(reg) { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); const tmp = REG + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(tmp, REG); }

// The PATH probe itself now lives in runner-bins.js (config.js needs it too); re-exported so every
// existing caller keeps importing it from the runners module it belongs to.
export { findBinary };

// [{id, label, available, enabled, path, default}] — the list the Hoop's /code/runners also derives from.
export function listRunners(env = process.env) {
  const reg = readReg();
  const out = [{ id: "hcode", label: "Hoop Code (built in)", available: true, enabled: true, path: "", default: true }];
  for (const [id, def] of Object.entries(EXTERNAL)) {
    const removed = reg[id]?.enabled === false;
    const p = removed ? null : findBinary(def.bin, env);
    out.push({ id, label: def.label, available: Boolean(p), enabled: !removed, path: p || "", default: false, uninstall: def.uninstall });
  }
  return out;
}

export function removeRunner(id) {
  if (!EXTERNAL[id]) throw new Error(`unknown runner ${id} (claude|codex)`);
  const reg = readReg(); reg[id] = { enabled: false, removedAt: Date.now() }; writeReg(reg);
  return `${EXTERNAL[id].label} removed from hcode: \`--runner ${id}\` is refused and the Hoop no longer lists it. The program itself is still yours; to delete it too: ${EXTERNAL[id].uninstall}`;
}
export function addRunner(id) {
  if (!EXTERNAL[id]) throw new Error(`unknown runner ${id} (claude|codex)`);
  const reg = readReg(); delete reg[id]; writeReg(reg);
  const p = findBinary(EXTERNAL[id].bin);
  return p ? `${EXTERNAL[id].label} enabled (${p})` : `${EXTERNAL[id].label} enabled, but no \`${EXTERNAL[id].bin}\` binary is on PATH — install it yourself first (hcode never installs software)`;
}

// Flags that bound the external CLI to the hcode policy. Pure function so it is testable.
// A foreign CLI cannot route per-action approvals through hcode, so `ask` is bounded to read-only (never more
// than hcode's own broker would grant without the owner); `auto` and explicitly
// confirmed session-only `all` let it write. An agency grant of 7+ carries the same
// write semantics (张良's ruling: 档7-8 ≡ auto/all) so a frozen "ask" can never silently
// read-only a full-agency task. Network still follows project policy.
export const externalWrites = (mode, agencyLevel = null) => mode === "auto" || mode === "all" || Number(agencyLevel ?? 0) >= 7;
const FOREIGN_SECRET_ENV = /^(?:HCODE_.*|ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|OPENAI_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|GH_TOKEN|GITHUB_TOKEN|.*(?:_TOKEN|_SECRET|_PASSWORD))$/;

// A foreign runner is not allowed to traverse a convenient link out of the
// chosen project or to inherit an hcode/provider credential by environment.
// Its own owner-installed login remains its independent BYO boundary; hcode
// never reads or forwards that login material.
export function assertSafeExternalWorkspace(root) {
  const base = fs.realpathSync(root);
  if (!fs.statSync(base).isDirectory() || isSecretPath(base)) throw new Error("refused: external runner workspace is unsafe");
  const todo = [base]; let seen = 0;
  while (todo.length) {
    const dir = todo.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > 10000) throw new Error("refused: external runner workspace inventory exceeds limit");
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("refused: external runner workspace contains a symlink");
      if (isSecretPath(full)) throw new Error("refused: external runner workspace contains a secret-shaped path");
      if (entry.isDirectory()) todo.push(full);
      else if (!entry.isFile()) throw new Error("refused: external runner workspace contains a non-file entry");
    }
  }
  return base;
}
export function externalRunnerEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (FOREIGN_SECRET_ENV.test(key)) delete clean[key];
  return clean;
}
export function boundedArgs(id, { mode, agencyLevel = null, policy, prompt, resume, model, effort = "high", system, promptViaStdin = false, images = [] }) {
  const net = policy?.network?.default === "on";
  const writes = externalWrites(mode, agencyLevel);
  if (id === "claude") {
    const tools = writes ? ["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "Bash"] : ["Read", "Glob", "Grep", "LS"];
    if (net) tools.push("WebFetch", "WebSearch");
    const denied = [...(writes ? [] : ["Edit", "Write", "MultiEdit", "Bash", "NotebookEdit"]), ...(net ? [] : ["WebFetch", "WebSearch"])];
    return ["-p", ...(promptViaStdin ? [] : [prompt]), "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", writes ? "acceptEdits" : "plan",
      "--effort", effort,
      "--allowedTools", tools.join(","), ...(denied.length ? ["--disallowedTools", denied.join(",")] : []),
      ...(images.length ? ["--add-dir", ...new Set(images.map(image => image.root))] : []),
      ...(system ? ["--append-system-prompt", system] : []), ...(resume ? ["--resume", resume] : []), ...(model ? ["--model", model] : [])];
  }
  if (id === "codex") {
    // `codex exec` is non-interactive by design (it never asks); the sandbox flag is the bound
    // --skip-git-repo-check: hcode already scoped the work to the owner's chosen project root; codex's own sandbox still applies
    const fullPrompt = system ? `${system}\n\n# Assigned task\n${prompt}` : prompt;
    return ["exec", "--json", "--skip-git-repo-check", "--sandbox", writes ? "workspace-write" : "read-only",
      "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
      ...(net ? ["-c", "sandbox_workspace_write.network_access=true"] : []), ...(model ? ["--model", model] : []),
      ...images.flatMap(image => ["--image", image.path]), ...(resume ? ["resume", resume] : []), promptViaStdin ? "-" : fullPrompt];
  }
  throw new Error(`unknown runner ${id}`);
}

// ---- output → v2 events ---------------------------------------------------------------------------------
// Both CLIs print JSON lines; we map what we can recognise to text / tool_call / tool_result items and keep the
// foreign session id in turn.end so `--resume` can hand it back to the same CLI.
export function makeTranslator(id, session, { onText, onTool, root = null }) {
  const open = new Map();     // foreign tool id → lifecycle facts
  const finished = new Set(); // foreign tool ids already resulted
  let foreignSession = null; let text = ""; let usage = { in: 0, out: 0 };
  // A run that reports its cost only when it is over cannot be watched while it works, so the stream's
  // own token counters are read as they pass and published as a live event — never written to the thread,
  // because the `result` line at the end is still the single record and it *assigns* over this estimate.
  // The arithmetic is the same one that settles it, so the number can only be behind, never a different
  // basis: input plus cache reads (a cache read is an input token the provider billed) and output.
  let live = { in: 0, out: 0 }; let outBase = 0; let published = { in: -1, out: -1 };
  const publish = () => { if (live.in === published.in && live.out === published.out) return; published = { ...live }; session.live("usage", { in: live.in, out: live.out }); };
  const call = (fid, name, input) => {
    const tool = mapTool(id, name); const inp = mapInput(id, name, input);
    const item = session.toolCall(tool, inp, risksOf(tool, inp, root), "running");
    const life = { iid: item.id, name: tool, input: inp, detail: `${name} ${JSON.stringify(inp)}`, risk: item.risk, startedAt: Date.now() };
    if (fid) open.set(fid, life);
    onTool?.({ phase: "start", name: tool, input: inp, detail: life.detail, risk: item.risk, id: item.id });
    return item.id;
  };
  const result = (fid, ok, output) => {
    const life = open.get(fid); if (!life) return;
    open.delete(fid);
    const durationMs = Date.now() - life.startedAt;
    session.setCallState(life.iid, ok ? "done" : "failed");
    session.toolResult(life.iid, ok, output, durationMs);
    onTool?.({ phase: "end", name: life.name, input: life.input, detail: life.detail, risk: life.risk, id: life.iid, state: ok ? "done" : "failed", output, durationMs });
  };
  const delta = chunk => { const t = escapeControls(chunk); if (!t) return; text += t; session.live("text", { delta: t }); onText?.(t); };
  function line(raw) {
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    if (id === "claude") {
      if (ev.session_id) foreignSession = ev.session_id;
      const inner = ev.type === "stream_event" ? ev.event : null;
      if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") delta(inner.delta.text);
      // one assistant message per step: its input is billed at message_start, its output grows through
      // message_delta (cumulative for that message, hence the base carried across steps)
      if (inner?.type === "message_start") { const u = inner.message?.usage || {}; live.in += (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0); outBase = live.out; publish(); }
      if (inner?.type === "message_delta" && inner.usage) { live.out = outBase + (+inner.usage.output_tokens || 0); publish(); }
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) for (const b of ev.message.content) if (b.type === "tool_use" && !open.has(b.id)) call(b.id, b.name, b.input);
      if (ev.type === "user" && Array.isArray(ev.message?.content)) for (const b of ev.message.content) if (b.type === "tool_result") result(b.tool_use_id, !b.is_error, typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));
      if (ev.type === "result") { const u = ev.usage || {}; usage = { in: (+u.input_tokens || 0) + (+u.cache_read_input_tokens || 0), out: +u.output_tokens || 0 }; live = { ...usage }; publish(); if (!text && typeof ev.result === "string") delta(ev.result); }
    } else {
      const msg = ev.msg || ev.item || ev;               // codex exec --json: {type:"item.completed", item:{…}} or legacy {msg:{type:…}}
      if (ev.thread_id) foreignSession = ev.thread_id; if (ev.session_id) foreignSession = ev.session_id;
      const t = msg.type || ev.type || "";
      if (/agent_message/.test(t) && (msg.text || msg.message)) delta(msg.text || msg.message);
      if (/command_execution|exec_command_begin/.test(t)) {
        // codex emits item.started and item.completed for the same item id: one tool_call, one result
        const cmd = Array.isArray(msg.command) ? msg.command.join(" ") : String(msg.command || ""); const fid = msg.id || msg.call_id || cmd;
        if (!open.has(fid) && !finished.has(fid)) call(fid, "Bash", { command: cmd });
        if (msg.status === "completed" || msg.status === "failed" || (msg.aggregated_output !== undefined && !/started/.test(ev.type || ""))) { result(fid, msg.status !== "failed" && (msg.exit_code ?? 0) === 0, String(msg.aggregated_output || "") + `\n[exit ${msg.exit_code ?? 0}]`); finished.add(fid); }
      }
      if (/exec_command_end/.test(t)) result(msg.call_id, (msg.exit_code ?? 0) === 0, String(msg.stdout || "") + String(msg.stderr || ""));
      if (/file_change|patch_apply/.test(t)) { const files = (msg.changes || []).map(c => c.path).filter(Boolean); const fid = msg.id || "patch"; call(fid, "Write", { path: files.join(", ") || "(patch)" }); result(fid, msg.status !== "failed", `changed ${files.length} file(s)`); }
      // codex reports a running total of its own; it is read the same way and settled the same way
      if (/token_count/.test(t)) {
        const u = msg.info?.total_token_usage || msg.info?.last_token_usage || msg.usage || msg.info || {};
        const running = { in: (+u.input_tokens || 0) + (+u.cached_input_tokens || 0), out: +u.output_tokens || 0 };
        if (running.in || running.out) { live = running; publish(); }
      }
      if (/turn.completed|task_complete/.test(t) && msg.usage) { usage = { in: +msg.usage.input_tokens || 0, out: +msg.usage.output_tokens || 0 }; live = { ...usage }; publish(); }
    }
  }
  return { line, get text() { return text; }, get foreignSession() { return foreignSession; }, get usage() { return usage; },
    abandon(reason) {
      for (const life of open.values()) {
        const durationMs = Date.now() - life.startedAt;
        session.setCallState(life.iid, "cancelled");
        session.toolResult(life.iid, false, reason, durationMs);
        onTool?.({ phase: "end", name: life.name, input: life.input, detail: life.detail, risk: life.risk, id: life.iid, state: "cancelled", output: reason, durationMs });
      }
      open.clear();
    } };
}
function mapTool(id, name) {
  const m = { Read: "read_file", Write: "write_file", Edit: "edit_file", MultiEdit: "edit_file", Glob: "glob", Grep: "grep", LS: "list_dir", Bash: "bash", WebFetch: "bash", WebSearch: "bash" };
  return m[name] || "bash";
}
function mapInput(id, name, input = {}) {
  if (name === "Bash") return { command: String(input.command || "") };
  if (["Read", "Write", "Edit", "MultiEdit", "LS"].includes(name)) return { path: String(input.file_path || input.path || "") };
  if (name === "Glob" || name === "Grep") return { pattern: String(input.pattern || ""), ...(input.path ? { path: String(input.path) } : {}) };
  if (name === "WebFetch" || name === "WebSearch") return { command: `${name.toLowerCase()} ${input.url || input.query || ""}` };
  return { command: `${name} ${JSON.stringify(input).slice(0, 200)}` };
}

// Runs one turn on an external CLI; same return shape as runAgent.
export async function runExternal({ id, cfg, policy, session, prompt, onText, onTool, onEvent, signal, system = null, resume = null, env = process.env, allowUnsafeWorkspace = false, images = [] }) {
  const entry = listRunners(env).find(r => r.id === id);
  if (!entry) throw new Error(`unknown runner ${id}`);
  if (!entry.enabled) throw new Error(`${entry.label} was removed from hcode (hcode runner add ${id} to enable it again)`);
  if (!entry.available) throw new Error(`${entry.label} is not installed: no \`${EXTERNAL[id].bin}\` on PATH. Install it yourself, or use --runner direct`);
  if (!allowUnsafeWorkspace) assertSafeExternalWorkspace(cfg.cwd);
  const safeImages = validateRunnerImages(images);
  const unsub = onEvent ? session.onEvent(onEvent) : null;
  // A helper that is running is a helper that should be visible while it runs. The board is told which
  // thread this is; it reads the same events the thread already emits and holds nothing of its own.
  const untrack = presence.thread(session);
  const tr = makeTranslator(id, session, { onText, onTool, root: cfg.cwd });
  const promptViaStdin = cfg.runnerPromptViaStdin === true;
  const assignedPrompt = runnerPromptWithImages(prompt, safeImages);
  const args = boundedArgs(id, { mode: cfg.mode, agencyLevel: cfg.agencyLevel ?? null, policy, prompt: assignedPrompt, resume, model: cfg.runnerModel || null, effort: cfg.effort, system, promptViaStdin, images: safeImages });
  const childEnv = externalRunnerEnv(env);
  const sb = policy?.sandbox === "none" ? "none" : id;   // the foreign CLI brings its own sandbox; we record which
  session.startTurn(prompt, { mode: cfg.mode, effort: cfg.effort, runner: id, sandbox: sb, ...(cfg.agencyLevel != null ? { agencyLevel: cfg.agencyLevel } : {}), ...(safeImages.length ? { attachments: attachmentMetadata(safeImages) } : {}) });
  session.message("user", userMessageContent(prompt, safeImages));
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(entry.path, args, { cwd: cfg.cwd, env: childEnv, detached: grouped, stdio: [promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const terminate = signalName => { try { process.kill(grouped ? -child.pid : child.pid, signalName); } catch { /* already gone */ } };
    let stdinFinished = !promptViaStdin; let stdinError = null;
    if (promptViaStdin) {
      child.stdin.on("error", error => { stdinError = error.code || error.message; });
      child.stdin.end(id === "codex" && system ? `${system}\n\n# Assigned task\n${assignedPrompt}` : assignedPrompt, () => { stdinFinished = true; });
    }
    let buf = "", err = "";
    child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { tr.line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on("data", d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    let timedOut = false; let settled = false; let killTimer = null;
    const deadline = Number(cfg.timeoutMs) > 0 ? setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null) terminate("SIGKILL"); }, 2000);
      killTimer.unref?.();
    }, Number(cfg.timeoutMs)) : null;
    deadline?.unref?.();
    const onAbort = () => terminate("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { if (deadline) clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", onAbort); unsub?.(); untrack(); };
    child.once("error", e => {
      if (settled) return; settled = true; cleanup(); tr.abandon("external runner could not start");
      session.error("runner_spawn", e.message); session.endTurn("error", tr.usage, { runner: id }); reject(new Error(`${entry.label} could not start: ${e.message}`));
    });
    child.once("close", code => {
      if (settled) return; settled = true; cleanup();
      if (buf.trim()) tr.line(buf);
      const u = { in: tr.usage.in, out: tr.usage.out };
      if (tr.text) session.message("assistant", [{ type: "text", text: tr.text }]);
      if (timedOut) { tr.abandon("external runner timed out"); session.error("runner_timeout", `${entry.label} exceeded ${cfg.timeoutMs} ms`); session.endTurn("error", u, { runner: id, foreignSession: tr.foreignSession }); return reject(new Error(`${entry.label} timed out after ${cfg.timeoutMs} ms`)); }
      if (signal?.aborted) { tr.abandon("cancelled"); session.endTurn("cancelled", u, { runner: id, foreignSession: tr.foreignSession }); return resolve({ usage: { input: u.in, output: u.out }, text: tr.text, cancelled: true }); }
      if (code !== 0) { tr.abandon(`${entry.label} exited ${code}`); session.error("runner_exit", `${entry.label} exited ${code}: ${err.trim().slice(-400)}`); session.endTurn("error", u, { runner: id, foreignSession: tr.foreignSession }); return reject(new Error(`${entry.label} exited ${code}${err.trim() ? ": " + err.trim().split("\n").at(-1).slice(0, 200) : ""}`)); }
      if (promptViaStdin && (!stdinFinished || stdinError)) { tr.abandon("bound prompt transport failed"); session.error("runner_prompt_transport", `stdin delivery failed (${stdinError || "not finished"})`); session.endTurn("error", u, { runner: id, foreignSession: tr.foreignSession }); return reject(new Error(`${entry.label} bound prompt did not finish stdin delivery`)); }
      tr.abandon("no result reported by the runner");
      session.checkpoint(`${session.turn} done (${id})`);
      session.endTurn("end_turn", u, { runner: id, foreignSession: tr.foreignSession });
      resolve({ usage: { input: u.in, output: u.out }, text: tr.text, foreignSession: tr.foreignSession });
    });
  });
}

// The foreign session id to pass back on --resume: the last turn.end of that runner that recorded one.
export function lastForeignSession(session, id) {
  for (let i = session.events.length - 1; i >= 0; i--) { const e = session.events[i]; if (e.type === "turn.end" && e.runner === id && e.foreignSession) return e.foreignSession; }
  return null;
}
