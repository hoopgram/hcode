// 0.9.2: subagents as something that is present. The board is a projection over files hcode already
// writes — the owner's child ledger and each helper's own v2 thread — so these tests use the real
// Session writer and the real runner translator as their fixtures. Nothing here mocks the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Presence, SUBAGENT_DIR, activityOf, projectTranscript, reclaimSubagentThreads, shortTitle, totalTokens } from "../src/presence.js";
import { Session } from "../src/session.js";
import { makeTranslator } from "../src/runners.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-presence-"));
const childDir = dir => path.join(dir, SUBAGENT_DIR);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// An owner thread with one helper spawned on it, wired to a board with a clock the test owns. The clock
// starts where the thread's own timestamps do, because elapsed is measured against what was recorded.
function board({ tickMs = 0 } = {}) {
  const dir = tmp();
  const clock = { at: Date.now() };
  const presence = new Presence({ now: () => clock.at, tickMs });
  const main = new Session(dir, null, { cwd: dir, runner: "hcode" });
  presence.observe(main);
  return { dir, clock, presence, main };
}
const spawnHelper = (main, dir, { task = "find where the parser lives", runner = "claude", model = "haiku" } = {}) => {
  const thread = new Session(childDir(dir), null, { cwd: dir, runner, model });
  const spawned = main.childSpawn({ runner, task, cwd: dir, model, session: thread.id, policy: { mode: "read", sandbox: "auto" } });
  return { thread, childId: spawned.childId };
};

// ---- 1. the list ---------------------------------------------------------------------------------
test("list() reports one row per helper in spawn order, with the fields the input line needs", () => {
  const { dir, clock, presence, main } = board();
  const first = spawnHelper(main, dir, { task: "read the frame renderer\nand say what it does" });
  const second = spawnHelper(main, dir, { task: "rename the flag", runner: "codex", model: "gpt-5.6-terra" });

  const rows = presence.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.id), [first.childId, second.childId]);      // spawn order, never reshuffled
  assert.equal(rows[0].kind, "claude");
  assert.equal(rows[0].model, "haiku");
  assert.equal(rows[0].title, "read the frame renderer");                          // first line only
  assert.equal(rows[0].state, "working");
  assert.equal(rows[0].tokens, 0);
  assert.equal(rows[1].kind, "codex");

  const startedAt = rows[0].startedAt;
  clock.at = startedAt + 4_000;
  assert.equal(presence.list()[0].elapsedMs, 4_000);                               // a working row ages on its own

  main.childReport({ childId: first.childId, status: "done", summary: "it draws the box", usage: { in: 900, out: 100 } });
  const done = presence.list()[0];
  assert.equal(done.state, "done");
  assert.equal(done.tokens, 1000);                                                 // in + out, exactly what the ledger filed
  const frozen = done.elapsedMs;
  clock.at += 10_000;
  assert.equal(presence.list()[0].elapsedMs, frozen);                              // a finished row stops ageing
  assert.equal(presence.list()[1].elapsedMs, clock.at - rows[1].startedAt);

  main.childReport({ childId: second.childId, status: "cancelled", summary: "stopped" });
  assert.equal(presence.list()[1].state, "cancelled");
  presence.close();
});

test("a long task becomes a title that still reads as language, and the states are the four agreed ones", () => {
  assert.equal(shortTitle("short one"), "short one");
  const long = shortTitle("investigate why the composer redraws the whole frame on every keystroke and report back");
  assert.ok(long.length <= 65 && long.endsWith("…") && !long.includes("  "), long);
  assert.ok(long.startsWith("investigate why the composer redraws"), long);
  const { dir, presence, main } = board();
  for (const status of ["done", "failed", "cancelled"]) {
    const helper = spawnHelper(main, dir, { task: `t ${status}` });
    main.childReport({ childId: helper.childId, status, summary: "" });
    assert.equal(presence.list().at(-1).state, status);
  }
  presence.close();
});

