// Bounded read concurrency: only calls that need no decision overlap, and only their waiting overlaps.
// The evidence is the fake Hoop's own in-flight counter, not a wall clock guess.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";
import { createUI } from "../src/ui.js";
import { startFakeModel, text, tool } from "./fake-model.js";

const DELAY = 200;

// A slow read tool that is honest about concurrency: it counts how many requests are in flight at once.
async function startSlowReads() {
  const state = { inFlight: 0, peak: 0, served: [] };
  const server = http.createServer((req, res) => {
    state.inFlight++; state.peak = Math.max(state.peak, state.inFlight);
    const query = new URL(req.url, "http://x").searchParams.get("q") || "";
    setTimeout(() => {
      state.inFlight--; state.served.push(query);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: query }));
    }, DELAY);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => server.close();
  return state;
}

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-par-"));
  fs.mkdirSync(path.join(cwd, ".hcode"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  return cwd;
}
const cfgFor = (base, cwd, hoopUrl, extra = {}) =>
  ({ baseUrl: base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 4, bashTimeoutMs: 2000, cwd, mode: "auto", hoopUrl, hoopName: "test-hoop", ...extra });
const read = q => tool("hoop_memory", { query: q });
const results = model => model.lastTools().map(block => block.content);

test("three reads that need no decision run at once and still answer in the model's order", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("alpha"), read("beta"), read("gamma")], stop: "tool_use" }
    : text("all three read"));
  const cwd = workspace();
  const sink = () => ({ isTTY: false, columns: 80, text: "", write(value) { this.text += String(value); return true; } });
  const out = sink(), err = sink();
  const terminal = createUI({ out, err, env: {} });
  const started = Date.now();
  try {
    const run = await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "look", terminal });
    const elapsed = Date.now() - started;
    assert.equal(run.text, "all three read");
    assert.equal(hoop.peak, 3, `three reads were in flight together, saw ${hoop.peak}`);
    assert.ok(elapsed < DELAY * 3, `concurrent reads finish in about one delay, took ${elapsed}ms`);
    const answers = results(model);
    assert.equal(answers.length, 3);
    assert.deepEqual(answers.map(body => JSON.parse(body.split("\n").slice(1).join("\n")).answer), ["alpha", "beta", "gamma"]);
    // the plain sink stays whole lines in order: three completed reads, then the answer
    assert.doesNotMatch(out.text, /[\x1b\r]/, "no control bytes reach a pipe");
    assert.match(out.text, /^(• Completed · \d+ms\n){3}all three read\n/);
    // and each call is billed for its own waiting, not for the batch's
    for (const [, ms] of out.text.matchAll(/· (\d+)ms/g)) assert.ok(Number(ms) < DELAY * 2, `one call's duration is its own: ${ms}ms`);
  } finally { model.close(); hoop.close(); }
});

test("a write is never overtaken: the reads around it stay serial", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("before"), tool("write_file", { path: "note.txt", content: "N" }), read("after")], stop: "tool_use" }
    : text("mixed batch done"));
  const cwd = workspace();
  const started = Date.now();
  try {
    await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "mix", quiet: true });
    const elapsed = Date.now() - started;
    assert.equal(hoop.peak, 1, "a write between two reads keeps them one after another");
    assert.ok(elapsed >= DELAY * 2, `both reads waited in turn, took ${elapsed}ms`);
    assert.equal(fs.readFileSync(path.join(cwd, "note.txt"), "utf8"), "N");
    assert.deepEqual(hoop.served, ["before", "after"]);
    const answers = results(model);
    assert.equal(answers.length, 3);
    assert.match(answers[1], /note\.txt/);
  } finally { model.close(); hoop.close(); }
});

test("a read the owner must approve is asked about alone, in order, and never batched", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("one"), read("two"), read("three")], stop: "tool_use" }
    : text("asked for each"));
  const cwd = workspace(); const asked = [];
  try {
    await runAgent({
      cfg: cfgFor(model.base, cwd, hoop.url, { agencyLevel: 0 }), settings: {}, session: new Session(path.join(cwd, "s")),
      prompt: "ask first", quiet: true,
      confirm: async (_name, input) => { assert.equal(hoop.inFlight, 0, "nothing runs while a human is being asked"); asked.push(input.query); return true; },
    });
    assert.deepEqual(asked, ["one", "two", "three"]);
    assert.equal(hoop.peak, 1, "approved calls still run one at a time when each needed a decision");
    assert.deepEqual(results(model).length, 3);
  } finally { model.close(); hoop.close(); }
});

