// A1 event stream v2 + A2 context + A5 reliability (CONTRACTS-V027 §1, §10). Fake model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAgent, maybeCompact, compactNow, estimateTokens, effectiveBudget, LOCAL_BUDGET, contextNotice, contextTiers, CONTEXT_TIERS } from "../src/agent.js";
import { createUI } from "../src/ui.js";
import { Session, idemKey, validChildId } from "../src/session.js";
import { backoffMs } from "../src/api.js";
import { startFakeModel, text, tool } from "./fake-model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-ev-"));
const cfgFor = (base, cwd, extra = {}) => {
  fs.mkdirSync(path.join(cwd, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  return { baseUrl: base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 8, bashTimeoutMs: 2000, cwd, mode: "auto", tokenBudget: 120000, ...extra };
};
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const types = file => lines(file).map(e => e.type === "item" ? "item." + e.item.kind + (e.item.state ? ":" + e.item.state : "") : e.type);

// ---- A1: line format, turns, items, checkpoints -------------------------------------------------------
test("A1 writes v2 JSONL: header, turn.start, items with stable ids/idem/risk, approval, checkpoint, turn.end", async () => {
  const m = await startFakeModel((msgs, _r, n) => n === 1 ? { blocks: [{ type: "text", text: "plan" }, tool("write_file", { path: "a.txt", content: "A" }, "toolu_1")], stop: "tool_use" } : text("done"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"), null, { cwd, model: "m", tokenBudget: 120000 });
  const seen = []; const live = [];
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "write A", quiet: true, onEvent: ev => { seen.push(ev.type); live.push(ev); } });
  const raw = fs.readFileSync(s.file, "utf8");
  assert.doesNotMatch(raw, /[\x1b\r]/, "terminal decoration never enters the event stream");
  for (const line of raw.split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
  const rows = lines(s.file);
  assert.deepEqual(rows[0], { ...rows[0], v: 2, type: "header", id: s.id, cwd, runner: "hcode", model: "m", tokenBudget: 120000 });
  const seqs = rows.slice(1).map(r => r.seq); assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.ok(rows.slice(1).every(r => r.v === 2 && typeof r.ts === "number" && /^t-\d{2,}$/.test(r.turn)));
  assert.equal(rows[1].type, "turn.start"); assert.equal(rows[1].prompt, "write A"); assert.equal(rows[1].turn, "t-01"); assert.equal(rows[1].runner, "hcode");
  const call = rows.find(r => r.type === "item" && r.item.kind === "tool_call");
  assert.match(call.item.id, /^i-[0-9a-f]{4,8}$/); assert.deepEqual(call.item.risk, ["write"]); assert.equal(call.item.state, "pending");
  assert.equal(call.item.idem, idemKey("write_file", { path: "a.txt", content: "A" }, "t-01"));
  const approval = rows.find(r => r.type === "approval"); assert.equal(approval.itemId, call.item.id); assert.equal(approval.by, "policy"); assert.equal(approval.decision, "allow");
  const result = rows.find(r => r.type === "item" && r.item.kind === "tool_result");
  assert.equal(result.item.callId, call.item.id); assert.equal(result.item.v, 1); assert.equal(result.item.ok, true); assert.equal(result.item.code, "ok"); assert.equal(result.item.retryable, false); assert.equal(result.item.truncated, false); assert.ok(result.item.bytes > 0);
  assert.ok(!rows.some(r => r.type === "text"), "text deltas are live-only, never on disk");
  assert.ok(live.some(e => e.type === "text" && e.delta === "plan" && e.live === true && e.seq === undefined), "but they reach onEvent");
  assert.ok(rows.some(r => r.type === "checkpoint" && r.lastSeq > 0));
  const end = rows.at(-1); assert.equal(end.type, "turn.end"); assert.equal(end.reason, "end_turn"); assert.deepEqual(end.usage, { in: 20, out: 10, cacheWrite: 0, cacheRead: 0 });
  assert.ok(seen.includes("turn.start") && seen.includes("turn.end") && seen.includes("approval"));
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "A");
  m.close();
});

test("A1 reads 0.1.0 (v1) sessions and resumes them; new writes are v2", async () => {
  const cwd = tmp(); const dir = path.join(cwd, "s"); fs.mkdirSync(dir);
  const file = path.join(dir, "20260101000000-ab12.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ header: true, id: "20260101000000-ab12", cwd, startedAt: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ ts: 1, role: "user", content: "hello" }),
    JSON.stringify({ ts: 2, role: "assistant", content: [{ type: "text", text: "hi" }] }),
    JSON.stringify({ ts: 3, role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "bash", input: { command: "ls" } }] }),  // dangling
  ].join("\n") + "\n");
  const s = new Session(dir, "20260101000000-ab12");
  assert.equal(s.messages.length, 2, "dangling v1 tool_use dropped");
  assert.equal(s.header.legacy, true);
  const m = await startFakeModel(msgs => { assert.equal(msgs[0].content, "hello"); return text("again"); });
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "more", quiet: true });
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.ok(rows.slice(4).every(r => r.v === 2), "appended rows are v2");
  assert.equal(Session.list(dir)[0].v, 1);
  m.close();
});

