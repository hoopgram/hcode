// A3 policy + sandbox, A4 tool contract, and the red-team four (CONTRACTS-V027 §2, §3, §9).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPolicy, classifyCommand, decide, hostsIn, domainAllowed, pathsIn } from "../src/policy.js";
import { TOOL_CONTRACT, TOOL_DEFS, risksOf, validateInput, writeAtomic, createTools, isSecretPath, judgePath } from "../src/tools.js";
import * as sandbox from "../src/sandbox.js";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";
import { startFakeModel, text, tool } from "./fake-model.js";
import { AttachmentStore } from "../src/attachments.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-p-"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const cfgFor = (base, cwd, mode = "auto") => ({ baseUrl: base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 6, bashTimeoutMs: 3000, cwd, mode, tokenBudget: 120000 });

// ---- A4 contract ----------------------------------------------------------------------------------------
test("A4 every tool declares input/output schema, risk and idempotent; the model sees the same 11 tools", () => {
  assert.equal(TOOL_CONTRACT.length, 11);
  for (const t of TOOL_CONTRACT) {
    assert.ok(t.name && t.description && t.input?.type === "object" && t.output?.type, t.name);
    assert.ok(Array.isArray(t.risk) && t.risk.length, t.name); assert.equal(typeof t.idempotent, "boolean", t.name);
    assert.equal(t.input.additionalProperties, false);
    for (const r of t.risk) assert.match(r, /^(read|write|network|money|identity|destructive|external)\??$/);
  }
  const byName = Object.fromEntries(TOOL_CONTRACT.map(t => [t.name, t.risk]));
  for (const n of ["read_file", "list_dir", "glob", "grep", "ask_user", "update_plan"]) assert.deepEqual(byName[n], ["read"]);
  assert.deepEqual(byName.web_search, ["read", "network"]);
  assert.deepEqual(byName.write_file, ["write"]); assert.deepEqual(byName.edit_file, ["write"]);
  assert.deepEqual(byName.bash, ["write", "network?", "destructive?"]);
  assert.deepEqual(TOOL_DEFS.map(t => t.name), TOOL_CONTRACT.map(t => t.name));
  assert.ok(TOOL_DEFS.every(t => t.input_schema && !t.risk));
});

test("A4 input validation rejects unknown fields and wrong types", () => {
  assert.equal(validateInput("read_file", { path: "a" }), null);
  assert.match(validateInput("read_file", { path: "a", extra: 1 }), /unknown field/);
  assert.match(validateInput("read_file", {}), /missing required/);
  assert.match(validateInput("bash", { command: 1 }), /must be a string/);
  assert.match(validateInput("read_file", { path: "a", offset: 0 }), /integer/);
  const plan = { goal: "Fix UI", checkpoint: "Implement", steps: [{ label: "Inspect", status: "completed" }, { label: "Edit", status: "in_progress" }] };
  assert.equal(validateInput("update_plan", plan), null);
  assert.match(validateInput("update_plan", { ...plan, steps: [{ label: "Edit", status: "working" }] }), /pending\|in_progress\|completed/);
  assert.match(validateInput("update_plan", { ...plan, steps: [{ label: "Edit", status: "pending", extra: true }] }), /unknown field/);
  assert.match(validateInput("update_plan", { ...plan, steps: Array.from({ length: 9 }, () => ({ label: "x", status: "pending" })) }), /at most 8/);
  assert.match(validateInput("nope", {}), /unknown tool/);
  assert.equal(validateInput("web_search", { query: "youtube anope", max_results: 8 }), null);
  assert.match(validateInput("web_search", { query: "youtube anope", max_results: 9 }), /integer ≤ 8/);
});

test("bounded public search follows the visible permission mode without opening Bash network", () => {
  const policy = loadPolicy(tmp()); const input = { query: "youtube anope" }; const risk = risksOf("web_search", input);
  assert.equal(decide({ policy, mode: "read", name: "web_search", input, risk }).decision, "deny");
  assert.equal(decide({ policy, mode: "ask", name: "web_search", input, risk }).decision, "ask");
  assert.equal(decide({ policy, mode: "auto", name: "web_search", input, risk }).decision, "allow");
  assert.equal(decide({ policy, mode: "all", name: "web_search", input, risk }).decision, "allow");
  assert.equal(decide({ policy, mode: "all", name: "bash", input: { command: "curl https://example.com" }, risk: ["write", "network"] }).decision, "deny");
});

test("A4 bash risk classifier separates parser unknown from actual high risk", () => {
  const r = c => classifyCommand(c).risk;
  assert.deepEqual(r("git status && ls -la"), ["read"]); assert.equal(classifyCommand("git status").readOnly, true);
  assert.deepEqual(r("cd src && grep -n permission policy.js"), ["read"]);
  assert.deepEqual(r("cd /tmp/worktree && git status"), ["read"], "cd is shell navigation, never money");
  assert.deepEqual(r("command grep -n TODO README.md"), ["read"], "shell command wrapper preserves the executable action");
  assert.deepEqual(r("command find . -maxdepth 1 -type f"), ["read"]);
  assert.deepEqual(r("builtin printf '%s\\n' ok"), ["read"], "builtin wrapper is classified by its action");
  assert.deepEqual(r("env LC_ALL=C command grep -n TODO README.md | wc -l"), ["read"]);
  assert.deepEqual(r("command -v grep"), ["read"], "command lookup is read-only");
  assert.deepEqual(r("curl https://example.com"), ["write", "network"]);
  assert.deepEqual(r("git push origin main"), ["write", "network"]);
  assert.deepEqual(r("npm install"), ["write", "network"]);
  assert.deepEqual(r("rm -rf build"), ["write", "destructive"]);
  assert.deepEqual(r("git reset --hard HEAD~1"), ["write", "destructive"]);
  assert.deepEqual(r("sudo systemctl restart nginx"), ["write", "destructive"]);
  assert.ok(r("env | grep -i token").includes("identity"), "environment secret inventory is identity-sensitive");
  const unknown = classifyCommand("frobnicate --all");
  assert.deepEqual(unknown.risk, ["unknown"]); assert.equal(unknown.parseStatus, "unknown");
  assert.match(unknown.reason, /could not parse/); assert.doesNotMatch(unknown.reason, /money|destructive/);
  assert.deepEqual(r("git push -f origin main"), ["write", "network", "destructive"]);
  assert.deepEqual(r("node --test"), ["write"]); assert.equal(classifyCommand("node --test").readOnly, false);
  assert.deepEqual(r("echo hi > out.txt"), ["write"]); assert.equal(classifyCommand("echo hi > out.txt").readOnly, false);
  assert.deepEqual(r("ssh gram@hoop.example.com uptime"), ["write", "network"]);
  assert.deepEqual(hostsIn("curl -s https://api.github.com/x | jq . ; scp a gram@h.hoopgram.ai:/tmp"), ["api.github.com", "h.hoopgram.ai"]);
  assert.deepEqual(risksOf("bash", { command: "ls" }), ["read"]); assert.deepEqual(risksOf("read_file", {}), ["read"]);
});

