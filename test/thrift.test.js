// 0.8 B: saving money is the default that needs no argument. Two halves — a delegation that declared
// nothing takes the smallest tier when the work is looking rather than building, and the rewind store
// reclaims blobs by reference at the end of a session instead of waiting a week for the TTL.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inferKind, resolveSubagentModel, SUBAGENT_TIERS } from "../src/subagents.js";
import { Session } from "../src/session.js";
import { SnapshotStore, snapshotBefore, snapshotAfter, referencedBlobs, reclaimSnapshots, reclaimOnClose, formatReclaim, restoreFiles } from "../src/rewind.js";
import { activeDir, continueFrom, ledgerRoot, parseLedger, retiredThreads, writeLedger } from "../src/handoff.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-thrift-"));

// ---- the cheap default -------------------------------------------------------------------------------
test("looking is inferred as search; building still has to be declared", () => {
  for (const task of ["find where the parser lives", "search the repo for retry logic", "grep for TODO",
    "scan the logs for the 502", "where is loadPolicy defined", "list every file that imports tools.js",
    "read the build output and tell me what failed", "定位这个函数的定义"]) {
    assert.equal(inferKind(task), "search", task);
  }
  for (const task of ["write a JSON parser", "refactor the session store", "add a --json flag and tests",
    "fix the off-by-one in the composer"]) {
    assert.equal(inferKind(task), "", task);
  }
});

test("a delegation that names neither brain nor tier takes the smallest tier and says so", () => {
  const chosen = resolveSubagentModel({ runner: "claude", task: "find where the retry logic lives", coordinatorModel: "claude-fable-5" });
  assert.equal(chosen.model, SUBAGENT_TIERS.claude.search);
  assert.equal(chosen.kind, "search");
  assert.equal(chosen.source, "inferred", "hcode chose this, not the caller");
  assert.match(chosen.note, /smallest tier/);
  assert.match(chosen.note, /implement/, "the note says how to spend more, or it is not a choice");

  // codex takes its own smallest tier, not a claude name
  assert.equal(resolveSubagentModel({ runner: "codex", task: "scan the logs" }).model, SUBAGENT_TIERS.codex.search);

  // an undeclared implementation task is still refused: cheap is the default, not a guess at what was meant
  assert.throws(() => resolveSubagentModel({ runner: "claude", task: "write the migration and its tests" }),
    /needs its brain named/);
  // and declaring anything still wins over the inference
  assert.equal(resolveSubagentModel({ runner: "claude", kind: "implement", task: "find the parser" }).model, SUBAGENT_TIERS.claude.implement);
  assert.equal(resolveSubagentModel({ runner: "claude", model: "sonnet", task: "find the parser" }).source, "named");
  assert.equal(resolveSubagentModel({ runner: "claude", model: "sonnet", task: "find the parser" }).note, undefined);
});

test("the inferred tier is never a flagship, whatever the task says", () => {
  const chosen = resolveSubagentModel({ runner: "claude", task: "search for fable in the config", coordinatorModel: "claude-fable-5" });
  assert.equal(chosen.model, "haiku");
});

// ---- reclaiming the blob store ------------------------------------------------------------------------
const snap = (session, store, root, file, body) => {
  fs.writeFileSync(path.join(root, file), body);
  const handle = snapshotBefore({ session, store, tool: "write_file", input: { path: file }, root, callId: "c1" });
  fs.writeFileSync(path.join(root, file), body + "-changed");
  snapshotAfter({ session, store, snap: handle });
  return handle;
};
const stored = store => store.list().map(name => "sha256:" + name.replace(/\.blob$/, "")).sort();
const age = (store, name) => fs.utimesSync(path.join(store.root, name), new Date(0), new Date(0));

