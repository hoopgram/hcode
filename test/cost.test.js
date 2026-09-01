import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanCosts, formatCost, costUnits, shortSessionId, COST_WEIGHTS, contextMeter, formatSpend, meterBand, sessionSpend, spendDollars } from "../src/cost.js";
import { readPrices } from "../src/config.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const turnEnd = (seq, ts, usage) => JSON.stringify({ v: 2, ts, seq, turn: "t-0" + seq, type: "turn.end", reason: "done", usage });

// four shapes a real sessions directory contains: a healthy thread whose tail was rewritten by a
// crash, a pre-cache thread, a thread with half a line in it, a 0.1.0 file, and an old thread.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cost-test-"));
  const write = (id, lines) => fs.writeFileSync(path.join(dir, id + ".jsonl"), lines.join("\n") + "\n");

  const big = turnEnd(4, NOW - DAY, { in: 500, out: 300, cacheWrite: 1000, cacheRead: 8000 });
  write("20260830120000-bbbb", [
    JSON.stringify({ v: 2, type: "header", id: "20260830120000-bbbb", cwd: "/tmp/p", startedAt: NOW - DAY, runner: "hcode" }),
    JSON.stringify({ v: 2, ts: NOW - DAY, seq: 1, turn: "t-01", type: "turn.start", prompt: "hello" }),
    turnEnd(2, NOW - DAY, { in: 1000, out: 200, cacheWrite: 4000, cacheRead: 0 }),
    JSON.stringify({ v: 2, ts: NOW - DAY, seq: 3, turn: "t-02", type: "item", item: { id: "i-1", kind: "message", role: "assistant", content: "the log calls that row turn.end" } }),
    big, big,                                    // recovery rewrote the tail: same seq twice on disk
    turnEnd(6, NOW - DAY, { in: 200, out: 100, cacheWrite: 0, cacheRead: 20000 }),
  ]);
  write("20260830130000-cccc", [
    JSON.stringify({ v: 2, type: "header", id: "20260830130000-cccc", cwd: "/tmp/p", startedAt: NOW - 2 * DAY, runner: "hcode" }),
    turnEnd(2, NOW - 2 * DAY, { in: 9000, out: 400 }),                       // pre-0.5: no cache fields at all
  ]);
  write("20260830140000-dddd", [
    JSON.stringify({ v: 2, type: "header", id: "20260830140000-dddd", cwd: "/tmp/p", startedAt: NOW - 3 * DAY, runner: "hcode" }),
    '{"v":2,"ts":1,"seq":2,"type":"turn.end","reason":"done","usa',       // killed mid-write
    turnEnd(3, NOW - 3 * DAY, { in: 100, out: 10, cacheWrite: 0, cacheRead: 1000 }),
  ]);
  write("20260830150000-eeee", [                                            // 0.1.0 file: no turn.end at all
    JSON.stringify({ header: true, id: "20260830150000-eeee", cwd: "/tmp/p", startedAt: "2026-08-30T15:00:00.000Z" }),
    JSON.stringify({ ts: "2026-08-30T15:00:01.000Z", role: "user", content: "hi" }),
    JSON.stringify({ ts: "2026-08-30T15:00:02.000Z", role: "assistant", content: "hello" }),
  ]);
  write("20260801120000-aaaa", [                                            // outside a --days 7 window
    JSON.stringify({ v: 2, type: "header", id: "20260801120000-aaaa", cwd: "/tmp/p", startedAt: NOW - 40 * DAY, runner: "hcode" }),
    turnEnd(2, NOW - 40 * DAY, { in: 1000, out: 100 }),
  ]);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a session\n");
  return dir;
}

