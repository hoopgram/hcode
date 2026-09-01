// A scriptable fake Messages API for tests: no network, no key. script(msgs, req) → {blocks, stop} | {status, body} |
// {blocks, stop, cutAfter:n} (close the socket after n SSE events = stream interruption) | {hang:true}.
import http from "node:http";

export function sse(events) { return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""); }
export function turnEvents(blocks, stop, usage = { in: 10, out: 5 }) {
  const ev = [{ type: "message_start", message: { usage: { input_tokens: usage.in } } }];
  blocks.forEach((b, i) => {
    if (b.type === "text") { ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); ev.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }); }
    else { ev.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
    ev.push({ type: "content_block_stop", index: i });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: usage.out } }); ev.push({ type: "message_stop" });
  return ev;
}
export const text = (t, stop = "end_turn") => ({ blocks: [{ type: "text", text: t }], stop });
export const tool = (name, input, id = "toolu_" + Math.random().toString(16).slice(2, 8)) => ({ type: "tool_use", id, name, input });

export async function startFakeModel(script) {
  const state = { calls: [], script };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => body += d); req.on("end", () => {
      let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
      Object.defineProperty(parsed, "_route", { value: req.url, enumerable: false });
      Object.defineProperty(parsed, "_headers", { value: req.headers, enumerable: false });
      state.calls.push(parsed);
      const r = state.script(parsed.messages || [], parsed, state.calls.length);
      if (r.hang) return;
      if (r.delay) { const d = r.delay; delete r.delay; return setTimeout(() => answer(r), d); }   // slow brain: headers after d ms
      answer(r);
    });
    function answer(r) {                                   // never answers (timeout/abort tests)
      if (r.status) { res.writeHead(r.status, { "content-type": "application/json", ...(r.headers || {}) }); return res.end(r.body || ""); }
      if (r.json) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(r.json)); }
      res.writeHead(200, { "content-type": "text/event-stream", ...(r.headers || {}) });
      const events = turnEvents(r.blocks, r.stop, r.usage);
      if (r.cutAfter !== undefined) { res.write(sse(events.slice(0, r.cutAfter))); return setTimeout(() => res.socket.destroy(), 20); }
      res.end(sse(events));
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  server.unref();                                          // a failed assertion before close() must not keep the test child alive
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () => server.close();
  state.lastTools = () => { const last = state.calls.at(-1)?.messages?.at(-1); return Array.isArray(last?.content) ? last.content.filter(b => b.type === "tool_result") : []; };
  return state;
}