test("H-013 destructive system actions never auto-run at agency 8", () => {
  const policy = loadPolicy(tmp());
  for (const command of ["nixos-rebuild switch --flake .#hoop", "systemctl restart forge-web"]) {
    const risk = classifyCommand(command).risk;
    const verdict = decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command }, risk });
    assert.equal(verdict.decision, "ask", command);
    assert.match(verdict.why, /destructive/);
  }
});

test("P1 compound read inventory is honestly unknown; real money stays money; simple reads pass", () => {
  const policy = loadPolicy(tmp());
  const inventory = "cd /tmp/worktree && for f in *.md; do command grep -oE 'buy|refund' \"$f\" | wc -l; done; printf 'done\\n'";
  const unknown = classifyCommand(inventory);
  assert.deepEqual(unknown.risk, ["unknown"]); assert.equal(unknown.parseStatus, "unknown");
  assert.doesNotMatch(unknown.reason, /moves money|destructive/);
  assert.ok(unknown.unknownCommands.includes("for") && unknown.unknownCommands.includes("do"), "loop syntax remains honestly unparsed");
  const unknownVerdict = decide({ policy, mode: "all", name: "bash", input: { command: inventory }, risk: unknown.risk });
  assert.equal(unknownVerdict.decision, "ask"); assert.match(unknownVerdict.why, /could not parse.*review it yourself/);
  assert.doesNotMatch(unknownVerdict.why, /money|destructive/);

  const moneyCommand = "node checkout.js --amount=20";
  const money = classifyCommand(moneyCommand);
  assert.ok(money.risk.includes("money")); assert.equal(money.parseStatus, "parsed");
  const moneyVerdict = decide({ policy, mode: "auto", name: "bash", input: { command: moneyCommand }, risk: money.risk });
  assert.equal(moneyVerdict.decision, "ask"); assert.match(moneyVerdict.why, /moves money/);
  assert.ok(classifyCommand("env LANG=C command node checkout.js --amount=20").risk.includes("money"), "wrappers cannot hide a money action");

  const simple = "cd /tmp/worktree && grep -n TODO README.md | wc -l";
  const read = classifyCommand(simple);
  assert.deepEqual(read.risk, ["read"]); assert.equal(read.parseStatus, "parsed");
  assert.equal(decide({ policy, mode: "ask", name: "bash", input: { command: simple }, risk: read.risk }).decision, "allow");
});

test("P0 exact 007 buy.html audit command is read-only, not unknown or money", () => {
  const command = `cd /workspace/project/apps/site \\
 && echo "=== buy.html self-host/GPU/24-7 grep ===" \\
 && command grep -nE "self-host|self host|on-demand|ondemand|按需|自带|24/7|24×7|7×24|持续在线|随时" \\
      src/buy.html src/en/buy.html 2>/dev/null \\
 || echo "no matches (clean)"`;
  const cls = classifyCommand(command);
  assert.deepEqual(cls.risk, ["read"]); assert.equal(cls.readOnly, true); assert.equal(cls.parseStatus, "parsed");
  assert.doesNotMatch(cls.reason, /unknown|money|destructive|write/i);
  const policy = loadPolicy(tmp());
  const verdict = decide({ policy, mode: "ask", name: "bash", input: { command }, risk: cls.risk });
  assert.deepEqual(verdict, { decision: "allow", why: "read-only" });
});

test("P1 end to end: an unparsed compound shell asks honestly and never runs silently in all mode", async () => {
  const command = "cd . && for f in *.md; do command grep -oE 'buy|refund' \"$f\" | wc -l; done; printf 'done\\n'";
  const m = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("bash", { command })], stop: "tool_use" }
    : text("not run without the owner's review"));
  const cwd = tmp(); const session = new Session(path.join(cwd, "sessions")); const approvals = [];
  try {
    await runAgent({ cfg: cfgFor(m.base, cwd, "all"), settings: {}, session, prompt: "inventory", quiet: true,
      confirm: async (name, input, meta) => { approvals.push({ name, input, meta }); return false; } });
  } finally { m.close(); }
  assert.equal(approvals.length, 1, "unknown must reach the owner even in all mode");
  assert.deepEqual(approvals[0].meta.risk, ["unknown"]);
  assert.match(approvals[0].meta.reason, /could not parse/); assert.match(approvals[0].meta.why, /review it yourself/);
  assert.doesNotMatch(approvals[0].meta.reason + approvals[0].meta.why, /moves money|destructive/);
  assert.equal([...session.calls.values()][0].state, "denied", "declined unknown command must not execute");
});

test("A4 atomic patch: tmp + rename; a failed write leaves no half-written file and no tmp", async () => {
  const root = tmp(); const tools = createTools({ root, sandboxWant: "none" });
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  await tools.edit_file({ path: "f.txt", old_string: "one", new_string: "two" });
  assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "two\n");
  assert.deepEqual(fs.readdirSync(root).filter(f => f.includes("hcode-tmp")), []);
  // rename target is a directory → rename fails → original untouched, tmp removed
  fs.mkdirSync(path.join(root, "dir"));
  assert.throws(() => writeAtomic(path.join(root, "dir"), "x"));
  assert.ok(fs.statSync(path.join(root, "dir")).isDirectory());
  assert.deepEqual(fs.readdirSync(root).filter(f => f.includes("hcode-tmp")), []);
  // mode preserved
  fs.chmodSync(path.join(root, "f.txt"), 0o755); writeAtomic(path.join(root, "f.txt"), "three\n");
  assert.equal(fs.statSync(path.join(root, "f.txt")).mode & 0o777, 0o755);
});

