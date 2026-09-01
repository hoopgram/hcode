// 0.7 B: who a subagent may run as (tier or named brain, never a flagship, never the CLI's own default),
// the aside that answers without joining the conversation, and the ledger /attach reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASIDE_SYSTEM, FLAGSHIP_MODELS, SUBAGENT_DIR, SUBAGENT_KINDS, SUBAGENT_TIERS,
  askAside, childLedger, childSummary, childTranscript, formatSubagents, isFlagship, openChild,
  parseDelegateFlags, resolveSubagentModel, subagentTiers,
} from "../src/subagents.js";
import { Session } from "../src/session.js";
import { toolDefs, TOOL_BY_NAME, createTools } from "../src/tools.js";
import { runAgent } from "../src/agent.js";
import { startFakeModel, text, tool } from "./fake-model.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-sub-"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const throws = call => { try { call(); return null; } catch (error) { return error.message; } };

// ---- 1. the brain is always named ---------------------------------------------------------------------
test("a subagent with no model and no kind is refused, and the refusal is the call to write instead", () => {
  const tool = throws(() => resolveSubagentModel({ runner: "claude", coordinatorModel: "deepseek-v4-pro" }));
  assert.match(tool, /needs its brain named/);
  for (const fragment of ['model:"sonnet"', 'kind:"search"', 'kind:"mechanical"', 'kind:"implement"', "haiku", "opus"]) assert.ok(tool.includes(fragment), `${fragment} missing from: ${tool}`);
  assert.match(tool, /never lets a subagent inherit the CLI's own default/);
  // the owner types flags, so the owner's refusal shows flags
  const command = throws(() => resolveSubagentModel({ runner: "codex", syntax: "command" }));
  assert.ok(command.includes("--kind search") && command.includes("--model gpt-5.6-terra") && !command.includes('kind:"'), command);
  assert.match(throws(() => resolveSubagentModel({ runner: "claude", kind: "quick" })), /kind must be one of search\|mechanical\|implement/);
  assert.match(throws(() => resolveSubagentModel({ runner: "gemini", kind: "search" })), /unknown subagent runner "gemini" \(claude\|codex\)/);
  assert.match(throws(() => resolveSubagentModel({ runner: "claude", model: "opus; rm -rf /" })), /is not a model id/);
});

test("each kind takes its own tier, and a named model wins over the tier", () => {
  const at = (runner, kind) => resolveSubagentModel({ runner, kind, coordinatorModel: "deepseek-v4-pro" });
  assert.deepEqual(SUBAGENT_KINDS, ["search", "mechanical", "implement"]);
  assert.equal(at("claude", "search").model, "haiku");
  assert.equal(at("claude", "mechanical").model, "sonnet");
  assert.equal(at("claude", "implement").model, "opus");
  assert.equal(at("claude", "search").source, "tier");
  assert.equal(at("codex", "search").model, SUBAGENT_TIERS.codex.search);
  const named = resolveSubagentModel({ runner: "claude", model: "haiku-3-5", kind: "implement", coordinatorModel: "deepseek-v4-pro" });
  assert.deepEqual(named, { model: "haiku-3-5", kind: "implement", source: "named" });
});

test("a flagship brain is never a helper unless the call names it", () => {
  const refusal = throws(() => resolveSubagentModel({ runner: "claude", model: "fable", coordinatorModel: "deepseek-v4-pro" }));
  assert.match(refusal, /"fable" is a flagship brain/);
  assert.ok(refusal.includes('kind:"implement"') && refusal.includes("opus") && refusal.includes("allow_flagship:true"), refusal);
  assert.doesNotMatch(refusal, /the very class this coordinator runs on/);
  assert.match(throws(() => resolveSubagentModel({ runner: "claude", model: "claude-fable-5", coordinatorModel: "deepseek-v4-pro" })), /flagship brain/);
  // the coordinator's own brain is flagship by definition, whatever it is today
  const same = throws(() => resolveSubagentModel({ runner: "codex", model: "deepseek-v4-pro", coordinatorModel: "deepseek-v4-pro" }));
  assert.match(same, /the very class this coordinator runs on/);
  assert.equal(resolveSubagentModel({ runner: "claude", model: "fable", coordinatorModel: "x", allowFlagship: true }).model, "fable");
  assert.ok(FLAGSHIP_MODELS.includes("fable"));
  assert.equal(isFlagship("sonnet", { coordinator: "claude-sonnet-5" }), false, "an alias is not the coordinator's own id");
  assert.equal(isFlagship("anthropic/claude-fable-5"), true, "a vendor prefix hides nothing");
  assert.equal(isFlagship(""), false);
});

test("the owner may replace any tier cell; a nonsense override is ignored", () => {
  const tiers = subagentTiers({ codex: { search: "o4-mini" }, claude: { implement: "not a model id" }, gemini: { search: "x" } });
  assert.equal(tiers.codex.search, "o4-mini");
  assert.equal(tiers.claude.implement, SUBAGENT_TIERS.claude.implement);
  assert.equal(tiers.gemini, undefined);
  assert.equal(SUBAGENT_TIERS.codex.search, "gpt-5.6-luna", "the built-in table is not mutated");
  assert.equal(resolveSubagentModel({ runner: "codex", kind: "search", tiers }).model, "o4-mini");
});

test("delegate_agent offers the tier to a full brain and hides it from a lean one", () => {
  const full = toolDefs().find(entry => entry.name === "delegate_agent");
  assert.deepEqual(full.input_schema.properties.kind.enum, SUBAGENT_KINDS);
  assert.deepEqual(TOOL_BY_NAME.delegate_agent.leanOmit, ["model", "kind", "allow_flagship"]);
  const lean = toolDefs({ lean: true }).find(entry => entry.name === "delegate_agent");
  assert.deepEqual(Object.keys(lean.input_schema.properties), ["agent", "task"], "a 4B window pays for no refinement");
  assert.deepEqual(toolDefs({ lean: true }).find(entry => entry.name === "grep").input_schema.properties.pattern, { type: "string" });
});

test("the tool hands model, kind and the flagship opt-in through to the coordinator", async () => {
  const seen = [];
  const tools = createTools({ root: tmp(), sandboxWant: "none", delegateAgent: async input => { seen.push(input); return "report"; } });
  await tools.delegate_agent({ agent: "codex", task: "read the parser", kind: "search", allow_flagship: true });
  assert.deepEqual(seen, [{ agent: "codex", task: "read the parser", model: "", kind: "search", allowFlagship: true }]);
});

// 0.8: a task that reads as search/scan now takes the smallest tier by itself (test/thrift.test.js).
// Work that would *build* something still has to declare what it is — the cheap default is not a guess.
test("a delegation with no tier comes back to the model as the exact call to write", async () => {
  const cwd = tmp(); const sessionsDir = path.join(cwd, "sessions");
  const model = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("delegate_agent", { agent: "claude", task: "write a JSON parser and its tests" })], stop: "tool_use" }
    : text("asked again with a tier"));
  const session = new Session(sessionsDir, null, { cwd, runner: "hcode", model: "deepseek-v4-pro" });
  try {
    await runAgent({ cfg: { baseUrl: model.base, apiKey: "k", model: "deepseek-v4-pro", maxTokens: 100, maxTurns: 4, cwd, mode: "auto", sessionsDir }, settings: {}, session, prompt: "review", quiet: true, confirm: async () => true });
  } finally { model.close(); }
  const result = lines(session.file).find(event => event.type === "item" && event.item.kind === "tool_result");
  assert.equal(result.item.ok, false);
  assert.match(result.item.output, /needs its brain named/);
  assert.ok(result.item.output.includes('kind:"search"'), result.item.output);
  assert.equal(lines(session.file).some(event => event.type === "child.spawn"), false, "nothing was spawned");
});

