// 0.7 E — Rewind (esc esc): the snapshot taken before a mutating call, Session.forkAt(seq), the
// restore that only puts back what hcode itself changed, and the whole move driven from the keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";
import { TerminalComposer } from "../src/composer.js";
import { SnapshotStore, formatRewind, openRewind, restoreFiles, rewindAnchors, rewindOptions, rewindTo, snapshotAfter, snapshotBefore, snapshotRecords } from "../src/rewind.js";
import { skipReason } from "../src/memory.js";
import { startFakeModel, text, tool } from "./fake-model.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-rw-"));
const cfgFor = (base, cwd) => {
  fs.mkdirSync(path.join(cwd, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  return { baseUrl: base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 8, bashTimeoutMs: 2000, cwd, mode: "auto", tokenBudget: 120000 };
};
const read = file => fs.readFileSync(file, "utf8");

// Two real turns through the kernel: the first writes a.txt, the second edits it and adds b.txt.
async function twoTurns() {
  const model = await startFakeModel((msgs, req, n) =>
    n === 1 ? { blocks: [tool("write_file", { path: "a.txt", content: "one\n" }, "u1")], stop: "tool_use" }
      : n === 2 ? text("wrote a.txt")
        : n === 3 ? { blocks: [tool("edit_file", { path: "a.txt", old_string: "one", new_string: "two" }, "u2"), tool("write_file", { path: "b.txt", content: "B\n" }, "u3")], stop: "tool_use" }
          : text("changed a.txt and added b.txt"));
  const cwd = tmp(); const dir = path.join(cwd, "sessions");
  const session = new Session(dir, null, { cwd, model: "m" });
  const cfg = cfgFor(model.base, cwd);
  await runAgent({ cfg, settings: {}, session, prompt: "write a.txt", quiet: true });
  await runAgent({ cfg, settings: {}, session, prompt: "change a.txt and add b.txt", quiet: true });
  model.close();
  return { cwd, dir, session, store: new SnapshotStore(dir) };
}

test("a mutating call is snapshotted before it runs, content-addressed, with both caps recorded", () => {
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const session = new Session(dir, null, { cwd });
  const store = new SnapshotStore(dir, { maxFileBytes: 64, maxStoreBytes: 1_000_000 });
  fs.writeFileSync(path.join(cwd, "a.txt"), "same");
  fs.writeFileSync(path.join(cwd, "b.txt"), "same");                    // identical content, one blob
  fs.writeFileSync(path.join(cwd, "big.txt"), "x".repeat(200));
  fs.writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
  for (const p of ["a.txt", "b.txt", "big.txt", "bin.dat", "new.txt"]) snapshotBefore({ session, store, tool: "write_file", input: { path: p }, root: cwd });
  assert.equal(snapshotBefore({ session, store, tool: "bash", input: { command: "rm -rf build" }, root: cwd }), null,
    "bash can change files hcode cannot name in advance, so it is deliberately never snapshotted");
  assert.equal(snapshotBefore({ session, store, tool: "write_file", input: { path: "../outside.txt" }, root: cwd }), null, "outside the project root is not hcode's to keep");

  assert.equal(store.list().length, 2, "one blob per distinct content: a.txt and b.txt share one, bin.dat has its own, big.txt was skipped");
  const rows = Object.fromEntries(snapshotRecords(session).map(row => [row.path, row]));
  assert.equal(rows["a.txt"].before.sha256, rows["b.txt"].before.sha256);
  assert.equal(rows["big.txt"].before.skipped, "too_large"); assert.equal(rows["big.txt"].before.bytes, 200);
  assert.equal(rows["bin.dat"].before.binary, true);
  assert.equal(rows["new.txt"].before.absent, true, "a file that does not exist yet: restoring means removing it again");

  // The store cap is the other bound, and it is recorded rather than silently dropping the point.
  const tight = new SnapshotStore(path.join(cwd, "tight"), { maxFileBytes: 64, maxStoreBytes: 2 });
  const small = new Session(dir, null, { cwd });
  snapshotBefore({ session: small, store: tight, tool: "write_file", input: { path: "a.txt" }, root: cwd });
  assert.equal(snapshotRecords(small)[0].before.skipped, "store_full");
  assert.equal(tight.list().length, 0);
  // A blob is a verbatim copy of a project file, so the memory harvest never walks into the store.
  assert.equal(skipReason("snapshots", true), "workspace");
});

test("forkAt copies the thread up to a seq, seals a call left open at the cut, and never touches the original", () => {
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const session = new Session(dir, null, { cwd, model: "m" });
  session.startTurn("first"); session.message("user", "first");
  session.message("assistant", [{ type: "text", text: "hi" }]);
  const endOfTurnOne = session.seq;
  session.startTurn("second"); session.message("user", "second");
  const call = session.toolCall("write_file", { path: "a.txt", content: "A" }, ["write"]);
  session.setCallState(call.id, "running");
  const openCall = session.seq;
  session.checkpoint("later");
  const original = read(session.file);

  const clean = session.forkAt(endOfTurnOne);
  assert.notEqual(clean.id, session.id);
  assert.equal(clean.header.forkedFrom, session.id); assert.equal(clean.header.forkedAt, endOfTurnOne);
  assert.deepEqual(clean.messages.map(m => m.role), ["user", "assistant"]);
  assert.equal(clean.seq, endOfTurnOne, "the fork keeps the parent's seq numbering and carries on from the cut");

  const sealed = session.forkAt(openCall);
  const state = sealed.calls.get(call.id);
  assert.equal(state.state, "cancelled", "hcode never re-runs a side effect it did not see finish");
  assert.match(sealed.results.get(call.id).output, /rewound/);
  const last = sealed.messages.at(-1);
  assert.equal(last.role, "user"); assert.equal(last.content[0].type, "tool_result", "a transcript may never end on an unanswered tool_use");

  assert.equal(read(session.file), original, "the thread that was forked from is left exactly as it was");
  assert.throws(() => session.forkAt(session.seq), /nothing to fork/);
  assert.throws(() => session.forkAt(-1), /whole seq/);
});

test("anchors are the distinct points to go back to: each request, each file change, no duplicate states", async () => {
  const { session } = await twoTurns();
  const anchors = rewindAnchors(session);
  assert.deepEqual(anchors.map(a => a.seq).slice().sort((a, b) => b - a), anchors.map(a => a.seq), "newest first");
  const keys = anchors.map(a => `${a.kind}:${a.label}`);
  assert.ok(keys.includes("message:write a.txt"), "the first request is a point to go back to");
  assert.ok(keys.includes("message:change a.txt and add b.txt"));
  assert.ok(keys.some(k => k === "edit:edit_file a.txt"), "so is the moment before each file changed");
  assert.ok(keys.some(k => k === "edit:write_file b.txt"));
  assert.equal(new Set(anchors.map(a => a.seq)).size, anchors.length, "one row per seq");
  assert.ok(!keys.some(k => /^checkpoint:t-01 done$/.test(k)),
    "the end-of-turn checkpoint restores exactly what the next request's anchor restores, so it is one row and not two");
  const back = anchors.find(a => a.label === "change a.txt and add b.txt");
  assert.equal(back.files, 2, "going back there puts two files back");
  assert.match(rewindOptions(anchors)[0].description, /seq \d+/);
});

test("restoring puts back only what hcode changed after the point, and only where hcode's own write still stands", async () => {
  const { cwd, session, store } = await twoTurns();
  assert.equal(read(path.join(cwd, "a.txt")), "two\n");
  const anchor = rewindAnchors(session).find(a => a.label === "change a.txt and add b.txt");

  // Someone else edited b.txt after hcode wrote it: that file is reported, never silently overwritten.
  fs.writeFileSync(path.join(cwd, "b.txt"), "mine, not hcode's\n");
  const guarded = await restoreFiles({ session, store, root: cwd, seq: anchor.seq });
  assert.deepEqual(guarded.restored.map(r => r.path), ["a.txt"]);
  assert.equal(read(path.join(cwd, "a.txt")), "one\n", "hcode's own change goes back");
  assert.deepEqual(guarded.conflicts.map(c => ({ path: c.path, reason: c.reason })), [{ path: "b.txt", reason: "changed_outside_hcode" }]);
  assert.equal(read(path.join(cwd, "b.txt")), "mine, not hcode's\n", "the owner's own work is left alone");

  // Asked explicitly, the same restore removes it — b.txt did not exist at that point.
  fs.writeFileSync(path.join(cwd, "a.txt"), "two\n");
  const asked = [];
  const forced = await restoreFiles({ session, store, root: cwd, seq: anchor.seq, onConflict: c => { asked.push(c.path); return true; } });
  assert.deepEqual(asked, ["b.txt"]);
  assert.equal(forced.conflicts[0].overwritten, true);
  assert.equal(fs.existsSync(path.join(cwd, "b.txt")), false, "a file that did not exist at that point is removed again");
  assert.equal(read(path.join(cwd, "a.txt")), "one\n");
  assert.deepEqual(forced.skipped, []);
});

test("rewindTo forks the thread and moves the files together; both threads record where it happened", async () => {
  const { cwd, session, store } = await twoTurns();
  const anchor = rewindAnchors(session).find(a => a.label === "change a.txt and add b.txt");
  const parentFile = session.file;
  const result = await rewindTo({ session, anchor, store, root: cwd });

  assert.equal(read(path.join(cwd, "a.txt")), "one\n");
  assert.equal(fs.existsSync(path.join(cwd, "b.txt")), false);
  assert.equal(result.session.header.forkedFrom, session.id);
  const prompts = result.session.events.filter(e => e.type === "turn.start").map(e => e.prompt);
  assert.deepEqual(prompts, ["write a.txt"], "the message stream stops at the point that was chosen");
  assert.ok(result.session.events.some(e => e.type === "rewind" && e.from === session.id));
  assert.ok(session.events.some(e => e.type === "rewind" && e.to === result.session.id), "the thread it left from says a fork went out here");
  assert.ok(fs.existsSync(parentFile), "and is still on disk, resumable");
  assert.match(formatRewind(result), /a\.txt \(reverted\)[\s\S]*b\.txt \(removed\)|b\.txt \(removed\)[\s\S]*a\.txt \(reverted\)/);
  // The new thread is a working thread: it can be rewound again from the blobs the parent stored.
  assert.ok(rewindAnchors(result.session).length > 0);
});

class FakeInput extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.raw = false; }
  setRawMode(value) { this.raw = Boolean(value); }
  resume() {}
}
const output = () => ({ isTTY: true, columns: 80, rows: 24, text: "", write(value) { this.text += String(value); return true; }, on() {}, off() {} });
const settle = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise(done => setImmediate(done)); };

