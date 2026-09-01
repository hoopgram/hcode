import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runAgent, systemPrompt } from "../src/agent.js";
import { Session } from "../src/session.js";
import { nativeEffortConfig, thinkingConfig, sseEvents } from "../src/api.js";
import { startFakeModel, text, tool } from "./fake-model.js";
import { createUI } from "../src/ui.js";

// A tiny fake Messages API: turn 1 asks to write a file, turn 2 says done.
function sse(events) { return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function turn(blocks, stop) {
  const ev = [{ type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 } } }];
  blocks.forEach((b, i) => {
    if (b.type === "text") { ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }); }
    else if (b.type === "thinking") { ev.push({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }); ev.push({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } }); if (b.signature) ev.push({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: b.signature } }); }
    else { ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }); ev.push({ type: "message_stop" });
  return sse(ev);
}
let calls = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", d => body += d); req.on("end", () => {
    const msgs = JSON.parse(body).messages; calls.push(msgs);
    const last = msgs[msgs.length - 1];
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last.role === "user" && typeof last.content === "string")
      res.end(turn([{ type: "text", text: "writing" }, { type: "tool_use", id: "t1", name: "write_file", input: { path: "out.txt", content: "hello" } }, { type: "tool_use", id: "t2", name: "bash", input: { command: "echo hi | tee command.txt" } }], "tool_use"));
    else res.end(turn([{ type: "text", text: "done: " + last.content.map(c => c.content).join(" | ") }], "end_turn"));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const mk = mode => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-a-"));
  fs.mkdirSync(path.join(cwd, ".hcode"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  return { cfg: { baseUrl: base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 5, bashTimeoutMs: 1000, cwd, mode }, cwd };
};

test("portable effort uses the native field only on compatible Claude models", () => {
  assert.deepEqual(nativeEffortConfig("claude-sonnet-5", "medium"), { effort: "medium" });
  assert.equal(nativeEffortConfig("deepseek-v4-pro", "medium"), null);
  assert.match(systemPrompt({ cwd: process.cwd(), mode: "ask", effort: "low", model: "deepseek-v4-pro" }), /Reasoning effort: low/);
});

test("effort low switches deepseek reasoning off; other tiers and other brains stay untouched", () => {
  assert.deepEqual(thinkingConfig("deepseek-v4-pro", "low"), { type: "disabled" });
  assert.deepEqual(thinkingConfig("deepseek-v4-flash", "low"), { type: "disabled" });
  assert.equal(thinkingConfig("deepseek-v4-pro", "medium"), null);
  assert.equal(thinkingConfig("deepseek-v4-pro", "high"), null);
  assert.equal(thinkingConfig("claude-sonnet-5", "low"), null);   // claude has the native effort field
  assert.equal(thinkingConfig("glm-5.3", "low"), null);           // unprobed gateways keep the prompt tier
});

test("an explicit public search runs the sourced web tool instead of falling back to Hoop memory", async () => {
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: [tool("web_search", { query: "site:youtube.com anope song", max_results: 3 })], stop: "tool_use" }
    : text("Found it from the returned YouTube source."));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-web-agent-")); const calls = [];
  try {
    const result = await runAgent({ cfg: { ...mk("auto").cfg, baseUrl: model.base, cwd }, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "搜索 youtube anope这首歌", quiet: true,
      webSearch: async (query, options) => { calls.push({ query, options }); return "1. Anope\n   https://youtube.com/watch?v=abc"; } });
    assert.match(result.text, /YouTube source/); assert.equal(calls.length, 1); assert.equal(calls[0].query, "site:youtube.com anope song");
  } finally { model.close(); }
});

test("read mode refuses writes and bash", async () => {
  const { cfg, cwd } = mk("read");
  const r = await runAgent({ cfg, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true });
  assert.match(r.text, /refused: write_file is not allowed in read mode/);
  assert.ok(!fs.existsSync(path.join(cwd, "out.txt")));
});

