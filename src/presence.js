// Presence (0.9.2): a subagent is something that is *there*, not a line that scrolled away.
//
// Four rules hold this file together, and every one of them is a refusal to build something new:
//   1. the record already exists. `child.spawn` / `child.report` on the owner's thread is the
//      append-only ledger of every helper this session started, and the helper's own v2 thread is its
//      full conversation. Presence opens no second store and writes no file of its own — it is a
//      projection over what hcode already appends, which is why a helper that finished an hour ago
//      reads back exactly like one that finished a second ago, and why a process that dies mid-run
//      cannot corrupt anything presence owns: it owns nothing;
//   2. the numbers come from the stream, never from a second meter. A row's tokens are the ones its
//      runner reported and its ledger filed. Presence adds them up and never re-derives them, so the
//      number under the input box and the number in `hcode cost` can never disagree;
//   3. a row that is working has to look alive. Elapsed time moves on its own tick — unref'd, so it
//      never holds the process open one moment past the work — and starts only while something is
//      actually working. Nothing ticks in an idle session;
//   4. what was running when the process died is cancelled, never assumed done. A spawn replayed from
//      disk with no report is a helper nobody will ever hear from again; it is filed as cancelled, the
//      same judgement `Session.recover` makes about an interrupted tool call.
//
// Rendering is not here. This file answers list / transcript / mainTurn and says when to ask again.
import fs from "node:fs";
import path from "node:path";
import { Session, headTail } from "./session.js";

export const SUBAGENT_DIR = "subagents";
export const TICK_MS = 1000;                 // "working" must move even when no event arrives
export const TITLE_MAX = 64;
export const MAX_TOOL_OUTPUT = 4000;         // per transcript row; headTail keeps both ends
export const MAX_LIVE_THREADS = 64;          // a bound, so a long-lived worker cannot accumulate listeners

const firstLine = value => String(value ?? "").split("\n").map(line => line.trim()).find(Boolean) || "";
const base = value => { const name = String(value || "").split(/[\\/]/).filter(Boolean).pop(); return name || String(value || ""); };

