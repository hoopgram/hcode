// Threads (sessions): one append-only JSONL file per conversation, event stream v2 (CONTRACTS-V027 §1).
//   line 1  header   {v:2,type:"header",id,cwd,startedAt,runner,model?,tokenBudget?}
//   line n  event    {v:2,ts,seq,turn,type,...}   type = turn.start | turn.end | item | approval | compaction | checkpoint | error
//                                                        | child.* | snapshot | rewind
// `text{delta}` is a live-only event (onEvent/onText), never appended: the assistant `message` item at the end of
// the model call is the single source of text on disk, so snapshots never carry the text twice.
// `seq` is monotonic per thread and is what replay/recovery de-duplicates on. 0.1.0 files ({ts,role,content} rows,
// no `v`) are read as message items; 0.2.0 only ever writes v2. A corrupt tail line is dropped and recorded as
// error{code:"tail_corrupt"} so a thread can never become unreadable.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Truncation keeps both ends: the head says what happened, the tail says how it ended, and the middle is counted.
// (A8 HC-10: keeping only the tail here and only the head there ate both ends of a large output.)
export function headTail(text, max, label = "characters") {
  if (text.length <= max) return { text, truncated: false, dropped: 0 };
  const half = Math.floor((max - 80) / 2);
  const dropped = text.length - half * 2;
  return { text: text.slice(0, half) + `\n… [hcode: ${dropped} ${label} omitted from the middle] …\n` + text.slice(-half), truncated: true, dropped };
}

export const SIDE_EFFECT_RISKS = new Set(["write", "destructive", "money", "identity", "network", "external"]);
export const hasSideEffect = risk => (risk || []).some(r => SIDE_EFFECT_RISKS.has(r));

export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
export const idemKey = (tool, input, turn) => "sha256:" + crypto.createHash("sha256").update(tool + canonical(input || {}) + turn).digest("hex");
export const newItemId = () => "i-" + crypto.randomBytes(3).toString("hex");
const CHILD_ID_RE = /^c-[0-9a-f]{4,12}$/;
const CHILD_MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
const CHILD_SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
const CHILD_STATUS = new Set(["done", "failed", "cancelled"]);
const CHILD_OUTCOME = new Set(["applied", "conflict", "skipped"]);

// CONTRACTS-V028 §6: these are deliberately events, not a general subprocess API.
// The coordinator owns execution and capability checks; this layer only makes the
// append-only record impossible to shape incorrectly.
export function childId() { return "c-" + crypto.randomBytes(4).toString("hex"); }
export function validChildId(id) { return CHILD_ID_RE.test(String(id || "")); }

export class Session {
  // new Session(dir) creates; new Session(dir, id) reopens (v1 or v2).
  constructor(dir, id = null, meta = {}) {
    this.dir = dir; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.id = id || new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
    this.file = path.join(dir, this.id + ".jsonl");
    this.events = []; this.seq = 0; this.turnNo = 0; this.turn = null;
    this.calls = new Map();      // itemId → tool_call item (latest state)
    this.results = new Map();    // callId → tool_result item
    this.byIdem = new Map();     // idem → callId
    this.compaction = null;      // last compaction event
    this.objective = null;       // durable mission, independent of compacted chat messages
    this.listeners = [];
    if (id) this.load();
    else {
      this.header = { v: 2, type: "header", id: this.id, cwd: meta.cwd || process.cwd(), startedAt: Date.now(), runner: meta.runner || "hcode",
        ...(meta.model ? { model: meta.model } : {}), ...(meta.effort ? { effort: meta.effort } : {}), ...(meta.tokenBudget ? { tokenBudget: meta.tokenBudget } : {}),
        ...(meta.forkedFrom ? { forkedFrom: meta.forkedFrom, forkedAt: meta.forkedAt } : {}) };
      fs.writeFileSync(this.file, JSON.stringify(this.header) + "\n", { mode: 0o600 });
    }
    this.rebuild();
  }

  onEvent(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }

