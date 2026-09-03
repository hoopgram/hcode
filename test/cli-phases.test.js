// The launch is a sequence of named phases (cli.js), a table of one-shot answers (cli-commands.js)
// and a session made of more phases (cli-session.js). These are the contracts that hold the sequence
// together — the ones a reader cannot see by looking at any single phase.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "hcode.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-phases-home-"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-phases-"));

const { parseArgs } = await import("../src/cli.js");
const { answerOneShot, answerLiveBenchmark } = await import("../src/cli-commands.js");
const { SLASH_GROUPS, chooseRenderPath, openThread } = await import("../src/cli-session.js");
const { ui } = await import("../src/ui.js");
const { EFFORT_LEVELS } = await import("../src/config.js");

const run = (args, opts = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: opts.cwd || tmp(),
    env: { ...process.env, HOME: home, HCODE_HOME: home, NO_COLOR: "1", HCODE_API_KEY: "test", HCODE_BASE_URL: "http://127.0.0.1:1", ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = ""; let err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  child.stdin.end(opts.stdin || "");
  child.on("close", code => resolve({ code, out, err }));
});

// ---- phase 1: parseArgs ---------------------------------------------------------------------------

test("parseArgs feeds each launch phase the flags that phase reads", () => {
  // openLaunch reads the agency grant; attachBrain reads the tunnel options; openThread reads
  // --resume; openRenderPath reads --print. One parse, then nothing re-reads argv.
  const a = parseArgs(["--agency", "9", "--agency-budget-usd", "2.5", "--unattended",
    "--user", "gram", "--port", "18092", "--hoop-port", "18095", "--identity", "/k/id",
    "--resume", "abc123", "-p", "do the thing"]);
  assert.equal(a.agencyLevel, 9);
  assert.equal(a.agencyBudgetUsd, 2.5);
  assert.equal(a.unattended, true);
  assert.deepEqual([a.user, a.port, a.hoopPort, a.identity], ["gram", 18092, 18095, "/k/id"]);
  assert.equal(a.resume, "abc123");
  assert.equal(a.print, true);
  assert.deepEqual(a._, ["do the thing"]);
  // `--resume` with a flag behind it takes no value; `--resume list` is a value, not a session id.
  assert.equal(parseArgs(["--resume", "-p", "x"]).resume, true);
  assert.equal(parseArgs(["--resume", "list"]).resume, "list");
  // A value-taking flag at the end of argv is an error, not a silent undefined.
  assert.throws(() => parseArgs(["--model"]), /--model needs a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option --nope/);
  // Anything that is not a flag is positional, in order: subcommand first, then its words.
  assert.deepEqual(parseArgs(["task", "start", "claude", "fix it"])._, ["task", "start", "claude", "fix it"]);
});

// ---- phase: which render path this sink gets ------------------------------------------------------

test("chooseRenderPath: only a capable interactive TTY with nothing to do gets the composer", () => {
  const tty = { isTTY: true, setRawMode() {} };
  const out = { isTTY: true };
  const term = { TERM: "xterm-256color" };
  assert.equal(chooseRenderPath({ task: "", stdin: tty, stdout: out, env: term }), "composer");
  // A task typed on the command line has no input box to draw.
  assert.equal(chooseRenderPath({ task: "fix the test", stdin: tty, stdout: out, env: term }), "readline");
  // A pipe on either end, a dumb terminal, or NO_COLOR: readline plus a plain sink.
  assert.equal(chooseRenderPath({ task: "", stdin: { isTTY: false }, stdout: out, env: term }), "readline");
  assert.equal(chooseRenderPath({ task: "", stdin: tty, stdout: { isTTY: false }, env: term }), "readline");
  assert.equal(chooseRenderPath({ task: "", stdin: tty, stdout: out, env: { TERM: "dumb" } }), "readline");
  assert.equal(chooseRenderPath({ task: "", stdin: tty, stdout: out, env: { ...term, NO_COLOR: "1" } }), "readline");
  // A TTY that cannot go raw cannot hold a composer either.
  assert.equal(chooseRenderPath({ task: "", stdin: { isTTY: true }, stdout: out, env: term }), "readline");
});

// ---- phase: the one-shot answers ------------------------------------------------------------------

test("answerOneShot and answerLiveBenchmark return null for a plain launch, so the session still opens", async () => {
  // The bug this guards: a group that answers 0 instead of null turns `hcode` into a no-op that
  // exits successfully without ever opening a thread.
  const cfg = { cwd: tmp(), sessionsDir: tmp(), runner: "hcode" };
  assert.equal(await answerOneShot({ sub: undefined, args: { _: [] }, cfg, policy: {} }), null);
  assert.equal(await answerLiveBenchmark({ sub: undefined, args: {}, cfg, tunnel: null }), null);
  // `hcode benchmark` without --live or --polyglot is answered before the tunnel, not after it.
  assert.equal(await answerLiveBenchmark({ sub: "benchmark", args: {}, cfg, tunnel: null }), null);
});