test("esc esc opens the rewind menu; choosing a point takes the files and the message stream back to it", async () => {
  const { cwd, dir, session, store } = await twoTurns();
  const composer = new TerminalComposer({ input: new FakeInput(), output: output(), env: { HCODE_REDUCE_MOTION: "1" } });
  const said = [];
  let current = session;
  const escape = async () => { composer.feed("\x1b"); await new Promise(done => setTimeout(done, 60)); };

  let finished = null;
  composer.on("rewind", () => {
    finished = openRewind({ session: current, store, root: cwd, select: spec => composer.select(spec), ask: null,
      show: value => said.push(value), info: value => said.push(value), warn: value => said.push(value) });
  });

  composer.setBusy(true);
  await escape(); await escape();
  assert.equal(composer.menu, null, "while a turn runs Esc still only cancels it");
  composer.setBusy(false);

  await escape();
  assert.equal(composer.menu, null, "one Esc on an idle composer is not a rewind");
  composer.feed("x");                                   // anything typed in between puts the pair back to zero
  await escape();
  assert.equal(composer.menu, null);
  composer.feed("\x15");                                // Ctrl-U clears the draft

  await escape(); await escape();
  await settle();
  assert.ok(composer.menu, "esc esc on an idle composer opens the rewind menu");
  assert.match(composer.menu.title, /Rewind/);
  const wanted = composer.menu.options.findIndex(option => option.label.includes("change a.txt and add b.txt"));
  assert.ok(wanted >= 0, "the menu lists the request to go back before");
  for (let i = 0; i < wanted; i++) composer.feed("\x1b[B");
  composer.feed("\r");
  const result = await finished;
  assert.ok(result, "the menu resolved into a rewind");
  current = result.session;

  assert.equal(read(path.join(cwd, "a.txt")), "one\n", "the file is back to what it held at that point");
  assert.equal(fs.existsSync(path.join(cwd, "b.txt")), false, "and the file that did not exist yet is gone again");
  assert.deepEqual(current.events.filter(e => e.type === "turn.start").map(e => e.prompt), ["write a.txt"]);
  assert.notEqual(current.id, session.id);
  assert.ok(fs.readdirSync(dir).includes(session.id + ".jsonl"), "the thread it came from is still there");
  assert.ok(said.some(line => /Rewound to seq/.test(line)));

  // Esc backs out of the same menu without changing anything.
  said.length = 0; finished = null;
  await escape(); await escape();
  await settle();
  assert.ok(composer.menu);
  await escape();
  assert.equal(await finished, null);
  assert.ok(said.some(line => /cancelled/.test(line)));
  assert.equal(read(path.join(cwd, "a.txt")), "one\n");
});
