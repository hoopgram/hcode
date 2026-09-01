import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runAgent, MAX_CONTINUATIONS } from "../src/agent.js";
import { Session } from "../src/session.js";

// A brain whose replies stop at the output cap: "cut" twice, then finishes; "runaway" never finishes.
function sse(events) { return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
function reply(text, stop) {
  return sse([{ type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…" } }, { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }, { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
}
const requests = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", d => body += d); req.on("end", () => {
    const msgs = JSON.parse(body).messages; requests.push(msgs);
    const prompt = msgs[0].content; const continuations = msgs.filter(m => m.role === "user").length - 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (/runaway/.test(JSON.stringify(prompt))) return res.end(reply(`part${continuations + 1} `, "max_tokens"));
    res.end(continuations < 2 ? reply(`part${continuations + 1} `, "max_tokens") : reply("end.", "end_turn"));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const mk = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cont-"));
  fs.mkdirSync(path.join(cwd, ".hcode")); fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  return { cfg: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 10, bashTimeoutMs: 1000, cwd, mode: "auto" }, cwd };
};

test("a reply cut at the output cap is continued and the pieces are joined", async () => {
  const { cfg, cwd } = mk(); requests.length = 0;
  const session = new Session(path.join(cwd, "s"));
  const r = await runAgent({ cfg, settings: {}, session, prompt: "cut", quiet: true });
  assert.equal(r.truncated, false); assert.equal(r.text, "part1 part2 end.");
  assert.equal(requests.length, 3);
  const nudge = requests[2].filter(m => m.role === "user").at(-1);
  assert.match(JSON.stringify(nudge.content), /Continue exactly from where it stopped/);
  assert.ok(requests[2].some(m => m.role === "assistant" && m.content.some(b => b.type === "thinking")), "the partial assistant message stays in the conversation");
  assert.equal(session.events.filter(e => e.type === "error" && e.code === "recovered").length, 2);
});

test("a reply that never finishes stops after MAX_CONTINUATIONS and says so", async () => {
  const { cfg, cwd } = mk(); requests.length = 0;
  const r = await runAgent({ cfg, settings: {}, session: new Session(path.join(cwd, "s")), prompt: "runaway", quiet: true });
  assert.equal(r.truncated, true); assert.equal(r.truncatedBy, "max_tokens");
  assert.equal(requests.length, MAX_CONTINUATIONS + 1);
  assert.equal(r.text, Array.from({ length: MAX_CONTINUATIONS + 1 }, (_, i) => `part${i + 1} `).join(""));
});

test.after(() => server.close());
