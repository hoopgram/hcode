// Rewind (esc esc): going back is never an erasure.
// The thread is append-only and the working tree is not, so a rewind needs three things that
// nothing else in hcode provided:
//   1. a snapshot of every file a mutating call is about to change, taken *before* it runs and
//      stored content-addressed beside the sessions (bounded: a per-file cap and a store cap,
//      both recorded in the thread when they bite, so a restore point can say what it is missing);
//   2. `Session.forkAt(seq)` (session.js) — a new thread that carries this one's events up to a
//      chosen seq and seals whatever call was still open at the cut; the original file is untouched;
//   3. this file's restore: the files hcode itself changed after that seq go back to the snapshot
//      taken there — and only those. A file that has moved since hcode last wrote it was changed by
//      someone else, and hcode says so instead of silently overwriting the owner's own work.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { judgePath, writeAtomic } from "./tools.js";
import { selectOption } from "./select.js";

export const SNAPSHOT_DIR = "snapshots";
// Only the tools whose target file is knowable before they run. `bash` can change anything, so it
// is deliberately not snapshotted: a rewind that claimed to undo a command it never recorded would
// be worse than one that says which points it can restore.
export const SNAPSHOT_TOOLS = new Set(["write_file", "edit_file"]);
export const MAX_SNAPSHOT_BYTES = 2_000_000;      // one file; bigger is recorded as skipped, never half-kept
export const MAX_STORE_BYTES = 64_000_000;        // the whole blob store for this sessions directory
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // the backstop: age, once reference has had its turn
export const MAX_ANCHORS = 30;

const digest = buffer => "sha256:" + crypto.createHash("sha256").update(buffer).digest("hex");
const oneLine = value => String(value ?? "").replace(/\s+/g, " ").trim();
const since = (ts, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Number(ts || 0)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

// A content-addressed blob store shared by every thread in one sessions directory. Sharing is what
// makes a fork work: the forked thread inherits its parent's snapshot events, and the blobs they
// name have to still be readable from the new thread's own id.
export class SnapshotStore {
  constructor(dir, { maxFileBytes = MAX_SNAPSHOT_BYTES, maxStoreBytes = MAX_STORE_BYTES, ttlMs = SNAPSHOT_TTL_MS } = {}) {
    this.root = path.join(dir, SNAPSHOT_DIR);
    this.maxFileBytes = Math.max(0, Number(maxFileBytes) || 0);
    this.maxStoreBytes = Math.max(0, Number(maxStoreBytes) || 0);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.used = null;
  }

  blob(hash) { return path.join(this.root, String(hash).replace(/^sha256:/, "") + ".blob"); }
  has(hash) { return fs.existsSync(this.blob(hash)); }
  read(hash) { return fs.readFileSync(this.blob(hash)); }

  bytes() {
    if (this.used !== null) return this.used;
    let total = 0;
    for (const name of this.list()) { try { total += fs.statSync(path.join(this.root, name)).size; } catch { /* raced with a sweep */ } }
    this.used = total;
    return total;
  }

  list() { try { return fs.readdirSync(this.root).filter(name => name.endsWith(".blob")); } catch { return []; } }

  // The backstop, for a store whose sessions were deleted without anyone running a reclaim: oldest
  // blobs past the TTL go when the store is full, referenced or not. A pruned blob makes exactly one
  // old restore point incomplete (its record says the file could not be put back), which is a better
  // failure than a store that can never take another snapshot.
  prune(now = Date.now()) {
    let freed = 0;
    for (const name of this.list()) {
      const file = path.join(this.root, name);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs < this.ttlMs) continue;
        fs.rmSync(file, { force: true });
        freed += st.size;
      } catch { /* already gone */ }
    }
    if (freed) this.used = Math.max(0, this.bytes() - freed);
    return freed;
  }

  // → { hash, stored } when the bytes are in the store, { hash, full: true } when they are not.
  put(buffer) {
    const hash = digest(buffer);
    if (this.has(hash)) return { hash, stored: 0 };
    if (this.bytes() + buffer.length > this.maxStoreBytes) {
      // Reference first, age second. A blob no surviving thread names is garbage whatever its date;
      // a blob still named by a thread the owner can resume is not, however old. The TTL below stays
      // as the backstop for a store whose sessions were removed without anyone telling us.
      reclaimSnapshots({ store: this });
      if (this.bytes() + buffer.length > this.maxStoreBytes) this.prune();
      if (this.bytes() + buffer.length > this.maxStoreBytes) return { hash, full: true };
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.blob(hash); const tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, buffer, { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (error) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing half-written survives */ } throw error; }
    this.used = this.bytes() + buffer.length;
    return { hash, stored: buffer.length };
  }
}