// ---- A3 policy ------------------------------------------------------------------------------------------
test("A3 policy.json is parsed per contract; bad values are reported, not applied; settings.json allow merges", () => {
  const cwd = tmp(), shared = tmp(); fs.mkdirSync(path.join(cwd, ".hcode"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, mode: "auto", network: { default: "off", allow: ["api.github.com", "*.hoopgram.ai"] }, allow: ["bash:git *"], allowedRoots: [shared], sandbox: "none" }));
  fs.writeFileSync(path.join(cwd, ".hcode", "settings.json"), JSON.stringify({ allow: ["write_file:docs/**"] }));
  const p = loadPolicy(cwd);
  assert.equal(p.mode, "auto"); assert.equal(p.sandbox, "none"); assert.deepEqual(p.allow, ["write_file:docs/**", "bash:git *"]); assert.deepEqual(p.allowedRoots, [fs.realpathSync(shared)]);
  assert.ok(domainAllowed(p, "api.github.com") && domainAllowed(p, "x.hoopgram.ai") && !domainAllowed(p, "evil.com"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ mode: "yolo", sandbox: "docker", network: { default: "maybe" }, allowedRoots: ["relative", path.join(cwd, "missing")] }));
  const bad = loadPolicy(cwd); assert.equal(bad.mode, null); assert.equal(bad.sandbox, "auto"); assert.equal(bad.network.default, "off"); assert.equal(bad.problems.length, 5);
  assert.equal(loadPolicy(tmp()).fromFile, false);
});

test("A3 broker decisions: read-only allowed; read mode denies; network off by default; allow rules; auto", () => {
  const policy = loadPolicy(tmp()); policy.allow.push("bash:git *");
  const d = (mode, name, input) => decide({ policy, mode, name, input, risk: risksOf(name, input) }).decision;
  assert.equal(d("read", "read_file", { path: "a" }), "allow");
  assert.equal(d("read", "write_file", { path: "a", content: "" }), "deny");
  assert.equal(d("ask", "write_file", { path: "a", content: "" }), "ask");
  assert.equal(d("ask", "bash", { command: "git status" }), "allow");
  assert.equal(d("ask", "bash", { command: "ls" }), "allow");
  assert.equal(d("auto", "bash", { command: "ls" }), "allow");
  assert.equal(d("auto", "bash", { command: "curl https://evil.com" }), "deny", "network off by default even in auto");
  assert.equal(d("ask", "bash", { command: "curl https://evil.com" }), "ask");
  policy.network.allow.push("api.github.com");
  assert.equal(d("auto", "bash", { command: "curl https://api.github.com/repos" }), "allow");
  assert.equal(d("auto", "bash", { command: "curl https://api.github.com/x https://evil.com" }), "deny");
  policy.network.default = "on";
  assert.equal(d("auto", "bash", { command: "curl https://evil.com" }), "allow");
});

test("A3 subagent delegation always needs a specific owner yes/no, even in auto", async () => {
  const policy = { mode: null, network: { default: "off", allow: [] }, allow: ["delegate_agent"], sandbox: "none" };
  for (const mode of ["read", "ask", "auto"]) {
    const verdict = decide({ policy, mode, name: "delegate_agent", input: { agent: "codex", task: "inspect parser" }, risk: ["external"], idempotent: false });
    assert.equal(verdict.decision, "ask");
    assert.match(verdict.why, /read-only task to codex/);
  }
  const delegated = [];
  const tools = createTools({ root: tmp(), delegateAgent: async input => { delegated.push(input); return "bounded report"; }, sandboxWant: "none" });
  assert.equal(await tools.delegate_agent({ agent: "claude", task: "review tests", kind: "search" }), "bounded report");
  assert.deepEqual(delegated, [{ agent: "claude", task: "review tests", model: "", kind: "search", allowFlagship: false }]);
  assert.match(validateInput("delegate_agent", { agent: "other", task: "x" }), /codex\|claude/);
});

test("session-only all bypasses ordinary prompts but preserves fixed safety boundaries", () => {
  const root = tmp(); const policy = loadPolicy(root);
  const d = (name, input, risk = risksOf(name, input, root)) => decide({ policy, mode: "all", name, input, risk, root });
  assert.equal(d("write_file", { path: "src/a.js", content: "x" }).decision, "allow");
  assert.equal(d("bash", { command: "npm run build" }).decision, "allow");
  // 0.8: a named consequence is not something a mode switches off. `all` still means "stop confirming
  // ordinary work", and deleting a tree was never ordinary work. (gates.js, test/gates.test.js)
  const wipe = d("bash", { command: "rm -rf build" });
  assert.equal(wipe.decision, "ask", "a consequence gate holds in all mode");
  assert.deepEqual(wipe.gates, ["irreversible", "deletion"]);
  assert.equal(d("delegate_agent", { agent: "codex", task: "review parser" }, ["external"]).decision, "allow");
  assert.equal(d("bash", { command: "curl https://evil.example" }).decision, "deny", "network policy still rules");
  assert.equal(d("bash", { command: "node pay.js --amount 20" }).decision, "ask", "money still needs its own owner decision");
  assert.equal(d("bash", { command: "cat ~/.hcode/config.json" }).decision, "deny", "secrets never unlock");
  for (const command of ["rm -rf /", "rm -rf ~", "chmod -R 000 $HOME"]) {
    const verdict = d("bash", { command });
    assert.equal(verdict.decision, "deny", command); assert.match(verdict.why, /root or home/);
  }
});

test("all mode end to end runs ordinary work and audits hard-boundary refusals", async () => {
  const m = await startFakeModel((_messages, _request, turnNo) => turnNo === 1 ? { blocks: [
    tool("write_file", { path: "safe.txt", content: "done" }),
    tool("bash", { command: "cat ~/.hcode/config.json" }),
    tool("bash", { command: "node pay.js --amount 20" }),
  ], stop: "tool_use" } : text("finished"));
  const cwd = tmp(); const session = new Session(path.join(cwd, "sessions")); const approvals = [];
  try {
    await runAgent({ cfg: cfgFor(m.base, cwd, "all"), settings: {}, session, prompt: "do the work", quiet: true,
      confirm: async (name, input, meta) => { approvals.push([name, input.command, meta.risk]); return false; } });
  } finally { m.close(); }
  assert.equal(fs.readFileSync(path.join(cwd, "safe.txt"), "utf8"), "done");
  assert.deepEqual(approvals.map(row => row[1]), ["node pay.js --amount 20"], "only the money boundary asks again");
  const decisionEvents = session.events.filter(event => /^owner-decision\./.test(event.type));
  assert.deepEqual(decisionEvents.map(event => event.type), ["owner-decision.required", "owner-decision.resolved"]);
  assert.equal(decisionEvents[0].state, "waiting-owner"); assert.equal(decisionEvents[1].requiredSeq, decisionEvents[0].seq);
  const calls = [...session.calls.values()];
  assert.equal(calls[0].state, "done"); assert.equal(calls[1].state, "denied"); assert.equal(calls[2].state, "denied");
  assert.ok(!fs.readFileSync(session.file, "utf8").includes("apiKey"));
});