test("the one-shot order is the command surface: --resume list is answered before the tool catalog", async () => {
  // answerHistory sits before answerCatalog exactly as the old if-chain did, so `hcode tools
  // --resume list` prints sessions. Reordering the groups would silently change what this prints.
  const r = await run(["tools", "--resume", "list"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /no sessions yet/);
  assert.doesNotMatch(r.out, /idempotent/);
});

test("openLaunch refuses an impossible agency grant with 64 before anything is opened", async () => {
  const bad = await run(["--agency", "12", "-p", "hello"]);
  assert.equal(bad.code, 64);
  assert.match(bad.err + bad.out, /--agency must be an integer from 0 to 9/);
  // Level 9 without an owner-set ceiling is not refused — it is honestly demoted to 8 and said so.
  const demoted = await run(["--agency", "9", "sessions"]);
  assert.equal(demoted.code, 0);
  assert.match(demoted.err + demoted.out, /agency 9 needs a positive --agency-budget-usd; using agency 8/);
});

// ---- phase: the thread --------------------------------------------------------------------------

test("openThread refuses a resume it cannot honour and opens a fresh thread otherwise", () => {
  const sessionsDir = tmp();
  const cfg = { cwd: tmp(), sessionsDir, runner: "hcode", model: "m", effort: "high", tokenBudget: 1000, mode: "ask" };
  // Nothing to resume is exit 1, not a silent new conversation that loses the owner's place.
  const empty = { args: { resume: true }, cfg, session: null };
  assert.equal(openThread(empty), 1);
  assert.equal(empty.session, null);
  // A named session that does not exist is also 1, and still opens nothing.
  const missing = { args: { resume: "no-such-session" }, cfg, session: null };
  assert.equal(openThread(missing), 1);
  // No --resume: a fresh thread, and the phase says "carry on" by returning null.
  const fresh = { args: {}, cfg, session: null };
  assert.equal(openThread(fresh), null);
  assert.ok(fresh.session?.id);
  // The new thread is on disk, so a later `hcode --resume` can find it.
  assert.ok(fs.existsSync(sessionsDir));
});

// ---- phase: the slash catalog ---------------------------------------------------------------------

const stubCtx = () => ({ cfg: { cwd: tmp(), sessionsDir: tmp() }, policy: {}, settings: {}, customCommands: [], session: null });

test("a slash group that does not own the line answers null, so the next group still sees it", async () => {
  // This is the contract the whole catalog rests on. A group that returned false instead of null
  // would swallow every command defined after it, silently.
  const ctx = stubCtx();
  for (const group of SLASH_GROUPS) {
    assert.equal(await group(ctx, "fix the failing assertion in ui.test.js", [], { startup: false }), null,
      `${group.name} claimed an ordinary prompt`);
  }
});

test("each built-in reaches its own group: nothing earlier in the order claims it first", async () => {
  // Only the groups BEFORE the owner are exercised — running the owner would actually execute the
  // command. What is being pinned is the order, which is the thing a split can quietly change.
  const owner = {
    "/exit": 0, "/logout": 0, "/compact": 1, "/clear": 1, "/handoff": 1, "/savetoken": 1,
    "/context": 2, "/diff": 2, "/plan": 2, "/model": 3, "/effort": 3, "/permissions": 3,
    "/doctor": 3, "/update": 3, "/cost": 4, "/tune": 4, "/resume": 4, "/brain": 5, "/agents": 5,
    "/btw": 5, "/attach": 5, "/status": 6, "/policy": 6, "/help": 6, "/command": 6,
    "/not-a-builtin": 7,
  };
  const ctx = stubCtx();
  for (const [line, index] of Object.entries(owner)) {
    for (let i = 0; i < index; i++) {
      assert.equal(await SLASH_GROUPS[i](ctx, line, [], { startup: false }), null,
        `${SLASH_GROUPS[i].name} claimed ${line}, which belongs to ${SLASH_GROUPS[index].name}`);
    }
  }
});

test("/effort accepts the same five levels as /config, in the argument form", async () => {
  // /effort <value> used to hardcode ["low", "medium", "high"], leaving xhigh and max reachable
  // only through /config. Both now read the same EFFORT_LEVELS list from config.js.
  const ctx = { ...stubCtx(), cfg: { cwd: tmp(), sessionsDir: tmp(), effort: "high" }, refreshMeter: () => {} };
  assert.equal(await SLASH_GROUPS[3](ctx, "/effort xhigh", [], { startup: false }), false);
  assert.equal(ctx.cfg.effort, "xhigh");
  const original = ui.error;
  let seen = "";
  ui.error = message => { seen = message; };
  try {
    assert.equal(await SLASH_GROUPS[3](ctx, "/effort bogus", [], { startup: false }), false);
  } finally { ui.error = original; }
  assert.equal(ctx.cfg.effort, "xhigh"); // unchanged on a bad value
  for (const level of EFFORT_LEVELS) assert.match(seen, new RegExp(level));
});

test("/exit leaves and an unknown slash command does not, in the same catalog", async () => {
  const ctx = stubCtx();
  assert.equal(await SLASH_GROUPS[0](ctx, "/exit", [], { startup: false }), true);
  assert.equal(await SLASH_GROUPS[0](ctx, "/quit", [], { startup: false }), true);
  assert.equal(await SLASH_GROUPS[0](ctx, "/q", [], { startup: false }), true);
  // An unknown name at the prompt is a warning and the session stays open; it is never an exit.
  assert.equal(await SLASH_GROUPS[7](ctx, "/nope", [], { startup: false }), false);
});