// ---- 2. subscribe ---------------------------------------------------------------------------------
test("subscribe() fires on change, ticks at least once a second while a helper works, and unrefs its timer", async () => {
  const { dir, presence, main } = board({ tickMs: 20 });
  let calls = 0;
  const stop = presence.subscribe(() => { calls++; });

  const helper = spawnHelper(main, dir);                 // a state change wakes the renderer
  assert.ok(calls >= 1, `spawn should notify, got ${calls}`);
  assert.ok(presence.timer, "a working row must start the tick");
  assert.equal(presence.timer.hasRef(), false, "the tick must never hold the process open");

  const before = calls;
  await sleep(90);
  assert.ok(calls >= before + 2, `elapsed time alone must keep the row alive, got ${calls - before} ticks`);

  main.childReport({ childId: helper.childId, status: "done", summary: "", usage: { in: 1, out: 1 } });
  await sleep(60);
  assert.equal(presence.timer, null, "nothing working, nothing ticking");
  const idle = calls;
  await sleep(50);
  assert.equal(calls, idle, "an idle board costs nothing");

  stop();
  spawnHelper(main, dir, { task: "another" });
  assert.equal(calls, idle, "unsubscribe means unsubscribed");
  presence.close();
});

test("a text delta does not wake the renderer; a number does", () => {
  const { dir, presence, main } = board();
  const helper = spawnHelper(main, dir);
  presence.thread(helper.thread);
  let calls = 0;
  presence.subscribe(() => { calls++; });
  helper.thread.live("text", { delta: "thinking out loud" });
  assert.equal(calls, 0);
  helper.thread.live("usage", { in: 10, out: 2 });
  assert.equal(calls, 1);
  assert.equal(presence.list()[0].tokens, 12);
  presence.close();
});

// ---- 3. live numbers, from the runner's own stream --------------------------------------------------
test("tokens climb while the helper streams, and the settled figure replaces the estimate", () => {
  const { dir, presence, main } = board();
  const helper = spawnHelper(main, dir);
  presence.thread(helper.thread);
  const tr = makeTranslator("claude", helper.thread, {});
  const tokens = () => presence.list()[0].tokens;

  tr.line(JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900 } } } }));
  assert.equal(tokens(), 1000);                                     // a cache read is an input token that was billed
  tr.line(JSON.stringify({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 50 } } }));
  assert.equal(tokens(), 1050);
  tr.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } }));
  assert.equal(tokens(), 1050, "text is not a token count");

  tr.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/src/frame.js" } }] } }));
  assert.equal(presence.list()[0].activity, "Reading frame.js…");   // what it is doing, in the owner's words

  tr.line(JSON.stringify({ type: "result", usage: { input_tokens: 120, cache_read_input_tokens: 900, output_tokens: 60 } }));
  assert.equal(tokens(), 1080, "the result line settles the estimate it was tracking");
  assert.deepEqual(tr.usage, { in: 1020, out: 60 });                // …and the ledger records the same numbers
  presence.close();
});

test("activity names the file, the pattern or the command, and nothing else", () => {
  assert.equal(activityOf("read_file", { path: "/a/b/frame.js" }), "Reading frame.js…");
  assert.equal(activityOf("edit_file", { path: "src/ui.js" }), "Editing ui.js…");
  assert.equal(activityOf("grep", { pattern: "childSpawn" }), "Searching childSpawn…");
  assert.equal(activityOf("bash", { command: "npm test\n--all" }), "Running npm test…");
  assert.equal(activityOf("read_file", {}), "Reading…");
});