test("hcode stays the speaker while an approved read-only Codex report returns as a tool result", async () => {
  const cwd = tmp(); const bin = tmp(); const sessionsDir = path.join(cwd, "sessions");
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
printf '%s\n' "$@" > codex-args.txt
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"child-1"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"parser evidence from codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}'
`, { mode: 0o755 });
  const m = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("delegate_agent", { agent: "codex", task: "inspect parser only", kind: "search" })], stop: "tool_use" }
    : text("hcode verified the report and gives the final answer"));
  const previousPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const session = new Session(sessionsDir, null, { cwd, runner: "hcode", model: "m", tokenBudget: 120000 });
  const imageStore = new AttachmentStore({ baseDir: tmp() });
  const image = imageStore.addBuffer(Buffer.from("89504e470d0a1a0a", "hex"));
  const approvals = [];
  try {
    const result = await runAgent({ cfg: { ...cfgFor(m.base, cwd, "auto"), sessionsDir, timeoutMs: 5000 }, settings: {}, session, prompt: "review parser", quiet: true,
      attachments: [image], attachmentStore: imageStore,
      confirm: async (name, input) => { approvals.push([name, input.agent, input.task]); return true; } });
    assert.equal(result.text, "hcode verified the report and gives the final answer");
  } finally { process.env.PATH = previousPath; m.close(); imageStore.cleanup(); }
  assert.deepEqual(approvals, [["delegate_agent", "codex", "inspect parser only"]]);
  assert.match(fs.readFileSync(path.join(cwd, "codex-args.txt"), "utf8"), new RegExp(`--image\\n${image.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(fs.readFileSync(path.join(cwd, "codex-args.txt"), "utf8"), /--model\ngpt-5\.6-luna/, "the declared tier, never the CLI's own default");
  const events = lines(session.file);
  assert.equal(events.find(e => e.type === "child.spawn")?.runner, "codex");
  assert.equal(events.find(e => e.type === "child.spawn")?.model, "gpt-5.6-luna");
  assert.equal(events.find(e => e.type === "child.report")?.status, "done");
  assert.match(events.find(e => e.type === "item" && e.item.kind === "tool_result")?.item.output || "", /parser evidence from codex/);
  assert.equal(events.find(e => e.type === "turn.start")?.runner, "hcode");
  assert.equal(events.at(-1).reason, "end_turn");
});

test("a pasted image never reaches a subagent when the owner declines delegation", async () => {
  const cwd = tmp(), bin = tmp(), marker = path.join(cwd, "subagent-started");
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const model = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("delegate_agent", { agent: "codex", task: "inspect image" })], stop: "tool_use" }
    : text("delegation was declined"));
  const previousPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const imageStore = new AttachmentStore({ baseDir: tmp() }); const image = imageStore.addBuffer(Buffer.from("89504e470d0a1a0a", "hex"));
  const session = new Session(path.join(cwd, "sessions"), null, { cwd, runner: "hcode", model: "m" });
  try {
    const result = await runAgent({ cfg: { ...cfgFor(model.base, cwd, "auto"), sessionsDir: path.join(cwd, "sessions") }, settings: {}, session,
      prompt: "inspect", attachments: [image], attachmentStore: imageStore, quiet: true, confirm: async () => false });
    assert.equal(result.text, "delegation was declined"); assert.equal(fs.existsSync(marker), false);
  } finally { process.env.PATH = previousPath; model.close(); imageStore.cleanup(); }
});

test("A3 ask mode writes approval events (allow / deny / always) and 'always' becomes a policy rule for the session", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "a.txt", content: "1" }), tool("bash", { command: "printf hi > one.txt" }), tool("bash", { command: "printf again > two.txt" }), tool("write_file", { path: "b.txt", content: "2" })], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  const asked = [];
  await runAgent({ cfg: cfgFor(m.base, cwd, "ask"), settings: {}, session: s, prompt: "go", quiet: true,
    confirm: async (name, input, meta) => { asked.push([name, meta.risk]); return name === "bash" ? "always" : input.path === "a.txt"; } });
  assert.deepEqual(asked, [["write_file", ["write"]], ["bash", ["write"]], ["write_file", ["write"]]], "second echo was covered by 'always'");
  const approvals = lines(s.file).filter(e => e.type === "approval");
  assert.deepEqual(approvals.map(a => a.decision), ["allow", "always", "allow", "deny"]);
  assert.deepEqual(approvals.map(a => a.by), ["owner", "owner", "policy", "owner"]);
  assert.ok(approvals.every(a => /^i-/.test(a.itemId) && typeof a.at === "number"));
  assert.ok(fs.existsSync(path.join(cwd, "a.txt")) && !fs.existsSync(path.join(cwd, "b.txt")));
  const denied = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_call" && e.item.state === "denied"); assert.equal(denied.length, 1);
  m.close();
});

test("A3 secrets: keys never appear in events, and tool subprocesses do not inherit them", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "env | grep -c -E 'HCODE_API_KEY|ANTHROPIC_API_KEY' || true; echo HCODE_SANDBOX=$HCODE_SANDBOX" })], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  process.env.ANTHROPIC_API_KEY = "sk-ant-secret-SHOULD-NOT-LEAK";
  try {
    await runAgent({ cfg: { ...cfgFor(m.base, cwd), apiKey: "sk-ant-secret-SHOULD-NOT-LEAK" }, settings: {}, session: s, prompt: "go", quiet: true });
  } finally { delete process.env.ANTHROPIC_API_KEY; }
  const raw = fs.readFileSync(s.file, "utf8");
  assert.ok(!raw.includes("SHOULD-NOT-LEAK"));
  const out = lines(s.file).find(e => e.type === "item" && e.item.kind === "tool_result").item.output;
  assert.match(out, /^0\n/); assert.match(out, /HCODE_SANDBOX=(sandbox-exec|bwrap|systemd-run|none)/);
  m.close();
});