// The title is the one sentence the owner would use to say what this helper is for: the first line of
// the task, cut at a word boundary so a truncation still reads as language rather than as a broken id.
export function shortTitle(task, max = TITLE_MAX) {
  const line = firstLine(task);
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

// ---- the one arithmetic ------------------------------------------------------------------------------
// tokens = in + out + cacheWrite + cacheRead, and every source reports its own fields exactly once:
// hcode's own turn reports input/output/cacheWrite/cacheRead as four separate numbers (agent.js keeps
// them apart because api.js hands them over apart), while a foreign CLI reports an `in` that has already
// folded its cache reads into it and carries no cache fields at all (runners.js). The same sum is
// therefore right for both and double-counts neither. It is deliberately the total spend of the helper,
// not "what it typed": a subagent that reads 100k tokens of context cost that whether or not it spoke.
export const totalTokens = usage =>
  Number(usage?.in || 0) + Number(usage?.out || 0) + Number(usage?.cacheWrite || 0) + Number(usage?.cacheRead || 0);

const addUsage = (into, usage) => {
  into.in = Number(usage?.in || 0); into.out = Number(usage?.out || 0);
  into.cacheWrite = Number(usage?.cacheWrite || 0); into.cacheRead = Number(usage?.cacheRead || 0);
  return into;
};
const emptyUsage = () => ({ in: 0, out: 0, cacheWrite: 0, cacheRead: 0 });

// What a helper is doing right now, in the owner's words rather than the tool's. A running call is the
// only honest source for this: text deltas say a helper is thinking, but not about what.
export function activityOf(tool, input = {}) {
  const name = String(tool || "");
  const file = base(input.path || input.file_path || "");
  if (name === "read_file") return file ? `Reading ${file}…` : "Reading…";
  if (name === "write_file") return file ? `Writing ${file}…` : "Writing…";
  if (name === "edit_file") return file ? `Editing ${file}…` : "Editing…";
  if (name === "list_dir") return file ? `Listing ${file}…` : "Listing…";
  if (name === "glob" || name === "grep") { const pattern = firstLine(input.pattern || ""); return pattern ? `Searching ${pattern.slice(0, 30)}…` : "Searching…"; }
  if (name === "bash") { const cmd = firstLine(input.command || ""); return cmd ? `Running ${cmd.slice(0, 40)}…` : "Running…"; }
  if (name === "delegate_agent") return "Delegating…";
  return name ? `${name}…` : "";
}

// ---- the transcript ----------------------------------------------------------------------------------
// A subagent thread is an ordinary v2 thread, so its conversation is read back the way the owner's is.
// Four roles, because four is what a reader needs: who asked, who answered, what was touched, and what
// the machinery said about it. The owner's prompt is taken from `turn.start` and a `user` message that
// merely repeats it is dropped — the runners write both, and a transcript that says everything twice is
// harder to read than one that says it once.
export function projectTranscript(events = []) {
  const rows = []; const seenCalls = new Set(); let lastOwner = null;
  const owner = text => { const t = String(text || "").trim(); if (!t || t === lastOwner) return; lastOwner = t; rows.push({ role: "owner", text: t }); };
  for (const event of events) {
    if (event.type === "turn.start") { owner(event.prompt); continue; }
    if (event.type === "error") { rows.push({ role: "meta", text: `${event.code}: ${firstLine(event.message)}` }); continue; }
    if (event.type === "turn.end") {
      const tokens = totalTokens(event.usage);
      rows.push({ role: "meta", text: `turn ended (${event.reason})${tokens ? ` · ${tokens} tokens` : ""}` });
      continue;
    }
    if (event.type !== "item") continue;
    const item = event.item;
    if (item.kind === "message") {
      const text = Array.isArray(item.content)
        ? item.content.filter(block => block.type === "text").map(block => block.text).join("")
        : String(item.content ?? "");
      if (!text.trim()) continue;
      if (item.role === "assistant") rows.push({ role: "agent", text: text.trim() });
      else owner(text);
    } else if (item.kind === "tool_call") {
      if (!item.input || seenCalls.has(item.id)) continue;    // state updates are partial items; the input is logged once
      seenCalls.add(item.id);
      rows.push({ role: "tool", text: `${item.tool} ${firstLine(JSON.stringify(item.input)).slice(0, 200)}` });
    } else if (item.kind === "tool_result") {
      const out = headTail(String(item.output ?? ""), MAX_TOOL_OUTPUT).text.trim();
      rows.push({ role: "tool", text: `${item.ok ? "→" : "✗"}${out ? " " + out : item.ok ? " ok" : " failed"}` });
    }
  }
  return rows;
}

// ---- the board ---------------------------------------------------------------------------------------
export class Presence {
  constructor({ now = () => Date.now(), tickMs = TICK_MS, subagentDir = SUBAGENT_DIR } = {}) {
    this.now = now; this.tickMs = Math.max(0, Number(tickMs) || 0); this.subagentDir = subagentDir;
    this.rows = new Map();          // childId → row (insertion order is spawn order, which is what list() promises)
    this.byThread = new Map();      // thread id → childId
    this.threads = new Map();       // thread id → { session, unsub }
    this.main = null;               // { session, unsub }
    this.turn = { active: false, startedAt: 0, endedAt: 0, usage: emptyUsage() };
    this.listeners = [];
    this.timer = null;
  }

  // ---- wiring ------------------------------------------------------------------------------------
  // The owner's thread: its child ledger is the list, its turns are `mainTurn`. Everything already on
  // disk is replayed first (so `--resume` shows yesterday's helpers), then the same reducer runs live.
  // Idempotent by thread id: observing twice is what a caller does when it cannot be sure.
  observe(session) {
    if (!session || this.main?.session === session) return () => {};
    this.detachMain();
    this.main = { session, unsub: null };
    for (const event of session.events || []) this.applyOwnerEvent(event, { replaying: true });
    // A helper the ledger never heard back from is not still working — the process that was running it
    // is gone. Same judgement session.recover() makes: interrupted is cancelled, never done.
    for (const row of this.rows.values()) if (row.state === "working") { row.state = "cancelled"; row.endedAt = row.endedAt || row.lastAt || row.startedAt; }
    this.applyTurnFromHistory(session);
    // Only a change presence can show is worth waking the renderer for: a thread emits a text delta every
    // few hundred characters, and none of them move a row, a state or a number on this board.
    this.main.unsub = session.onEvent(event => { if (this.applyOwnerEvent(event, { replaying: false })) this.changed(); });
    this.changed();
    return () => this.detachMain();
  }

  detachMain() { this.main?.unsub?.(); this.main = null; }

  // A helper's own live thread. Called by whoever is actually running it (runners.js) — presence never
  // reaches into a process to find work, it is told. Detaches itself when the turn ends: after that the
  // file on disk says everything the object in memory did, and a listener kept past its use is a leak.
  thread(session) {
    const id = session?.id;
    if (!id || this.threads.has(id) || this.main?.session?.id === id) return () => {};
    const entry = { session, unsub: null };
    entry.unsub = session.onEvent(event => {
      const moved = this.applyThreadEvent(id, event);
      if (event.type === "turn.end") this.dropThread(id);
      if (moved) this.changed();
    });
    this.threads.set(id, entry);
    while (this.threads.size > MAX_LIVE_THREADS) this.dropThread(this.threads.keys().next().value);
    return () => this.dropThread(id);
  }

  dropThread(id) { const entry = this.threads.get(id); if (!entry) return; entry.unsub?.(); this.threads.delete(id); }

  // Drops every listener and stops the tick. A session that is over should cost nothing.
  close() { this.detachMain(); for (const id of [...this.threads.keys()]) this.dropThread(id); this.stopTimer(); this.listeners = []; }

  // ---- reducers ----------------------------------------------------------------------------------
  // → true when something this board shows has moved. Everything else is somebody else's event.
  applyOwnerEvent(event, { replaying = false } = {}) {
    if (!event || typeof event !== "object") return false;
    if (event.type === "child.spawn") {
      if (this.rows.has(event.childId)) return false;
      const row = {
        id: event.childId, kind: String(event.runner || "?"), model: String(event.model || ""),
        title: shortTitle(event.task), task: String(event.task || ""),
        state: "working", startedAt: Number(event.ts) || this.now(), endedAt: 0, lastAt: Number(event.ts) || 0,
        usage: emptyUsage(), activity: "", summary: "", outcome: "", files: [],
        thread: String(event.session || ""), dir: "",
      };
      this.rows.set(row.id, row);
      if (row.thread) {
        this.byThread.set(row.thread, row.id);
        const live = this.threads.get(row.thread);          // registered before the ledger named it
        if (live && !replaying) row.dir = live.session.dir;
      }
      return true;
    }
    if (event.type === "child.report") {
      const row = this.rows.get(event.childId); if (!row) return false;
      row.state = ["done", "failed", "cancelled"].includes(event.status) ? event.status : "failed";
      row.summary = String(event.summary || ""); row.endedAt = Number(event.ts) || this.now(); row.activity = "";
      // The ledger's number is the settled one: a live estimate may have been behind it, never a
      // different basis, so the filed figure simply replaces it.
      if (event.usage) addUsage(row.usage, event.usage);
      return true;
    }
    if (event.type === "child.merge") {
      const row = this.rows.get(event.childId); if (!row) return false;
      row.outcome = String(event.outcome || ""); row.files = Array.isArray(event.files) ? [...event.files] : [];
      return true;
    }
    if (event.type === "turn.start") { this.turn = { active: true, startedAt: Number(event.ts) || this.now(), endedAt: 0, usage: emptyUsage() }; return true; }
    if (event.type === "turn.end") { this.turn.active = false; this.turn.endedAt = Number(event.ts) || this.now(); addUsage(this.turn.usage, event.usage); return true; }
    if (event.type === "usage" && event.live) { addUsage(this.turn.usage, event); return true; }
    return false;
  }

  // Replayed history must not claim a turn is still running: only a turn.start with no turn.end after it
  // in the same file was interrupted, and an interrupted turn is over — the process that owned it is gone.
  applyTurnFromHistory(session) {
    let start = null; let end = null;
    for (const event of session.events || []) {
      if (event.type === "turn.start") { start = event; end = null; }
      else if (event.type === "turn.end") end = event;
    }
    this.turn = { active: false, startedAt: Number(start?.ts) || 0, endedAt: Number(end?.ts) || Number(start?.ts) || 0, usage: emptyUsage() };
    if (end?.usage) addUsage(this.turn.usage, end.usage);
  }

  applyThreadEvent(threadId, event) {
    const row = this.rows.get(this.byThread.get(threadId) || "");
    if (!row || !event) return false;
    row.lastAt = Number(event.ts) || this.now();
    if (!row.dir) { const live = this.threads.get(threadId); if (live) row.dir = live.session.dir; }
    // A live usage event is cumulative for the run, so it is assigned rather than added: the runner is
    // the meter and presence never keeps a second count that could drift from it.
    if (event.type === "usage" && event.live) { addUsage(row.usage, event); return true; }
    if (event.type === "item" && event.item?.kind === "tool_call" && event.item.input) { row.activity = activityOf(event.item.tool, event.item.input); return true; }
    if (event.type === "turn.end") { if (event.usage) addUsage(row.usage, event.usage); row.activity = ""; return true; }
    return false;
  }

  // ---- the contract ------------------------------------------------------------------------------
  // Spawn order, always: the list under the input box must not reshuffle itself while it is read.
  list() {
    const now = this.now();
    return [...this.rows.values()].map(row => Object.freeze({
      id: row.id, kind: row.kind, model: row.model, title: row.title, state: row.state,
      startedAt: row.startedAt,
      elapsedMs: Math.max(0, (row.state === "working" ? now : (row.endedAt || row.lastAt || now)) - row.startedAt),
      tokens: totalTokens(row.usage),
      // beyond the agreed contract, because the row has to be renderable: what it is doing, what it
      // said, and where its conversation lives.
      activity: row.activity, summary: row.summary, outcome: row.outcome, thread: row.thread,
    }));
  }

  get mainTurn() {
    const now = this.now();
    return Object.freeze({
      active: this.turn.active,
      startedAt: this.turn.startedAt,
      elapsedMs: this.turn.startedAt ? Math.max(0, (this.turn.active ? now : (this.turn.endedAt || now)) - this.turn.startedAt) : 0,
      tokens: totalTokens(this.turn.usage),
    });
  }

  // Every change reaches one subscription: a state, a number, or the second that passed while a helper
  // kept working. The tick exists because elapsed time is a change nobody emits an event for.
  subscribe(fn) {
    if (typeof fn !== "function") throw new Error("presence.subscribe needs a function");
    this.listeners.push(fn);
    this.ensureTimer();
    return () => { this.listeners = this.listeners.filter(item => item !== fn); if (!this.listeners.length) this.stopTimer(); };
  }

  changed() {
    this.ensureTimer();
    for (const fn of this.listeners) { try { fn(); } catch { /* a renderer must never break the board */ } }
  }

  working() { return this.turn.active || [...this.rows.values()].some(row => row.state === "working"); }

  ensureTimer() {
    if (this.timer || !this.listeners.length || !this.tickMs || !this.working()) return;
    this.timer = setInterval(() => {
      if (!this.working() || !this.listeners.length) { this.stopTimer(); return; }
      for (const fn of this.listeners) { try { fn(); } catch { /* same */ } }
    }, this.tickMs);
    this.timer.unref?.();      // presence is never a reason for the process to stay alive
  }

  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // The whole conversation, in order, still readable after the helper is gone — because it was never
  // held in memory in the first place. A running helper is read from the thread object it is writing;
  // a finished one from the same file on disk, through the same reader `--resume` uses.
  transcript(id) {
    const key = String(id || "");
    const row = this.rows.get(key) || this.rows.get(this.byThread.get(key) || "");
    const threadId = row?.thread || key;
    const live = this.threads.get(threadId);
    if (live) return projectTranscript(live.session.events);
    const missing = text => (row ? [{ role: "meta", text }] : []);   // an id nobody ever spawned is not a story
    const dir = row?.dir || this.threadDir(threadId);
    if (!dir) return missing("no thread was recorded for this subagent");
    if (!fs.existsSync(path.join(dir, threadId + ".jsonl"))) return missing(`its thread ${threadId} is no longer on disk`);
    try { return projectTranscript(new Session(dir, threadId).events); }
    catch (error) { return [{ role: "meta", text: `its thread ${threadId} could not be read: ${error.message}` }]; }
  }

  // Where a finished helper's thread lives: beside the owner's own, under subagents/.
  threadDir(threadId) {
    if (!this.main?.session?.dir || !/^[A-Za-z0-9-]{1,64}$/.test(threadId)) return "";
    return path.join(this.main.session.dir, this.subagentDir);
  }
}

// The process-wide board. One session, one board: runners.js hands it every helper thread it starts, and
// whoever owns the screen calls observe() with the owner's thread and subscribe() to be told.
export const presence = new Presence();

// ---- keeping the helper threads from growing forever -------------------------------------------------
// Same philosophy as the snapshot store (rewind.js), for the same reason: a helper's thread is alive
// exactly as long as some surviving owner thread's `child.spawn` still names it. Reading the files IS the
// reference count — a count kept in a side file is a count that disagrees with reality after the first
// crash, and this store's failure mode has to be "keeps too much", never "deleted the conversation the
// owner was about to open". `retire` names owner threads whose claim is being given up (an archived or
// deleted thread), exactly as reclaimSnapshots means it; the TTL is only the backstop for helper threads
// whose owner file was removed without anyone telling us, and no thread inside the grace window is ever
// touched, because a spawn writes its thread a moment before the ledger line that names it.
export const THREAD_TTL_MS = 0;           // off by default: reference decides, age is only a caller's backstop
export const THREAD_GRACE_MS = 60_000;
const THREAD_NAMED_IN_LINE = /"type":"child\.spawn"[^\n]*?"session":"([A-Za-z0-9-]{1,64})"/g;

export function threadsNamedBy(file) {
  const named = new Set();
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return named; }
  for (const match of text.matchAll(THREAD_NAMED_IN_LINE)) named.add(match[1]);
  return named;
}