test("the owner can switch concurrency off in settings or in the environment", async () => {
  for (const [label, settings, env] of [["settings", { parallelTools: false }, undefined], ["environment", {}, "0"]]) {
    const hoop = await startSlowReads();
    const model = await startFakeModel((_messages, _request, turn) => turn === 1
      ? { blocks: [read("x"), read("y")], stop: "tool_use" }
      : text("serial"));
    const cwd = workspace();
    const before = process.env.HCODE_PARALLEL_TOOLS;
    if (env === undefined) delete process.env.HCODE_PARALLEL_TOOLS; else process.env.HCODE_PARALLEL_TOOLS = env;
    try {
      await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings, session: new Session(path.join(cwd, "s")), prompt: "off", quiet: true });
      assert.equal(hoop.peak, 1, `${label}: concurrency is off`);
      assert.deepEqual(hoop.served, ["x", "y"]);
    } finally {
      if (before === undefined) delete process.env.HCODE_PARALLEL_TOOLS; else process.env.HCODE_PARALLEL_TOOLS = before;
      model.close(); hoop.close();
    }
  }
});

// The live activity row holds one line at a time. A batch must therefore say itself once and say how big it
// is, or the owner watching four reads is told about whichever one happened to start last.
test("a batch tells the owner it is a batch, in one row, instead of four rows overwriting each other", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("one"), read("two"), read("three")], stop: "tool_use" }
    : text("batch shown"));
  const cwd = workspace();
  const shown = [];
  const composer = { print() {}, setActivity: (label, kind) => shown.push({ label, kind }), clearActivity: () => shown.push({ label: null }) };
  const sink = () => ({ isTTY: true, columns: 80, text: "", write(value) { this.text += String(value); return true; } });
  const terminal = createUI({ out: sink(), err: sink(), env: { TERM: "xterm" } });
  terminal.attachComposer(composer);
  try {
    await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "batch", terminal });
    const rows = shown.filter(row => row.label).map(row => row.label);
    assert.equal(rows.length, 1, `one row for the whole batch, saw ${rows.length}: ${rows.join(" | ")}`);
    assert.match(rows[0], /\+2 more$/, `the row counts the calls waiting beside it: ${rows[0]}`);
    assert.equal(hoop.peak, 3, "and the three really did overlap");
  } finally { model.close(); hoop.close(); }
});

test("a lone call still says only its own words, with no count", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("only")], stop: "tool_use" }
    : text("one shown"));
  const cwd = workspace();
  const shown = [];
  const composer = { print() {}, setActivity: label => shown.push(label), clearActivity() {} };
  const sink = () => ({ isTTY: true, columns: 80, text: "", write(value) { this.text += String(value); return true; } });
  const terminal = createUI({ out: sink(), err: sink(), env: { TERM: "xterm" } });
  terminal.attachComposer(composer);
  try {
    await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "one", terminal });
    assert.equal(shown.length, 1);
    assert.doesNotMatch(shown[0], /more$/, `a single call is not a batch: ${shown[0]}`);
  } finally { model.close(); hoop.close(); }
});

test("an identical read repeated in one step replays the first result instead of running twice", async () => {
  const hoop = await startSlowReads();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [read("same"), read("same"), read("other")], stop: "tool_use" }
    : text("replayed"));
  const cwd = workspace();
  try {
    await runAgent({ cfg: cfgFor(model.base, cwd, hoop.url), settings: {}, session: new Session(path.join(cwd, "s")), prompt: "dup", quiet: true });
    assert.deepEqual(hoop.served, ["same", "other"], "the duplicate never reached the tool");
    const answers = results(model);
    assert.equal(answers.length, 3);
    assert.equal(answers[0], answers[1]);
  } finally { model.close(); hoop.close(); }
});