test("A3 sandbox adapter detection is honest: 'none' is degraded unless the policy asked for it", () => {
  const none = sandbox.detect("none", { force: true }); assert.equal(none.adapter, "none"); assert.equal(none.degraded, false);
  const auto = sandbox.detect("auto", { force: true });
  assert.ok(["sandbox-exec", "bwrap", "systemd-run", "none"].includes(auto.adapter));
  if (auto.adapter === "none") assert.equal(auto.degraded, true); else assert.equal(auto.degraded, false);
  const missing = sandbox.detect("bwrap", { force: true });
  if (process.platform === "darwin") { assert.equal(missing.adapter, "none"); assert.match(missing.reason, /not installed|refused/); }
  assert.match(sandbox.describe({ adapter: "none", degraded: true, reason: "x" }), /DEGRADED/);
  sandbox.detect("auto", { force: true });
});

test("SandboxWriteGate refuses mutation when the OS sandbox is degraded but permits a read-only command", async () => {
  const root = tmp();
  const tools = createTools({ root, sandboxStatus: { adapter: "none", degraded: true, reason: "systemd-run exited 226" } });
  assert.throws(() => tools.bash({ command: "touch changed.txt" }), error => error.code === "sandbox_degraded" && /226/.test(error.message));
  assert.equal(fs.existsSync(path.join(root, "changed.txt")), false);
  assert.match(await tools.bash({ command: "pwd" }), /\[exit 0\]/);
});

test("sandbox argv preserves a root containing spaces and Chinese as one argument", () => {
  const root = path.join(os.tmpdir(), "AI 协作系统", "交接", "hoopgram", "active");
  const [bin, args] = sandbox.wrap(["bash", "-lc", "pwd"], { root, adapter: "systemd-run" });
  assert.equal(bin, "systemd-run");
  assert.ok(args.includes(`ReadWritePaths=${root} /tmp`));
  assert.deepEqual(args.slice(-4), ["--", "bash", "-lc", "pwd"]);
  assert.equal(args.filter(arg => arg === root || arg === "/hoopgram/active").length, 0);
});

test("ToolResult v1 marks a runtime systemd-run 226 as retryable sandbox_unavailable", async () => {
  const root = tmp(), binDir = tmp(), fake = path.join(binDir, "systemd-run");
  fs.writeFileSync(fake, "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 226\n", { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const model = await startFakeModel((_messages, _request, turnNo) => turnNo === 1 ? { blocks: [tool("bash", { command: "touch never-ran.txt" })], stop: "tool_use" } : text("stopped safely"));
    const session = new Session(path.join(root, "sessions"));
    // the file's 3s bash timeout is tight enough that a loaded machine can kill the wrapper before it
    // reports 226, turning this into a timeout assertion; what is under test here is the exit code.
    try { await runAgent({ cfg: { ...cfgFor(model.base, root, "auto"), bashTimeoutMs: 30000, sandboxStatus: { adapter: "systemd-run", degraded: false, reason: "" } }, settings: {}, session, prompt: "go", quiet: true }); }
    finally { model.close(); }
    const result = lines(session.file).find(e => e.type === "item" && e.item.kind === "tool_result").item;
    assert.equal(result.ok, false); assert.equal(result.code, "sandbox_unavailable"); assert.equal(result.retryable, true);
    assert.match(result.output, /\[exit 226\].*OS sandbox wrapper failed/);
    assert.equal(fs.existsSync(path.join(root, "never-ran.txt")), false);
  } finally { process.env.PATH = oldPath; }
});

// the OS sandbox itself (only where an adapter is available; the result is honest either way)
test("A3 sandboxed bash: no writes outside the project, secrets unreadable, network off — where the OS offers a sandbox", async () => {
  const st = sandbox.detect("auto", { force: true });
  const root = tmp(); const tools = createTools({ root, sandboxWant: "auto" });
  const outside = path.join(os.homedir(), ".hcode-test-leak-" + process.pid);
  try {
    if (st.adapter === "none") {
      assert.throws(() => tools.bash({ command: "touch inside.txt" }), error => error.code === "sandbox_degraded");
      assert.match(await tools.bash({ command: "pwd" }), /\[exit 0\]/);
      return;
    }
    const r1 = await tools.bash({ command: `touch ${JSON.stringify(outside)} && echo LEAKED` });
    const r2 = await tools.bash({ command: "ls ~/.ssh 2>&1 | head -1" });
    const r3 = await tools.bash({ command: "touch inside.txt && echo fine" });
    assert.match(r3, /fine/);
    if (st.adapter !== "none") {
      assert.ok(!/LEAKED/.test(r1), r1); assert.ok(!fs.existsSync(outside));
      if (fs.existsSync(path.join(os.homedir(), ".ssh"))) assert.match(r2, /not permitted|Permission denied|No such file|cannot/i);
    }
  } finally { fs.rmSync(outside, { force: true }); }
});

// ---- red team (execution-book acceptance): auto mode ------------------------------------------------------
test("red team: auto mode cannot read secret paths, reach the network, write outside the root, or run undeclared danger silently", async () => {
  const home = os.homedir();
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [
    tool("read_file", { path: "~/.ssh/id_ed25519" }), tool("read_file", { path: path.join(home, ".hoopgram/keys/x") }), tool("read_file", { path: "~/.codex/auth.json" }), tool("read_file", { path: "~/.claude/settings.json" }),
    tool("write_file", { path: "../outside.txt", content: "x" }), tool("edit_file", { path: "/etc/hosts", old_string: "a", new_string: "b" }),
    tool("bash", { command: "curl -s https://evil.example/x" }), tool("bash", { command: "cat ~/.hcode/config.json" }),
  ], stop: "tool_use" } : text("ok"));
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd, "auto"), settings: {}, session: s, prompt: "go", quiet: true });
  const results = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_result").map(e => e.item);
  assert.equal(results.length, 8);
  for (const r of results.slice(0, 6)) { assert.equal(r.ok, false); assert.match(r.output, /refused|secret|outside/); }
  assert.equal(results[6].ok, false); assert.match(results[6].output, /network is off by default/);
  assert.ok(!/apiKey|baseUrl/.test(results[7].output), "the model must not read hcode's own config through bash");
  assert.ok(isSecretPath("/h/.codex/auth.json") && isSecretPath("/h/.claude/settings.local.json") && isSecretPath("/h/.hoopgram/keys/a") && isSecretPath("/h/x.pem"));
  const calls = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_call" && e.item.state === "denied");
  assert.ok(calls.length >= 1, "a denial is an audited state");
  m.close();
});