test("a blob lives exactly as long as some thread still names it", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const store = new SnapshotStore(dir);
  const a = new Session(dir, null, { cwd: root });
  const b = new Session(dir, null, { cwd: root });
  snap(a, store, root, "a.txt", "only-a-names-this");
  snap(b, store, root, "b.txt", "only-b-names-this");
  assert.equal(store.list().length, 2);

  // every stored blob is spoken for while both threads are on disk
  const live = referencedBlobs(dir);
  for (const hash of stored(store)) assert.ok(live.has(hash), hash);

  // nothing is retired, so nothing goes — even with the grace window wide open
  assert.equal(reclaimSnapshots({ dir, store, graceMs: 0 }).removed, 0);
  assert.equal(store.list().length, 2);

  // retire b: its private blob goes, a's stays
  const swept = reclaimSnapshots({ dir, store, retire: [b.id], graceMs: 0 });
  assert.equal(swept.removed, 1);
  assert.equal(swept.kept, 1);
  assert.ok(swept.freed > 0);
  assert.equal(store.list().length, 1);
  assert.ok(referencedBlobs(dir, { retire: [b.id] }).has(stored(store)[0]), "what survived is what a is still holding");
});

test("a fork shares its parent's blobs, and the count knows it", async () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const store = new SnapshotStore(dir);
  const parent = new Session(dir, null, { cwd: root });
  snap(parent, store, root, "shared.txt", "written-before-the-fork");
  const at = parent.seq;
  snap(parent, store, root, "after.txt", "written-after-the-fork");
  const child = parent.forkAt(at, { dir });
  assert.equal(store.list().length, 2);

  // the child's file carries the parent's snapshot events, so the shared blob is named twice and
  // retiring the parent cannot take it: only the blob the fork was cut before goes.
  const retired = reclaimSnapshots({ dir, store, retire: [parent.id], graceMs: 0 });
  assert.equal(retired.removed, 1, "only the blob the fork never inherited goes");
  assert.equal(retired.kept, 1);

  // and the survivor is still usable: the fork can still put its file back
  fs.writeFileSync(path.join(root, "shared.txt"), "written-before-the-fork-changed");
  const result = await restoreFiles({ session: child, store, root, seq: 0 });
  assert.deepEqual(result.skipped, [], "a shared blob was not collected out from under the fork");
  assert.equal(fs.readFileSync(path.join(root, "shared.txt"), "utf8"), "written-before-the-fork");
});

test("a blob written moments ago is never swept out from under a snapshot in flight", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const store = new SnapshotStore(dir);
  const session = new Session(dir, null, { cwd: root });
  snap(session, store, root, "fresh.txt", "just-now");
  // retired, so nothing references it — only the grace window is holding this blob
  assert.equal(reclaimSnapshots({ dir, store, retire: [session.id] }).removed, 0, "grace window holds");
  assert.equal(reclaimSnapshots({ dir, store, retire: [session.id], graceMs: 0 }).removed, 1);
});

// ---- 0.9: the archive action is what retires a claim ---------------------------------------------------
test("filing a finished ledger retires its thread's blobs and leaves an unfinished thread's alone", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const store = new SnapshotStore(dir);
  const done = new Session(dir, null, { cwd: root });
  const busy = new Session(dir, null, { cwd: root });
  snap(done, store, root, "done.txt", "the-finished-thread-wrote-this");
  snap(busy, store, root, "busy.txt", "the-unfinished-thread-wrote-this");
  writeLedger({ session: done, cfg: { cwd: root }, task: "shipped", status: "done" });
  writeLedger({ session: busy, cfg: { cwd: root }, task: "still-going", status: "active" });
  assert.equal(store.list().length, 2);

  const result = continueFrom(ledgerRoot(root));
  assert.deepEqual(result.archived.map(row => row.thread), [done.id], "a filed ledger names the thread that wrote it");
  const retire = retiredThreads(result.archived, { keep: busy.id });
  assert.deepEqual(retire, [done.id]);

  const swept = reclaimSnapshots({ dir, store, retire, graceMs: 0 });
  assert.equal(swept.removed, 1); assert.equal(swept.kept, 1, "the still-active thread's blob is untouched");
  assert.ok(swept.freed > 0);
  assert.ok(referencedBlobs(dir, { retire }).has(stored(store)[0]), "what survived is what the active thread holds");
  assert.equal(fs.existsSync(path.join(dir, `${done.id}.jsonl`)), true, "the retired thread itself is still resumable");
});