test("A1 seq de-duplication: a replayed duplicate line is ignored", () => {
  const cwd = tmp(); const dir = path.join(cwd, "s"); fs.mkdirSync(dir);
  const id = "20260101000000-dd01"; const file = path.join(dir, id + ".jsonl");
  const hdr = { v: 2, type: "header", id, cwd, startedAt: 1, runner: "hcode" };
  const u = { v: 2, ts: 1, seq: 1, turn: "t-01", type: "item", item: { id: "i-0001", kind: "message", role: "user", content: "q" } };
  const a = { v: 2, ts: 2, seq: 2, turn: "t-01", type: "item", item: { id: "i-0002", kind: "message", role: "assistant", content: [{ type: "text", text: "a" }] } };
  fs.writeFileSync(file, [hdr, u, a, a, u].map(x => JSON.stringify(x)).join("\n") + "\n");
  const s = new Session(dir, id);
  assert.equal(s.events.length, 2); assert.equal(s.seq, 2); assert.equal(s.messages.length, 2);
});

test("Y2 child events are v2-only, append in sequence, and reject escalation-shaped fields", () => {
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  s.startTurn("coordinate");
  const spawned = s.childSpawn({ runner: "claude", task: "only parser tests", cwd: "Projects/demo", policy: { mode: "ask", sandbox: "bwrap" } });
  assert.ok(validChildId(spawned.childId));
  s.childReport({ childId: spawned.childId, status: "done", summary: "3 tests added", usage: { in: 12, out: 3 } });
  s.childMerge({ childId: spawned.childId, outcome: "applied", files: ["test/parser.mjs"], commit: "abc1234" });
  const rows = lines(s.file); const events = rows.filter(r => r.type.startsWith("child."));
  assert.deepEqual(events.map(e => e.type), ["child.spawn", "child.report", "child.merge"]);
  assert.deepEqual(events.map(e => e.seq), [2, 3, 4]);
  assert.throws(() => s.childSpawn({ childId: "root", runner: "claude", task: "x", cwd: "x" }), /invalid child id/);
  assert.throws(() => s.childMerge({ childId: spawned.childId, outcome: "applied", files: ["../secret"], commit: "x" }), /invalid child merge/);
});

test("A1 tail corruption: the broken line is dropped and recorded as error{tail_corrupt}; thread stays readable", () => {
  const cwd = tmp(); const dir = path.join(cwd, "s"); fs.mkdirSync(dir);
  const id = "20260101000000-cc01"; const file = path.join(dir, id + ".jsonl");
  fs.writeFileSync(file, JSON.stringify({ v: 2, type: "header", id, cwd, startedAt: 1, runner: "hcode" }) + "\n" +
    JSON.stringify({ v: 2, ts: 1, seq: 1, turn: "t-01", type: "item", item: { id: "i-1", kind: "message", role: "user", content: "q" } }) + "\n" +
    '{"v":2,"ts":2,"seq":2,"turn":"t-01","type":"item","item":{"id":"i-2","kind":"mess');   // killed mid-write
  const s = new Session(dir, id);
  assert.equal(s.messages.length, 1);
  const rows = lines(file); const last = rows.at(-1);
  assert.equal(last.type, "error"); assert.equal(last.code, "tail_corrupt"); assert.equal(last.seq, 2);
  assert.doesNotThrow(() => new Session(dir, id));
});

// ---- A1: cancel + crash recovery -----------------------------------------------------------------------
test("A1 cancel: running tool_call gets tool_result{ok:false} / cancelled and turn.end{reason:cancelled}", async () => {
  const m = await startFakeModel((_m, _r, n) => n === 1 ? { blocks: [tool("bash", { command: "sleep 5" })], stop: "tool_use" } : text("never"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const ac = new AbortController();
  const unsub = s.onEvent(ev => { if (ev.type === "item" && ev.item.kind === "tool_call" && ev.item.state === "running") setTimeout(() => ac.abort(), 50); });
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true, signal: ac.signal });
  unsub();
  assert.equal(r.cancelled, true);
  const rows = lines(s.file);
  const call = rows.find(e => e.type === "item" && e.item.kind === "tool_call").item;
  const states = rows.filter(e => e.type === "item" && e.item.kind === "tool_call" && e.item.id === call.id).map(e => e.item.state);
  assert.ok(states.includes("cancelled"), states.join(","));
  const res = rows.find(e => e.type === "item" && e.item.kind === "tool_result"); assert.equal(res.item.ok, false);
  assert.equal(rows.at(-1).type, "turn.end"); assert.equal(rows.at(-1).reason, "cancelled");
  assert.ok(rows.indexOf(res) < rows.indexOf(rows.at(-1)));
  m.close();
});