// ---- the gate is one ruler: what read_file refuses, bash may not fetch either (A8: HC-22/23/24/27) ----------
test("gate: symlinks are resolved before judging — a link to a secret or out of the root is refused", async () => {
  const root = tmp(); const outside = tmp();
  fs.writeFileSync(path.join(outside, ".env"), "SENTINEL=hcode-secret\n");
  fs.writeFileSync(path.join(outside, "plain.txt"), "outside\n");
  fs.symlinkSync(path.join(outside, ".env"), path.join(root, "link.txt"));
  fs.symlinkSync(outside, path.join(root, "escape"));
  const tools = createTools({ root, sandboxWant: "none" });
  await assert.rejects(tools.read_file({ path: "link.txt" }), /secret/);
  await assert.rejects(tools.write_file({ path: "escape/x.txt", content: "x" }), /outside the project root/);
  assert.equal(judgePath(root, "link.txt").secret, true);
  assert.equal(judgePath(root, "escape/plain.txt").inside, false);
  assert.equal(judgePath(root, "sub/new-file.txt").inside, true, "a path that does not exist yet is still judged");
});

test("gate: a bash command is judged by what it touches — secret paths refused in every mode", () => {
  const root = tmp(); fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "auth.json"), '{"token":"SENTINEL"}');
  const policy = loadPolicy(root);
  const d = (mode, command) => decide({ policy, mode, name: "bash", input: { command }, risk: risksOf("bash", { command }, root), root });
  for (const mode of ["read", "ask", "auto"]) {
    const v = d(mode, "cat .codex/auth.json");
    assert.equal(v.decision, "deny", mode); assert.match(v.why, /secret path/);
  }
  assert.equal(d("auto", "grep -r token .codex/auth.json | head").decision, "deny");
  assert.equal(d("auto", "cat README.md").decision, "allow");
  assert.deepEqual(risksOf("bash", { command: "cat .codex/auth.json" }, root), ["write", "identity"]);
});

test("gate: a command writing outside the root is denied in auto, asked in ask (node -e counts)", () => {
  const root = tmp(); const policy = loadPolicy(root);
  const cmd = `node -e "require('fs').writeFileSync('../outside/report.md','x')"`;
  const risk = risksOf("bash", { command: cmd }, root);
  assert.ok(risk.includes("destructive"));
  const auto = decide({ policy, mode: "auto", name: "bash", input: { command: cmd }, risk, root });
  assert.equal(auto.decision, "deny"); assert.match(auto.why, /outside the project root/);
  const ask = decide({ policy, mode: "ask", name: "bash", input: { command: cmd }, risk, root });
  assert.equal(ask.decision, "ask"); assert.match(ask.why, /\.\.\/outside\/report\.md/);
  // harmless system paths and in-root paths are not flagged
  const ok = decide({ policy, mode: "auto", name: "bash", input: { command: "node test.js > /dev/null 2>&1" }, risk: risksOf("bash", { command: "node test.js > /dev/null 2>&1" }, root), root });
  assert.equal(ok.decision, "allow");
});

test("gate: a payment-shaped command is money — it never runs unasked, not even in auto", () => {
  const root = tmp(); const policy = loadPolicy(root);
  const cmd = "node pay.js --amount 20 --card 4242424242424242";
  const risk = risksOf("bash", { command: cmd }, root);
  assert.ok(risk.includes("money"), risk.join(","));
  const v = decide({ policy, mode: "auto", name: "bash", input: { command: cmd }, risk, root });
  assert.equal(v.decision, "ask"); assert.match(v.why, /moves money/);
  assert.ok(!risksOf("bash", { command: "node test.js" }, root).includes("money"));
  for (const message of ["buy the fix", "refund parser false positive", "checkout cleanup"]) {
    const command = `cd ${root} && git commit -m "${message}"`;
    const commitRisk = risksOf("bash", { command }, root);
    assert.ok(!commitRisk.includes("money"), `${message}: ${commitRisk.join(",")}`);
    assert.equal(decide({ policy, mode: "auto", name: "bash", input: { command }, risk: commitRisk, root }).decision, "allow");
  }
  assert.ok(risksOf("bash", { command: "cd app && node checkout.js --amount=20" }, root).includes("money"));
});

test("risk gate judges executable actions, never grep patterns or printable prose", () => {
  const readAudit = classifyCommand("grep -rn -E '备份|退款|转移|独立恢复|死亡|自带服务器|自主交易|真钱' a.html b.html c.html | head -20; sed -n '30,80p' proof.html");
  assert.deepEqual(readAudit.risk, ["read"]); assert.equal(readAudit.readOnly, true);
  const liveFlip = classifyCommand("./owner-live-money-status-from-god.sh paddle-live-flip");
  assert.ok(liveFlip.risk.includes("money"));
  const inplace = classifyCommand("sed -i 's/a/b/' page.html");
  assert.ok(inplace.risk.includes("write")); assert.equal(inplace.readOnly, false);
  const print = classifyCommand("sed -n '30,80p' proof.html");
  assert.deepEqual(print.risk, ["read"]); assert.equal(print.readOnly, true);
});

test("agency level drives the gate but never unlocks a live payment action", () => {
  const root = tmp(); const policy = loadPolicy(root);
  const verdict = (level, command) => {
    const risk = classifyCommand(command).risk;
    return decide({ policy, mode: level >= 3 ? "all" : "ask", agencyLevel: level, name: "bash", input: { command }, risk, root }).decision;
  };
  assert.equal(verdict(8, "sed -n '30,50p' apps/comsite/src/buy.html"), "allow");
  assert.equal(verdict(0, "sed -n '30,50p' apps/comsite/src/buy.html"), "ask");
  assert.equal(verdict(8, "./owner-live-money-status-from-god.sh paddle-live-flip"), "ask");
  assert.equal(verdict(9, "./owner-live-money-status-from-god.sh paddle-live-flip"), "ask");
});