test("the thread running /continue never retires itself, and a ledger naming no thread retires nothing", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const store = new SnapshotStore(dir);
  const live = new Session(dir, null, { cwd: root });
  snap(live, store, root, "live.txt", "the-running-thread-wrote-this");
  writeLedger({ session: live, cfg: { cwd: root }, task: "finished-in-place", status: "done" });

  const result = continueFrom(ledgerRoot(root));
  assert.deepEqual(result.archived.map(row => row.thread), [live.id]);
  // the owner filed their own ledger from inside the thread: those snapshots are still theirs to rewind to
  assert.deepEqual(retiredThreads(result.archived, { keep: live.id }), [], "a running thread has given up no claim");
  assert.equal(reclaimSnapshots({ dir, store, retire: [], graceMs: 0 }).removed, 0);
  assert.equal(store.list().length, 1, "the live thread can still rewind");

  // a ledger written before line 0 carried a thread parses fine and simply names nobody
  assert.equal(parseLedger("0. 模式: default | 状态: done").thread, "");
  assert.deepEqual(retiredThreads([{ name: "old.md", thread: "" }], { keep: live.id }), []);
});

test("a reclaim that cannot run leaves the archive it followed standing", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  const session = new Session(dir, null, { cwd: root });
  writeLedger({ session, cfg: { cwd: root }, task: "filed", status: "done" });

  const ledgers = ledgerRoot(root);
  const result = continueFrom(ledgers);
  assert.equal(result.archived.length, 1);
  const filed = result.archived[0].file;
  assert.ok(fs.existsSync(filed), "the ledger is in the archive before any reclaim is attempted");

  // the store is not there at all: reclaim reports nothing rather than throwing, so /continue cannot fail on it
  assert.deepEqual(reclaimSnapshots({ dir: path.join(root, "no-such-sessions"), retire: [session.id], graceMs: 0 }),
    { removed: 0, freed: 0, kept: 0 });
  assert.ok(fs.existsSync(filed), "and the archive still stands");
  assert.equal(fs.existsSync(path.join(activeDir(ledgers), "hcode-filed.md")), false, "nothing was put back in active/");
});

test("reference is tried before age, so the seven-day TTL is only a backstop", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  // a store small enough that the second snapshot has to make room for itself
  const store = new SnapshotStore(dir, { maxStoreBytes: 300 });
  const gone = new Session(dir, null, { cwd: root });
  snap(gone, store, root, "old.txt", "x".repeat(200));
  assert.equal(store.list().length, 1);
  fs.rmSync(gone.file);                       // the thread is deleted; its blob is now unreferenced
  age(store, store.list()[0]);                // and old enough for the reclaim's grace window

  const keeper = new Session(dir, null, { cwd: root });
  snap(keeper, store, root, "new.txt", "y".repeat(200));
  // the new snapshot fits because put() reclaimed the orphan by reference — the TTL never came into it
  assert.equal(store.list().length, 1);
  const record = keeper.events.find(event => event.type === "snapshot" && event.before);
  assert.ok(record && !record.before.skipped, "the new snapshot was actually stored, not refused as store_full");
});

test("the close hook only pays for a scan when the store is worth scanning", () => {
  const root = tmp(); const dir = path.join(root, "sessions");
  assert.equal(reclaimOnClose(dir), null, "an empty store is not scanned");
  const store = new SnapshotStore(dir);
  const session = new Session(dir, null, { cwd: root });
  snap(session, store, root, "a.txt", "small");
  assert.equal(reclaimOnClose(dir), null, "a nearly empty store is left alone");
  const swept = reclaimOnClose(dir, { threshold: 0 });
  assert.equal(swept.removed, 0, "and when it does run, a referenced blob still survives");
  assert.match(formatReclaim(swept), /nothing to reclaim/);
  assert.match(formatReclaim({ removed: 2, freed: 4096, kept: 1 }), /reclaimed 2 blobs \(4 KB\)/);
});