test("scanCosts counts each seq once, splits the four classes, and never double-counts a rewritten tail", () => {
  const dir = fixture();
  const report = scanCosts(dir, { now: NOW });
  assert.equal(report.sessions.length, 5);
  assert.equal(report.turns, 6);                                            // 3 + 1 + 1 + 0 + 1, the duplicate seq dropped
  assert.deepEqual(report.totals, { input: 11800, output: 1110, cacheWrite: 5000, cacheRead: 29000, units: 26500 });

  const by = Object.fromEntries(report.sessions.map(s => [s.id.slice(-4), s]));
  assert.deepEqual([by.bbbb.turns, by.bbbb.input, by.bbbb.output, by.bbbb.cacheWrite, by.bbbb.cacheRead], [3, 1700, 600, 5000, 28000]);
  assert.equal(by.bbbb.peak, 20200);                                        // in + cacheWrite + cacheRead of the fattest turn
  assert.equal(by.bbbb.units, 13750);
  assert.equal(report.corrupt, 1);                                          // the half-written turn.end, skipped like Session.load does
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pre-cache session reads as zeros and a 0.1.0 file does not crash the scan", () => {
  const dir = fixture();
  const by = Object.fromEntries(scanCosts(dir, { now: NOW }).sessions.map(s => [s.id.slice(-4), s]));
  assert.deepEqual([by.cccc.input, by.cccc.output, by.cccc.cacheWrite, by.cccc.cacheRead], [9000, 400, 0, 0]);
  assert.equal(by.cccc.peak, 9000);                                         // no cache fields: the prompt is the uncached input
  assert.equal(by.cccc.units, 11000);
  assert.equal(by.eeee.turns, 0);
  assert.equal(by.eeee.units, 0);
  assert.equal(by.eeee.startedAt, Date.parse("2026-08-30T15:00:00.000Z"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("whales are ordered by cost units and --days filters on the session start", () => {
  const dir = fixture();
  assert.deepEqual(scanCosts(dir, { now: NOW }).sessions.map(s => s.id.slice(-4)), ["bbbb", "cccc", "aaaa", "dddd", "eeee"]);
  const week = scanCosts(dir, { now: NOW, days: 7 });
  assert.deepEqual(week.sessions.map(s => s.id.slice(-4)), ["bbbb", "cccc", "dddd", "eeee"]);
  assert.equal(week.skipped, 1);
  assert.deepEqual(week.totals, { input: 10800, output: 1010, cacheWrite: 5000, cacheRead: 29000, units: 25000 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("costUnits weighs the classes against each other and never claims dollars", () => {
  assert.deepEqual(COST_WEIGHTS, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
  assert.equal(costUnits({ input: 100, output: 100, cacheWrite: 100, cacheRead: 100 }), 735);
  const dir = fixture();
  const text = formatCost(scanCosts(dir, { now: NOW }));
  assert.ok(!text.includes("$"), "no gateway price list exists, so no dollar figure may appear");
  assert.match(text, /relative weights, not dollars/);
  assert.match(text, /cost units\s+26,500/);
  assert.match(text, /input \(uncached\)\s+11,800/);
  assert.match(text, /cache read\s+29,000/);
  const whales = text.slice(text.indexOf("whales")).split("\n").slice(2);
  assert.match(whales[0], /^ {2}20260830-bbbb\s+3\s+20,200\s+28,000\s+13,750$/);
  assert.match(whales[1], /^ {2}20260830-cccc\s+1\s+9,000\s+0\s+11,000$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty or missing sessions directory is a sentence, not a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cost-empty-"));
  assert.match(formatCost(scanCosts(dir, { now: NOW })), /0 sessions/);
  assert.match(formatCost(scanCosts(path.join(dir, "nope"), { now: NOW })), /nothing recorded/);
  assert.equal(shortSessionId("20260830120000-bbbb"), "20260830-bbbb");
  assert.equal(shortSessionId("legacy"), "legacy");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the live session meter -----------------------------------------------------------------------
test("a resumed meter restores provider-reported token classes from the thread", () => {
  assert.deepEqual(sessionSpend([
    { type: "turn.end", usage: { in: 100, out: 20, cacheWrite: 30, cacheRead: 400 } },
    { type: "item", usage: { in: 999 } },
    { type: "turn.end", usage: { input: 50, output: 5 } },
  ]), { input: 150, output: 25, cacheWrite: 30, cacheRead: 400 });
});

test("the context meter bands at 60% and 80%, and the top band only ever says /handoff", () => {
  const spend = { input: 1000, output: 200, cacheWrite: 400, cacheRead: 20000 };
  const calm = contextMeter({ tokens: 40000, window: 120000, spend, model: "deepseek-v4-pro", effort: "high", sessionMode: "savetoken", permission: "ask" });
  assert.equal(calm.band, "calm");
  assert.equal(calm.text, "↓ 21.6K tokens · Context 67% left · 40K/120K · 4.5K cu");
  assert.deepEqual(calm.identity, { model: "deepseek-v4-pro", effort: "high", sessionMode: "savetoken", permission: "ask" });
  assert.doesNotMatch(calm.text, /handoff/);

  assert.equal(contextMeter({ tokens: 71999, window: 120000 }).band, "calm", "just under 60% is still calm");
  assert.equal(contextMeter({ tokens: 72000, window: 120000 }).band, "warn", "60% is the warning band");
  assert.equal(contextMeter({ tokens: 95999, window: 120000 }).band, "warn");

  const danger = contextMeter({ tokens: 96000, window: 120000, spend });
  assert.equal(danger.band, "danger", "80% — the same line the compactor acts on");
  assert.match(danger.text, /^↓ 21\.6K tokens · Context 20% left · 96K\/120K · 4\.5K cu · \/handoff$/, "it advises, it never acts");
  assert.deepEqual([meterBand(0), meterBand(0.6), meterBand(0.8), meterBand(9)], ["calm", "warn", "danger", "danger"]);
  assert.equal(contextMeter({ tokens: 5000, window: 0 }).text, "↓ 0 tokens · Context 5K", "no budget, no percentage invented");
});

test("dollars appear only when the owner supplied a price list; otherwise cost units", () => {
  const spend = { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 };
  assert.equal(spendDollars(spend, null), null, "no price list, no invented money");
  assert.equal(formatSpend(spend, null), `${Math.round(costUnits(spend) / 100) / 10}K cu`);

  const prices = readPrices('{"input":3,"cacheWrite":3.75,"cacheRead":0.3,"output":15}');
  assert.deepEqual({ ...prices }, { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 });
  assert.equal(spendDollars(spend, prices), 18);
  assert.equal(formatSpend(spend, prices), "$18.00");
  assert.match(contextMeter({ tokens: 10, window: 100, spend, prices }).text, /\$18\.00$/);
  assert.equal(formatSpend({ input: 100, output: 0, cacheWrite: 0, cacheRead: 0 }, prices), "$0.0003", "a tiny session is not rounded away to $0.00");

  assert.equal(readPrices('{"input":"free"}'), null, "a malformed price list is dropped whole, never half-applied");
  assert.equal(readPrices('{"input":-1,"output":2}'), null);
  assert.equal(readPrices("not json"), null);
  assert.equal(readPrices({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }), null, "all zeros is not a price list");
  assert.deepEqual({ ...readPrices({ output: 15 }) }, { input: 0, cacheWrite: 0, cacheRead: 0, output: 15 }, "a partial list is filled with zeros, not rejected");
});