test("ask mode confirms each mutating call; denial is reported to the model", async () => {
  const { cfg, cwd } = mk("ask"); const asked = [];
  const r = await runAgent({ cfg, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true, confirm: async (name) => { asked.push(name); return name === "write_file"; } });
  assert.deepEqual(asked, ["write_file", "bash"]);
  assert.equal(fs.readFileSync(path.join(cwd, "out.txt"), "utf8"), "hello");
  assert.match(r.text, /declined/);
});

test("tool duration starts after owner deliberation", async () => {
  const { cfg, cwd } = mk("ask"); const session = new Session(path.join(cwd, "s")); let clock = 1000;
  await runAgent({ cfg, settings: {}, session, prompt: "go", quiet: true,
    confirm: async () => { clock += 5000; return true; }, now: () => clock });
  const rows = fs.readFileSync(session.file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const results = rows.filter(row => row.type === "item" && row.item.kind === "tool_result");
  assert.equal(results.length, 2); assert.ok(results.every(row => row.item.durationMs === 0), "approval wait is not tool runtime");
});

test("ask mode + allow list skips confirmation; auto runs everything", async () => {
  const { cfg, cwd } = mk("ask"); let n = 0;
  await runAgent({ cfg, settings: { allow: ["bash:echo *", "write_file"] }, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true, confirm: async () => { n++; return true; } });
  assert.equal(n, 0);
  const a = mk("auto");
  const r = await runAgent({ cfg: a.cfg, settings: {}, session: new Session(path.join(a.cwd, "s")), prompt: "go", quiet: true });
  assert.match(r.text, /created out\.txt/); assert.match(r.text, /hi\n\[exit 0\]/);
});

test("session persists and resumes without dangling tool_use", async () => {
  const { cfg, cwd } = mk("auto"); const dir = path.join(cwd, "s");
  const s = new Session(dir); await runAgent({ cfg, settings: {}, session: s, prompt: "go", quiet: true });
  const again = new Session(dir, s.id);
  assert.equal(again.messages.length, 4);   // user, assistant(tool_use), user(results), assistant(done)
  assert.equal(Session.latest(dir), s.id);
});

test("interactive renderer keeps one low-noise activity line without entering the session", async () => {
  const { cfg, cwd } = mk("auto"); const session = new Session(path.join(cwd, "s"));
  const out = { isTTY: true, columns: 80, text: "", write(value) { this.text += String(value); return true; } };
  const err = { isTTY: false, text: "", write(value) { this.text += String(value); return true; } };
  const terminal = createUI({ out, err, env: { TERM: "xterm-256color" } });
  await runAgent({ cfg, settings: {}, session, prompt: "go", terminal });
  const visible = out.text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal((visible.match(/● (?:Writing out\.txt|Running echo hi \| tee command\.txt)/g) || []).length, 2);
  assert.equal((visible.match(/• (?:Wrote out\.txt|Ran echo hi \| tee command\.txt)/g) || []).length, 2);
  assert.doesNotMatch(visible, /Ctrl-C|write_file|\$ printf|\[done\]/); assert.match(visible, /\r/);
  const raw = fs.readFileSync(session.file, "utf8");
  assert.doesNotMatch(raw, /[\x1b\r]/); raw.split("\n").filter(Boolean).forEach(line => JSON.parse(line));
});

test("a model plan update reaches the live goal/checkpoint panel and the session ledger", async () => {
  const plan = { goal: "Fix the live work UI", checkpoint: "Implement", steps: [
    { label: "Inspect", status: "completed" }, { label: "Edit", status: "in_progress" }, { label: "Verify", status: "pending" },
  ] };
  const model = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("update_plan", plan)], stop: "tool_use" }
    : text("plan is current"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-plan-")); fs.mkdirSync(path.join(cwd, ".hcode"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  const session = new Session(path.join(cwd, "s"));
  const out = { isTTY: true, columns: 80, text: "", write(value) { this.text += String(value); return true; } };
  const terminal = createUI({ out, err: { isTTY: false, write() { return true; } }, env: { TERM: "xterm" } });
  try {
    await runAgent({ cfg: { baseUrl: model.base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 4, bashTimeoutMs: 1000, cwd, mode: "auto" }, settings: {}, session, prompt: "fix it", terminal });
  } finally { model.close(); }
  const visible = out.text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(visible, /• Updated Plan/); assert.match(visible, /Goal  Fix the live work UI/); assert.match(visible, /Checkpoint  Implement/);
  assert.match(visible, /✓ Inspect/); assert.match(visible, /◌ Edit/); assert.match(visible, /□ Verify/);
  const events = fs.readFileSync(session.file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.item?.kind === "tool_call" && event.item?.tool === "update_plan"));
});