  // ---- reading -------------------------------------------------------------------------------------
  load() {
    const raw = fs.readFileSync(this.file, "utf8");
    if (raw.length && !raw.endsWith("\n")) fs.appendFileSync(this.file, "\n");   // a killed writer left half a line: seal it
    const lines = raw.split("\n"); if (lines[lines.length - 1] === "") lines.pop();
    const seen = new Set(); let corrupt = 0; let legacy = 0;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let row; try { row = JSON.parse(line); } catch { corrupt++; return; }
      if (row.type === "header" && row.v === 2) { this.header = row; return; }
      if (row.header) { this.header = { v: 2, type: "header", id: row.id, cwd: row.cwd, startedAt: Date.parse(row.startedAt) || 0, runner: "hcode", legacy: true }; return; }
      if (row.v !== 2) {                                  // 0.1.0 row: {ts, role, content}
        if (!row.role) return;
        legacy++; this.seq++;
        this.events.push({ v: 2, ts: row.ts || 0, seq: this.seq, turn: "t-00", type: "item", item: { id: "i-v1" + String(legacy).padStart(4, "0"), kind: "message", role: row.role, content: row.content } });
        return;
      }
      if (typeof row.seq !== "number" || seen.has(row.seq)) return;   // duplicate replay → ignore
      seen.add(row.seq); this.seq = Math.max(this.seq, row.seq);
      this.events.push(row);
      if (row.type === "turn.start") this.turnNo = Math.max(this.turnNo, Number(String(row.turn).slice(2)) || 0);
    });
    if (!this.header) this.header = { v: 2, type: "header", id: this.id, cwd: process.cwd(), startedAt: 0, runner: "hcode" };
    if (corrupt) this.emit("error", { code: "tail_corrupt", message: `${corrupt} unreadable line(s) dropped` });
  }

  // Rebuilds the model-facing message list and the tool-call index from the event log.
  rebuild() {
    this.calls.clear(); this.results.clear(); this.byIdem.clear(); this.compaction = null; this.objective = null;
    for (const ev of this.events) {
      if (ev.type === "compaction") this.compaction = ev;
      if (ev.type === "objective.started") this.objective = ev.objective;
      if (ev.type !== "item") continue;
      const it = ev.item;
      if (it.kind === "tool_call") this.indexCall(it);
      else if (it.kind === "tool_result") this.results.set(it.callId, it);
    }
    const from = this.compaction ? this.compaction.droppedSeq[1] : 0;
    const messages = [];
    if (this.compaction) messages.push({ role: "user", content: "[context compacted — summary of earlier work]\n" + this.compaction.summary });
    let pendingResults = [];
    const flush = () => { if (pendingResults.length) { messages.push({ role: "user", content: pendingResults }); pendingResults = []; } };
    for (const ev of this.events) {
      if (ev.type !== "item" || ev.seq <= from) continue;
      const it = ev.item;
      if (it.kind === "message") { flush(); messages.push({ role: it.role, content: it.content }); }
      else if (it.kind === "tool_result") pendingResults.push({ type: "tool_result", tool_use_id: it.callId, content: it.output, is_error: it.ok ? undefined : true });
    }
    flush();
    // a transcript must not end in an assistant tool_use without its results (0.1.0 files: drop it; v2 files: recovery fills them)
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && Array.isArray(last.content) && last.content.some(b => b.type === "tool_use")) {
      const ids = last.content.filter(b => b.type === "tool_use").map(b => b.id);
      if (ids.every(id => this.calls.has(id))) this.dangling = ids; else messages.pop();
    } else this.dangling = null;
    this.messages = messages;
  }

  // first call with a given idem owns it: a later identical call replays that result instead of running
  indexCall(it) { this.calls.set(it.id, { ...this.calls.get(it.id), ...it }); if (it.idem && !this.byIdem.has(it.idem)) this.byIdem.set(it.idem, it.id); }

  // ---- writing -------------------------------------------------------------------------------------
  emit(type, fields = {}) {
    const ev = { v: 2, ts: Date.now(), seq: ++this.seq, turn: this.turn || "t-00", type, ...fields };
    fs.appendFileSync(this.file, JSON.stringify(ev) + "\n");
    this.events.push(ev);
    if (type === "item") {
      const it = ev.item;
      if (it.kind === "tool_call") this.indexCall(it);
      else if (it.kind === "tool_result") this.results.set(it.callId, it);
    }
    if (type === "compaction") this.compaction = ev;
    for (const fn of this.listeners) { try { fn(ev); } catch { /* a renderer must never break the thread */ } }
    return ev;
  }
  flushAndVerify(seq = this.seq) {
    const fd = fs.openSync(this.file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const last = fs.readFileSync(this.file, "utf8").trimEnd().split("\n").at(-1);
    let row; try { row = JSON.parse(last); } catch { throw new Error("session flush reread failed: invalid JSON tail"); }
    if (row.seq !== seq) throw new Error(`session flush reread failed: expected seq ${seq}, got ${row.seq}`);
    return row;
  }
  // live-only event: handed to listeners, not written, no seq (renderers show it; the item that follows is the record)
  live(type, fields = {}) {
    const ev = { v: 2, ts: Date.now(), turn: this.turn || "t-00", type, live: true, ...fields };
    for (const fn of this.listeners) { try { fn(ev); } catch { /* renderer errors never break the thread */ } }
    return ev;
  }
  startTurn(prompt, extra = {}) { this.turnNo++; this.turn = "t-" + String(this.turnNo).padStart(2, "0"); return this.emit("turn.start", { prompt, ...extra }); }
  // The agency grant (level, unattended, level-9 budget) stamped on turn.start — and moved by
  // /permission's agency.level.changed — outlives any single process. A supervisor's --resume
  // re-reads it so a mission started at --agency 8 never silently falls back to ask-per-action
  // with no human present (2026-08-28, 张良 layer one).
  agencyGrant() {
    let grant = null;
    for (const ev of this.events) {
      if (ev.type === "turn.start" && ev.agencyLevel !== undefined && ev.agencyLevel !== null)
        grant = { agencyLevel: ev.agencyLevel, unattended: Boolean(ev.unattended), agencyBudgetUsd: ev.agencyBudgetUsd ?? null };
      else if (ev.type === "agency.level.changed")
        grant = { agencyLevel: ev.level, unattended: grant?.unattended ?? false, agencyBudgetUsd: ev.budgetUsd ?? null };
    }
    return grant;
  }
  endTurn(reason, usage = { in: 0, out: 0 }, extra = {}) { const ev = this.emit("turn.end", { reason, usage, ...extra }); return ev; }
  item(kind, fields) { return this.emit("item", { item: { id: fields.id || newItemId(), kind, ...fields } }); }
  message(role, content) { this.messages.push({ role, content }); return this.item("message", { role, content }); }
  // 0.1.0 API kept for the mind runner / old callers: append({role, content}).
  append(msg) { return this.message(msg.role, msg.content); }
  toolCall(tool, input, risk, state = "pending", id = null) { return this.item("tool_call", { id: id || newItemId(), tool, input, idem: idemKey(tool, input, this.turn || "t-00"), risk, state }).item; }
  // state updates are partial items (id + state); readers merge by id, so the input is logged once
  setCallState(id, state) { const c = this.calls.get(id); if (!c) return null; this.item("tool_call", { id, tool: c.tool, state }); return this.calls.get(id); }
  toolResult(callId, ok, output, durationMs = 0, meta = {}) {
    output = String(output ?? ""); const bytes = Buffer.byteLength(output);
    const cut = headTail(output, 60000);
    const code = cut.truncated ? "output_truncated" : meta.code || (ok ? "ok" : "tool_error");
    return this.item("tool_result", { v: 1, callId, ok, code, retryable: Boolean(meta.retryable), output: cut.text, bytes, truncated: cut.truncated, durationMs }).item;
  }
  approval(itemId, decision, by = "owner") { return this.emit("approval", { itemId, decision, by, at: Date.now() }); }
  // `model` and `session` are what 0.7 added: no helper runs on an unnamed brain, and the thread it
  // wrote is addressable, so /attach can open a finished subagent instead of only reading its summary.
  childSpawn({ childId: id = childId(), runner, task, cwd, parent = "root", policy, model = "", session = "" }) {
    if (!validChildId(id) || (parent !== "root" && !validChildId(parent))) throw new Error("invalid child id");
    if (typeof runner !== "string" || !runner || typeof cwd !== "string" || !cwd || typeof task !== "string" || !task.trim() || task.length > 4000) throw new Error("invalid child spawn");
    if (model && !CHILD_MODEL_RE.test(model)) throw new Error("invalid child model");
    if (session && !CHILD_SESSION_RE.test(session)) throw new Error("invalid child session");
    return this.emit("child.spawn", { childId: id, runner, task: task.trim(), cwd, parent, ...(model ? { model } : {}), ...(session ? { session } : {}),
      policy: { mode: policy?.mode || "ask", sandbox: policy?.sandbox || "bwrap" } });
  }
  childReport({ childId: id, status, summary = "", usage = { in: 0, out: 0 } }) {
    if (!validChildId(id) || !CHILD_STATUS.has(status) || typeof summary !== "string" || summary.length > 4000) throw new Error("invalid child report");
    const input = Number(usage?.in || 0), output = Number(usage?.out || 0);
    if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) throw new Error("invalid child usage");
    return this.emit("child.report", { childId: id, status, summary, usage: { in: input, out: output } });
  }
  childMerge({ childId: id, outcome, files = [], commit = "" }) {
    if (!validChildId(id) || !CHILD_OUTCOME.has(outcome) || !Array.isArray(files) || files.length > 200 || !files.every(f => typeof f === "string" && f && !path.isAbsolute(f) && !f.split("/").includes("..")) || typeof commit !== "string") throw new Error("invalid child merge");
    return this.emit("child.merge", { childId: id, outcome, files, commit: commit || undefined });
  }
  checkpoint(label) { return this.emit("checkpoint", { label, lastSeq: this.seq }); }
  error(code, message, extra = {}) { return this.emit("error", { code, message: String(message).slice(0, 2000), ...extra }); }
  replay(idem) { const id = this.byIdem.get(idem); const r = id ? this.results.get(id) : null; return r && r.ok ? r : null; }

  // ---- recovery (CONTRACTS-V027 §1.2, last paragraph) ------------------------------------------------
  // Tool calls that were running/pending/approved when the process died: side-effect tools are never re-run
  // (state → cancelled, result ok:false); read-only ones are returned for the agent to run again.
  recover() {
    const rerun = [], cancelled = [];
    for (const c of this.calls.values()) {
      if (this.results.has(c.id) || ["done", "failed", "cancelled", "denied"].includes(c.state)) continue;
      if (hasSideEffect(c.risk)) {
        this.setCallState(c.id, "cancelled");
        this.toolResult(c.id, false, `interrupted: hcode stopped while ${c.tool} was ${c.state}; it was NOT re-run (side effects) — check the file/command state before retrying`);
        cancelled.push(c);
      } else rerun.push(c);
    }
    if (cancelled.length) this.error("recovered", `${cancelled.length} interrupted side-effect call(s) cancelled, not re-run`);
    return { rerun, cancelled };
  }
  // ---- rewind (0.7 E) ---------------------------------------------------------------------------
  // A thread is append-only, so going back is a fork, never a truncation: every event up to `seq` is
  // copied into a new thread — through the same reader `--resume` uses, so nothing about the copy is
  // special — and this file is left exactly as it was. A call that was still open at the cut is
  // sealed as cancelled with a result saying so, because a transcript may never end on an
  // unanswered tool_use, and hcode never re-runs a side effect it did not see finish.
  forkAt(seq, { dir = this.dir, meta = {} } = {}) {
    const at = Number(seq);
    if (!Number.isInteger(at) || at < 0) throw new Error("forkAt needs a whole seq");
    if (at >= this.seq) throw new Error(`nothing to fork: seq ${at} is not earlier than this thread's ${this.seq}`);
    const kept = this.events.filter(ev => ev.seq <= at);
    const child = new Session(dir, null, { cwd: this.header.cwd, runner: this.header.runner, model: this.header.model,
      effort: this.header.effort, tokenBudget: this.header.tokenBudget, ...meta, forkedFrom: this.id, forkedAt: at });
    if (kept.length) fs.appendFileSync(child.file, kept.map(ev => JSON.stringify(ev)).join("\n") + "\n");
    const forked = new Session(dir, child.id);
    forked.turn = kept.at(-1)?.turn || null;      // the seal belongs to the turn that was cut, not to t-00
    for (const c of forked.calls.values()) {
      if (forked.results.has(c.id) || ["done", "failed", "cancelled", "denied"].includes(c.state)) continue;
      forked.setCallState(c.id, "cancelled");
      forked.toolResult(c.id, false, `rewound: this ${c.tool} call was still open when the thread was rewound to seq ${at}; it was NOT re-run`);
    }
    forked.rebuild();
    return forked;
  }

  cancelRunning() {
    for (const c of this.calls.values()) {
      if (this.results.has(c.id) || !["running", "pending", "approved"].includes(c.state)) continue;
      this.setCallState(c.id, "cancelled"); this.toolResult(c.id, false, "cancelled");
    }
  }

  // ---- listing --------------------------------------------------------------------------------------
  static latest(dir) { const l = Session.list(dir, 1); return l.length ? l[0].id : null; }
  static list(dir, n = 10) {
    let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort().slice(-n).reverse(); } catch { return []; }
    return files.map(f => {
      const id = f.replace(/\.jsonl$/, ""); const info = { id, startedAt: 0, cwd: "", prompt: "", turns: 0, v: 2 };
      try {
        const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).slice(0, 200);
        for (const line of lines) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (row.type === "header") { info.startedAt = row.startedAt; info.cwd = row.cwd; info.runner = row.runner; }
          else if (row.header) { info.v = 1; info.startedAt = Date.parse(row.startedAt) || 0; info.cwd = row.cwd; }
          else if (row.type === "turn.start") { info.turns++; if (!info.prompt) info.prompt = String(row.prompt).slice(0, 80); }
          else if (row.role === "user" && typeof row.content === "string") { info.turns++; if (!info.prompt) info.prompt = row.content.slice(0, 80); }
        }
      } catch { /* unreadable: still listed by id */ }
      return info;
    });
  }
}