// ---- reclaiming the store ------------------------------------------------------------------------
// A snapshot blob is alive exactly as long as some thread's events still name it. That is what makes
// forks safe to collect: `forkAt` copies the parent's snapshot events into the child file, so a shared
// blob is named twice and a count over the files on disk is a reference count with no bookkeeping to
// drift. Delete a thread and its private blobs become unreferenced; its shared ones do not.
//
// Reading the files is the whole algorithm on purpose. A refcount kept in a side file is a refcount that
// disagrees with reality after the first crash, and this store's failure mode has to be "keeps too much",
// never "deleted the file the owner was about to put back".
const HASH_IN_LINE = /"sha256":"(sha256:[0-9a-f]{64})"/g;
export const RECLAIM_GRACE_MS = 60_000;   // a blob younger than this may belong to a snapshot mid-write

export function blobsNamedBy(file) {
  const hashes = new Set();
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return hashes; }
  for (const match of text.matchAll(HASH_IN_LINE)) hashes.add(match[1]);
  return hashes;
}

// Every session file under a sessions directory, this thread's own subagent threads included.
export function sessionFiles(dir) {
  const out = [];
  for (const base of [dir, path.join(dir, "subagents")]) {
    let names; try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) if (name.endsWith(".jsonl")) out.push(path.join(base, name));
  }
  return out;
}

// The hashes still spoken for. `retire` names sessions whose claim is being given up — an archived or
// deleted thread — so their private blobs fall out of the set while anything a fork also names stays in.
export function referencedBlobs(dir, { retire = [] } = {}) {
  const dropped = new Set(retire.map(String));
  const live = new Set();
  for (const file of sessionFiles(dir)) {
    if (dropped.has(path.basename(file).replace(/\.jsonl$/, ""))) continue;
    for (const hash of blobsNamedBy(file)) live.add(hash);
  }
  return live;
}

// Collect every blob no surviving thread names. Returns {removed, freed, kept}.
export function reclaimSnapshots({ dir, store, retire = [], now = Date.now(), graceMs = RECLAIM_GRACE_MS } = {}) {
  const snapshots = store || new SnapshotStore(dir);
  const base = dir || path.dirname(snapshots.root);
  const live = referencedBlobs(base, { retire });
  let removed = 0; let freed = 0; let kept = 0;
  for (const name of snapshots.list()) {
    const hash = "sha256:" + name.replace(/\.blob$/, "");
    if (live.has(hash)) { kept++; continue; }
    const file = path.join(snapshots.root, name);
    try {
      const st = fs.statSync(file);
      // Still being written, or written just now by another process. `graceMs: 0` turns the window off
      // outright rather than comparing against it: mtimeMs carries sub-millisecond precision that a
      // truncated Date.now() does not, so a blob written moments ago can read as a fraction in the future.
      if (graceMs > 0 && now - st.mtimeMs < graceMs) { kept++; continue; }
      fs.rmSync(file, { force: true });
      removed++; freed += st.size;
    } catch { /* already gone */ }
  }
  if (removed) snapshots.used = null;
  return { removed, freed, kept };
}

// The lifecycle hook: run when a session ends. Bounded so leaving hcode never pays for a full scan of a
// store that is nowhere near full — below the threshold there is nothing worth reclaiming yet.
export function reclaimOnClose(dir, { threshold = 0.25, now = Date.now() } = {}) {
  const store = new SnapshotStore(dir);
  if (!store.list().length) return null;
  if (store.bytes() < store.maxStoreBytes * threshold) return null;
  return reclaimSnapshots({ dir, store, now });
}