test("token use is counted in four classes and the turn end carries them", async () => {
  const { cfg, cwd } = mk("auto"); const session = new Session(path.join(cwd, "s"));
  const r = await runAgent({ cfg, settings: {}, session, prompt: "go", quiet: true });
  assert.deepEqual(r.usage, { input: 20, output: 10, cacheWrite: 6, cacheRead: 14 });   // two API steps
  const rows = fs.readFileSync(session.file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const end = rows.filter(row => row.type === "turn.end").at(-1);
  assert.deepEqual(end.usage, { in: 20, out: 10, cacheWrite: 6, cacheRead: 14 });
});

test("a brain that reports no cache fields counts them as zero", async () => {
  const plain = http.createServer((req, res) => {
    let body = ""; req.on("data", d => body += d); req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ type: "message_start", message: { usage: { input_tokens: 4 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]));
    });
  });
  await new Promise(resolve => plain.listen(0, "127.0.0.1", resolve));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-nocache-"));
  const cfg = { baseUrl: `http://127.0.0.1:${plain.address().port}`, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 2, bashTimeoutMs: 1000, cwd, mode: "auto" };
  const r = await runAgent({ cfg, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "go", quiet: true });
  plain.close();
  assert.deepEqual(r.usage, { input: 4, output: 2, cacheWrite: 0, cacheRead: 0 });
});

test("sse parser handles split chunks", async () => {
  const text = sse([{ type: "a", v: 1 }, { type: "b", v: 2 }]);
  async function* chunks() { yield Buffer.from(text.slice(0, 7)); yield Buffer.from(text.slice(7, 30)); yield Buffer.from(text.slice(30)); }
  const out = []; for await (const e of sseEvents(chunks())) out.push(e.type);
  assert.deepEqual(out, ["a", "b"]);
});

test("the coordinator names local and Hoop worlds without moving local subagents", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-worlds-"));
  const prompt = systemPrompt({ cwd, mode: "ask", hoopUrl: "http://127.0.0.1:18095", hoopName: "my-hoop", model: "m" });
  assert.match(prompt, /Local file\/command tools and Codex\/Claude subagents always run on THIS machine/);
  assert.match(prompt, /hoop_\* tools read the connected Hoop \(my-hoop\)/);
  assert.match(prompt, /Never claim Hoop facts without a hoop_\* result/);
  assert.match(prompt, /hoop_status \+ hoop_chats \+ hoop_finance/);
  assert.match(prompt, /local list_dir on ~\/Downloads, never hoop_files/);
});

test("extended thinking is preserved across a tool round but never rendered as answer text", async (t) => {
  let roundTripped = false;
  const thinkingServer = http.createServer((req, res) => {
    let body = ""; req.on("data", d => body += d); req.on("end", () => {
      const messages = JSON.parse(body).messages;
      const last = messages.at(-1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (typeof last.content === "string") {
        return res.end(turn([
          { type: "thinking", thinking: "private transport state", signature: "sig-roundtrip" },
          { type: "tool_use", id: "remote-list", name: "list_dir", input: { path: "." } },
        ], "tool_use"));
      }
      const assistant = messages.at(-2)?.content || [];
      const thinking = assistant.find(block => block.type === "thinking");
      roundTripped = thinking?.thinking === "private transport state" && thinking?.signature === "sig-roundtrip";
      if (!roundTripped) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "thinking must be passed back" } })); }
      res.end(turn([{ type: "text", text: "round trip ok" }], "end_turn"));
    });
  });
  await new Promise(resolve => thinkingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => thinkingServer.close());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-thinking-"));
  fs.writeFileSync(path.join(cwd, "visible.txt"), "ok");
  const cfg = { baseUrl: `http://127.0.0.1:${thinkingServer.address().port}`, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 3, bashTimeoutMs: 1000, cwd, mode: "auto" };
  const result = await runAgent({ cfg, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "inspect", quiet: true });
  assert.equal(roundTripped, true);
  assert.equal(result.text, "round trip ok");
  assert.doesNotMatch(result.text, /private transport state/);
});

