// The three diseases: vendor rate limit (waiting helps), spend pool drained (waiting for a
// month rollover helps), provider key missing/invalid (waiting NEVER helps — that route is
// physically impossible).  Mixing them once made 007 wait all night for a recovery that
// could never arrive, so each failure must carry its class and the class must survive both
// the fallback chain and the supervisor's regex classification of process output.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyApiFailure, ApiError, streamMessage } from "../src/api.js";
import { classifyFailure } from "../src/retry-circuit.js";
import { startFakeModel, sse, turnEvents, text } from "./fake-model.js";

test("classifyApiFailure separates the three diseases", () => {
  assert.equal(classifyApiFailure(429, "keyproxy: pool cap reached ($5/month)"), "out_of_budget");
  assert.equal(classifyApiFailure(429, "rate limit exceeded, retry after 60s"), "rate_limited");
  assert.equal(classifyApiFailure(403, "keyproxy: no key for anthropic"), "auth_failed");
  assert.equal(classifyApiFailure(401, "x-api-key header is required"), "auth_failed");
  assert.equal(classifyApiFailure(503, "upstream error"), "transient");
  assert.equal(classifyApiFailure(404, "not found"), "fatal");
});

test("ApiError carries its failure class to whoever catches it", () => {
  assert.equal(new ApiError(403, "no key").failureClass, "auth_failed");
  assert.equal(new ApiError(429, "pool cap reached").failureClass, "out_of_budget");
});

test("the structured failure line beats regex classification of mixed output", () => {
  // tonight's real shape: a 429 trail followed by a 403 capability probe — the terminal
  // cause is auth, and classifying it as "quota" means waiting for a reset that never comes
  const mixed = "brain answered 429; retry 3/3\nHTTP 403 on capability probe\nhcode-failure: class=auth_failed status=403 model=claude-sonnet-5\nApiError stack";
  assert.equal(classifyFailure(mixed, 1), "deterministic");
  assert.equal(classifyFailure("hcode-failure: class=out_of_budget status=429", 1), "quota");
  assert.equal(classifyFailure("hcode-failure: class=rate_limited status=429", 1), "quota");
  // legacy output without the structured line still classifies by regex
  assert.equal(classifyFailure("the brain answered 429 rate limit", 1), "quota");
});

// A fake brain that speaks both routes: the capability manifest + probe (fallback gate) and
// the message stream itself, scriptable per model.
async function startChainedBrain({ primaryStatus, fallbackStatus, tailStatus }) {
  const state = await startFakeModel((msgs, parsed, call) => {
    const model = parsed.model;
    if (parsed._route === "/v1/model-capabilities")
      return { json: { v: 1, model, contextTokens: 128000, agenticTier: "agentic" } };
    if (parsed._headers && parsed._headers["x-hcode-capability-probe"] === "1")
      return { status: 200, headers: { "content-type": "application/json", "x-hcode-context-tokens": "128000", "x-hcode-agentic-tier": "agentic", "x-hcode-capability-nonce": parsed._headers["x-hcode-capability-nonce"] }, body: "{}" };
    if (model === "primary-m" && primaryStatus) return primaryStatus;
    if (model === "fallback-m" && fallbackStatus) return fallbackStatus;
    if (model === "tail-m" && tailStatus) return tailStatus;
    return text("ok from " + model);
  });
  return state;
}

const baseCfg = brain => ({ baseUrl: brain.base, apiKey: "test", model: "primary-m", fallbackModels: ["fallback-m"], maxAttempts: 1, timeoutMs: 3000, fallbackMinContextTokens: 16000 });

test("a 429 on the primary switches to the cross-provider fallback", async () => {
  const brain = await startChainedBrain({ primaryStatus: { status: 429, body: "rate limit exceeded" } });
  try {
    const fallbacks = [];
    const r = await streamMessage({ ...baseCfg(brain) }, { onFallback: f => fallbacks.push(f), messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.model, "fallback-m");
    assert.equal(r.fallbackFrom, "primary-m");
    assert.equal(fallbacks[0].reason, "rate_limited");
  } finally { brain.close(); }
});

test("a 403 on the primary ALSO switches providers — auth death must not strand the chain", async () => {
  // the physical case from tonight: anthropic has no key on this box, 403 forever; z.ai lives
  const brain = await startChainedBrain({ primaryStatus: { status: 403, body: "keyproxy: no key for anthropic" } });
  try {
    const fallbacks = [];
    const r = await streamMessage({ ...baseCfg(brain) }, { onFallback: f => fallbacks.push(f), messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.model, "fallback-m");
    assert.equal(fallbacks[0].reason, "auth_failed");
  } finally { brain.close(); }
});

test("pool exhaustion is reported as out_of_budget, not a generic rate limit", async () => {
  const drained = { status: 429, body: "keyproxy: pool cap reached ($5/month)" };
  const brain = await startChainedBrain({ primaryStatus: drained, fallbackStatus: drained, tailStatus: drained });
  try {
    const fallbacks = [];
    await assert.rejects(
      streamMessage({ ...baseCfg(brain), fallbackModels: ["fallback-m", "tail-m"] }, { onFallback: f => fallbacks.push(f), messages: [{ role: "user", content: "hi" }] }),
      err => err.failureClass === "out_of_budget" && err.status === 429,
    );
    assert.equal(fallbacks.length, 2); // it tried both fallback levels (cross-provider, then same-provider) before dying honestly
  } finally { brain.close(); }
});

test("every provider 403 surfaces auth_failed with no provider left alive", async () => {
  const noKey = { status: 403, body: "no key" };
  const brain = await startChainedBrain({ primaryStatus: noKey, fallbackStatus: noKey, tailStatus: noKey });
  try {
    await assert.rejects(
      streamMessage({ ...baseCfg(brain), fallbackModels: ["fallback-m", "tail-m"] }, { messages: [{ role: "user", content: "hi" }] }),
      err => err.failureClass === "auth_failed",
    );
  } finally { brain.close(); }
});