// ---- 2. /btw: an answer that does not join the conversation --------------------------------------------
test("an aside answers the owner, records itself in the ledger, and never enters the thread", async () => {
  const cwd = tmp(); const sessionsDir = path.join(cwd, "sessions");
  const session = new Session(sessionsDir, null, { cwd, runner: "hcode", model: "deepseek-v4-pro" });
  session.startTurn("real work"); session.message("user", "real work"); session.message("assistant", [{ type: "text", text: "on it" }]);
  const before = JSON.stringify(session.messages);
  const calls = [];
  const aside = await askAside({
    cfg: { cwd, sessionsDir, model: "deepseek-v4-pro", effort: "high" }, policy: { sandbox: "none", network: { default: "on", allow: ["*"] } },
    session, runner: "claude", question: "which file owns the composer?",
    run: async options => { calls.push(options); options.session.startTurn(options.prompt); options.session.message("assistant", [{ type: "text", text: "src/composer.js" }]); return { text: "src/composer.js", usage: { input: 7, output: 2 } }; },
  });
  assert.equal(aside.text, "src/composer.js");
  assert.equal(aside.model, "haiku", "an aside is a search by default");
  assert.equal(JSON.stringify(session.messages), before, "the aside bought no seat in every later prompt");
  const [call] = calls;
  assert.equal(call.cfg.runnerModel, "haiku"); assert.equal(call.cfg.mode, "read");
  assert.deepEqual(call.policy.network, { default: "off", allow: [] });
  assert.equal(call.system, ASIDE_SYSTEM);
  assert.notEqual(call.session.id, session.id, "the aside writes its own thread");
  const spawn = lines(session.file).find(event => event.type === "child.spawn");
  assert.equal(spawn.model, "haiku"); assert.equal(spawn.session, aside.session); assert.equal(spawn.task, "which file owns the composer?");
  assert.equal(lines(session.file).find(event => event.type === "child.report").status, "done");
  assert.ok(fs.existsSync(path.join(sessionsDir, SUBAGENT_DIR, `${aside.session}.jsonl`)));
});