test("agency >= 8 renews the step budget autonomously and accounts it; lower levels still stop (2026-08-28 order)", async () => {
  // Full Agency must not halt every maxTurns steps waiting for a human — the step budget renews
  // itself, every renewal lands in the session trail, and level < 8 keeps the old spend brake.
  const model = await startFakeModel((messages) => {
    // count this RUN's steps from the transcript, not the server's cumulative call counter —
    // two runs share one fake model here
    const step = messages.filter(m => m.role === "assistant").length + 1;
    if (step <= 5) return { blocks: [tool("read_file", { path: "note.txt" })], stop: "tool_use" };
    return text("done after renewals");
  });
  try {
    const mkCfg = (level) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-ac-"));
      fs.mkdirSync(path.join(cwd, ".hcode"));
      fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
      fs.writeFileSync(path.join(cwd, "note.txt"), "x");
      return { cfg: { baseUrl: model.base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 2, bashTimeoutMs: 1000, cwd, mode: "all", agencyLevel: level }, cwd };
    };
    const hi = mkCfg(8);
    const s8 = new Session(path.join(hi.cwd, "s8"));
    const r8 = await runAgent({ cfg: hi.cfg, settings: {}, session: s8, prompt: "go", quiet: true });
    assert.equal(r8.truncated, false, "level 8 crossed the budget without halting");
    assert.equal(r8.text, "done after renewals");
    assert.ok(r8.steps > 2, `expected more than the original budget, got ${r8.steps}`);
    const trail8 = fs.readFileSync(s8.file, "utf8");
    assert.match(trail8, /auto-continue x1 at step 3/, "first renewal is accounted in the trail");
    assert.match(trail8, /auto-continue x2 at step 5/, "second renewal is accounted in the trail");
    assert.match(trail8, /"type":"agency\.auto-continue"/, "renewals are machine-readable events");
    const lo = mkCfg(3);
    const r3 = await runAgent({ cfg: lo.cfg, settings: {}, session: new Session(path.join(lo.cwd, "s3")), prompt: "go", quiet: true });
    assert.equal(r3.truncated, true, "level 3 still stops at the limit");
    assert.equal(r3.steps, 2);
  } finally { model.close(); }
});

test.after(() => server.close());

test("an invalid choice at the decision gate is a machine decision in the audit — auto-denied, never \"human\" (阿加莎 2026-08-28)", async () => {
  const { cfg, cwd } = mk("ask");
  const session = new Session(path.join(cwd, "s-inv"));
  const r = await runAgent({ cfg, settings: {}, session, prompt: "go", quiet: true, confirm: async () => "invalid-choice" });
  assert.match(r.text, /auto-denied \(invalid choice\)[^]*no human decision was made/);
  assert.doesNotMatch(r.text, /human declined/);
  const raw = fs.readFileSync(session.file, "utf8");
  assert.match(raw, /"by":"gate"/, "the approval event is recorded as the gate, not the owner");
  assert.doesNotMatch(raw, /"decision":"deny","by":"owner"/, "no forged human denial in the audit");
});

test("unattended refusals are unobserved decisions — no human was available, so none is recorded (张良 layer two)", async () => {
  const { cfg, cwd } = mk("ask");
  const session = new Session(path.join(cwd, "s-unatt"));
  const r = await runAgent({ cfg, settings: {}, session, prompt: "go", quiet: true });   // no confirm injected
  assert.match(r.text, /no human was available \(unattended\)/);
  assert.doesNotMatch(r.text, /human declined/);
  const raw = fs.readFileSync(session.file, "utf8");
  assert.match(raw, /"decision":"unobserved","by":"transport"/, "the audit says no human decided — not the owner's name");
  assert.doesNotMatch(raw, /"by":"owner"/, "an unattended session never records an owner decision");
});
