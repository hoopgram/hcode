// Request-body shape on the wire: prompt cache breakpoints and the native effort ladder.
// Fake model server, no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPromptCache, isNativeClaude, nativeEffortConfig, promptCacheMode, streamMessage } from "../src/api.js";
import { EFFORT_LEVELS, normalizePromptCache } from "../src/config.js";
import { startFakeModel, text } from "./fake-model.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// loadConfig reads the owner's real ~/.hcode/config.json and HCODE_* env, so resolution is
// checked in a child with an empty home and a scrubbed environment - never against this machine.
const here = path.dirname(fileURLToPath(import.meta.url));
const resolveConfig = (cli = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cfg-"));
  const env = { PATH: process.env.PATH, HOME: home, HCODE_HOME: home, HCODE_TEST_OFF_HOOP: "1" };
  const script = `import { loadConfig } from ${JSON.stringify(path.join(here, "..", "src", "config.js"))};
    process.stdout.write(JSON.stringify(loadConfig(${JSON.stringify(cli)})));`;
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) { throw new Error(String(error.stderr || error.message)); }
};

const bodyOf = (over = {}) => ({
  model: "claude-sonnet-5", max_tokens: 100, stream: true,
  system: "you are hcode",
  tools: [{ name: "read_file" }, { name: "bash" }],
  messages: [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }],
  ...over,
});

test("automatic caching is the default: one top-level breakpoint, nothing else touched", () => {
  const body = bodyOf();
  const messages = body.messages, tools = body.tools;
  applyPromptCache(body, { model: "claude-sonnet-5" });
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.equal(body.system, "you are hcode", "auto mode leaves the string system prompt alone");
  assert.equal(body.messages, messages); assert.equal(body.tools, tools);
  assert.equal(promptCacheMode({ model: "claude-opus-5" }), "auto");
});

test("1h TTL rides the same single breakpoint (hcode never mixes two TTLs in one request)", () => {
  const auto = bodyOf(); applyPromptCache(auto, { model: "claude-fable-5-1", cacheTtl: "1h" });
  assert.deepEqual(auto.cache_control, { type: "ephemeral", ttl: "1h" });
  const explicit = bodyOf(); applyPromptCache(explicit, { model: "claude-fable-5-1", cacheTtl: "1h", promptCache: "explicit" });
  const marks = [explicit.tools.at(-1).cache_control, explicit.system.at(-1).cache_control, explicit.messages.at(-1).content.at(-1).cache_control];
  for (const mark of marks) assert.deepEqual(mark, { type: "ephemeral", ttl: "1h" });
});

