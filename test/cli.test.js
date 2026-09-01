// A6 terminal surface (doctor in plain words, tools table, sessions list, print mode) and A7 external runners
// (detection, bounded flags, v2 translation, remove/add). Fake binaries on a temp PATH; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "hcode.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-home-"));
process.env.HCODE_HOME = home;                       // config.js reads it at import time
const { parseArgs, sessionsTable, toolsTable } = await import("../src/cli.js");
const { VERSION } = await import("../src/config.js");
const { listRunners, boundedArgs, removeRunner, addRunner, runExternal, makeTranslator, lastForeignSession, assertSafeExternalWorkspace, externalRunnerEnv, externalWrites } = await import("../src/runners.js");
const { Session } = await import("../src/session.js");
const { doctor } = await import("../src/doctor.js");
const { brainChoices, needsBrainSetup, resolveBrainChoice, saveRunner, saveDefaultHoop } = await import("../src/brain.js");
const { TRANSIENT_SSH } = await import("../src/connect.js");
const { startFakeModel, text, tool } = await import("./fake-model.js");
const { CoordinatorStore, createContract } = await import("../src/coordinator.js");
const { requestGate } = await import("../src/supervise.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cli-"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const UNSAFE_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// async so the fake model (served by this very process) can answer while hcode runs
const run = (args, opts = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: "1", ...opts.env }, cwd: opts.cwd || tmp(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
  if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
  child.on("close", status => resolve({ status, stdout, stderr }));
});

// fake external CLIs: a `claude` that speaks stream-json and a `codex` that speaks exec --json
function fakeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-bin-"));
  fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh
printf '%s\\n' '{"type":"system","session_id":"claude-sess-1"}'
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello from claude"}}}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"git status"}}]}}'
printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"clean"}]}}'
printf '%s\\n' '{"type":"result","result":"hello from claude","session_id":"claude-sess-1","usage":{"input_tokens":11,"output_tokens":3}}'
echo "$@" > "$FAKE_ARGS"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "codex"), `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-thread-9"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","aggregated_output":"a.txt","exit_code":0,"status":"completed"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"hello from codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'
echo "$@" > "$FAKE_ARGS"
`, { mode: 0o755 });
  return dir;
}

function fakeControlBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-control-bin-"));
  fs.writeFileSync(path.join(dir, "claude"), `#!/bin/sh
printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"external\\u001b]52;c;x\\u0007\\u009b31m"}}}'
printf '%s\\n' '{"type":"result","result":"external","session_id":"control-session","usage":{"input_tokens":1,"output_tokens":1}}'
`, { mode: 0o755 });
  return dir;
}

test("A6 parseArgs: new flags, --resume list, tools --json", () => {
  const a = parseArgs(["--runner", "codex", "--effort", "medium", "--max-turns", "6", "--token-budget", "5000", "--hoop-port", "19095", "--resume", "list", "tools", "--json", "--live", "--budget-usd", "0.75"]);
  assert.equal(a.runner, "codex"); assert.equal(a.tokenBudget, "5000"); assert.equal(a.resume, "list"); assert.deepEqual(a._, ["tools"]); assert.equal(a.json, true);
  assert.equal(a.effort, "medium"); assert.equal(a.maxTurns, "6");
  assert.equal(a.hoopPort, 19095);
  assert.equal(a.live, true); assert.equal(a.budgetUsd, 0.75);
  assert.equal(parseArgs(["--resume"]).resume, true);
  assert.equal(parseArgs(["--unattended", "-p", "x"]).unattended, true);
  assert.equal(parseArgs(["--tmux", "--stop", "--note", "checked"]).note, "checked");
  assert.equal(parseArgs(["guard", "--once", "--interval", "15m", "--registry", "/tmp/registry", "--tmux-socket", "guard-test"]).tmuxSocket, "guard-test");
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});

test("HeadlessLaunch v1: unsafe workspace exits with stable approval_required JSON", async () => {
  const cwd = tmp();
  fs.symlinkSync(cwd, path.join(cwd, "workspace-link"));
  const result = await run(["--cwd", cwd, "--json", "task", "start", "codex", "review safely"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const body = JSON.parse(result.stderr);
    assert.equal(body.ok, false); assert.equal(body.code, "approval_required"); assert.equal(body.cwd, cwd); assert.equal(body.mode, "all");
  assert.equal(body.runner, "codex"); assert.equal(body.policy, "workspace"); assert.deepEqual(body.allowedRoots, []);
  assert.ok(["sandbox-exec", "bwrap", "systemd-run", "none"].includes(body.sandbox.adapter));
});

test("guard status is scriptable without a brain or tmux connection", async () => {
  const cwd = tmp(), file = path.join(cwd, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, sessions: [{ name: "reviewer", type: "codex", cwd, expected: "working" }] }));
  const result = await run(["guard", "status", "--registry", file]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /reviewer\s+codex\s+expected=working/);
});