test("gate end to end: auto mode + no human → the four A8 bypasses all end as denied tool_calls with reasons", async () => {
  const cwd = tmp(); fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".codex", "auth.json"), '{"token":"SENTINEL-A8"}');
  fs.symlinkSync(path.join(cwd, ".codex", "auth.json"), path.join(cwd, "link.txt"));
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [
    tool("bash", { command: "cat .codex/auth.json" }),
    tool("read_file", { path: "link.txt" }),
    tool("bash", { command: `node -e "require('fs').writeFileSync('../outside.md','x')"` }),
    tool("bash", { command: "node pay.js --amount 20 --card 4242" }),
  ], stop: "tool_use" } : text("ok"));
  const s = new Session(path.join(cwd, "s"));
  await runAgent({ cfg: cfgFor(m.base, cwd, "auto"), settings: {}, session: s, prompt: "go", quiet: true });
  const raw = fs.readFileSync(s.file, "utf8");
  assert.ok(!raw.includes("SENTINEL-A8"), "no secret byte ever reaches the thread");
  const results = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_result").map(e => e.item);
  assert.equal(results.length, 4);
  assert.ok(results.every(r => r.ok === false), results.map(r => r.output).join(" | "));
  assert.match(results[0].output, /secret path/); assert.match(results[1].output, /secret/);
  assert.match(results[2].output, /outside the project root/); assert.match(results[3].output, /money|approve/);
  assert.ok(!fs.existsSync(path.join(path.dirname(cwd), "outside.md")));
  const denied = lines(s.file).filter(e => e.type === "item" && e.item.kind === "tool_call" && e.item.state === "denied");
  assert.equal(denied.length, 4, "every refusal is an audited event");
  m.close();
});

// ---- parser: the 2026-08-28 system-level block, four faces of one disease (rule of three, fourth hit) ----
// The parser guesses semantics from raw strings. These five reverse tests pin the fix: quotes are
// one unit, heredoc bodies are data, HTML tags are not paths, relatives resolve where the shell
// would run them, and money is an executable action — while a paddle live flip gates at EVERY level.
test("parser: a quoted path with spaces is ONE path — the handoff dir must be readable", () => {
  const root = tmp();
  const collab = path.join(root, "AI 协作系统", "交接", "hoopgram", "active");
  fs.mkdirSync(collab, { recursive: true });
  fs.writeFileSync(path.join(collab, "READ-FIRST.md"), "handoff");
  const command = `cat "${path.join(collab, "READ-FIRST.md")}"`;
  const one = pathsIn(command);
  assert.equal(one.length, 1, `expected exactly one path, got ${JSON.stringify(one)}`);
  assert.ok(one[0].includes("AI 协作系统"), "the space-bearing path survived as one word");
  const policy = loadPolicy(root);
  const risk = risksOf("bash", { command }, root);
  const v = decide({ policy, mode: "auto", name: "bash", input: { command }, risk, root });
  assert.equal(v.decision, "allow", v.why);
});

test("parser: heredoc bodies are data — </p> is an HTML tag, not the path /p", () => {
  const command = "python3 - <<'EOF'\nimport json\nh = '<p class=\"price\">按需</p>'\ne = dict(a=1, b=\"unknown\"))\nprint(h)\nEOF";
  assert.deepEqual(pathsIn(command), [], "nothing inside a heredoc body is a path");
  const cls = classifyCommand(command);
  assert.equal(cls.parseStatus, "parsed", `heredoc body parsed as commands: ${cls.reason}`);
  assert.ok(!cls.reason.includes("import"), cls.reason);
  const root = tmp(); const policy = loadPolicy(root);
  const v = decide({ policy, mode: "all", agencyLevel: 8, name: "bash", input: { command }, risk: cls.risk, root });
  assert.equal(v.decision, "allow", v.why);
});

test("parser: relative paths resolve where the shell would run them — cd into a subdir first", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "apps", "comsite"), { recursive: true });
  fs.mkdirSync(path.join(root, "nixos", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "nixos", "docs", "claims.json"), "{}");
  const policy = loadPolicy(root);
  const command = "cd apps/comsite && cat ../../nixos/docs/claims.json";
  const risk = risksOf("bash", { command }, root);
  assert.deepEqual(risk, ["read"], risk.join(","));
  const v = decide({ policy, mode: "auto", name: "bash", input: { command }, risk, root });
  assert.equal(v.decision, "allow", v.why);
  // without the cd, the same ../ escape really does leave the root and must still be refused
  const escape = "cat ../outside.md";
  const escRisk = risksOf("bash", { command: escape }, root);
  assert.ok(escRisk.includes("destructive"), escRisk.join(","));
  assert.equal(decide({ policy, mode: "auto", name: "bash", input: { command: escape }, risk: escRisk, root }).decision, "deny");
});

test("parser: flipping the paddle integration to live is money at every agency level", () => {
  const root = tmp(); const policy = loadPolicy(root);
  const flips = [
    "sed -i 's/sandbox/live/g' apps/paddle/config.json",
    "PADDLE_ENV=live node scripts/deploy.js",
    "echo live > apps/paddle/mode.env",
    "node scripts/paddle-live.js --amount=20",
  ];
  for (const command of flips) {
    const risk = risksOf("bash", { command }, root);
    assert.ok(risk.includes("money"), `${command}: ${risk.join(",")}`);
    for (const level of [0, 3, 8, 9]) {
      const v = decide({ policy, mode: level >= 3 ? "all" : "ask", agencyLevel: level, name: "bash", input: { command }, risk, root });
      assert.equal(v.decision, "ask", `level ${level}: ${command} -> ${v.decision} (${v.why})`);
    }
  }
  // read-only talk about paddle/live stays readable
  const notes = "grep -n 'paddle.*live' docs/notes.md";
  assert.ok(!risksOf("bash", { command: notes }, root).includes("money"));
});