test("Esc reaches an aside: a cancelled /btw is filed as cancelled, not as an answer", async () => {
  const cwd = tmp(); const sessionsDir = path.join(cwd, "sessions");
  const session = new Session(sessionsDir, null, { cwd, runner: "hcode", model: "m" });
  const controller = new AbortController();
  const aside = await askAside({
    cfg: { cwd, sessionsDir, model: "m" }, policy: {}, session, runner: "claude", question: "long question",
    signal: controller.signal,
    // runners.js settles a cancelled run instead of throwing, so the aside has to read the flag.
    run: async options => { controller.abort(); return { text: "half an answer", cancelled: true, usage: { input: 3, output: 1 }, signal: options.signal }; },
  });
  assert.equal(aside.cancelled, true, "the caller can tell an abort from an answer");
  assert.equal(lines(session.file).find(event => event.type === "child.report").status, "cancelled");
  assert.equal(JSON.stringify(session.messages), "[]", "and a cancelled aside still joins nothing");
});

test("a failed aside is recorded as failed and never silently swallowed", async () => {
  const cwd = tmp(); const sessionsDir = path.join(cwd, "sessions");
  const session = new Session(sessionsDir, null, { cwd, runner: "hcode", model: "m" });
  const call = () => askAside({ cfg: { cwd, sessionsDir, model: "m" }, policy: {}, session, runner: "codex", question: "why", run: async () => { throw new Error("codex exited 1"); } });
  await assert.rejects(call, /codex exited 1/);
  assert.equal(lines(session.file).find(event => event.type === "child.report").status, "failed");
  await assert.rejects(() => askAside({ cfg: { cwd, sessionsDir, model: "m" }, policy: {}, session, runner: "claude", question: "  ", run: async () => ({}) }), /needs a question/);
  await assert.rejects(() => askAside({ cfg: { cwd, sessionsDir, model: "fable" }, policy: {}, session, runner: "claude", question: "hi", model: "fable", run: async () => ({}) }), /flagship brain/);
});