// ---- 4. the transcript, after the helper is gone ------------------------------------------------------
test("transcript() reads the whole conversation in order, and still reads it in a new process", () => {
  const { dir, presence, main } = board();
  const helper = spawnHelper(main, dir, { task: "explain the ledger" });
  presence.thread(helper.thread);

  helper.thread.startTurn("explain the ledger");
  helper.thread.message("user", "explain the ledger");             // the runners write both; the board says it once
  const call = helper.thread.toolCall("read_file", { path: "src/session.js" }, [], "running");
  helper.thread.toolResult(call.id, true, "childSpawn is an event");
  helper.thread.message("assistant", [{ type: "text", text: "it is append-only" }]);
  helper.thread.error("runner_exit", "nothing fatal");
  helper.thread.endTurn("end_turn", { in: 10, out: 4 });
  main.childReport({ childId: helper.childId, status: "done", summary: "append-only", usage: { in: 10, out: 4 } });

  const live = presence.transcript(helper.childId);
  assert.deepEqual(live.map(row => row.role), ["owner", "tool", "tool", "agent", "meta", "meta"]);
  assert.equal(live[0].text, "explain the ledger");
  assert.match(live[1].text, /read_file/);
  assert.match(live[2].text, /^→ childSpawn is an event/);
  assert.equal(live[3].text, "it is append-only");

  // a new process: nothing in memory, everything on disk, read through the reader --resume uses
  const reopened = new Presence({ now: () => 2_000_000 });
  reopened.observe(new Session(dir, main.id));
  assert.deepEqual(reopened.transcript(helper.childId), live);
  assert.equal(reopened.list()[0].state, "done");
  assert.equal(reopened.list()[0].tokens, 14);
  assert.deepEqual(reopened.transcript(helper.thread.id), live, "a thread id opens the same conversation");
  assert.deepEqual(reopened.transcript("c-deadbeef"), []);
  reopened.close(); presence.close();
});

test("a helper the process died on is cancelled on reopen, never left working and never lost", () => {
  const { dir, presence, main } = board();
  const helper = spawnHelper(main, dir, { task: "a run nobody reported" });
  helper.thread.startTurn("a run nobody reported");
  helper.thread.message("assistant", [{ type: "text", text: "half an answer" }]);
  assert.equal(presence.list()[0].state, "working");
  presence.close();

  const reopened = new Presence({ now: () => 2_000_000 });
  reopened.observe(new Session(dir, main.id));
  const row = reopened.list()[0];
  assert.equal(row.state, "cancelled", "interrupted is cancelled, the same judgement recover() makes");
  assert.equal(row.title, "a run nobody reported");
  assert.deepEqual(reopened.transcript(helper.childId).map(r => r.role), ["owner", "agent"]);
  reopened.close();
});

test("a thread killed mid-line still opens: the half-written line is dropped, the rest is the transcript", () => {
  const { dir, presence, main } = board();
  const helper = spawnHelper(main, dir, { task: "crash" });
  helper.thread.startTurn("crash");
  helper.thread.message("assistant", [{ type: "text", text: "survived" }]);
  presence.close();

  const file = path.join(childDir(dir), helper.thread.id + ".jsonl");
  fs.appendFileSync(file, '{"v":2,"ts":1,"seq":99,"type":"item","item":{"kind":"mess');   // a writer that died mid-append

  const reopened = new Presence({ now: () => 2_000_000 });
  reopened.observe(new Session(dir, main.id));
  const rows = reopened.transcript(helper.childId);
  assert.deepEqual(rows.map(r => r.role), ["owner", "agent", "meta"]);
  assert.equal(rows[1].text, "survived");
  assert.match(rows[2].text, /tail_corrupt: 1 unreadable line/);   // the thread says what it lost instead of failing
  reopened.close();
});

test("projectTranscript is total: an empty thread and an unknown event are rows nobody has to guard against", () => {
  assert.deepEqual(projectTranscript([]), []);
  assert.deepEqual(projectTranscript([{ type: "checkpoint", label: "x" }, null].filter(Boolean)), []);
});

// ---- 5. the main turn --------------------------------------------------------------------------------
test("mainTurn carries the running turn's own numbers, on the same arithmetic as every row", () => {
  const { clock, presence, main } = board();
  assert.deepEqual({ ...presence.mainTurn }, { active: false, startedAt: 0, elapsedMs: 0, tokens: 0 });

  main.startTurn("do the thing");
  assert.equal(presence.mainTurn.active, true);
  const startedAt = presence.mainTurn.startedAt;
  assert.ok(startedAt > 0);

  clock.at = startedAt + 345_000;
  assert.equal(presence.mainTurn.elapsedMs, 345_000);
  main.live("usage", { in: 5_000, out: 900, cacheWrite: 3_000, cacheRead: 75_000 });
  assert.equal(presence.mainTurn.tokens, 83_900);                   // input + output + cache write + cache read

  main.endTurn("end_turn", { in: 5_200, out: 1_000, cacheWrite: 3_000, cacheRead: 75_000 });
  assert.equal(presence.mainTurn.active, false);
  assert.equal(presence.mainTurn.tokens, 84_200);
  const frozen = presence.mainTurn.elapsedMs;
  clock.at += 60_000;
  assert.equal(presence.mainTurn.elapsedMs, frozen, "a finished turn stops counting");

  main.startTurn("next");
  assert.equal(presence.mainTurn.tokens, 0, "each turn reports its own cost, not the session's");
  presence.close();
});

