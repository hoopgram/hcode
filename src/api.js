// Anthropic Messages API, streaming (SSE) with tool use. Node built-ins only.
// Works against api.anthropic.com, a Hoop's keyproxy, or any compatible endpoint.
import http from "node:http";
import https from "node:https";
import { VERSION, isLocalBrain } from "./config.js";

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 3;            // one call = at most 3 tries; the model call itself has no side effects

// One predicate for every field only Anthropic's own Messages API is known to accept
// (output_config.effort, cache_control). A DeepSeek / z.ai / llama.cpp gateway speaking the same
// protocol may answer 400 for a field it does not know, so nothing native-only leaves this gate.
export function isNativeClaude(model) {
  return /^claude-(?:sonnet|opus|fable|mythos)/i.test(String(model || ""));
}

// Current Claude models accept the native Messages API effort control. Other
// Anthropic-compatible brains keep the same portable tier in the hcode system
// prompt instead of receiving a field their gateway may reject.
// Effort must stay stable for a whole session: the resolved effort level is rendered into the
// prompt itself, so changing it (or the thinking config) starts a NEW cache prefix and every
// breakpoint below misses. Changing effort mid-session costs a full-price re-read of the history.
export function nativeEffortConfig(model, effort) {
  if (!effort || !isNativeClaude(model)) return null;
  return { effort };
}

// Prompt caching. Without a breakpoint a 30-step session pays full price for the same
// system + tools + history prefix thirty times; with one, that prefix is read back at 0.1x.
//   auto (default)  one top-level `cache_control`; the API puts the breakpoint on the last
//                   cacheable block and moves it forward as the conversation grows - the
//                   documented starting point for multi-turn work, and it never touches
//                   `messages` at all (hcode's message list is a projection of the session
//                   ledger and must not be mutated).
//   explicit        breakpoints placed by hand in the documented order tools -> system ->
//                   messages (3, under the limit of 4), so the stable tools+system prefix keeps
//                   its own cache entry even when the tail of the conversation churns.
// TTL is one value per request (default 5m, `1h` at 2x write price); hcode never mixes the two,
// which is what the "long TTL before short TTL" ordering rule is about.
export function promptCacheMode(cfg = {}) {
  if (!isNativeClaude(cfg.model)) return false;             // never send a native-only field elsewhere
  const setting = cfg.promptCache;
  if (setting === false) return false;
  return setting === "explicit" ? "explicit" : "auto";
}

const CACHEABLE_BLOCK = new Set(["text", "tool_result", "image", "document", "search_result"]);

// Returns the body with cache breakpoints added. Never mutates `messages`, its message objects
// or their content arrays - every touched level is copied first.
export function applyPromptCache(body, cfg = {}) {
  const mode = promptCacheMode(cfg);
  if (!mode) return body;
  const ttl = cfg.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  const mark = () => ({ ...ttl });
  if (mode === "auto") { body.cache_control = mark(); return body; }
  if (Array.isArray(body.tools) && body.tools.length)
    body.tools = body.tools.map((tool, i) => i === body.tools.length - 1 ? { ...tool, cache_control: mark() } : tool);
  if (typeof body.system === "string" && body.system)
    body.system = [{ type: "text", text: body.system, cache_control: mark() }];
  else if (Array.isArray(body.system) && body.system.length)
    body.system = body.system.map((block, i) => i === body.system.length - 1 ? { ...block, cache_control: mark() } : block);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { at = i; break; }
  if (at < 0) return body;
  const message = messages[at];
  if (typeof message.content === "string" && message.content) {
    body.messages = messages.map((m, i) => i === at ? { ...m, content: [{ type: "text", text: m.content, cache_control: mark() }] } : m);
    return body;
  }
  if (!Array.isArray(message.content) || !message.content.length) return body;
  const last = message.content[message.content.length - 1];
  if (!CACHEABLE_BLOCK.has(last?.type)) return body;        // a thinking block cannot carry cache_control
  const content = message.content.map((block, i) => i === message.content.length - 1 ? { ...block, cache_control: mark() } : block);
  body.messages = messages.map((m, i) => i === at ? { ...m, content } : m);
  return body;
}