test("explicit mode marks tools then system then the last user block, and copies instead of mutating", () => {
  const body = bodyOf();
  const messages = body.messages, tools = body.tools, lastMessage = messages.at(-1), lastContent = lastMessage.content;
  applyPromptCache(body, { model: "claude-sonnet-5", promptCache: "explicit" });
  assert.equal(body.cache_control, undefined, "explicit mode does not also ask for the automatic breakpoint");
  assert.equal(body.tools.at(-1).name, "bash");
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" });
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.system, [{ type: "text", text: "you are hcode", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
  const count = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.equal(count, 3, "three breakpoints, under the API limit of four");
  // the session ledger's projection must survive untouched
  assert.notEqual(body.messages, messages);
  assert.equal(tools[1].cache_control, undefined);
  assert.equal(lastContent, lastMessage.content);
  assert.equal(lastContent.at(-1).cache_control, undefined);
  assert.deepEqual(messages.at(-1).content, [{ type: "tool_result", tool_use_id: "t1", content: "done" }]);
});

test("explicit mode never marks a block that cannot carry cache_control", () => {
  const body = bodyOf({ messages: [{ role: "user", content: [{ type: "thinking", thinking: "hmm" }] }] });
  applyPromptCache(body, { model: "claude-sonnet-5", promptCache: "explicit" });
  assert.equal(body.messages.at(-1).content.at(-1).cache_control, undefined);
  const stringy = bodyOf({ messages: [{ role: "user", content: "plain" }] });
  applyPromptCache(stringy, { model: "claude-sonnet-5", promptCache: "explicit" });
  assert.deepEqual(stringy.messages.at(-1).content, [{ type: "text", text: "plain", cache_control: { type: "ephemeral" } }]);
});

test("only native Claude routes get cache_control; the switch turns it off everywhere", () => {
  assert.ok(isNativeClaude("claude-opus-5") && isNativeClaude("claude-mythos-5-1") && !isNativeClaude("deepseek-v4-pro") && !isNativeClaude("qwen3-4b"));
  for (const model of ["deepseek-v4-pro", "glm-5.3", "qwen3-4b", ""]) {
    const body = bodyOf({ model });
    applyPromptCache(body, { model, promptCache: true });
    assert.equal(JSON.stringify(body).includes("cache_control"), false, `${model || "(unset)"} keeps the portable body`);
    assert.equal(promptCacheMode({ model }), false);
  }
  const off = bodyOf();
  applyPromptCache(off, { model: "claude-sonnet-5", promptCache: false });
  assert.equal(JSON.stringify(off).includes("cache_control"), false);
  assert.equal(promptCacheMode({ model: "claude-sonnet-5", promptCache: false }), false);
});

test("the wire body carries the breakpoint, and the non-streaming fallback reuses the same one", async () => {
  const seen = [];
  const m = await startFakeModel((_msgs, req, n) => {
    seen.push(req);
    if (n === 1) return text("cached");
    if (n === 2) return { status: 400, body: "tools with stream are not supported" };
    return { json: { content: [{ type: "text", text: "offline" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } } };
  });
  const base = { baseUrl: m.base, apiKey: "k", maxTokens: 100, maxAttempts: 1 };
  const opts = { system: "sys", tools: [{ name: "read_file" }], messages: [{ role: "user", content: "go" }] };
  await streamMessage({ ...base, model: "claude-sonnet-5", effort: "xhigh" }, opts);
  assert.deepEqual(seen[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(seen[0].output_config, { effort: "xhigh" });
  const fallback = await streamMessage({ ...base, model: "claude-sonnet-5", cacheTtl: "1h" }, opts);
  assert.equal(fallback.streamFallback, true);
  assert.deepEqual(seen[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(seen[2].cache_control, { type: "ephemeral", ttl: "1h" }, "the offline retry is billed against the same prefix");
  assert.equal(seen[2].stream, false);
  assert.equal(opts.messages[0].content, "go", "the caller's message list is never rewritten");
  m.close();
});

test("effort accepts the whole documented ladder and still rejects anything else", () => {
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  for (const effort of EFFORT_LEVELS) {
    assert.equal(resolveConfig({ effort }).effort, effort);
    assert.deepEqual(nativeEffortConfig("claude-opus-5", effort), { effort });
    assert.equal(nativeEffortConfig("deepseek-v4-pro", effort), null);
  }
  assert.throws(() => resolveConfig({ effort: "adaptive" }), /bad --effort adaptive \(low\|medium\|high\|xhigh\|max\)/);
  assert.throws(() => resolveConfig({ effort: "ultra" }), /bad --effort/);
  assert.equal(resolveConfig({}).effort, "high", "the API default stays hcode's default");
});

test("prompt cache config: default on, off spellings, explicit, bad value refused", () => {
  assert.equal(resolveConfig({}).promptCache, true);
  assert.equal(resolveConfig({}).cacheTtl, "5m");
  assert.equal(resolveConfig({ promptCache: "explicit" }).promptCache, "explicit");
  assert.equal(resolveConfig({ promptCache: false }).promptCache, false);
  assert.equal(resolveConfig({ cacheTtl: "1h" }).cacheTtl, "1h");
  for (const off of ["0", "false", "off", "no", false]) assert.equal(normalizePromptCache(off), false);
  for (const on of ["1", "true", "auto", "on", true, undefined, ""]) assert.equal(normalizePromptCache(on), true);
  assert.throws(() => normalizePromptCache("sometimes"), /bad promptCache/);
  assert.throws(() => resolveConfig({ cacheTtl: "2h" }), /bad cacheTtl 2h \(5m\|1h\)/);
});