export const formatReclaim = result => !result || !result.removed
  ? `snapshots: nothing to reclaim (${result?.kept ?? 0} blobs still referenced by a saved thread)`
  : `snapshots: reclaimed ${result.removed} blob${result.removed === 1 ? "" : "s"} (${Math.round(result.freed / 1024)} KB); ${result.kept} still referenced by a saved thread`;

// What one path looks like on disk right now: absent, unreadable, too big to hash, or a hash.
export function fileState(abs, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return { absent: true }; }
  if (!st.isFile()) return { skipped: st.isDirectory() ? "directory" : "not_a_regular_file" };
  if (st.size > maxBytes) return { skipped: "too_large", bytes: st.size };
  let buffer;
  try { buffer = fs.readFileSync(abs); } catch { return { skipped: "unreadable" }; }
  return { sha256: digest(buffer), bytes: buffer.length, mode: st.mode & 0o777, ...(buffer.includes(0) ? { binary: true } : {}), buffer };
}

const withoutBuffer = state => { const { buffer, ...rest } = state; return rest; };
const snapshotId = () => "s-" + crypto.randomBytes(3).toString("hex");

// Called with the tool about to run. Emits `snapshot{id, before}` and returns the handle the caller
// hands back to snapshotAfter(); null when this call changes no knowable file.
export function snapshotBefore({ session, store, tool, input, root, callId = "" }) {
  if (!store || !SNAPSHOT_TOOLS.has(tool)) return null;
  const wanted = String(input?.path || "");
  if (!wanted) return null;
  const judged = judgePath(root, wanted);
  if (!judged.inside || judged.secret) return null;      // outside the project or secret-shaped: never copied
  const rel = path.relative(root, judged.abs).split(path.sep).join("/");
  const state = fileState(judged.abs, { maxBytes: store.maxFileBytes });
  let before;
  if (state.absent) before = { absent: true };
  else if (state.skipped) before = { skipped: state.skipped, ...(state.bytes ? { bytes: state.bytes } : {}) };
  else {
    const put = store.put(state.buffer);
    before = put.full
      ? { skipped: "store_full", sha256: put.hash, bytes: state.bytes }
      : { sha256: put.hash, bytes: state.bytes, mode: state.mode, ...(state.binary ? { binary: true } : {}) };
  }
  const id = snapshotId();
  session.emit("snapshot", { id, callId, tool, path: rel, before });
  return { id, path: rel, abs: judged.abs };
}

// The other half of the same record: what the file became, so a later restore can tell hcode's own
// change from someone else's. Written as a partial event merged by id, like tool_call state updates.
export function snapshotAfter({ session, store, snap, maxBytes = MAX_SNAPSHOT_BYTES }) {
  if (!snap) return null;
  const state = fileState(snap.abs, { maxBytes: store?.maxFileBytes ?? maxBytes });
  const after = state.absent ? { absent: true } : state.skipped ? { skipped: state.skipped } : { sha256: state.sha256, bytes: state.bytes, mode: state.mode };
  return session.emit("snapshot", { id: snap.id, path: snap.path, after });
}