test("A1 recovery: side-effect calls interrupted by a crash are cancelled, never re-run; read-only ones re-run", async () => {
  const cwd = tmp(); const dir = path.join(cwd, "s"); fs.mkdirSync(dir);
  const id = "20260101000000-rc01"; const file = path.join(dir, id + ".jsonl");
  fs.writeFileSync(path.join(cwd, "r.txt"), "fact\n");
  const w = { id: "i-w1", kind: "tool_call", tool: "write_file", input: { path: "boom.txt", content: "X" }, idem: idemKey("write_file", { path: "boom.txt", content: "X" }, "t-01"), risk: ["write"], state: "running" };
  const rd = { id: "i-r1", kind: "tool_call", tool: "read_file", input: { path: "r.txt" }, idem: idemKey("read_file", { path: "r.txt" }, "t-01"), risk: ["read"], state: "running" };
  fs.writeFileSync(file, [
    { v: 2, type: "header", id, cwd, startedAt: 1, runner: "hcode" },
    { v: 2, ts: 1, seq: 1, turn: "t-01", type: "turn.start", prompt: "go" },
    { v: 2, ts: 1, seq: 2, turn: "t-01", type: "item", item: { id: "i-u1", kind: "message", role: "user", content: "go" } },
    { v: 2, ts: 1, seq: 3, turn: "t-01", type: "item", item: w },
    { v: 2, ts: 1, seq: 4, turn: "t-01", type: "item", item: rd },
    { v: 2, ts: 1, seq: 5, turn: "t-01", type: "item", item: { id: "i-a1", kind: "message", role: "assistant", content: [{ type: "tool_use", id: "i-w1", name: "write_file", input: w.input }, { type: "tool_use", id: "i-r1", name: "read_file", input: rd.input }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const m = await startFakeModel(msgs => {
    const results = msgs.at(-2).content;   // the recovered results precede the new prompt
    assert.equal(results.find(b => b.tool_use_id === "i-w1").is_error, true);
    assert.match(results.find(b => b.tool_use_id === "i-r1").content, /fact/);
    return text("resumed");
  });
  const s = new Session(dir, id);
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "continue", quiet: true });
  assert.equal(r.text, "resumed");
  assert.ok(!fs.existsSync(path.join(cwd, "boom.txt")), "side-effect tool must not run again");
  const rows = lines(file);
  assert.ok(rows.some(e => e.type === "item" && e.item.kind === "tool_call" && e.item.id === "i-w1" && e.item.state === "cancelled"));
  assert.ok(rows.some(e => e.type === "error" && e.code === "recovered"));
  assert.equal(rows.find(e => e.type === "turn.start" && e.turn === "t-02").prompt, "continue");
  m.close();
});

test("A1 idempotency: the same tool_call (same idem) in one turn replays the result instead of running twice", async () => {
  let n = 0;
  const m = await startFakeModel((_m, _r, k) => k <= 2 ? { blocks: [tool("bash", { command: "echo run >> count.txt" })], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true, onTool: () => n++ });
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(cwd, "count.txt"), "utf8"), "run\n", "ran once, replayed once");
  const calls = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_call" && e.item.idem);
  assert.equal(calls.length, 2); assert.equal(calls[0].item.idem, calls[1].item.idem);
  m.close();
});

test("A1 killed process: SIGKILL mid-tool, then --resume does not re-run the write", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "echo once >> side.txt; sleep 30" })], stop: "tool_use" } : text("after"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runAgent } from ${JSON.stringify(path.join(here, "../src/agent.js"))};
    import { Session } from ${JSON.stringify(path.join(here, "../src/session.js"))};
    const s = new Session(${JSON.stringify(dir)}); console.log(s.id);
    await runAgent({ cfg: ${JSON.stringify(cfgFor(m.base, cwd))}, settings: {}, session: s, prompt: "go", quiet: true });
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let id = ""; child.stdout.on("data", d => id += d);
  const t0 = Date.now();
  while (!fs.existsSync(path.join(cwd, "side.txt")) && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 100));
  child.kill("SIGKILL"); await new Promise(r => child.on("exit", r));
  id = id.trim(); assert.ok(id);
  const s = new Session(dir, id);
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "resume", quiet: true });
  assert.equal(r.text, "after");
  assert.equal(fs.readFileSync(path.join(cwd, "side.txt"), "utf8"), "once\n", "the interrupted command did not run again");
  m.close();
});

// ---- A2: budget, compaction, checkpoint resume ---------------------------------------------------------
test("A2 compaction: over budget → compaction event keeps fact sources + decision pointers; messages rebuilt; side effects not redone", async () => {
  const big = "x".repeat(12000);
  const m = await startFakeModel((msgs, _r, k) => {
    if (k === 1) return { blocks: [tool("write_file", { path: "w.txt", content: "W" }), tool("read_file", { path: "w.txt" })], stop: "tool_use" };
    if (k === 2) return { blocks: [{ type: "text", text: "decision: keep W. " + big }], stop: "end_turn" };
    // turn 2: the compacted view must start with the summary and still not re-run anything
    assert.match(msgs[0].content, /context compacted/); assert.match(msgs[0].content, /w\.txt/); assert.match(msgs[0].content, /decision: keep W/);
    return text("turn2");
  });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"), null, { cwd, tokenBudget: 4000 });
  const cfg = cfgFor(m.base, cwd, { tokenBudget: 4000 });
  await runAgent({ cfg, settings: {}, session: s, prompt: "first", quiet: true });
  const before = lines(s.file).length;
  await runAgent({ cfg, settings: {}, session: s, prompt: "second", quiet: true });
  const rows = lines(s.file);
  const comp = rows.find(e => e.type === "compaction");
  assert.ok(comp, "compaction event written"); assert.ok(Array.isArray(comp.keeps) && comp.keeps.length >= 1);
  assert.equal(comp.droppedSeq[0], 1); assert.ok(comp.droppedSeq[1] <= before);
  assert.match(comp.summary, /Files changed[\s\S]*w\.txt/); assert.match(comp.summary, /Files read[\s\S]*w\.txt/);
  assert.ok(s.messages[0].content.includes("context compacted"));
  assert.ok(estimateTokens(s.messages) < 4000);
  assert.equal(fs.readFileSync(path.join(cwd, "w.txt"), "utf8"), "W");
  // reopening rebuilds the same compacted view
  const again = new Session(path.join(cwd, "s"), s.id); assert.equal(again.messages[0].content, s.messages[0].content);
  m.close();
});