// DeepSeek's Anthropic-compatible gateway ignores budget_tokens and reasoning_effort but
// honours thinking.type (probed live through the Hoop keyproxy, 2026-08-31: disabling took a
// small answer from 93 output tokens to 1). So the dial is binary: effort low switches
// reasoning off; medium/high keep the server default (enabled). Only for deepseek-* — other
// gateways are unprobed and keep the portable prompt tier instead.
export function thinkingConfig(model, effort) {
  if (effort !== "low" || !/^deepseek/i.test(String(model || ""))) return null;
  return { type: "disabled" };
}

// How long to wait before try n (1-based), honouring the provider's retry-after when it sent one.
export function backoffMs(attempt, retryAfter = null, now = Date.now()) {
  if (retryAfter != null) {
    const secs = /^\d+$/.test(String(retryAfter).trim()) ? Number(retryAfter) : (Date.parse(retryAfter) - now) / 1000;
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}
const RETRYABLE = status => status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);

const CAPABILITY_TIERS = { basic: 0, assistant: 1, agentic: 2 };
const authHeaders = cfg => cfg.apiKey ? { "x-api-key": cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` } : {};
const agentHeaders = cfg => ({ ...(cfg.agentId ? { "x-hcode-agent-id": cfg.agentId } : {}), ...(cfg.taskId ? { "x-hcode-task-id": cfg.taskId } : {}) });

// The provider declaration is not trusted by name. It must be schema-valid and then agree
// with an independent live probe answered by the candidate model route.
export async function verifyFallbackCapability(cfg, model, { signal } = {}) {
  const minimum = Number(cfg.fallbackMinContextTokens) || 16000;
  let manifest;
  try {
    const declared = await postJson(cfg, "/v1/model-capabilities", { v: 1, model }, { signal, timeoutMs: Math.min(cfg.timeoutMs || DEFAULT_TIMEOUT_MS, 30000), headers: { "content-type": "application/json", ...authHeaders(cfg), ...agentHeaders(cfg) } });
    if (!declared.ok) return { state: "unobserved", detail: `provider capability manifest unavailable (HTTP ${declared.status})` };
    manifest = await declared.json();
  } catch (error) { return { state: "unobserved", detail: `provider capability manifest could not be observed (${error.code || error.message})` }; }
  if (manifest?.v !== 1 || manifest.model !== model || !Number.isInteger(manifest.contextTokens) || !Object.hasOwn(CAPABILITY_TIERS, manifest.agenticTier))
    return { state: "unobserved", detail: "provider capability manifest failed schema/model validation" };
  let observed;
  try {
    const nonce = globalThis.crypto.randomUUID();
    const probe = await postJson({ ...cfg, model }, "/v1/messages", { model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hcode capability probe; answer one token" }] }, { signal, timeoutMs: Math.min(cfg.timeoutMs || DEFAULT_TIMEOUT_MS, 30000), headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-hcode-capability-probe": "1", "x-hcode-capability-nonce": nonce, ...authHeaders(cfg), ...agentHeaders(cfg) } });
    await probe.text();
    if (!probe.ok) return { state: "unobserved", detail: `candidate capability probe failed (HTTP ${probe.status})`, manifest };
    observed = { contextTokens: Number(probe.headers["x-hcode-context-tokens"]), agenticTier: probe.headers["x-hcode-agentic-tier"], nonce: probe.headers["x-hcode-capability-nonce"] };
    if (observed.nonce !== nonce) return { state: "unobserved", detail: "candidate probe did not echo the fresh capability nonce", manifest, observed };
  } catch (error) { return { state: "unobserved", detail: `candidate capability probe could not be observed (${error.code || error.message})`, manifest }; }
  if (!Number.isInteger(observed.contextTokens) || !Object.hasOwn(CAPABILITY_TIERS, observed.agenticTier))
    return { state: "unobserved", detail: "candidate probe omitted machine-verifiable capability headers", manifest };
  if (observed.contextTokens !== manifest.contextTokens || observed.agenticTier !== manifest.agenticTier)
    return { state: "unobserved", detail: "provider declaration does not match the live candidate probe", manifest, observed };
  if (manifest.contextTokens < minimum || CAPABILITY_TIERS[manifest.agenticTier] < CAPABILITY_TIERS.agentic)
    return { state: "below_minimum", detail: `verified capability is below floor (context ${manifest.contextTokens}/${minimum}, tier ${manifest.agenticTier}/agentic)`, manifest, observed };
  return { state: "eligible", detail: `verified provider capability (context ${manifest.contextTokens}, tier ${manifest.agenticTier})`, manifest, observed };
}

// POST JSON over node:http(s) — no undici headersTimeout (a slow local brain may take minutes before the first
// byte). One total deadline (connect + headers + body) = timeoutMs; the result is a definite error{code:"timeout"}.
export function postJson(cfg, route, body, { signal, timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const url = new URL(cfg.baseUrl + route);
  const mod = url.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = err => { if (done) return; done = true; clearTimeout(timer); reject(err); };
    const req = mod.request(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(payload) } }, res => {
      if (done) { res.resume(); return; }
      done = true;
      // the deadline keeps running while the body streams: a stalled stream is a timeout too
      res.on("close", () => clearTimeout(timer));
      const out = { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: res, headers: res.headers,
        text: () => new Promise((r, j) => { let t = ""; res.setEncoding("utf8"); res.on("data", d => t += d); res.on("end", () => r(t)); res.on("error", j); }),
        json: async () => JSON.parse(await out.text()) };
      resolve(out);
    });
    const timer = setTimeout(() => {
      const mins = Math.round((Date.now() - t0) / 60000 * 10) / 10;
      const e = new Error(`the brain is too slow or too busy: waited ${mins} min for ${url.host} and gave up (HCODE_TIMEOUT_MS=${timeoutMs}); try again later, a smaller task, or a faster model`);
      e.code = "timeout"; req.destroy(e); fail(e);
    }, timeoutMs);
    req.on("error", err => { if (signal?.aborted) return fail(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" })); if (err.code === "timeout") return fail(err); fail(Object.assign(new Error(`cannot reach ${cfg.baseUrl} (${err.code || err.message}) — run \`hcode doctor\``), { code: "unreachable" })); });
    if (signal) { const onAbort = () => req.destroy(); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    req.end(payload);
  });
}
// Three different diseases hide behind "the brain answered an error": the vendor throttled
// this key (waiting helps), the spend pool is drained (waiting for a reset helps, waiting
// minutes does not), or this provider's key is missing/invalid (no amount of waiting helps —
// that route is physically impossible until a human changes the connection).  Mixing them
// makes an agent wait for a recovery that will never arrive, so every failure carries a class.
// Read-only GET on the brain channel (the quota bucket answer). Same shape as postJson.
export function getJson(cfg, route, { signal, timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const url = new URL(cfg.baseUrl + route);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = err => { if (done) return; done = true; clearTimeout(timer); reject(err); };
    const req = mod.request(url, { method: "GET", headers: { accept: "application/json", ...headers } }, res => {
      if (done) { res.resume(); return; }
      done = true; clearTimeout(timer);
      const out = { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers,
        text: () => new Promise((r, j) => { let t = ""; res.setEncoding("utf8"); res.on("data", d => t += d); res.on("end", () => r(t)); res.on("error", j); }),
        json: async () => JSON.parse(await out.text()) };
      resolve(out);
    });
    const timer = setTimeout(() => { const e = new Error(`GET ${route} timed out`); e.code = "timeout"; req.destroy(e); fail(e); }, timeoutMs);
    req.on("error", err => { if (signal?.aborted) return fail(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" })); fail(Object.assign(new Error(`cannot reach ${cfg.baseUrl} (${err.code || err.message}) — run \`hcode doctor\``), { code: "unreachable" })); });
    if (signal) { const onAbort = () => req.destroy(); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    req.end();
  });
}

export function classifyApiFailure(status, body) {
  const text = String(body || "");
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return /out of budget|pool cap|quota|insufficient/i.test(text) ? "out_of_budget" : "rate_limited";
  if (RETRYABLE(status)) return "transient";
  return "fatal";
}
// Turns an API failure into one human sentence with the way out (never echoes a key).
export function explainApiError(status, body) {
  const text = String(body || "");
  if (status === 429) {
    if (/out of budget|pool cap|quota|insufficient/i.test(text)) return "the spend pool is drained (429). Waiting minutes will not help — it resets on the pool's schedule; pick a BYO/local model with --model until then.";
    return "the brain is rate-limited (429). Honour the retry-after pause and retry, or pick another model with --model.";
  }
  if (status >= 500) return `the brain is having trouble (${status}); retry in a minute.`;
  if (status === 401 || /x-api-key header is required|invalid x-api-key|authentication_error|api key/i.test(text))
    return "the Hoop Code coordinator could not authenticate. Run `hcode setup` to connect HoopGram, your API provider, or your self-hosted Hoop.";
  if (status === 403) return "the provider refused this route (403): that is an authentication failure, not rate limiting — retrying this same model will never succeed. Run `hcode setup` to change its connection; another provider on the fallback chain may still answer.";
  if (status === 404) return "the model endpoint answered 404 — the base URL or model id is wrong (`hcode doctor` shows both).";
  return `API ${status}: ${text.slice(0, 300)}`;
}
export class ApiError extends Error {
  constructor(status, body) { super(explainApiError(status, body)); this.status = status; this.body = String(body).slice(0, 2000); this.failureClass = classifyApiFailure(status, body); }
}

// Parses one SSE stream into {type, ...} events.
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = null, data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      const text = data.join("\n");
      if (text === "[DONE]") return;
      try { yield { event, ...JSON.parse(text) }; } catch { /* ignore keep-alives */ }
    }
  }
}