export function referencedThreads(dir, { retire = [] } = {}) {
  const dropped = new Set(retire.map(String));
  const live = new Set();
  let names; try { names = fs.readdirSync(dir); } catch { return live; }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    if (dropped.has(name.replace(/\.jsonl$/, ""))) continue;
    for (const id of threadsNamedBy(path.join(dir, name))) live.add(id);
  }
  return live;
}

// → {removed, freed, kept}, the same shape reclaimSnapshots returns, so one caller can report both.
export function reclaimSubagentThreads({ dir, retire = [], now = Date.now(), graceMs = THREAD_GRACE_MS, ttlMs = THREAD_TTL_MS, subagentDir = SUBAGENT_DIR } = {}) {
  const root = path.join(dir, subagentDir);
  const live = referencedThreads(dir, { retire });
  let names; try { names = fs.readdirSync(root); } catch { return { removed: 0, freed: 0, kept: 0 }; }
  let removed = 0; let freed = 0; let kept = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.replace(/\.jsonl$/, "");
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      // Written moments ago: a spawn writes the helper's thread just before the ledger line that names
      // it, so a young file is presumed spoken for. (mtimeMs carries sub-millisecond precision a
      // truncated `now` does not, which is why the window is compared rather than the sign of it.)
      if (now - stat.mtimeMs < graceMs) { kept++; continue; }
      // Reference first, age second. A thread no surviving owner names is garbage whatever its date; a
      // thread still named by an owner the owner can resume is not, however old — unless the caller
      // explicitly asked for the age backstop, which trades one unopenable old conversation for a
      // directory that stops growing. That trade is never made by default.
      const stale = ttlMs > 0 && now - stat.mtimeMs >= ttlMs;
      if (live.has(id) && !stale) { kept++; continue; }
      fs.rmSync(file, { force: true });
      removed++; freed += stat.size;
    } catch { /* already gone */ }
  }
  return { removed, freed, kept };
}