test("A2 checkpoint resume: a thread reopened after a checkpoint continues without repeating the write", async () => {
  const m = await startFakeModel((msgs, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "c.txt", content: "1" })], stop: "tool_use" } : k === 2 ? text("done1") : text("done2"));
  const cwd = tmp(); const dir = path.join(cwd, "s"); const s = new Session(dir);
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "a", quiet: true });
  const cp = lines(s.file).filter(e => e.type === "checkpoint"); assert.ok(cp.length >= 2);
  fs.writeFileSync(path.join(cwd, "c.txt"), "edited-by-owner");
  const s2 = new Session(dir, s.id);
  assert.deepEqual(s2.recover(), { rerun: [], cancelled: [] });
  assert.equal(s2.messages.length, 4);
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s2, prompt: "b", quiet: true });
  assert.equal(r.text, "done2");
  assert.equal(fs.readFileSync(path.join(cwd, "c.txt"), "utf8"), "edited-by-owner");
  m.close();
});

test("A2 maybeCompact is a no-op under budget", () => {
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  s.startTurn("x"); s.message("user", "x"); s.message("assistant", [{ type: "text", text: "y" }]);
  assert.equal(maybeCompact(s, { tokenBudget: 100000 }), null);
});

test("A2 repeated automatic compaction stays bounded during a long session", () => {
  const cwd = tmp(); const dir = path.join(cwd, "s"); const s = new Session(dir);
  const cfg = cfgFor("http://unused", cwd, { model: "claude-sonnet-5", tokenBudget: 8000 });
  let compactions = 0;
  for (let i = 0; i < 240; i++) {
    const prompt = `request ${i} FACT-${i} ${"x".repeat(850)}`;
    s.startTurn(prompt); s.message("user", prompt); s.message("assistant", [{ type: "text", text: `done ${i}` }]); s.endTurn("end_turn");
    if (maybeCompact(s, cfg)) compactions++;
  }
  maybeCompact(s, cfg);
  assert.ok(compactions > 10, "the stress run crosses the budget repeatedly");
  assert.ok(estimateTokens(s.messages) < cfg.tokenBudget * 0.8, `context stayed below the trigger: ${estimateTokens(s.messages)}`);
  assert.ok(s.compaction.summary.length <= cfg.tokenBudget * 0.9, "the carried summary has a hard bound");
  assert.match(s.compaction.summary, /Owner's requests so far/); assert.match(JSON.stringify(s.messages), /FACT-239/);
  const reopened = new Session(dir, s.id);
  assert.equal(estimateTokens(reopened.messages), estimateTokens(s.messages));
});

test("/compact is local, append-only, and retains an auditable summary", () => {
  const dir = tmp(), s = new Session(dir);
  s.startTurn("inspect the parser"); s.message("user", "inspect the parser"); s.message("assistant", "I read src/parser.js"); s.endTurn("end_turn");
  const before = fs.statSync(s.file).size, event = compactNow(s, { tokenBudget: 120000 });
  assert.equal(event.manual, true); assert.ok(fs.statSync(s.file).size > before); assert.match(event.summary, /inspect the parser/);
  assert.match(s.messages[0].content, /context compacted/); assert.equal(compactNow(s, { tokenBudget: 120000 }), null);
});

// ---- A2: context pressure tiers (warning only — hcode never clears the owner's context) ---------------
test("A2 tiers: one line per tier per thread, the ladder is walked once, compaction puts it back", async () => {
  const held = [130000, 140000, 160000, 190000];
  const m = await startFakeModel((_msgs, _r, k) => ({ ...text(`turn ${k}`), usage: { in: held[k - 1] ?? 190000, out: 5 } }));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const cfg = cfgFor(m.base, cwd, { tokenBudget: 1_000_000 });   // far above the tiers: no compaction interferes
  const sink = () => ({ isTTY: false, columns: 80, text: "", write(value) { this.text += String(value); return true; } });
  const out = sink(), err = sink();
  const terminal = createUI({ out, err, env: {} });
  for (const prompt of ["a", "b", "c", "d"]) await runAgent({ cfg, settings: {}, session: s, prompt, terminal });
  const notices = lines(s.file).filter(e => e.type === "error" && e.code === "context_pressure");
  assert.deepEqual(notices.map(e => e.tier), [120000, 150000, 180000]);   // 140K said nothing new
  assert.deepEqual(notices.map(e => e.tokens), [130000, 160000, 190000]);
  assert.equal((err.text.match(/context \d/g) || []).length, 3, "one warning line per tier");
  assert.match(err.text, /⚠ context 130,000 tokens — tier 120K of 120K\/150K\/180K/);
  assert.match(err.text, /\/handoff[\s\S]*\/clear[\s\S]*--resume/);
  assert.doesNotMatch(out.text, /context 1[0-9]{2},000 tokens/, "the warning is stderr, never the transcript");
  // a compaction is the reset: the same pressure is worth saying again afterwards
  assert.equal(contextNotice(s, 190000), null);
  s.emit("compaction", { summary: "…", keeps: [], droppedSeq: [1, s.seq] });
  assert.equal(contextNotice(s, 190000).tier, 180000);
  m.close();
});

test("A2 tiers stay silent in print mode and are configurable in project settings", async () => {
  const m = await startFakeModel(() => ({ ...text("printed"), usage: { in: 200000, out: 5 } }));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const err = { isTTY: false, text: "", write(value) { this.text += String(value); return true; } };
  const terminal = createUI({ out: { isTTY: false, columns: 80, write: () => true }, err, env: {} });
  await runAgent({ cfg: cfgFor(m.base, cwd, { tokenBudget: 1_000_000 }), settings: {}, session: s, prompt: "p", quiet: true, terminal });
  assert.equal(err.text, "", "-p and pipes print nothing");
  assert.equal(lines(s.file).filter(e => e.type === "error" && e.code === "context_pressure").length, 1, "the notice is still in the thread");
  assert.deepEqual(contextTiers({ contextTiers: [90000, 40000] }), [40000, 90000]);
  assert.deepEqual(contextTiers({ contextTiers: ["nonsense"] }), CONTEXT_TIERS);
  assert.equal(contextNotice(new Session(tmp()), 39999, { contextTiers: [40000] }), null);
  m.close();
});

// ---- A5: reliability ----------------------------------------------------------------------------------
test("A5 model stream interruption → error{stream_interrupted} + turn.end{error}; thread resumable", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [{ type: "text", text: "half" }], stop: "end_turn", cutAfter: 3 } : text("whole"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 1 }), settings: {}, session: s, prompt: "go", quiet: true }), /stream (broke|ended)/);
  const rows = lines(s.file);
  assert.equal(rows.at(-1).type, "turn.end"); assert.equal(rows.at(-1).reason, "error");
  assert.ok(rows.some(e => e.type === "error" && e.code === "stream_interrupted"));
  const s2 = new Session(s.dir, s.id);
  const r = await runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 1 }), settings: {}, session: s2, prompt: "again", quiet: true });
  assert.equal(r.text, "whole");
  m.close();
});