// Streams one assistant turn. onText(delta) is called as text arrives.
// Resolves to { content: [...blocks], stopReason, usage }.
// Retries the whole call on a transient failure (429 / 5xx / a stream that broke before any content arrived).
// The model call has no side effects of its own — tools only run after it returns — so a retry cannot duplicate work.
export async function streamMessage(cfg, opts) {
  const attempts = Math.max(1, Number(cfg.maxAttempts) || MAX_ATTEMPTS);
  const models = [...new Set([cfg.model, ...(cfg.fallbackModels || [])].filter(Boolean))];
  let last;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const active = { ...cfg, model: models[modelIndex] };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await streamOnce(active, opts);
        return { ...result, model: active.model, ...(modelIndex ? { fallbackFrom: models[0] } : {}) };
      } catch (err) {
        last = err;
        if (!err.model) err.model = active.model;
        // a broken stream is always retryable: text deltas are live-only, so nothing on disk can be duplicated —
        // the retry replaces the whole assistant message (the renderer is told how much live text to discard)
        const transient = (err.status && RETRYABLE(err.status)) || err.code === "stream_interrupted" || err.code === "unreachable";
        if (!transient || attempt === attempts || opts.signal?.aborted) break;
        const waitMs = backoffMs(attempt, err.retryAfter);
        opts.onRetry?.({ attempt, of: attempts, waitMs, model: active.model, status: err.status || null, reason: err.code || `api_${err.status}`, ...(err.partialChars ? { discarded: err.partialChars } : {}) });
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    // 429 (rate limit / pool drained) AND 401/403 (this provider's key is missing or invalid)
    // both justify trying the next model on the chain: the next entry may live on a different
    // provider with its own key and its own bucket.  Auth failures are not retried on the SAME
    // model — waiting cannot fix a missing key — they only ever move the chain forward.
    const switchWorthy = last && (last.status === 429 || last.status === 401 || last.status === 403);
    if (opts.signal?.aborted || !switchWorthy || modelIndex + 1 >= models.length) throw last;
    const reason = last.failureClass || classifyApiFailure(last.status, last.body);
    let blocked = null, eligibleIndex = -1;
    for (let candidateIndex = modelIndex + 1; candidateIndex < models.length; candidateIndex++) {
      const to = models[candidateIndex];
      const capability = await verifyFallbackCapability(cfg, to, { signal: opts.signal });
      if (capability.state === "eligible") {
        eligibleIndex = candidateIndex;
        opts.onFallback?.({ from: active.model, to, reason, status: 429, capability, at: Date.now() });
        break;
      }
      const code = capability.state === "unobserved" ? "model_fallback_unobserved" : "model_fallback_below_minimum";
      blocked = Object.assign(new Error(`${capability.state === "unobserved" ? "UNOBSERVED: " : ""}refusing automatic fallback from ${active.model} to ${to}: ${capability.detail}; the current session and objective are preserved`), { code, fallbackFrom: active.model, fallbackTo: to, capability });
      opts.onFallbackBlocked?.({ from: active.model, to, reason, status: 429, capability, code, at: Date.now() });
    }
    if (eligibleIndex < 0) {
      // keep the owner-facing UX honest: when the PRIMARY failure was an auth rejection, the
      // "switch your brain" guidance must still fire even though the blocking error is about
      // the refused fallback — attach the original status/failureClass to the thrown error.
      if (blocked && (last.status === 401 || last.status === 403 || reason === "auth_failed")) {
        blocked.status = last.status; blocked.failureClass = reason;
      }
      throw blocked || last;
    }
    // Remove refused candidates so the next loop iteration can only call the verified model.
    if (eligibleIndex > modelIndex + 1) models.splice(modelIndex + 1, eligibleIndex - modelIndex - 1);
  }
  throw last;
}