test("owner flags are read off the front of the line and the question keeps its own dashes", () => {
  assert.deepEqual(parseDelegateFlags("--kind implement rewrite the parser --fast"),
    { model: "", kind: "implement", agent: "", allowFlagship: false, prompt: "rewrite the parser --fast" });
  assert.deepEqual(parseDelegateFlags("-a codex -m o4-mini --allow-flagship why is it slow"),
    { model: "o4-mini", kind: "", agent: "codex", allowFlagship: true, prompt: "why is it slow" });
  assert.equal(parseDelegateFlags("plain question").prompt, "plain question");
  assert.equal(parseDelegateFlags("   ").prompt, "");
  assert.match(throws(() => parseDelegateFlags("--model --kind search x")), /--model needs a value/);
});

// ---- 3. /attach: looking inside a subagent -------------------------------------------------------------
test("the child ledger folds spawn and report into one row per subagent", () => {
  const cwd = tmp(); const session = new Session(path.join(cwd, "sessions"), null, { cwd, runner: "hcode" });
  const first = session.childSpawn({ runner: "claude", task: "find the parser", cwd, model: "haiku", session: "20260831-aa", policy: { mode: "read", sandbox: "none" } });
  const second = session.childSpawn({ runner: "codex", task: "rename the fields", cwd, model: "gpt-5.6-terra", session: "20260831-bb", policy: { mode: "read", sandbox: "none" } });
  session.childReport({ childId: first.childId, status: "done", summary: "src/composer.js", usage: { in: 7, out: 2 } });
  session.childMerge({ childId: second.childId, outcome: "applied", files: ["src/a.js"] });
  const rows = childLedger(session);
  assert.deepEqual(rows.map(row => [row.childId, row.runner, row.model, row.status]),
    [[first.childId, "claude", "haiku", "done"], [second.childId, "codex", "gpt-5.6-terra", "running"]]);
  assert.equal(rows[0].summary, "src/composer.js"); assert.deepEqual(rows[1].files, ["src/a.js"]);
  assert.match(childSummary(rows[0], { now: rows[0].endedAt + 5000 }), /claude {2}haiku .*done .*5s ago {2}find the parser/);
  const listing = formatSubagents({ children: rows, tasks: ["task-1234  claude  haiku  done"] });
  assert.match(listing, /Subagents of this session/); assert.match(listing, /Background conversations/);
  assert.match(listing, new RegExp(`/attach <id>`));
  assert.match(formatSubagents({}), /No subagents yet/);
});

test("attach opens a finished subagent's own transcript, read-only", () => {
  const cwd = tmp(); const dir = path.join(cwd, "sessions", SUBAGENT_DIR);
  const child = new Session(dir, null, { cwd, runner: "claude", model: "haiku" });
  child.startTurn("find the parser");
  child.message("user", "find the parser");
  child.toolCall("grep", { pattern: "parse" }, ["read"], "running");
  child.message("assistant", [{ type: "text", text: "src/composer.js owns it" }]);
  child.endTurn("end_turn", { in: 7, out: 2 });
  const row = { childId: "c-1234abcd", runner: "claude", model: "haiku", status: "done", task: "find the parser", session: child.id, usage: { in: 7, out: 2 } };
  const view = openChild(row, { dir });
  assert.match(view, /c-1234abcd · claude haiku · done · 7 in \/ 2 out/);
  assert.match(view, /> find the parser/);
  assert.match(view, /· grep \{"pattern":"parse"\}/);
  assert.match(view, /src\/composer\.js owns it/);
  assert.match(view, /Read-only/);
  assert.match(openChild({ ...row, session: "" }, { dir }), /no thread was recorded/);
  assert.match(openChild({ ...row, session: "20260831-gone" }, { dir }), /could not be read/);
  assert.match(childTranscript(new Session(dir, null, { cwd, runner: "claude" })), /wrote nothing/);
});

test("the ledger refuses a shaped-wrong model or thread id", () => {
  const cwd = tmp(); const session = new Session(path.join(cwd, "sessions"), null, { cwd, runner: "hcode" });
  const spawn = extra => session.childSpawn({ runner: "claude", task: "t", cwd, ...extra });
  assert.throws(() => spawn({ model: "opus; curl evil" }), /invalid child model/);
  assert.throws(() => spawn({ session: "../../etc/passwd" }), /invalid child session/);
  assert.equal(spawn({}).model, undefined, "a spawn without a brain records no brain rather than a wrong one");
});