test("A5 API errors are definite events: 401 → owner-facing setup action; 429 → api_429", async () => {
  let status = 401;
  const m = await startFakeModel(() => ({ status, body: JSON.stringify({ error: { message: "x-api-key header is required" } }) }));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true }), /hcode setup/);
  assert.ok(lines(s.file).some(e => e.type === "error" && e.code === "api_401"));
  status = 429;
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true }), /rate-limited/);
  assert.ok(lines(s.file).some(e => e.type === "error" && e.code === "api_429"));
  m.close();
});

test("A5 tool done but response lost: the retry recovers it, the tool ran once, the result is seen exactly once", async () => {
  let k2 = 0;
  const m = await startFakeModel((msgs, _r, k) => {
    if (k === 1) return { blocks: [tool("write_file", { path: "lost.txt", content: "L" })], stop: "tool_use" };
    if (k === 2 && k2++ === 0) return { blocks: [], stop: "end_turn", cutAfter: 1 };   // the response carrying the result is lost
    const results = msgs.filter(mm => Array.isArray(mm.content) && mm.content.some(b => b.type === "tool_result"));
    assert.equal(results.length, 1, "the tool result is sent exactly once");
    return text("seen");
  });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true });
  assert.equal(r.text, "seen");
  assert.equal(fs.readFileSync(path.join(cwd, "lost.txt"), "utf8"), "L");
  assert.equal(lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_result").length, 1, "the tool ran once");
  assert.equal(lines(s.file).filter(e => e.type === "error" && e.retry).length, 1, "the lost response is a definite retry event");
  // and it is still recoverable the hard way: reopening the thread sees the one result
  assert.equal(new Session(s.dir, s.id).results.size, 1);
  m.close();
});

test("A5 large output / backpressure: 5 MB of tool output is capped, truncated flag set, thread stays small", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "head -c 5000000 /dev/zero | tr '\\0' 'a'" })], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true });
  const res = lines(s.file).find(e => e.type === "item" && e.item.kind === "tool_result").item;
  assert.equal(res.truncated, true); assert.equal(res.code, "output_truncated"); assert.ok(res.output.length <= 60100); assert.ok(fs.statSync(s.file).size < 200_000);
  m.close();
});

test("A5 tool timeout and model timeout are definite events", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "sleep 10", timeout_ms: 200 })], stop: "tool_use" } : { hang: true });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const ac = new AbortController(); setTimeout(() => ac.abort(), 1500);
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true, signal: ac.signal });
  assert.equal(r.cancelled, true);
  const rows = lines(s.file);
  const timed = rows.find(e => e.type === "item" && e.item.kind === "tool_result").item;
  assert.match(timed.output, /killed: timeout/); assert.equal(timed.code, "timeout"); assert.equal(timed.retryable, true);
  assert.equal(rows.at(-1).reason, "cancelled");
  m.close();
});

test("A5 duplicate tool_use ids from the model never collide: item ids are hcode's own", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("read_file", { path: "p.txt" }, "dup"), tool("list_dir", { path: "." }, "dup")], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); fs.writeFileSync(path.join(cwd, "p.txt"), "p"); const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true });
  const ids = new Set(lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_call").map(e => e.item.id));
  assert.equal(ids.size, 2); assert.equal(s.results.size, 2);
  m.close();
});