test("a turn interrupted by a dead process is not still running when the thread is reopened", () => {
  const { dir, presence, main } = board();
  main.startTurn("interrupted");
  assert.equal(presence.mainTurn.active, true);
  presence.close();
  const reopened = new Presence({ now: () => 2_000_000 });
  reopened.observe(new Session(dir, main.id));
  assert.equal(reopened.mainTurn.active, false);
  reopened.close();
});

test("totalTokens double-counts neither reporter", () => {
  assert.equal(totalTokens({ in: 1020, out: 60 }), 1080);                                  // a foreign CLI folds cache reads into `in`
  assert.equal(totalTokens({ in: 10, out: 4, cacheWrite: 3, cacheRead: 7 }), 24);          // hcode keeps the four apart
  assert.equal(totalTokens(null), 0);
});

// ---- 6. the helper threads do not pile up forever ------------------------------------------------------
test("a helper thread lives exactly as long as an owner thread still names it", () => {
  const dir = tmp();
  const main = new Session(dir, null, { cwd: dir, runner: "hcode" });
  const kept = new Session(childDir(dir), null, { cwd: dir, runner: "claude" });
  const orphan = new Session(childDir(dir), null, { cwd: dir, runner: "claude" });
  main.childSpawn({ runner: "claude", task: "kept", cwd: dir, model: "haiku", session: kept.id, policy: { mode: "read", sandbox: "auto" } });

  const old = Date.now() + 3_600_000;                                       // past the grace window
  const first = reclaimSubagentThreads({ dir, now: old });
  assert.equal(first.removed, 1, "the thread nobody names is the only one collected");
  assert.equal(first.kept, 1);
  assert.ok(fs.existsSync(path.join(childDir(dir), kept.id + ".jsonl")));
  assert.ok(!fs.existsSync(path.join(childDir(dir), orphan.id + ".jsonl")));

  // a thread written moments ago is presumed spoken for: the ledger line that names it may not be written yet
  const newborn = new Session(childDir(dir), null, { cwd: dir, runner: "claude" });
  assert.equal(reclaimSubagentThreads({ dir }).removed, 0);
  assert.ok(fs.existsSync(path.join(childDir(dir), newborn.id + ".jsonl")));

  // retiring the owner thread gives up its claim, exactly as reclaimSnapshots means it: nothing names
  // either helper any more, so past the grace window both are collected
  assert.equal(reclaimSubagentThreads({ dir, retire: [main.id], now: old }).removed, 2);
  assert.ok(!fs.existsSync(path.join(childDir(dir), kept.id + ".jsonl")));
  assert.deepEqual(reclaimSubagentThreads({ dir: path.join(dir, "nope") }), { removed: 0, freed: 0, kept: 0 });
});

test("the age backstop is off unless a caller asks for it, and then it outranks the claim", () => {
  const dir = tmp();
  const main = new Session(dir, null, { cwd: dir, runner: "hcode" });
  const named = new Session(childDir(dir), null, { cwd: dir, runner: "claude" });
  main.childSpawn({ runner: "claude", task: "old but named", cwd: dir, model: "haiku", session: named.id, policy: { mode: "read", sandbox: "auto" } });
  const later = Date.now() + 90 * 24 * 3_600_000;
  assert.equal(reclaimSubagentThreads({ dir, now: later }).removed, 0, "age alone never collects a named thread");
  assert.equal(reclaimSubagentThreads({ dir, now: later, ttlMs: 30 * 24 * 3_600_000 }).removed, 1);
});