test("guard --once completes a zero-cost patrol through the configured local brain", async () => {
  const cwd = tmp(), guardHome = tmp(), file = path.join(cwd, "registry.json"), log = path.join(cwd, "rollout.jsonl"), bin = path.join(cwd, "tmux");
  fs.writeFileSync(log, "metadata\n"); fs.writeFileSync(file, JSON.stringify({ v: 1, sessions: [{ name: "reviewer", type: "codex", cwd, logPath: log, expected: "working" }] }));
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'reviewer\\tnode\\t0\\n'\n", { mode: 0o755 });
  const model = await startFakeModel(() => text('[{"session":"reviewer","verdict":"working","reason":"fresh registered log","action":"none","message":""}]'));
  try {
    const result = await run(["guard", "--once", "--registry", file, "--json"], { cwd, env: { HCODE_HOME: guardHome, HCODE_BASE_URL: model.base, HCODE_API_KEY: "fake", HCODE_MODEL: "fake-local", PATH: `${cwd}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr); const body = JSON.parse(result.stdout); assert.equal(body.decisions[0].action, "none"); assert.equal(model.calls.length, 1);
    const audit = lines(path.join(guardHome, "guard", "audit.jsonl")); assert.equal(audit[0].action, "none"); assert.equal(audit[0].delivered, false);
  } finally { model.close(); }
});

test("gate and work commands expose the durable coordinator without a connected brain", async () => {
  const cwd = tmp(); const c = createContract({ v: 1, id: "work-cafebabe", objective: "wait honestly", cwd, constraints: [], acceptance: ["done"], ownerGates: [{ id: "ship", question: "Ship?", preApproved: false }],
    budget: { wallMs: 10000, maxChildren: 1, maxConcurrent: 1, childTimeoutMs: 5000, heartbeatTimeoutMs: 1000, maxRetries: 0, maxCostUsd: null },
    lanes: [{ id: "inspect", runner: "codex", task: "inspect", mode: "read", dependsOn: [], ownership: [], verify: [] }], status: "proposed", stopReason: null });
  const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" }); requestGate(store, "ship", { laneId: "inspect" });
  const listed = await run(["--cwd", cwd, "gate", "list", c.id]); assert.equal(listed.status, 0, listed.stderr); assert.match(listed.stdout, /ship\s+requested\s+Ship\?/);
  const approved = await run(["--cwd", cwd, "gate", "approve", c.id, "ship", "--note", "checked"]); assert.equal(approved.status, 0, approved.stderr); assert.match(approved.stdout, /ship approved/);
  const status = await run(["--cwd", cwd, "work", "status", c.id]); assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, /work work-cafebabe[\s\S]*ship\s+approved/);
});

test("A6 `hcode tools --json` prints the contract; `hcode tools` a table; --version matches config.js", async () => {
  const j = await run(["tools", "--json"]); assert.equal(j.status, 0);
  assert.doesNotMatch(j.stdout, /[\x1b\r]/);
  const t = JSON.parse(j.stdout); assert.equal(t.length, 11); assert.ok(t.every(x => x.input && x.output && x.risk && "idempotent" in x));
  assert.match(toolsTable(), /bash\s+\[write,network\?,destructive\?\]/);
  const runners = await run(["runner", "list", "--json"]); assert.equal(runners.status, 0);
  assert.ok(Array.isArray(JSON.parse(runners.stdout))); assert.doesNotMatch(runners.stdout, /[\x1b\r]/);
  assert.equal((await run(["--version"])).stdout.trim(), VERSION);
  const help = (await run(["--help"])).stdout;
  assert.match(help, /hcode runner list\|add\|remove/); assert.match(help, /Ctrl-V pastes an image privately/); assert.match(help, /--effort <level>/); assert.match(help, /hcode benchmark \[--live\]/);
});

test("public benchmark describe and offline lanes are scriptable without a connected brain", async () => {
  const described = await run(["benchmark", "--describe"]);
  assert.equal(described.status, 0, described.stderr);
  const manifest = JSON.parse(described.stdout);
  assert.match(manifest.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.nominalEffort, "low");

  const offline = await run(["benchmark", "--json"], { env: { HCODE_API_KEY: "", ANTHROPIC_API_KEY: "", HCODE_TEST_OFF_HOOP: "1" } });
  assert.equal(offline.status, 0, offline.stderr);
  const report = JSON.parse(offline.stdout);
  assert.equal(report.pass, true);
  assert.equal(report.live, undefined);
  assert.equal(report.offline.context.turns, 240);
  assert.equal(report.offline.coordination.children, 32);
});

test("hcode mcp list is scriptable and redacts connector output", async () => {
  const bin = tmp();
  for (const name of ["codex", "claude"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '${name}-mcp API_KEY=hidden-value\\n'\n`, { mode: 0o755 });
  const result = await run(["mcp", "list"], { env: { PATH: bin } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Codex \[ready\].*Claude Code \[ready\]/s);
  assert.match(result.stdout, /API_KEY=\[redacted\]/); assert.doesNotMatch(result.stdout, /hidden-value|[\x1b\r]/);
  const json = await run(["mcp", "list", "--json"], { env: { PATH: bin } });
  assert.equal(json.status, 0); assert.equal(JSON.parse(json.stdout).length, 2);
});

test("first run never promotes Codex to brain; setup saves only the hcode coordinator", async () => {
  const isolatedHome = tmp(); const emptyPath = tmp(); const cwd = tmp();
  const emptyEnv = { HCODE_HOME: isolatedHome, PATH: emptyPath, HCODE_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", HCODE_RUNNER: "", HCODE_TEST_OFF_HOOP: "1" };
  const blocked = await run(["-p", "hello"], { cwd, env: emptyEnv });
  assert.equal(blocked.status, 78);
  assert.match(blocked.stderr, /No brain is connected.*hcode setup/s);
  assert.doesNotMatch(blocked.stdout + blocked.stderr, /x-api-key|ANTHROPIC_API_KEY|api\.anthropic\.com/);

  const bin = fakeBinDir();
  const selected = await run(["setup"], { cwd, input: "2\n", env: { ...emptyEnv, PATH: bin, HCODE_API_KEY: "configured" } });
  assert.equal(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /(?:Connect the Hoop Code coordinator|Change the coordinator connection).*My API provider.*\[configured\]/s);
  assert.doesNotMatch(selected.stdout, /Codex.*default brain|Claude Code.*default brain/s);
  const configFile = path.join(isolatedHome, "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { runner: "hcode" });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test("hcode demo shows the arrow-key menu as a still frame, with no brain and no config writes", async () => {
  const isolatedHome = tmp();
  const shown = await run(["demo"], { env: { HCODE_HOME: isolatedHome, HCODE_API_KEY: "", HCODE_TEST_OFF_HOOP: "1" } });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Change the coordinator connection.*HoopGram account.*demo of the \/brain menu/s);
  assert.match(shown.stdout, /demo only — nothing was run, saved or sent/);
  assert.ok(!fs.existsSync(path.join(isolatedHome, "config.json")));
});

test("HoopGram account is a browser device path, never a pasted provider key", async () => {
  const isolatedHome = tmp();
  const r = await run(["setup"], { input: "q\n", env: { HCODE_HOME: isolatedHome, PATH: tmp(), HCODE_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HoopGram account.*\[browser sign-in\]/s);
  assert.match(r.stdout, /Hoop desktop login is separate/);
  assert.match(r.stdout, /provider keys remain on the server/);
  assert.doesNotMatch(r.stdout, /paste|x-api-key|ANTHROPIC_API_KEY/i);
  assert.ok(!fs.existsSync(path.join(isolatedHome, "config.json")));
});

test("an expired provider becomes a brain switch, not a raw API-header failure", async () => {
  const m = await startFakeModel(() => ({ status: 401, body: JSON.stringify({ error: { message: "x-api-key header is required" } }) }));
  const cwd = tmp();
  const r = await run(["hello"], { cwd, env: { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" } });
  assert.equal(r.status, 1, "a failed one-shot task must be visible to its supervisor");
  assert.match(r.stderr, /This brain is no longer connected.*Type \/brain to switch/s);
  assert.doesNotMatch(r.stdout + r.stderr, /x-api-key|ANTHROPIC_API_KEY/);
  m.close();
});

test("/status keeps machine facts available without putting them on the first frame", async () => {
  const m = await startFakeModel(() => text("unused")); const cwd = tmp();
  const r = await run([], { cwd, input: "/status\n/exit\n", env: { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr);
  const beforeStatus = r.stdout.split("Current workspace")[0];
  assert.match(beforeStatus, /Your machine\. Your work\./);
  assert.doesNotMatch(beforeStatus, /sandbox:|session:/);
  assert.match(r.stdout, /Current workspace[\s\S]*workspace:[\s\S]*brain: Hoop Code \/ model: m[\s\S]*sandbox:[\s\S]*session:/);
  m.close();
});

test("/handoff files a ledger with a restart line, and /continue reads it back", async () => {
  const m = await startFakeModel(() => text("changed nothing yet")); const cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" };
  const r = await run([], { cwd, input: "check the parser\n/handoff active parser\n/handoff active parser\n/handoffs\n/exit\n", env });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(cwd, "交接", "hcode", "active", "hcode-parser.md");
  const body = fs.readFileSync(file, "utf8");
  assert.match(body.split("\n")[0], /^0\. 模式: default \| 状态: active \| 线程: \S+$/);
  assert.match(body, /asked: check the parser/);
  assert.match(body, /## 5\. 重启脚本/);
  assert.match(r.stdout, /✓ Wrote[\s\S]*?hcode-parser\.md/);
  assert.match(r.stdout, /✓ Updated[\s\S]*?hcode-parser\.md/);       // second write is the same file
  assert.match(r.stdout, /cd .* "\/continue parser"/);
  assert.doesNotMatch(r.stdout, /HCODE_API_KEY|configured/);            // a ledger never carries a credential
  assert.doesNotMatch(r.stderr, /Unknown command/);

  // The restart line's own argument: a slash command handed in at launch runs on the fresh session.
  const back = await run(["/continue parser"], { cwd, input: "/exit\n", env });
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /resuming hcode-parser\.md/);
  assert.match(back.stdout, /goal: {2}asked: check the parser/);
  m.close();
});

test("/savetoken survives /clear, rides in the ledger and comes back through /continue", async () => {
  const m = await startFakeModel(() => text("noted")); const cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" };
  const r = await run([], { cwd, input: "/savetoken\n/savetoken\n/clear\n/context\n/handoff active saving\n/exit\n", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Token-saving mode is on/);
  assert.match(r.stdout, /Already in savetoken mode/);
  assert.match(r.stdout, /Started a fresh conversation in savetoken mode/);   // /clear frees context, not the mode
  assert.match(r.stdout, /mode {8}savetoken/);
  const ledger = path.join(cwd, "交接", "hcode", "active", "hcode-saving.md");
  assert.match(fs.readFileSync(ledger, "utf8").split("\n")[0], /^0\. 模式: savetoken \| 状态: active \| 线程: \S+$/);

  const back = await run(["/continue saving"], { cwd, input: "/usedefault\n/context\n/exit\n", env });
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /Token-saving mode is on/);                        // restored from the ledger
  assert.match(back.stdout, /Token-saving mode is off/);                       // and /usedefault cancels it
  assert.match(back.stdout, /mode {8}default/);
  m.close();
});

test("/savetoken can prefix the prompt it modifies", async () => {
  const prompts = [];
  const m = await startFakeModel(messages => { prompts.push(messages.at(-1).content); return text("done"); });
  const cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" };
  const r = await run([], { cwd, input: "/savetoken hi\n/exit\n", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Token-saving mode is on/);
  assert.doesNotMatch(r.stderr, /Unknown command/);
  assert.deepEqual(prompts.map(prompt => typeof prompt === "string" ? prompt : prompt.map(block => block.text).join("")), ["hi"]);
  m.close();
});

test("/command new saves a prompt and /<name> runs it in the same session", async () => {
  const prompts = [];
  const m = await startFakeModel(messages => { prompts.push(messages.at(-1).content); return text("done"); });
  const cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" };
  const r = await run([], { cwd, input: "/command new tidy Format $ARGUMENTS and stop\n/tidy src/a.js\n/command list\n/command new cost mine\n/exit\n", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, ".hcode", "commands", "tidy.md"), "utf8").trim(), "Format $ARGUMENTS and stop");
  assert.match(r.stdout, /Saved \/tidy/);
  assert.deepEqual(prompts.map(p => (typeof p === "string" ? p : p.map(b => b.text).join(""))), ["Format src/a.js and stop"]);
  assert.match(r.stdout, /\/tidy +project {2}takes args Format \$ARGUMENTS and stop/);
  assert.match(r.stderr, /\/cost\s+is a built-in command and a built-in\s+always wins/); // wrapping never changes the contract
  assert.doesNotMatch(r.stderr, /Unknown command/);
  m.close();
});

// The launcher has no completion behind it, so a name it cannot match is a sentence, not a slip.
test("a launch argument naming no command is sent whole as a prompt; the composer still refuses one", async () => {
  const prompts = [];
  const m = await startFakeModel(messages => { prompts.push(messages.at(-1).content); return text("done"); });
  const cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" };
  const said = () => prompts.map(p => (typeof p === "string" ? p : p.map(b => b.text).join("")));

  const unknown = await run(["/rename the parser module"], { cwd, input: "/exit\n", env });
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.doesNotMatch(unknown.stderr, /Unknown command/);
  assert.deepEqual(said(), ["/rename the parser module"]);

  // A name that does resolve still runs as the command it is — here a custom one, loaded before the fallback decides.
  fs.mkdirSync(path.join(cwd, ".hcode", "commands"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "commands", "tidy.md"), "Format $ARGUMENTS and stop\n");
  const known = await run(["/tidy src/a.js"], { cwd, input: "/exit\n", env });
  assert.equal(known.status, 0, known.stderr);
  assert.deepEqual(said().slice(1), ["Format src/a.js and stop"]);

  // Typed into the composer, where `/` completes as you type, an unknown name stays a typo and costs no turn.
  const typed = await run([], { cwd, input: "/rename the parser module\n/exit\n", env });
  assert.equal(typed.status, 0, typed.stderr);
  assert.match(typed.stderr, /Unknown command \/rename/);
  assert.equal(said().length, 2);

  // --print is unchanged: a slash argument there was always a prompt and still is.
  const printed = await run(["--print", "/rename the parser module"], { cwd, env });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(said().slice(2), ["/rename the parser module"]);
  m.close();
});

test("hcode tune proposes from the real logs and writes nothing", async () => {
  const cwd = tmp(); const sessions = path.join(cwd, "s");
  const m = await startFakeModel(() => text("ok"));
  const env = { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: sessions, HCODE_MODEL: "m" };
  const empty = await run(["tune"], { cwd, env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /Not enough history to propose anything yet/);
  for (let n = 0; n < 4; n++) await run([], { cwd, input: `check the parser in src/a-${n}.js\n/exit\n`, env });
  const r = await run(["tune"], { cwd, env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Proposals only\. hcode changed nothing/);
  assert.match(r.stdout, /4×\s+check the parser in <path>/);
  assert.match(r.stdout, /\/command new check-parser/);
  assert.equal(fs.existsSync(path.join(cwd, ".hcode", "policy.json")), false);   // it proposed, it did not apply
  m.close();
});

function writeHoopSession(home, hoop, overrides = {}) {
  fs.mkdirSync(home, { recursive: true });
  const session = { hoop, accessToken: "s".repeat(32), expiresAt: Date.now() + 3600_000, issuedAt: Date.now() - 60_000,
    brainUrl: `https://${hoop}.hoopgram.ai/api/hcode`, dataUrl: `https://${hoop}.hoopgram.ai/api/hcode/data`,
    model: "deepseek-v4-pro", authBase: "https://hoopgram.ai", ...overrides };
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ v: 1, sessions: { [hoop]: session } }), { mode: 0o600 });
}

test("hcode account shows entitlement, expiry, and connection source, and never the token", async () => {
  const home = tmp();
  writeHoopSession(home, "lumi");
  const r = await run(["account", "lumi"], { env: { HCODE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HoopGram account/);
  assert.match(r.stdout, /account: lumi\.hoopgram\.ai/);
  assert.match(r.stdout, /entitlement: active/);
  assert.match(r.stdout, /session expires: \d{4}-\d{2}-\d{2}T/);
  assert.match(r.stdout, /connected through: lumi\.hoopgram\.ai \(signed in via https:\/\/hoopgram\.ai\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /s{32}|accessToken/);
});

test("hcode status includes the same account facts as hcode account, after the workspace block", async () => {
  const home = tmp();
  writeHoopSession(home, "lumi");
  const r = await run(["status", "lumi"], { env: { HCODE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Current workspace[\s\S]*HoopGram account[\s\S]*entitlement: active/);
});

test("hcode account reports an expired session with no accessToken leak", async () => {
  const home = tmp();
  writeHoopSession(home, "lumi", { expiresAt: Date.now() - 1000, accessToken: "EXPIREDTOKEN".repeat(3) });
  const r = await run(["account", "lumi"], { env: { HCODE_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /entitlement: expired/);
  assert.match(r.stdout, /run `hcode login lumi` again/);
  assert.doesNotMatch(r.stdout + r.stderr, /EXPIREDTOKEN/);
});

test("hcode account with no HoopGram session gives a clear next step, not an error", async () => {
  const r = await run(["account"], { env: { HCODE_HOME: tmp() } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HoopGram account\nnot connected on this machine\nrun `hcode login <hoop>`/);
});

test("brain router is deterministic and persists no credential material", () => {
  const runners = [
    { id: "hcode", enabled: true, available: true },
    { id: "claude", enabled: true, available: false },
    { id: "codex", enabled: true, available: true },
  ];
  const cfg = { runner: "hcode", apiKey: "" };
  assert.equal(needsBrainSetup(cfg, runners), true);
  const choices = brainChoices(cfg, runners);
  assert.equal(resolveBrainChoice("2", choices).id, "byok");
  assert.equal(resolveBrainChoice("codex", choices), null);
  assert.equal(resolveBrainChoice("99", choices), null);
  const isolatedHome = tmp(); saveRunner("hcode", isolatedHome);
  saveDefaultHoop("my-hoop", isolatedHome);
  const saved = fs.readFileSync(path.join(isolatedHome, "config.json"), "utf8");
  assert.deepEqual(JSON.parse(saved), { runner: "hcode", defaultHoop: "my-hoop", hoopBridge: false });
  assert.throws(() => saveRunner("codex", isolatedHome), /subagents/);
  assert.throws(() => saveDefaultHoop("bad hoop", isolatedHome), /invalid/);
  assert.doesNotMatch(saved, /key|token|password/i);
  // a Hoop whose sshd forbids -L is remembered as bridge-only so the next reconnect skips that handshake
  saveDefaultHoop("my-hoop", isolatedHome, { bridge: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolatedHome, "config.json"), "utf8")).hoopBridge, true);
  assert.match("ssh exec to gram@my-hoop.hoopgram.ai failed: Connection closed by 198.18.1.164 port 22", TRANSIENT_SSH);
  assert.match("kex_exchange_identification: read: Connection reset by peer", TRANSIENT_SSH);
  assert.doesNotMatch("gram@my-hoop.hoopgram.ai: Permission denied (publickey).", TRANSIENT_SSH, "auth failures are never retried");
  assert.doesNotMatch("channel 2: open failed: administratively prohibited: open failed", TRANSIENT_SSH);
});

test("A6 doctor turns provider authentication into a product action and prints no key", async () => {
  const m = await startFakeModel(() => ({ status: 401, body: JSON.stringify({ error: { type: "authentication_error", message: "x-api-key header is required" } }) }));
  const cwd = tmp();
  const out = []; const orig = console.log; console.log = (...a) => out.push(a.join(" "));
  let code;
  try { code = await doctor({ baseUrl: m.base, apiKey: "sk-ant-SECRET-DO-NOT-PRINT", model: "m", mode: "ask", cwd, sessionsDir: path.join(cwd, "s"), tokenBudget: 120000 }, { cli: { apiKey: "x" } }); }
  finally { console.log = orig; }
  const all = out.join("\n");
  assert.equal(code, 1);
  assert.doesNotMatch(all, /x-api-key header is required/); assert.match(all, /could not authenticate/); assert.match(all, /hcode setup/);
  assert.ok(!all.includes("SECRET-DO-NOT-PRINT")); assert.match(all, /never shown or logged/);
  assert.match(all, /sandbox/); assert.match(all, /policy/); assert.match(all, /runners/);
  m.close();
});

// Free ephemeral port that nothing is listening on, for doctor's "is a tunnel already up" probe.
async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}

test("A6 doctor in tunnel mode: key is held by the Hoop (not a local failure), and doctor opens the tunnel on demand then closes it", async () => {
  const m = await startFakeModel(() => text("ok"));
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".hcode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ sandbox: "none" }));
  const port = await freePort();
  const out = [];
  let closed = false;
  const fakeOpenTunnel = async ({ name }) => {
    assert.equal(name, "my-hoop");
    // the fake model plays the brain behind the tunnel; cfg.baseUrl below is a dead address on purpose
    return { brainAlive: true, viaBridge: true, remotePort: 8092, baseUrl: m.base, close: async () => { closed = true; } };
  };
  const code = await doctor(
    { baseUrl: "http://127.0.0.1:9", apiKey: "", model: "m", mode: "ask", cwd, sessionsDir: path.join(cwd, "s"), tokenBudget: 120000, runner: "hcode", defaultHoop: "my-hoop" },
    { cli: { port }, write: v => out.push(v), openTunnel: fakeOpenTunnel },
  );
  const all = out.join("\n");
  m.close();
  assert.equal(code, 0, all);
  assert.match(all, /\[ok\]\s+key\s+held by the Hoop \(my-hoop\.hoopgram\.ai\) — nothing stored locally/);
  assert.match(all, /\[ok\]\s+tunnel\s+opened on demand to my-hoop\.hoopgram\.ai:8092 and the brain answers \(via ssh stdio bridge\)/);
  assert.match(all, /\[ok\]\s+brain\s+answers \(200 in \d+ ms\) through the tunnel/, "brain is pinged through the tunnel, not cfg.baseUrl");
  assert.equal(closed, true, "doctor must close the tunnel it opened");
});

test("A6 doctor in tunnel mode: on-demand tunnel that fails to reach the brain is reported and still closed", async () => {
  const m = await startFakeModel(() => text("ok"));
  const cwd = tmp();
  const port = await freePort();
  const out = [];
  let closed = false;
  const fakeOpenTunnel = async () => ({ brainAlive: false, hint: "tunnel is up, but the brain service refused/reset the connection", close: async () => { closed = true; } });
  const code = await doctor(
    { baseUrl: m.base, apiKey: "", model: "m", mode: "ask", cwd, sessionsDir: path.join(cwd, "s"), tokenBudget: 120000, runner: "hcode", defaultHoop: "my-hoop" },
    { cli: { port }, write: v => out.push(v), openTunnel: fakeOpenTunnel },
  );
  const all = out.join("\n");
  m.close();
  assert.equal(code, 1);
  assert.match(all, /\[failed\]\s+tunnel\s+tunnel is up, but the brain service refused\/reset the connection/);
  assert.match(all, /\[failed\]\s+brain\s+not probed — the tunnel above is not answering/);
  assert.doesNotMatch(all, /brain\s+answers/, "a dead tunnel must not be masked by pinging cfg.baseUrl");
  assert.equal(closed, true, "doctor must close the tunnel it opened even on failure");
});

test("A6 doctor: no key and no default Hoop is still a real failure", async () => {
  const m = await startFakeModel(() => ({ status: 401, body: JSON.stringify({ error: { type: "authentication_error", message: "x" } }) }));
  const cwd = tmp();
  const out = [];
  const code = await doctor({ baseUrl: m.base, apiKey: "", model: "m", mode: "ask", cwd, sessionsDir: path.join(cwd, "s"), tokenBudget: 120000, runner: "hcode", defaultHoop: "" }, { cli: {}, write: v => out.push(v) });
  m.close();
  assert.equal(code, 1);
  assert.match(out.join("\n"), /\[failed\]\s+key\s+none set — the brain will refuse/);
});

test("A6 sessions list shows id, time, turns, first prompt; --resume list prints it", async () => {
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const s = new Session(dir, null, { cwd }); s.startTurn("fix the login bug"); s.message("user", "fix the login bug"); s.endTurn("end_turn");
  const table = sessionsTable(Session.list(dir));
  assert.match(table, new RegExp(`${s.id}\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\s+1 turn\\s+fix the login bug`));
  const r = await run(["--resume", "list"], { env: { HCODE_SESSIONS: dir } }); assert.equal(r.status, 0); assert.match(r.stdout, /fix the login bug/);
});

test("A6 one-shot direct prompt exits nonzero when the model turn fails", async () => {
  const m = await startFakeModel(() => ({ status: 401, body: "authentication_error" }));
  const cwd = tmp(), dir = path.join(cwd, "s");
  const r = await run(["one-shot failure"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /hcode setup|could not authenticate|no longer connected/);
  assert.equal(lines(path.join(dir, fs.readdirSync(dir)[0])).at(-1).reason, "error");
  m.close();
});

test("headless -p: a gate refusal is a visible failure, never a silent exit 0", async () => {
  // -p has no human to ask. The fake brain tries a money-shaped paddle flip in ask mode;
  // the gate must deny it AND the process must say so and exit 3 — a headless worker can
  // tell "the gate refused this" (retrying is pointless; escalate) from "budget stopped" (1).
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "PADDLE_ENV=live ./flip-to-live.sh" })], stop: "tool_use" } : text("done"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const denied = await run(["-p", "flip paddle to live"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(denied.status, 3, "a denied headless task must be visible to its supervisor");
  assert.match(denied.stderr, /hcode-print: denied=1/);
  assert.match(denied.stderr, /denied by the permission gate/);
  m.close();

  // and a clean read-only headless run still exits 0 — the marker must not fire on success
  const m2 = await startFakeModel(() => text("all readable"));
  const ok = await run(["-p", "read things"], { cwd, env: { HCODE_BASE_URL: m2.base, HCODE_API_KEY: "k", HCODE_SESSIONS: path.join(cwd, "s2"), HCODE_MODEL: "m" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /hcode-print: denied=/);
  m2.close();
});

test("A6 print mode end to end against the fake brain: streams, writes v2 session, exit 0", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "hi.txt", content: "hi" })], stop: "tool_use" } : text("wrote hi.txt"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const r = await run(["-p", "--mode", "auto", "make hi.txt"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "wrote hi.txt\n"); assert.doesNotMatch(r.stdout, /[\x1b\r]/);
  assert.equal(fs.readFileSync(path.join(cwd, "hi.txt"), "utf8"), "hi");
  const f = fs.readdirSync(dir)[0]; const rows = lines(path.join(dir, f));
  assert.equal(rows[0].type, "header"); assert.equal(rows[0].runner, "hcode"); assert.equal(rows.at(-1).type, "turn.end");
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  assert.ok(!raw.includes('"k"'), "the key is not in the session file"); assert.doesNotMatch(raw, /[\x1b\r]/);
  m.close();
});

test("A6 print mode visibly escapes model and external-runner controls", async () => {
  const hostile = "answer\x1b]52;c;x\x07\u009b31m";
  const m = await startFakeModel(() => text(hostile)); const cwd = tmp(); const dir = path.join(cwd, "s");
  const local = await run(["-p", "show controls"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(local.status, 0, local.stderr); assert.equal(local.stdout, "answer\\x1b]52;c;x\\x07\\x9b31m\n");
  assert.doesNotMatch(local.stdout, UNSAFE_CONTROL);
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"); assert.doesNotMatch(raw, UNSAFE_CONTROL);
  m.close();

  const externalDir = path.join(cwd, "external-s");
  const external = await run(["-p", "--runner", "claude", "show controls"], { cwd, env: { PATH: fakeControlBinDir(), HCODE_SESSIONS: externalDir } });
  assert.equal(external.status, 0, external.stderr); assert.equal(external.stdout, "external\\x1b]52;c;x\\x07\\x9b31m\n");
  assert.doesNotMatch(external.stdout, UNSAFE_CONTROL);
  const externalRaw = fs.readFileSync(path.join(externalDir, fs.readdirSync(externalDir)[0]), "utf8"); assert.doesNotMatch(externalRaw, UNSAFE_CONTROL);
});

test("A6 ask mode in a terminal: permission prompt says what/why, piped answers work, denial is reported", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("bash", { command: "rm -rf build" }), tool("edit_file", { path: "e.txt", old_string: "a", new_string: "b" })], stop: "tool_use" } : text("finished"));
  const cwd = tmp(); fs.writeFileSync(path.join(cwd, "e.txt"), "a\n");
  const r = await run(["--mode", "ask", "do it"], { cwd, input: "n\ny\n", env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /[\x1b\r]/);
  assert.match(r.stdout, /hcode wants to run rm -rf build/); assert.match(r.stdout, /risk: write, destructive/);
  assert.match(r.stdout, /hcode wants to edit e\.txt/); assert.match(r.stdout, /- a\n\+ b/);
  assert.match(r.stdout, /allow\? \[y\]es once \/ \[n\]o \/ \[a\]lways/);
  assert.match(r.stdout, /declined/); assert.equal(fs.readFileSync(path.join(cwd, "e.txt"), "utf8"), "b\n");
  m.close();
});

test("P1 terminal names an unparsed compound shell honestly instead of inventing money risk", async () => {
  const command = "cd . && for f in *.md; do command grep -oE 'buy|refund' \"$f\" | wc -l; done; printf done";
  const m = await startFakeModel((_messages, _request, turnNo) => turnNo === 1
    ? { blocks: [tool("bash", { command })], stop: "tool_use" }
    : text("declined safely"));
  const cwd = tmp();
  const r = await run(["--mode", "ask", "inventory"], { cwd, input: "n\n", env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /risk: unknown/);
  assert.match(r.stdout, /could not parse shell command or syntax/);
  assert.match(r.stdout, /review it yourself before allowing it/);
  assert.doesNotMatch(r.stdout, /moves money|risk:.*destructive/);
  m.close();
});

test("A6 blank approval fails closed without forging a human refusal", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "must-not-exist.txt", content: "no" })], stop: "tool_use" } : text("declined safely"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const r = await run(["--mode", "ask", "try a write"], { cwd, input: "\n", env: { NO_COLOR: "", HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr); assert.ok(!fs.existsSync(path.join(cwd, "must-not-exist.txt")));
  assert.match(r.stdout, /Press Enter without a choice: do not run/); assert.match(r.stdout, /○ Not run:/);
  assert.match(r.stdout, /no human decision was observed/);
  assert.doesNotMatch(r.stdout, /the human declined/);
  assert.doesNotMatch(r.stdout + r.stderr, /[\x1b\r]/);
  const rows = lines(path.join(dir, fs.readdirSync(dir)[0]));
  const approval = rows.find(row => row.type === "approval");
  assert.equal(approval.decision, "unobserved"); assert.equal(approval.by, "transport");
  m.close();
});

test("A6 explicit no is the only interactive answer recorded as human decline", async () => {
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "must-not-exist.txt", content: "no" })], stop: "tool_use" } : text("declined safely"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const r = await run(["--mode", "ask", "try a write"], { cwd, input: "n\n", env: { NO_COLOR: "", HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr); assert.ok(!fs.existsSync(path.join(cwd, "must-not-exist.txt")));
  assert.match(r.stdout, /the human declined/);
  const rows = lines(path.join(dir, fs.readdirSync(dir)[0]));
  const approval = rows.find(row => row.type === "approval");
  assert.equal(approval.decision, "deny"); assert.equal(approval.by, "owner");
  m.close();
});

test("A6 SKILL.md: skills under .hcode/skills are loaded into the system prompt and listed by doctor", async () => {
  const cwd = tmp(); fs.mkdirSync(path.join(cwd, ".hcode", "skills", "release"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hcode", "skills", "release", "SKILL.md"), "# Release checklist\n1. run tests\n2. bump version\n");
  const { loadSkills, skillsPrompt } = await import("../src/skills.js");
  const sk = loadSkills(cwd); assert.equal(sk.length, 1); assert.equal(sk[0].title, "Release checklist");
  assert.match(skillsPrompt(sk), /## skill: release[\s\S]*bump version/);
  const m = await startFakeModel((_m, req) => { assert.match(req.system, /skill: release/); return text("ok"); });
  const r = await run(["-p", "go"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: path.join(cwd, "s"), HCODE_MODEL: "m" } });
  assert.equal(r.status, 0, r.stderr); m.close();
});

// ---- A7 ----------------------------------------------------------------------------------------------------
test("A7 runners are detected on PATH only, never installed; remove/add are one command each", () => {
  const none = listRunners({ PATH: tmp() });
  assert.deepEqual(none.map(r => [r.id, r.available]), [["hcode", true], ["claude", false], ["codex", false]]);
  const bin = fakeBinDir();
  const some = listRunners({ PATH: bin });
  assert.ok(some.find(r => r.id === "claude").available && some.find(r => r.id === "codex").available);
  assert.match(removeRunner("codex"), /removed from hcode/); assert.match(removeRunner("codex"), /npm uninstall -g @openai\/codex/);
  const after = listRunners({ PATH: bin }); assert.equal(after.find(r => r.id === "codex").enabled, false); assert.equal(after.find(r => r.id === "codex").available, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "runners.json"), "utf8")).codex.enabled, false);
  assert.match(addRunner("codex"), /enabled/); assert.equal(listRunners({ PATH: bin }).find(r => r.id === "codex").enabled, true);
  assert.throws(() => removeRunner("hcode"), /unknown runner/);
});

test("A7 external CLIs are bounded by the hcode policy (flags follow mode and network)", () => {
  const off = { network: { default: "off" } }, on = { network: { default: "on" } };
  const c = boundedArgs("claude", { mode: "read", policy: off, prompt: "p", effort: "medium" });
  assert.ok(c.includes("--permission-mode") && c[c.indexOf("--permission-mode") + 1] === "plan");
  assert.equal(c[c.indexOf("--effort") + 1], "medium");
  assert.ok(!c[c.indexOf("--allowedTools") + 1].includes("Bash") && !c.join(" ").includes("WebFetch,WebSearch") || c.includes("--disallowedTools"));
  const ask = boundedArgs("claude", { mode: "ask", policy: off, prompt: "p" });
  assert.equal(ask[ask.indexOf("--permission-mode") + 1], "plan", "ask cannot be routed through hcode → read-only"); assert.match(ask[ask.indexOf("--disallowedTools") + 1], /Bash.*WebFetch/);
  const ca = boundedArgs("claude", { mode: "auto", policy: on, prompt: "p", resume: "s1" });
  assert.equal(ca[ca.indexOf("--permission-mode") + 1], "acceptEdits"); assert.match(ca[ca.indexOf("--allowedTools") + 1], /Bash.*WebFetch/); assert.ok(ca.includes("--resume"));
  assert.ok(!ca.includes("--dangerously-skip-permissions"));
  const x = boundedArgs("codex", { mode: "read", policy: off, prompt: "p", effort: "medium" });
  assert.equal(x[x.indexOf("--sandbox") + 1], "read-only"); assert.ok(x.includes('model_reasoning_effort="medium"') && !x.includes("sandbox_workspace_write.network_access=true") && !x.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(boundedArgs("codex", { mode: "ask", policy: off, prompt: "p" })[4], "read-only");
  const xa = boundedArgs("codex", { mode: "auto", policy: on, prompt: "p" });
  assert.equal(xa[xa.indexOf("--sandbox") + 1], "workspace-write"); assert.ok(xa.includes("sandbox_workspace_write.network_access=true"));
  const allClaude = boundedArgs("claude", { mode: "all", policy: off, prompt: "p" });
  assert.equal(allClaude[allClaude.indexOf("--permission-mode") + 1], "acceptEdits"); assert.ok(!allClaude.includes("--dangerously-skip-permissions"));
  const allCodex = boundedArgs("codex", { mode: "all", policy: off, prompt: "p" });
  assert.equal(allCodex[allCodex.indexOf("--sandbox") + 1], "workspace-write"); assert.ok(!allCodex.includes("--dangerously-bypass-approvals-and-sandbox"));
  const image = { path: "/tmp/hcode-images-abc123/img.png", root: "/tmp/hcode-images-abc123" };
  const codexImage = boundedArgs("codex", { mode: "read", policy: off, prompt: "inspect", images: [image] });
  assert.deepEqual(codexImage.slice(codexImage.indexOf("--image"), codexImage.indexOf("--image") + 2), ["--image", image.path]);
  const claudeImage = boundedArgs("claude", { mode: "read", policy: off, prompt: "inspect", images: [image] });
  assert.deepEqual(claudeImage.slice(claudeImage.indexOf("--add-dir"), claudeImage.indexOf("--add-dir") + 2), ["--add-dir", image.root]);
});

test("an agency grant reaches the external-runner bound: levels 7-8 write even where a frozen mode says ask (张良 2026-08-28, runners.js:61)", () => {
  const off = { network: { default: "off", allow: [] } };
  assert.equal(externalWrites("ask", 8), true, "level 8 ≡ auto/all semantics — the ruling");
  assert.equal(externalWrites("ask", 7), true);
  assert.equal(externalWrites("ask", 3), false, "levels below 7 do not widen the external bound");
  assert.equal(externalWrites("ask", null), false);
  assert.equal(externalWrites("ask"), false);
  assert.equal(externalWrites("auto", null), true);
  // the frozen "ask" that stalled 007's children: the grant alone must restore workspace writes
  const c8 = boundedArgs("claude", { mode: "ask", agencyLevel: 8, policy: off, prompt: "p" });
  assert.equal(c8[c8.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.match(c8[c8.indexOf("--allowedTools") + 1], /Edit.*Write.*Bash/);
  // network is still policy-gated: only the web tools stay denied, never the write tools
  assert.doesNotMatch(c8[c8.indexOf("--disallowedTools") + 1], /Edit|Write|Bash/);
  const x7 = boundedArgs("codex", { mode: "ask", agencyLevel: 7, policy: off, prompt: "p" });
  assert.equal(x7[x7.indexOf("--sandbox") + 1], "workspace-write");
  // without a grant, or below 7, the bound is unchanged — ask stays read-only
  assert.equal(boundedArgs("codex", { mode: "ask", agencyLevel: 6, policy: off, prompt: "p" })[4], "read-only");
  assert.equal(boundedArgs("codex", { mode: "ask", policy: off, prompt: "p" })[4], "read-only");
});

test("A7 external runner refuses workspace links and secret-shaped files, and never receives broker credentials", () => {
  const cwd = tmp(); fs.writeFileSync(path.join(cwd, "ok.txt"), "ok");
  assert.equal(assertSafeExternalWorkspace(cwd), fs.realpathSync(cwd));
  const outside = tmp(); fs.symlinkSync(outside, path.join(cwd, "escape"));
  assert.throws(() => assertSafeExternalWorkspace(cwd), /symlink/);
  fs.unlinkSync(path.join(cwd, "escape")); fs.writeFileSync(path.join(cwd, ".env"), "secret");
  assert.throws(() => assertSafeExternalWorkspace(cwd), /secret-shaped/);
  const cleaned = externalRunnerEnv({ PATH: "/bin", KEEP: "yes", HCODE_API_KEY: "no", OPENAI_API_KEY: "no", CUSTOM_TOKEN: "no" });
  assert.deepEqual(cleaned, { PATH: "/bin", KEEP: "yes" });
});

test("owner can allow a private-shaped workspace for one audited external-runner session", async () => {
  const bin = fakeBinDir(); const cwd = tmp(); const sessions = path.join(cwd, "sessions-outside");
  fs.writeFileSync(path.join(cwd, ".env"), "PRIVATE=not-read-by-hcode");
  const argsFile = path.join(os.tmpdir(), `hcode-owner-gate-${process.pid}-${Date.now()}.txt`);
  const env = { HCODE_HOME: tmp(), HCODE_RUNNER: "codex", HCODE_SESSIONS: sessions, PATH: bin, FAKE_ARGS: argsFile };
  const allowed = await run(["hello"], { cwd, input: "y\n", env });
  assert.equal(allowed.status, 0, allowed.stderr); assert.match(allowed.stdout, /Owner decision[\s\S]*continue\? \[y\]es \/ \[n\]o[\s\S]*hello from codex/);
  const rows = lines(path.join(sessions, fs.readdirSync(sessions)[0]));
  const approval = rows.find(row => row.type === "workspace.approval");
  assert.deepEqual({ runner: approval.runner, cwd: approval.cwd, decision: approval.decision, scope: approval.scope }, { runner: "codex", cwd: fs.realpathSync(cwd), decision: "allow", scope: "session" });
  assert.doesNotMatch(fs.readFileSync(argsFile, "utf8"), /PRIVATE=|not-read-by-hcode/);

  const deniedSessions = path.join(cwd, "sessions-denied");
  const denied = await run(["hello"], { cwd, input: "\n", env: { ...env, HCODE_HOME: tmp(), HCODE_SESSIONS: deniedSessions, FAKE_ARGS: argsFile + "-denied" } });
  assert.equal(denied.status, 1, "a denied one-shot task must be visible to its supervisor"); assert.match(denied.stderr, /Not run/); assert.ok(!fs.existsSync(argsFile + "-denied"));
  const deniedRows = lines(path.join(deniedSessions, fs.readdirSync(deniedSessions)[0]));
  assert.equal(deniedRows.find(row => row.type === "workspace.approval").decision, "deny");
});

test("/btw answers aside on a declared tier, stays out of the thread, and /attach lists it; /claude still needs a brain", async () => {
  const bin = fakeBinDir(); const cwd = tmp(); const sessions = path.join(cwd, "s"); const argsFile = path.join(cwd, "aside-args.txt");
  const m = await startFakeModel(() => text("the coordinator was never asked"));
  const r = await run([], { cwd, input: "/btw where does the parser live?\n/attach\n/claude fix the parser\n/exit\n",
    env: { HCODE_HOME: tmp(), HCODE_BASE_URL: m.base, HCODE_API_KEY: "configured", HCODE_SESSIONS: sessions, HCODE_MODEL: "deepseek-v4-pro", PATH: bin, FAKE_ARGS: argsFile } });
  m.close();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello from claude/);
  assert.match(r.stdout, /aside c-[0-9a-f]+ · claude haiku · kept out of this conversation's context/);
  assert.match(fs.readFileSync(argsFile, "utf8"), /--model haiku/, "the search tier reached the CLI, not its own default");
  const thread = lines(path.join(sessions, fs.readdirSync(sessions).find(name => name.endsWith(".jsonl"))));
  assert.equal(thread.find(row => row.type === "child.spawn").model, "haiku");
  assert.equal(thread.find(row => row.type === "child.report").status, "done");
  assert.ok(!thread.some(row => row.type === "item"), "an aside adds no message to the coordinator's thread");
  assert.match(r.stdout, /Subagents of this session[\s\S]*claude {2}haiku[\s\S]*where does the parser live\?/);
  assert.match(r.stderr, /refused: a claude subagent needs its brain named[\s\S]*--kind search/);
  assert.doesNotMatch(r.stdout, /started in background/);
});

test("A7 a claude turn lands in the v2 thread (header.runner, tool_call/tool_result with risk, foreign session for --resume)", async () => {
  const bin = fakeBinDir(); const cwd = tmp(); const argsFile = path.join(cwd, "args.txt");
  const s = new Session(path.join(cwd, "s"), null, { cwd, runner: "claude" });
  const texts = []; const tools = [];
  const r = await runExternal({ id: "claude", cfg: { cwd, mode: "ask" }, policy: { network: { default: "off" }, sandbox: "auto" }, session: s, prompt: "say hi",
    env: { PATH: bin, FAKE_ARGS: argsFile, HCODE_API_KEY: "must-not-pass" }, onText: t => texts.push(t), onTool: t => tools.push(t) });
  assert.equal(r.text, "hello from claude"); assert.deepEqual(r.usage, { input: 11, output: 3 }); assert.equal(r.foreignSession, "claude-sess-1");
  assert.deepEqual(texts, ["hello from claude"]); assert.equal(tools[0].name, "bash");
  assert.deepEqual(tools.map(event => event.phase), ["start", "end"]); assert.equal(tools[1].state, "done"); assert.ok(tools[1].durationMs >= 0);
  const rows = lines(s.file);
  assert.equal(rows[0].runner, "claude"); assert.equal(rows.find(e => e.type === "turn.start").runner, "claude");
  const call = rows.find(e => e.type === "item" && e.item.kind === "tool_call").item;
  assert.equal(call.tool, "bash"); assert.deepEqual(call.input, { command: "git status" }); assert.deepEqual(call.risk, ["read"]);
  const res = rows.find(e => e.type === "item" && e.item.kind === "tool_result").item; assert.equal(res.callId, call.id); assert.equal(res.output, "clean");
  const end = rows.at(-1); assert.equal(end.type, "turn.end"); assert.equal(end.reason, "end_turn"); assert.equal(end.foreignSession, "claude-sess-1");
  assert.equal(lastForeignSession(new Session(s.dir, s.id), "claude"), "claude-sess-1");
  const argv = fs.readFileSync(argsFile, "utf8"); assert.match(argv, /--permission-mode plan/); assert.ok(!argv.includes("must-not-pass"));
  // v2 thread is exportable: reopening it rebuilds messages like any hcode session
  const again = new Session(s.dir, s.id); assert.equal(again.messages.length, 3); assert.equal(again.header.runner, "claude");
});

test("A7 a codex turn lands in the v2 thread; a removed runner is refused; a missing binary is refused", async () => {
  const bin = fakeBinDir(); const cwd = tmp(); const argsFile = path.join(cwd, "args.txt");
  const s = new Session(path.join(cwd, "s"), null, { cwd, runner: "codex" });
  const r = await runExternal({ id: "codex", cfg: { cwd, mode: "read" }, policy: { network: { default: "off" } }, session: s, prompt: "list", env: { PATH: bin, FAKE_ARGS: argsFile } });
  assert.equal(r.text, "hello from codex"); assert.equal(r.foreignSession, "codex-thread-9");
  const rows = lines(s.file); const call = rows.find(e => e.type === "item" && e.item.kind === "tool_call").item;
  assert.equal(call.tool, "bash"); assert.equal(call.input.command, "ls");
  assert.match(fs.readFileSync(argsFile, "utf8"), /--sandbox read-only/);
  removeRunner("codex");
  await assert.rejects(runExternal({ id: "codex", cfg: { cwd, mode: "read" }, policy: {}, session: s, prompt: "x", env: { PATH: bin } }), /removed from hcode/);
  addRunner("codex");
  await assert.rejects(runExternal({ id: "codex", cfg: { cwd, mode: "read" }, policy: {}, session: s, prompt: "x", env: { PATH: tmp() } }), /not installed/);
  const cli = await run(["--runner", "codex", "-p", "x"], { cwd, env: { PATH: tmp() } }); assert.equal(cli.status, 64); assert.match(cli.stderr, /not installed/);
});

test("A7 translator: a CLI that dies mid-tool leaves cancelled calls, never a dangling running state", () => {
  const cwd = tmp(); const s = new Session(path.join(cwd, "s"), null, { cwd, runner: "claude" });
  s.startTurn("x");
  const tr = makeTranslator("claude", s, {});
  tr.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "Write", input: { file_path: "a.txt" } }] } }));
  tr.abandon("Claude Code CLI exited 1");
  const rows = lines(s.file);
  assert.ok(rows.some(e => e.type === "item" && e.item.kind === "tool_call" && e.item.state === "cancelled"));
  assert.equal(rows.find(e => e.type === "item" && e.item.kind === "tool_result").item.ok, false);
});

test("--agency maps into the gate and the grant survives --resume (2026-08-28 layer one, 张良)", async () => {
  // run one starts at --agency 8: a WRITE must go through with no human (mode all semantics)
  const m = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "a.txt", content: "one" })], stop: "tool_use" } : text("wrote"));
  const cwd = tmp(); const dir = path.join(cwd, "s");
  const first = await run(["-p", "--agency", "8", "write a.txt"], { cwd, env: { HCODE_BASE_URL: m.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "one", "agency 8 allowed the write without a human");
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
  assert.match(raw, /"agencyLevel":8/, "the grant is stamped into the session trail");
  // the supervisor's resume does NOT re-pass --agency: the stored grant must carry, or this
  // write would be asked, refused headless, and exit 3 (the exact five-stall shape)
  const m2 = await startFakeModel((_m, _r, k) => k === 1 ? { blocks: [tool("write_file", { path: "b.txt", content: "two" })], stop: "tool_use" } : text("wrote again"));
  const second = await run(["--resume", "-p", "--unattended", "write b.txt"], { cwd, env: { HCODE_BASE_URL: m2.base, HCODE_API_KEY: "k", HCODE_SESSIONS: dir, HCODE_MODEL: "m" } });
  assert.equal(second.status, 0, second.stderr + fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").slice(-800));
  assert.equal(fs.readFileSync(path.join(cwd, "b.txt"), "utf8"), "two", "the resumed session kept its agency 8 grant");
  const raw2 = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
  assert.match(raw2, /"unattended":true/, "unattended is stamped too");
  m.close(); m2.close();
});

test("decision gate: an invalid choice is never a human decision (阿加莎's reproduction, 2026-08-28)", async () => {
  const { makeConfirm } = await import("../src/cli.js");
  // a rescue message typed at a TTY decision prompt re-asks and records NOTHING — the message is
  // not a decision, and swallowing it as "the human declined" forged an audit record all night
  const seen = [];
  const asks = ["hey 007, hang on — here is what you should check next", "n"];
  const ttyConfirm = makeConfirm(async q => { seen.push(q); return asks.shift() ?? ""; }, { interactive: true });
  assert.equal(await ttyConfirm("bash", { command: "rm x" }, {}), "deny", "the follow-up n is a real decline");
  assert.equal(seen.length, 2, "the rescue message caused a re-ask, not a decision");
  // the recognized choices keep their exact meanings: blank is unobserved (fail-closed, not a
  // human refusal — the automation-Enter forgery 张良 banned), only explicit n is a human deny
  const table = [["y", "allow"], ["Y", "allow"], ["yes", "allow"], ["n", "deny"], ["no", "deny"], ["", "unobserved"], ["a", "always"], ["always", "always"]];
  for (const [input, want] of table) {
    const one = await makeConfirm(async () => input, { interactive: true })("write_file", { path: "x", content: "y" }, {});
    assert.equal(one, want, `input ${JSON.stringify(input)} must map to ${JSON.stringify(want)}`);
  }
  // piped stdin has no human behind it: garbage auto-denies as a MACHINE decision, never "human"
  assert.equal(await makeConfirm(async () => "let me help you finish this", { interactive: false })("bash", { command: "rm x" }, {}), "invalid-choice");
});