test("A5 offline brain refuses tools+stream → one non-streaming retry, same event shape, streamFallback recorded", async () => {
  const m = await startFakeModel((msgs, req, k) => {
    if (req.stream) return { status: 500, body: JSON.stringify({ error: { message: "Cannot use tools with stream" } }) };
    const last = msgs.at(-1);
    if (typeof last.content === "string") return { json: { content: [{ type: "text", text: "writing" }, { type: "tool_use", id: "tu1", name: "write_file", input: { path: "off.txt", content: "O" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 } } };
    return { json: { content: [{ type: "text", text: "done offline" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } } };
  });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s")); const texts = []; const live = [];
  const r = await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true, onText: t => texts.push(t), onEvent: ev => live.push(ev) });
  assert.equal(r.text, "done offline"); assert.deepEqual(texts, ["writing", "done offline"]);
  assert.equal(fs.readFileSync(path.join(cwd, "off.txt"), "utf8"), "O");
  assert.equal(m.calls.filter(c => c.stream).length, 2); assert.equal(m.calls.filter(c => !c.stream).length, 2, "exactly one retry per step");
  const rows = lines(s.file);
  assert.equal(rows.filter(e => e.type === "error" && e.code === "recovered" && e.streamFallback === true).length, 2);
  assert.ok(live.some(e => e.type === "text" && e.delta === "writing") && !rows.some(e => e.type === "text"));
  assert.equal(rows.at(-1).reason, "end_turn"); assert.deepEqual(rows.at(-1).usage, { in: 8, out: 5, cacheWrite: 0, cacheRead: 0 });
  m.close();
});

test("A5 slow brain: headers after 2 s with HCODE_TIMEOUT_MS=500 → error{timeout} (not 'cannot reach'); 1 s with 5 s budget → ok", async () => {
  const m = await startFakeModel((_m, _r, k) => ({ ...text("slow ok"), delay: k === 1 ? 2000 : 1000 }));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd, { timeoutMs: 500 }), settings: {}, session: s, prompt: "go", quiet: true }), err => { assert.equal(err.code, "timeout"); assert.match(err.message, /too slow or too busy/); assert.doesNotMatch(err.message, /cannot reach/); return true; });
  const rows = lines(s.file);
  assert.ok(rows.some(e => e.type === "error" && e.code === "timeout")); assert.equal(rows.at(-1).reason, "error"); assert.equal(rows.at(-1).error, "timeout");
  const r = await runAgent({ cfg: cfgFor(m.base, cwd, { timeoutMs: 5000 }), settings: {}, session: s, prompt: "again", quiet: true });
  assert.equal(r.text, "slow ok");
  m.close();
});

test("lean prompt for a local brain: compact tool schema + short system prompt (< 1.5k tokens); external brains unchanged", async () => {
  const seen = [];
  const m = await startFakeModel((_m, req) => { seen.push(req); return text("ok"); });
  const cwd = tmp(); fs.writeFileSync(path.join(cwd, "HCODE.md"), "# notes\n" + "rule line\n".repeat(400));
  await runAgent({ cfg: cfgFor(m.base, cwd, { model: "qwen3-4b", effort: "medium" }), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true });
  await runAgent({ cfg: cfgFor(m.base, cwd, { model: "claude-sonnet-5", effort: "medium" }), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true });
  const est = x => Math.ceil(JSON.stringify(x).length / 3.5);
  const lean = est(seen[0].system) + est(seen[0].tools), full = est(seen[1].system) + est(seen[1].tools);
  assert.ok(lean < 1500, `lean prompt ${lean} tokens`); assert.ok(full > lean);
  assert.equal(seen[0].tools.length, 11); assert.ok(!seen[0].tools[0].input_schema.additionalProperties === false || seen[0].tools[0].input_schema.additionalProperties === undefined);
  const plan = seen[0].tools.find(item => item.name === "update_plan");
  assert.equal(plan.input_schema.properties.steps.type, "array"); assert.equal(plan.input_schema.properties.steps.items.properties.status.type, "string");
  assert.match(seen[1].system, /Project instructions/); assert.doesNotMatch(seen[0].system, /Project instructions/);
  assert.equal(seen[0].output_config, undefined, "unknown compatible gateways never receive a native-only field");
  assert.deepEqual(seen[1].output_config, { effort: "medium" });
  m.close();
});

test("A5 bounded backoff: 429 then 500 then success — at most 3 tries, retry-after honoured, each retry a definite event", async () => {
  let n = 0;
  const m = await startFakeModel(() => { n++; return n === 1 ? { status: 429, body: "rate limited", headers: { "retry-after": "0" } } : n === 2 ? { status: 500, body: "boom" } : text("third time"); });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const t0 = Date.now();
  const r = await runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 3 }), settings: {}, session: s, prompt: "go", quiet: true });
  assert.equal(r.text, "third time"); assert.equal(n, 3);
  assert.ok(Date.now() - t0 < 12000);
  const retries = lines(s.file).filter(e => e.type === "error" && e.code === "recovered" && e.retry);
  assert.equal(retries.length, 2); assert.deepEqual(retries.map(e => e.retry.attempt), [1, 2]);
  assert.equal(retries[0].retry.status, 429); assert.equal(retries[1].retry.status, 500);
  assert.equal(lines(s.file).at(-1).reason, "end_turn");
  m.close();
});

