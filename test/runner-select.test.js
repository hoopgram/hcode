// Who runs the turn. hcode is a kernel with a session, permission and evidence layer; the
// model call itself belongs to an executor the owner installed himself. These tests fix the whole
// selection rule: explicit beats automatic, automatic prefers codex, then claude, and hcode's own
// direct call is the floor — never an automatic preference.
//
// No network: every runner here is a shell script in a temp directory reached through a PATH this
// file controls. The developer's real codex/claude must never be able to answer one of these turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "hcode.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-runner-home-"));
process.env.HCODE_HOME = home;                        // config.js reads it at import time
const { autoRunner, loadConfig, normalizeRunner, DIRECT_RUNNER } = await import("../src/config.js");
const { addRunner, removeRunner } = await import("../src/runners.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-runner-"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

// A stub is a runner in every way that matters here: it is a file on PATH with the execute bit.
// `codex` also speaks enough of `codex exec --json` to complete one turn.
function stubs(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-runner-bin-"));
  for (const name of names) {
    const body = name === "codex" ? `#!/bin/sh
while IFS= read -r line; do :; done
printf '%s\\n' '{"type":"thread.started","thread_id":"codex-thread-1"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"hello from the stub codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}'
` : `#!/bin/sh
while IFS= read -r line; do :; done
printf '%s\\n' '{"type":"system","session_id":"claude-sess-1"}'
printf '%s\\n' '{"type":"result","result":"hello from the stub claude","session_id":"claude-sess-1","usage":{"input_tokens":4,"output_tokens":2}}'
`;
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

// process.env is this file's own (node --test gives every test file its own process), but restore
// anyway so one case can never decide the next one's answer.
function withEnv(patch, fn) {
  const before = { ...process.env };
  try { for (const [key, value] of Object.entries(patch)) { if (value === null) delete process.env[key]; else process.env[key] = value; } return fn(); }
  finally { for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); }
}

const run = (args, opts = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: "1", ...opts.env }, cwd: opts.cwd || tmp(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
  child.stdin.end(opts.input || "");
  child.on("close", status => resolve({ status, stdout, stderr }));
});

test("with no external runner installed the default is hcode's own direct call", () => {
  const empty = stubs([]);
  assert.equal(autoRunner({ PATH: empty }, home), DIRECT_RUNNER);
  withEnv({ PATH: empty, HCODE_RUNNER: null }, () => {
    const cfg = loadConfig({});
    assert.equal(cfg.runner, DIRECT_RUNNER);
    assert.equal(cfg.runnerExplicit, false);
  });
});

test("with only claude installed the default is claude", () => {
  const dir = stubs(["claude"]);
  assert.equal(autoRunner({ PATH: dir }, home), "claude");
  withEnv({ PATH: dir, HCODE_RUNNER: null }, () => assert.equal(loadConfig({}).runner, "claude"));
});

test("with codex and claude both installed codex wins the automatic choice", () => {
  const dir = stubs(["codex", "claude"]);
  assert.equal(autoRunner({ PATH: dir }, home), "codex");
  withEnv({ PATH: dir, HCODE_RUNNER: null }, () => assert.equal(loadConfig({}).runner, "codex"));
});

test("HCODE_RUNNER=direct and --runner direct beat detection; direct is never chosen automatically", () => {
  const dir = stubs(["codex", "claude"]);
  withEnv({ PATH: dir, HCODE_RUNNER: "direct" }, () => {
    const cfg = loadConfig({});
    assert.equal(cfg.runner, DIRECT_RUNNER);
    assert.equal(cfg.runnerExplicit, true);
  });
  withEnv({ PATH: dir, HCODE_RUNNER: null }, () => {
    assert.equal(loadConfig({ runner: "direct" }).runner, DIRECT_RUNNER);
    assert.equal(loadConfig({ runner: "codex" }).runner, "codex");
    assert.equal(loadConfig({}).runner, "codex");          // and without a word from the owner: detection
  });
});

test("--runner hcode still means the same thing as --runner direct (older configs keep working)", () => {
  const dir = stubs(["codex", "claude"]);
  assert.equal(normalizeRunner("direct"), DIRECT_RUNNER);
  assert.equal(normalizeRunner("hcode"), DIRECT_RUNNER);
  withEnv({ PATH: dir, HCODE_RUNNER: null }, () => {
    assert.equal(loadConfig({ runner: "hcode" }).runner, loadConfig({ runner: "direct" }).runner);
    assert.equal(loadConfig({ runner: "hcode" }).runnerExplicit, true);
  });
  withEnv({ PATH: dir, HCODE_RUNNER: "hcode" }, () => assert.equal(loadConfig({}).runner, DIRECT_RUNNER));
});

test("a runner saved in ~/.hcode/config.json is the owner's choice and outranks detection", () => {
  const dir = stubs(["codex", "claude"]);
  const configFile = path.join(home, "config.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ runner: "hcode" }));
  try {
    withEnv({ PATH: dir, HCODE_RUNNER: null }, () => {
      assert.equal(loadConfig({}).runner, DIRECT_RUNNER);
      assert.equal(loadConfig({}).runnerExplicit, true);
      assert.equal(loadConfig({ runner: "codex" }).runner, "codex");   // the command line still wins
    });
  } finally { fs.rmSync(configFile, { force: true }); }
});

test("a runner removed with `hcode runner remove` is not a candidate for the automatic choice", () => {
  const dir = stubs(["codex", "claude"]);
  removeRunner("codex");
  try {
    assert.equal(autoRunner({ PATH: dir }, home), "claude");
    withEnv({ PATH: dir, HCODE_RUNNER: null }, () => assert.equal(loadConfig({}).runner, "claude"));
    removeRunner("claude");
    assert.equal(autoRunner({ PATH: dir }, home), DIRECT_RUNNER);
  } finally { addRunner("codex"); addRunner("claude"); }
  assert.equal(autoRunner({ PATH: dir }, home), "codex");
});

test("hcode launch <runner> is hcode task start <runner>: same handler, same errors, same task", async () => {
  const bin = stubs(["codex", "claude"]);
  const taskHome = tmp();
  const env = { HCODE_HOME: taskHome, HCODE_SESSIONS: path.join(taskHome, "sessions"), PATH: bin, HCODE_RUNNER: "" };
  // the failure paths first: they prove the alias reaches the very same handler without starting anything
  const badLaunch = await run(["launch", "bogus", "hi"], { env });
  const badStart = await run(["task", "start", "bogus", "hi"], { env });
  assert.equal(badLaunch.status, 64); assert.equal(badLaunch.status, badStart.status);
  assert.equal(badLaunch.stderr, badStart.stderr);
  assert.match(badLaunch.stderr.replace(/\s+/g, " "), /hcode launch <claude\|codex> <prompt> is the same command/);
  const emptyLaunch = await run(["launch", "codex"], { env });
  const emptyStart = await run(["task", "start", "codex"], { env });
  assert.equal(emptyLaunch.stderr, emptyStart.stderr); assert.match(emptyLaunch.stderr, /task needs a prompt/);
  // and the happy path: one background conversation, started by the one-word spelling
  const started = await run(["launch", "codex", "--kind", "search", "list the files"], { env });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /^task-[a-z0-9]{8} started in the background/);
  const id = started.stdout.match(/task-[a-z0-9]{8}/)[0];
  const listed = await run(["task", "list"], { env });
  assert.match(listed.stdout, new RegExp(id));
  assert.equal(JSON.parse(fs.readFileSync(path.join(taskHome, "tasks", id, "state.json"), "utf8")).runner, "codex");
});

test("one turn through the automatically chosen runner lands in the append-only v2 session", async () => {
  const bin = stubs(["codex"]);
  const sessions = tmp(), cwd = tmp();
  // no HCODE_RUNNER, no --runner: the only thing that decides this is what is on PATH
  const result = await run(["-p", "say hello"], { cwd, env: { HCODE_HOME: tmp(), HCODE_SESSIONS: sessions, PATH: bin, HCODE_RUNNER: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hello from the stub codex/);
  const file = path.join(sessions, fs.readdirSync(sessions).find(name => name.endsWith(".jsonl")));
  const rows = lines(file);
  assert.equal(rows[0].type, "header");
  assert.equal(rows[0].runner, "codex");                       // the thread records who actually answered
  assert.equal(rows.find(row => row.type === "turn.start").runner, "codex");
  const items = rows.filter(row => row.type === "item").map(row => row.item);
  assert.equal(items.filter(item => item.kind === "message" && item.role === "user").length, 1);
  const said = items.filter(item => item.kind === "message" && item.role === "assistant")
    .flatMap(item => Array.isArray(item.content) ? item.content : [{ text: item.content }]).map(part => part.text || "").join("");
  assert.match(said, /hello from the stub codex/);
  assert.equal(rows.at(-1).type, "turn.end");
  // append-only: a second turn on the same session only adds
  const before = fs.readFileSync(file, "utf8");
  const again = await run(["-p", "--resume", path.basename(file, ".jsonl"), "again"], { cwd, env: { HCODE_HOME: tmp(), HCODE_SESSIONS: sessions, PATH: bin, HCODE_RUNNER: "" } });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(file, "utf8").startsWith(before), true);
});

test("a resumed thread keeps the runner it was already running on", async () => {
  const bin = stubs(["codex", "claude"]);
  const sessions = tmp(), cwd = tmp();
  const env = { HCODE_HOME: tmp(), HCODE_SESSIONS: sessions, PATH: bin, HCODE_RUNNER: "" };
  const first = await run(["-p", "--runner", "claude", "start on claude"], { cwd, env });
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(sessions, fs.readdirSync(sessions).find(name => name.endsWith(".jsonl")));
  const id = path.basename(file, ".jsonl");
  assert.equal(lines(file)[0].runner, "claude");
  // detection alone would say codex here; continuing someone else's conversation is not detection's call
  const again = await run(["-p", "--resume", id, "keep going"], { cwd, env });
  assert.equal(again.status, 0, again.stderr);
  const turns = lines(file).filter(row => row.type === "turn.start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map(turn => turn.runner), ["claude", "claude"]);
  // …but an explicit word from the owner still moves it
  const moved = await run(["-p", "--resume", id, "--runner", "codex", "now codex"], { cwd, env });
  assert.equal(moved.status, 0, moved.stderr);
  assert.deepEqual(lines(file).filter(row => row.type === "turn.start").map(turn => turn.runner), ["claude", "claude", "codex"]);
});

test("with an external runner in charge, hcode makes no model call of its own — doctor says so and stays green", async () => {
  const bin = stubs(["codex"]);
  const env = { HCODE_HOME: tmp(), HCODE_SESSIONS: tmp(), PATH: bin, HCODE_RUNNER: "", HCODE_TEST_OFF_HOOP: "1",
    HCODE_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" };
  const result = await run(["doctor", "--json"], { env });
  const report = JSON.parse(result.stdout);
  const row = name => report.rows.find(entry => entry.name === name);
  assert.equal(row("runners").detail.startsWith("codex runs this session"), true);
  assert.equal(row("key").ok, true);                       // no key is not a fault when no key is used
  assert.match(row("key").detail, /none needed while codex runs the turns/);
  assert.equal(row("brain").ok, true);
  assert.match(row("brain").detail, /not probed and not needed/);  // nothing was sent to any provider
  assert.equal(row("sandbox").ok, true);
  assert.match(row("sandbox").detail, /codex --sandbox workspace-write/);
  assert.equal(report.sandboxDegraded, false);
  assert.deepEqual(report.rows.filter(entry => !entry.ok).map(entry => entry.name).filter(name => ["brain", "key", "runners", "sandbox"].includes(name)), []);
});