// The snapshot events of a thread, merged by id (before + after), oldest first. `seq` is the seq of
// the *before* half — the point in the thread at which the file still held that content.
export function snapshotRecords(session) {
  const byId = new Map();
  for (const ev of session.events) {
    if (ev.type !== "snapshot" || !ev.id) continue;
    const row = byId.get(ev.id) || { id: ev.id, seq: ev.seq, ts: ev.ts, path: ev.path, tool: ev.tool, callId: ev.callId };
    if (ev.before) { row.before = ev.before; row.seq = ev.seq; row.ts = ev.ts; row.tool = ev.tool || row.tool; row.callId = ev.callId || row.callId; }
    if (ev.after) { row.after = ev.after; row.afterSeq = ev.seq; }
    row.path = row.path || ev.path;
    byId.set(ev.id, row);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

// ---- anchors ----------------------------------------------------------------------------------
// The points the owner may go back to: before each request they made, before each file hcode
// changed, and the thread's own checkpoints. Two anchors that would restore the same messages and
// the same files are the same anchor — the end-of-turn checkpoint and the next request are one row,
// not three — so the menu lists distinct states and the most descriptive label of each wins.
const KIND_RANK = { message: 0, edit: 1, checkpoint: 2 };
const KIND_MARK = { message: "↩ before", edit: "↩ before", checkpoint: "↩ at" };

export function rewindAnchors(session, { limit = MAX_ANCHORS, now = Date.now() } = {}) {
  const records = snapshotRecords(session);
  const raw = [];
  for (const ev of session.events) {
    if (ev.type === "turn.start") raw.push({ seq: ev.seq - 1, kind: "message", at: ev.ts, label: oneLine(ev.prompt).slice(0, 56) || "(no prompt)" });
    else if (ev.type === "checkpoint") raw.push({ seq: ev.seq, kind: "checkpoint", at: ev.ts, label: oneLine(ev.label).slice(0, 56) || "checkpoint" });
    else if (ev.type === "snapshot" && ev.before) raw.push({ seq: ev.seq - 1, kind: "edit", at: ev.ts, label: `${ev.tool} ${ev.path}`.slice(0, 56) });
  }
  // Two anchors restore the same state when the same items and the same snapshots lie behind them;
  // one pass over the thread gives every seq its running count of each.
  const items = new Int32Array(session.seq + 2); const snaps = new Int32Array(session.seq + 2);
  for (const ev of session.events) {
    if (!(ev.seq >= 0 && ev.seq < items.length)) continue;
    if (ev.type === "item") items[ev.seq]++;
    else if (ev.type === "snapshot" && ev.before) snaps[ev.seq]++;
  }
  for (let i = 1; i < items.length; i++) { items[i] += items[i - 1]; snaps[i] += snaps[i - 1]; }
  const distinct = new Map();
  for (const anchor of raw) {
    if (anchor.seq < 0 || anchor.seq >= session.seq) continue;
    const key = `${items[anchor.seq]}:${snaps[anchor.seq]}`;
    const held = distinct.get(key);
    if (!held || KIND_RANK[anchor.kind] < KIND_RANK[held.kind]) distinct.set(key, anchor);
  }
  return [...distinct.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map(anchor => ({ ...anchor, files: records.filter(row => row.seq > anchor.seq && row.before && !row.before.skipped).length, ago: since(anchor.at, now) }));
}

export function rewindOptions(anchors) {
  return anchors.map(anchor => ({
    label: `${KIND_MARK[anchor.kind]} ${anchor.label}`,
    description: `${anchor.ago} · seq ${anchor.seq} · ${anchor.files ? `${anchor.files} file${anchor.files === 1 ? "" : "s"} put back` : "no files to put back"}`,
  }));
}

// ---- restoring the files ------------------------------------------------------------------------
// Only what hcode changed after `seq`, and only where the working tree still holds what hcode last
// wrote. A file someone else edited since is a conflict: reported, and overwritten only if
// `onConflict` says the owner asked for it.
export async function restoreFiles({ session, store, root, seq, onConflict = null }) {
  const records = snapshotRecords(session);
  const undo = new Map();       // path → the earliest record after the cut: its `before` is the state to go back to
  const newest = new Map();     // path → the last thing hcode recorded writing there
  for (const row of records) {
    if (!row.path) continue;
    if (row.seq > seq && !undo.has(row.path)) undo.set(row.path, row);
    newest.set(row.path, row);
  }
  const restored = []; const conflicts = []; const skipped = [];
  for (const [rel, row] of undo) {
    const abs = path.resolve(root, rel);
    const before = row.before;
    if (!before || before.skipped) { skipped.push({ path: rel, reason: before?.skipped || "no_snapshot" }); continue; }
    if (!before.absent && !store?.has(before.sha256)) { skipped.push({ path: rel, reason: "snapshot_gone" }); continue; }
    const expected = newest.get(rel)?.after;
    const current = fileState(abs, { maxBytes: store?.maxFileBytes ?? MAX_SNAPSHOT_BYTES });
    const known = expected && !expected.skipped;
    const untouched = known && (expected.absent ? Boolean(current.absent) : !current.absent && !current.skipped && current.sha256 === expected.sha256);
    if (!untouched) {
      const conflict = { path: rel, reason: known ? "changed_outside_hcode" : "unknown_last_write", expected: known ? withoutBuffer(expected) : null, current: withoutBuffer(current) };
      const overwrite = onConflict ? await onConflict(conflict) : false;
      if (!overwrite) { conflicts.push(conflict); continue; }
      conflict.overwritten = true; conflicts.push(conflict);
    }
    if (before.absent) { try { fs.rmSync(abs, { force: true }); } catch { skipped.push({ path: rel, reason: "delete_failed" }); continue; } restored.push({ path: rel, action: "removed" }); continue; }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeAtomic(abs, store.read(before.sha256));
      if (before.mode) fs.chmodSync(abs, before.mode);
    } catch { skipped.push({ path: rel, reason: "write_failed" }); continue; }
    restored.push({ path: rel, action: current.absent ? "recreated" : "reverted", bytes: before.bytes || 0 });
  }
  return { restored, conflicts, skipped };
}

// ---- the whole move ------------------------------------------------------------------------------
export async function rewindTo({ session, anchor, store, root, dir = session.dir, onConflict = null, meta = {} }) {
  const seq = Number(anchor?.seq ?? anchor);
  if (!Number.isInteger(seq) || seq < 0) throw new Error("rewind needs a whole seq");
  if (seq >= session.seq) throw new Error("that point is already where this conversation is");
  const forked = session.forkAt(seq, { dir, meta });
  const files = await restoreFiles({ session, store, root, seq, onConflict });
  const summary = { atSeq: seq, restored: files.restored.map(row => row.path), conflicts: files.conflicts.map(row => row.path), skipped: files.skipped.map(row => row.path) };
  forked.emit("rewind", { from: session.id, ...summary, ...(anchor?.kind ? { anchor: { kind: anchor.kind, label: anchor.label } } : {}) });
  session.emit("rewind", { to: forked.id, atSeq: seq });
  return { session: forked, files, seq };
}

export function formatRewind(result) {
  const { files, session, seq } = result;
  const rows = [`Rewound to seq ${seq}. The conversation continues as ${session.id}; the thread it came from is untouched and still in \`hcode sessions\`.`];
  if (files.restored.length) rows.push(`  put back  ${files.restored.map(row => `${row.path} (${row.action})`).join(", ")}`);
  else rows.push("  put back  nothing — no file hcode changed after that point");
  for (const row of files.conflicts) rows.push(`  ${row.overwritten ? "overwrote" : "left alone"}  ${row.path} — ${row.reason === "unknown_last_write" ? "hcode never recorded what it last wrote here" : "changed outside hcode since hcode last wrote it"}`);
  for (const row of files.skipped) rows.push(`  not restorable  ${row.path} — ${row.reason}`);
  return rows.join("\n");
}

// The owner-facing move: the anchor menu (arrow keys with a composer, a numbered list without one),
// then the fork and the restore, then one honest summary. Returns the rewind result, or null when
// the owner backed out — the caller swaps in `result.session` and keeps going.
export async function openRewind({ session, store, root, select, ask, show = () => {}, info = () => {}, warn = () => {}, limit = MAX_ANCHORS }) {
  const anchors = rewindAnchors(session, { limit });
  if (!anchors.length) { info("Nothing to rewind to yet — this conversation has no earlier point."); return null; }
  const index = await selectOption({
    title: "Rewind — go back to an earlier point in this conversation",
    options: rewindOptions(anchors),
    hint: "Enter rewinds into a new thread (this one stays); Esc changes nothing",
    select, ask, show,
    fallbackPrompt: "Rewind to which point? (number, or Enter to stay here)\n> ",
  });
  if (index === null) { info("Rewind cancelled; nothing changed."); return null; }
  const anchor = anchors[index];
  const onConflict = async conflict => {
    if (!ask) return false;
    const answer = String(await ask(`${conflict.path} changed outside hcode since hcode last wrote it. Overwrite it with the snapshot from that point? [y/N]\n> `) || "").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
  try {
    const result = await rewindTo({ session, anchor, store, root, onConflict, meta: { anchor: anchor.kind } });
    info(formatRewind(result));
    return result;
  } catch (error) { warn(`Rewind did not happen: ${error.message}`); return null; }
}