test("A5 exhausted 429 falls back in the same turn and records the active backup model", async () => {
  const seen = [];
  const m = await startFakeModel((_messages, request) => {
    if (request._route === "/v1/model-capabilities") return { json: { v: 1, model: request.model, contextTokens: 64000, agenticTier: "agentic" } };
    if (request._route === "/v1/messages" && request.max_tokens === 1 && request.messages?.[0]?.content?.startsWith("hcode capability probe")) return { ...text("p"), headers: { "x-hcode-context-tokens": "64000", "x-hcode-agentic-tier": "agentic", "x-hcode-capability-nonce": request._headers["x-hcode-capability-nonce"] } };
    seen.push(request.model);
    return request.model === "primary-model" ? { status: 429, body: "pool cap reached", headers: { "retry-after": "0" } } : text("continued on backup");
  });
  const cwd = tmp(), s = new Session(path.join(cwd, "s"), null, { cwd, model: "primary-model" });
  const cfg = cfgFor(m.base, cwd, { model: "primary-model", fallbackModels: ["deepseek-v4-flash"], maxAttempts: 2 });
  const result = await runAgent({ cfg, settings: {}, session: s, prompt: "keep the same task", quiet: true });
  assert.equal(result.text, "continued on backup");
  assert.deepEqual(seen, ["primary-model", "primary-model", "deepseek-v4-flash"]);
  assert.equal(cfg.model, "deepseek-v4-flash", "later tool rounds and turns stay on the working model");
  const rows = lines(s.file), fallback = rows.find(row => row.type === "error" && row.code === "model_fallback");
  assert.equal(fallback.activeModel, "deepseek-v4-flash"); assert.equal(fallback.modelFallback.reason, "out_of_budget");
  assert.equal(rows.filter(row => row.type === "turn.start").length, 1, "fallback continues rather than opening a new turn");
  assert.equal(rows.at(-1).reason, "end_turn");
  m.close();
});

test("A5 cross-provider chain verifies every candidate and preserves task plus cost identity", async () => {
  const probes = [], taskCalls = [];
  const m = await startFakeModel((messages, request) => {
    if (request._route === "/v1/model-capabilities") return { json: { v: 1, model: request.model, contextTokens: 200000, agenticTier: "agentic" } };
    if (request.max_tokens === 1 && messages?.[0]?.content?.startsWith("hcode capability probe")) {
      probes.push(request.model);
      return { ...text("p"), headers: { "x-hcode-context-tokens": "200000", "x-hcode-agentic-tier": "agentic", "x-hcode-capability-nonce": request._headers["x-hcode-capability-nonce"] } };
    }
    taskCalls.push({ model: request.model, prompt: messages.at(-1)?.content, agent: request._headers["x-hcode-agent-id"], task: request._headers["x-hcode-task-id"] });
    return request.model === "claude-sonnet-5" ? text("same objective continued") : { status: 429, body: "provider quota", headers: { "retry-after": "0" } };
  });
  const cwd = tmp(), s = new Session(path.join(cwd, "s"), null, { cwd, model: "deepseek-v4-pro" });
  const cfg = cfgFor(m.base, cwd, { model: "deepseek-v4-pro", fallbackModels: ["deepseek-v4-flash", "claude-sonnet-5"], maxAttempts: 1, agentId: "007", taskId: "comsite-night" });
  const result = await runAgent({ cfg, settings: {}, session: s, prompt: "finish comsite product page", quiet: true });
  assert.equal(result.text, "same objective continued");
  assert.deepEqual(probes, ["deepseek-v4-flash", "claude-sonnet-5"]);
  assert.deepEqual(taskCalls.map(call => call.model), ["deepseek-v4-pro", "deepseek-v4-flash", "claude-sonnet-5"]);
  assert.ok(taskCalls.every(call => call.agent === "007" && call.task === "comsite-night"));
  assert.equal(taskCalls.at(-1).prompt, "finish comsite product page");
  assert.equal(lines(s.file).filter(row => row.type === "turn.start").length, 1);
  assert.equal(cfg.model, "claude-sonnet-5");
  m.close();
});

test("A5 manifest missing, declaration mismatch, and low tier are refused; objective survives", async () => {
  for (const [kind, backup, code, pattern] of [
    ["missing", "mystery-model", "model_fallback_unobserved", /UNOBSERVED/],
    ["mismatch", "lying-model", "model_fallback_unobserved", /UNOBSERVED/],
    ["low", "qwen3-4b-q4-k-m", "model_fallback_below_minimum", /below floor/],
  ]) {
    const m = await startFakeModel((_messages, request) => {
      if (request._route === "/v1/model-capabilities") return kind === "missing" ? { status: 404, body: "absent" } : { json: { v: 1, model: backup, contextTokens: kind === "low" ? 2000 : 64000, agenticTier: kind === "low" ? "basic" : "agentic" } };
      if (request._route === "/v1/messages" && request.max_tokens === 1) return { ...text("p"), headers: { "x-hcode-context-tokens": kind === "mismatch" ? "8000" : "2000", "x-hcode-agentic-tier": kind === "low" ? "basic" : "agentic", "x-hcode-capability-nonce": request._headers["x-hcode-capability-nonce"] } };
      return { status: 429, body: "out of budget", headers: { "retry-after": "0" } };
    });
    const cwd = tmp(), s = new Session(path.join(cwd, "s"), null, { cwd, model: "deepseek-v4-pro" });
    s.emit("objective.started", { objective: { v: 1, mission: "keep this exact task", acceptance: ["finish"], checkpoint: "retry" } });
    await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd, { model: "deepseek-v4-pro", fallbackModels: [backup], maxAttempts: 1 }), settings: {}, session: s, prompt: "continue", quiet: true }), pattern);
    const rows = lines(s.file);
    assert.ok(rows.some(row => row.type === "error" && row.code === code));
    assert.equal(rows.at(-1).reason, "error");
    assert.equal(new Session(s.dir, s.id).objective.mission, "keep this exact task");
    assert.equal(m.calls.filter(call => call.max_tokens !== 1 && call._route === "/v1/messages").length, 1, "a refused fallback never receives the task");
    m.close();
  }
});