test("parser: policy allowedRoots grant bash READS outside the root — mutations still refuse", () => {
  const root = tmp(); const grant = tmp();
  fs.mkdirSync(path.join(grant, "AI 协作系统", "交接"), { recursive: true });
  fs.writeFileSync(path.join(grant, "AI 协作系统", "交接", "READ-FIRST.md"), "handoff");
  const policy = loadPolicy(root); policy.allowedRoots.push(fs.realpathSync(grant));
  // a read of the space-bearing handoff path through the grant is read-only and allowed
  const readCmd = `cat "${path.join(grant, "AI 协作系统", "交接", "READ-FIRST.md")}"`;
  const readRisk = risksOf("bash", { command: readCmd }, root);
  const v = decide({ policy, mode: "auto", name: "bash", input: { command: readCmd }, risk: readRisk, root });
  assert.equal(v.decision, "allow", v.why);
  // without the grant the same read still asks (outside the root is an owner decision)
  const bare = loadPolicy(tmp());
  assert.equal(decide({ policy: bare, mode: "auto", name: "bash", input: { command: readCmd }, risk: readRisk, root }).decision, "deny");
  // and the grant is READ-only: sed -i inside it is a mutation and stays refused in auto
  const writeCmd = `sed -i 's/x/y/' "${path.join(grant, "AI 协作系统", "交接", "READ-FIRST.md")}"`;
  const writeRisk = risksOf("bash", { command: writeCmd }, root);
  assert.equal(decide({ policy, mode: "auto", name: "bash", input: { command: writeCmd }, risk: writeRisk, root }).decision, "deny");
});

test("grants: allowedTempRoots are the bounded home of self-destruction verification — and nothing more (2026-08-28 order)", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "CLAIMS-V0213-PUBLIC.json"), "{}");
  // Scratch is deliberately inside the project. Self-tests do not need any outside-write
  // authority; .hcode/tmp is the one narrow exception to .hcode's normal secret-path rule.
  const scratch = path.join(root, ".hcode", "tmp");
  fs.mkdirSync(path.join(root, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".hcode", "policy.json"), JSON.stringify({ v: 1, mode: "auto", allowedTempRoots: [scratch] }));
  const policy = loadPolicy(root);
  assert.deepEqual(policy.allowedTempRoots, [fs.realpathSync(scratch)], "declaration materializes the scratch dir");
  assert.equal(policy.problems.length, 0, policy.problems.join("; "));
  // ① self-destruction: hide the claims file in the declared scratch — the self-test move — allowed at 8
  const hide = `mv CLAIMS-V0213-PUBLIC.json ${path.join(scratch, "CLAIMS-V0213-PUBLIC.json")}`;
  assert.ok(!risksOf("bash", { command: hide }, root, policy).includes("destructive"), "bounded scratch move is not labelled destructive");
  assert.equal(decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command: hide }, risk: risksOf("bash", { command: hide }, root, policy), root }).decision, "allow", hide);
  // restore: mv back out of scratch into the project — also allowed (the gate went red, put it back)
  const back = `mv ${path.join(scratch, "CLAIMS-V0213-PUBLIC.json")} CLAIMS-V0213-PUBLIC.json`;
  assert.equal(decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command: back }, risk: risksOf("bash", { command: back }, root, policy), root }).decision, "allow", back);
  // ② the grant does not leak: the same mv to any other outside path still refuses
  const smuggle = `mv CLAIMS-V0213-PUBLIC.json ${path.join(tmp(), "smuggled.json")}`;
  assert.equal(decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command: smuggle }, risk: risksOf("bash", { command: smuggle }, root), root }).decision, "deny", smuggle);
  // ③ scratch is writable but money still asks inside it, at every level
  const flip = `sed -i 's/sandbox/live/' ${path.join(scratch, "paddle.conf")}`;
  assert.equal(decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command: flip }, risk: risksOf("bash", { command: flip }, root), root }).decision, "ask", "money asks even inside scratch");
  // ④ edges at load time: a read grant may not double as scratch; scratch may not swallow the project
  const conflictDir = tmp(); const conflictScratch = path.join(conflictDir, ".hcode", "tmp"); fs.mkdirSync(conflictScratch, { recursive: true });
  fs.writeFileSync(path.join(conflictDir, ".hcode", "policy.json"), JSON.stringify({ allowedRoots: [conflictScratch], allowedTempRoots: [conflictScratch] }));
  assert.ok(loadPolicy(conflictDir).problems.some(p => /read grants stay read-only/.test(p)), "read grant cannot double as scratch");
  const project = tmp(); fs.mkdirSync(path.join(project, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(project, ".hcode", "policy.json"), JSON.stringify({ allowedTempRoots: [path.join(os.tmpdir(), "outside-hcode-scratch")] }));
  assert.ok(loadPolicy(project).problems.some(p => /must be inside .*\.hcode\/tmp/.test(p)), "scratch may not grant project-external writes");
});

test("a read grant is read-only against redirects too — > and tee cannot write through it (张良's acceptance criterion, 2026-08-28)", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "note.txt"), "x");
  const grantDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-g-"));
  fs.writeFileSync(path.join(grantDir, "inbox.md"), "owner words");
  fs.mkdirSync(path.join(root, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".hcode", "policy.json"), JSON.stringify({ v: 1, mode: "auto", allowedRoots: [grantDir] }));
  const policy = loadPolicy(root);
  const verdict = command => decide({ policy, mode: "auto", agencyLevel: 8, name: "bash", input: { command }, risk: risksOf("bash", { command }, root), root });
  // the plain reads pass — that is the grant's whole purpose
  const read = `cat ${path.join(grantDir, "inbox.md")}`;
  assert.equal(verdict(read).decision, "allow", read);
  // a redirect under a READ_ONLY program is a WRITE into the grant — must refuse (echo is in
  // READ_ONLY, so before this fix `echo forged > /grant/inbox.md` slipped through as a "read")
  const forge = `echo forged > ${path.join(grantDir, "inbox.md")}`;
  assert.equal(verdict(forge).decision, "deny", forge);
  const viaGrep = `grep -l owner ${path.join(grantDir, "inbox.md")} > ${path.join(grantDir, "out.txt")}`;
  assert.equal(verdict(viaGrep).decision, "deny", viaGrep);
  const viaTee = `cat ${path.join(grantDir, "inbox.md")} | tee ${path.join(grantDir, "copy.md")}`;
  assert.equal(verdict(viaTee).decision, "deny", viaTee);
  // a redirect segment is write-shaped ALL THROUGH: even with the write target inside the project
  // root, the granted file is only readable by read-shaped commands — fail-closed on purpose
  // (patch-level freeze: no finer redirect-target parsing tonight; split `cat` + write_file instead)
  const home = `cat ${path.join(grantDir, "inbox.md")} > excerpt.md`;
  assert.equal(verdict(home).decision, "deny", home);
  // writes inside the project root with no granted file in the segment stay normal workspace writes
  assert.equal(verdict("echo x > excerpt.md").decision, "allow");
});