async function streamOnce(cfg, { system, messages, tools, onText, signal }) {
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": `hcode/${VERSION}`,
  };
  if (cfg.apiKey) { headers["x-api-key"] = cfg.apiKey; headers["authorization"] = `Bearer ${cfg.apiKey}`; }
  Object.assign(headers, agentHeaders(cfg));
  // a small local brain must be able to hold prompt + answer inside its window (canary: 4096)
  const maxTokens = isLocalBrain(cfg) ? Math.min(cfg.maxTokens, 1024) : cfg.maxTokens;
  const body = { model: cfg.model, max_tokens: maxTokens, stream: true, messages };
  const effort = nativeEffortConfig(cfg.model, cfg.effort);
  if (effort) body.output_config = effort;
  const thinking = thinkingConfig(cfg.model, cfg.effort);
  if (thinking) body.thinking = thinking;
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;
  applyPromptCache(body, cfg);   // last: the breakpoints depend on the finished system/tools/messages
  const res = await postJson(cfg, "/v1/messages", body, { signal, headers });
  if (!res.ok) {
    const text = await res.text();
    // An offline brain (keyproxy → llama.cpp, OpenAI protocol) may refuse tools + stream together. Retry the same
    // request once without streaming and hand the whole reply to the kernel in the same shape (streamFallback:true),
    // so Code works with no outside network at all.
    if ((res.status === 500 || res.status === 400) && /tools?/i.test(text) && /stream/i.test(text) && !signal?.aborted)
      return nonStreamingMessage(cfg, { headers, body, onText, signal });
    const err = new ApiError(res.status, text);
    err.retryAfter = res.headers?.["retry-after"] ?? null;
    throw err;
  }
  const blocks = []; let stopReason = null; const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const partialJson = new Map();
  let finished = false;
  try {
  for await (const ev of sseEvents(res.body)) {
    switch (ev.type) {
      case "message_start":
        Object.assign(usage, ev.message?.usage || {}); break;
      case "content_block_start":
        blocks[ev.index] = structuredClone(ev.content_block);
        if (ev.content_block.type === "tool_use") { partialJson.set(ev.index, ""); blocks[ev.index].input = {}; }
        if (ev.content_block.type === "text") blocks[ev.index].text = ev.content_block.text || "";
        break;
      case "content_block_delta": {
        const b = blocks[ev.index]; if (!b) break;
        if (ev.delta.type === "text_delta") { b.text += ev.delta.text; onText?.(ev.delta.text); }
        else if (ev.delta.type === "input_json_delta") partialJson.set(ev.index, partialJson.get(ev.index) + ev.delta.partial_json);
        else if (ev.delta.type === "thinking_delta") { b.thinking = (b.thinking || "") + ev.delta.thinking; }
        else if (ev.delta.type === "signature_delta") { b.signature = (b.signature || "") + ev.delta.signature; }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b && b.type === "tool_use") {
          const raw = partialJson.get(ev.index) || "";
          try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = { __invalid_json: raw }; }
        }
        break;
      }
      case "message_delta":
        stopReason = ev.delta?.stop_reason || stopReason;
        if (ev.usage) Object.assign(usage, ev.usage);
        break;
      case "message_stop":
        finished = true; break;
      case "error":
        throw new ApiError(500, JSON.stringify(ev.error || ev));
    }
  }
  } catch (err) {
    if (err instanceof ApiError || signal?.aborted || err.code === "timeout") throw err;
    const e = new Error(`the model stream broke mid-answer (${err.cause?.code || err.code || err.message}); nothing was lost — retry the turn`);
    e.code = "stream_interrupted"; e.partialChars = blocks.filter(Boolean).reduce((n, b) => n + (b.text?.length || 0), 0); throw e;
  }
  if (!finished && !stopReason) { const e = new Error("the model stream ended before the answer was complete; retry the turn"); e.code = "stream_interrupted"; e.partialChars = blocks.filter(Boolean).reduce((n, b) => n + (b.text?.length || 0), 0); throw e; }
  // Extended-thinking providers require every thinking/redacted_thinking block to be
  // returned byte-for-byte on the next tool round.  It stays invisible to the renderer
  // (agent.js only renders text), but it is transport state just like a tool_use id.
  // Dropping it makes the first read tool succeed and the second API call fail with 400.
  return { content: blocks.filter(Boolean), stopReason, usage };
}

// The offline retry reuses the SAME body (cache breakpoints included), so a fallback turn is
// billed against the same cached prefix as the streamed attempt that preceded it.
async function nonStreamingMessage(cfg, { headers, body, onText, signal }) {
  const res = await postJson(cfg, "/v1/messages", { ...body, stream: false }, { signal, headers });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  let msg; try { msg = await res.json(); } catch { const e = new Error("the brain answered without valid JSON (non-streaming fallback)"); e.code = "stream_interrupted"; throw e; }
  const content = (Array.isArray(msg.content) ? msg.content : []).filter(Boolean).map(b => b.type === "tool_use" ? { ...b, input: b.input && typeof b.input === "object" ? b.input : {} } : b);
  for (const b of content) if (b.type === "text" && b.text) onText?.(b.text);
  const usage = { input_tokens: msg.usage?.input_tokens || 0, output_tokens: msg.usage?.output_tokens || 0, cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens || 0, cache_read_input_tokens: msg.usage?.cache_read_input_tokens || 0 };
  return { content, stopReason: msg.stop_reason || (content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn"), usage, streamFallback: true };
}