test("A5 retry is bounded and never duplicates a side effect: 4 × 500 → 3 tries then error{api_500}", async () => {
  let n = 0;
  const m = await startFakeModel(() => { n++; return { status: 500, body: "still broken" }; });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 3 }), settings: {}, session: s, prompt: "go", quiet: true }), /trouble/);
  assert.equal(n, 3, "bounded at 3 attempts");
  const rows = lines(s.file);
  assert.equal(rows.filter(e => e.type === "error" && e.retry).length, 2);
  assert.ok(rows.some(e => e.type === "error" && e.code === "api_500")); assert.equal(rows.at(-1).reason, "error");
  m.close();
});

test("A5 a broken stream is retried and the thread keeps exactly one answer (live text is discarded, disk is not duplicated)", async () => {
  let n = 0;
  const m = await startFakeModel(() => { n++; return n === 1 ? { ...text("half"), cutAfter: 3 } : text("whole answer"); });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s")); const live = [];
  const r = await runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 3 }), settings: {}, session: s, prompt: "go", quiet: true, onEvent: ev => live.push(ev) });
  assert.equal(r.text, "whole answer"); assert.equal(n, 2);
  const rows = lines(s.file);
  assert.equal(rows.filter(e => e.type === "item" && e.item.kind === "message" && e.item.role === "assistant").length, 1, "one answer on disk");
  const retry = rows.find(e => e.type === "error" && e.retry);
  assert.equal(retry.retry.reason, "stream_interrupted"); assert.equal(retry.retry.discarded, 4); assert.match(retry.message, /discarded/);
  assert.equal(rows.at(-1).reason, "end_turn");
  assert.equal(backoffMs(1, "2"), 2000); assert.ok(backoffMs(1, null) >= 1000 && backoffMs(1, null) < 1300);
  assert.ok(backoffMs(3, null) >= 4000 && backoffMs(3, null) <= 8300);
  assert.equal(backoffMs(1, "600"), 60000, "a huge retry-after is capped");
  m.close();
});

test("A5 a stream that keeps breaking is bounded: 3 tries then error{stream_interrupted}", async () => {
  let n = 0;
  const m = await startFakeModel(() => { n++; return { ...text("half"), cutAfter: 3 }; });
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await assert.rejects(runAgent({ cfg: cfgFor(m.base, cwd, { maxAttempts: 3 }), settings: {}, session: s, prompt: "go", quiet: true }), /stream/);
  assert.equal(n, 3);
  assert.ok(lines(s.file).some(e => e.type === "error" && e.code === "stream_interrupted"));
  m.close();
});

test("A5/A8 HC-10: a huge tool result keeps head AND tail in the thread, with the omitted count in the middle", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "echo BEGIN-MARKER; head -c 4000000 /dev/zero | tr '\\0' 'a'; echo; echo END-MARKER" })], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd), settings: {}, session: s, prompt: "go", quiet: true });
  const res = lines(s.file).find(e => e.type === "item" && e.item.kind === "tool_result").item;
  assert.equal(res.truncated, true);
  assert.match(res.output, /BEGIN-MARKER/); assert.match(res.output, /END-MARKER/);
  assert.match(res.output, /omitted from the middle/);
  assert.ok(res.output.length <= 60100); assert.ok(fs.statSync(s.file).size < 200_000);
  // and that is exactly what the model is sent
  const sent = m.calls.at(-1).messages.flatMap(mm => Array.isArray(mm.content) ? mm.content : []).filter(b => b.type === "tool_result");
  assert.match(sent[0].content, /BEGIN-MARKER[\s\S]*END-MARKER/);
  m.close();
});

test("A2 local brain: the budget is small enough for a 4k window — a resumed thread is summary + latest turn", async () => {
  const seen = [];
  const m = await startFakeModel((msgs, req, k) => { seen.push(req); return text("turn " + k + " " + "detail ".repeat(300)); });
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const s = new Session(dir, null, { cwd, model: "qwen3-4b" });
  const cfg = cfgFor(m.base, cwd, { model: "qwen3-4b" });
  assert.equal(effectiveBudget(cfg), LOCAL_BUDGET);
  for (const p of ["one", "two", "three", "four"]) await runAgent({ cfg, settings: {}, session: new Session(dir, s.id), prompt: p, quiet: true });
  const est = x => Math.ceil(JSON.stringify(x).length / 3.5);
  const last = seen.at(-1);
  assert.ok(est(last.messages) + est(last.system) + est(last.tools) < 4096, `prompt ${est(last.messages) + est(last.system) + est(last.tools)} tokens must fit a 4k window`);
  const comp = lines(new Session(dir, s.id).file).filter(e => e.type === "compaction");
  assert.ok(comp.length >= 1, "the small window compacts by itself");
  assert.ok(comp.at(-1).summary.length < 4000, "the carried summary is bounded too");
  assert.match(String(last.messages[0].content), /context compacted/);
  assert.ok(last.max_tokens <= 1024, "the answer must fit the window too");
  m.close();
});
