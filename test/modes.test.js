import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { MODES, applyMode, currentMode, modeNotice, modePrompt, setMode } from "../src/modes.js";
import { systemPrompt, leanSystemPrompt } from "../src/agent.js";
import { resolveSubagentModel, SUBAGENT_TIERS } from "../src/subagents.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-modes-"));

test("a mode is a thread event, so it survives a reopen of the same log", () => {
  const dir = tmp();
  const session = new Session(dir, null, { cwd: dir });
  assert.equal(currentMode(session), "default");
  setMode(session, "savetoken");
  setMode(session, "default");
  setMode(session, "savetoken");                       // the last one wins, not the first
  assert.equal(currentMode(session), "savetoken");
  assert.equal(currentMode(new Session(dir, session.id)), "savetoken");
  assert.deepEqual(MODES, ["default", "savetoken"]);
  assert.throws(() => setMode(session, "cheap"), /unknown mode "cheap"/);
  assert.equal(currentMode({ events: null }), "default");
});

test("a mode only ever sets how hcode spends — never permission, brain or sandbox", () => {
  const cfg = { mode: "ask", model: "m", effort: "high", sandbox: "bwrap" };
  applyMode(cfg, "savetoken");
  assert.equal(cfg.saveToken, true); assert.equal(cfg.subagentDefaultKind, "search");
  assert.deepEqual([cfg.mode, cfg.model, cfg.effort, cfg.sandbox], ["ask", "m", "high", "bwrap"]);
  applyMode(cfg, "default");
  assert.equal(cfg.saveToken, false); assert.equal(cfg.subagentDefaultKind, "");
  assert.match(modeNotice("savetoken"), /\/usedefault cancels/);
  assert.match(modeNotice("default"), /off/);
});

test("the mode reaches the brain as guidance in both prompt shapes", () => {
  const cwd = tmp();
  assert.equal(modePrompt({ saveToken: false }), "");
  assert.match(modePrompt({ saveToken: true }), /Delegation is the default/);
  assert.match(modePrompt({ saveToken: true }), /correctness outranks the token rule/);
  assert.doesNotMatch(systemPrompt({ cwd, mode: "ask", model: "claude-sonnet-5" }), /Token-saving mode/);
  assert.match(systemPrompt({ cwd, mode: "ask", model: "claude-sonnet-5", saveToken: true }), /# Token-saving mode/);
  assert.match(leanSystemPrompt({ cwd, mode: "ask", saveToken: true }, "", []), /Token-saving mode: delegate/);
  assert.doesNotMatch(leanSystemPrompt({ cwd, mode: "ask" }, "", []), /Token-saving/);
});

test("in savetoken an unqualified delegation takes the smallest tier instead of being refused", () => {
  const call = { runner: "claude", coordinatorModel: "fable" };
  assert.throws(() => resolveSubagentModel(call), /needs its brain named in the call/);
  const chosen = resolveSubagentModel({ ...call, defaultKind: "search" });
  assert.deepEqual(chosen, { model: "haiku", kind: "search", source: "mode" });
  // The mode is a default, never an override: a named brain and a declared kind still win.
  assert.equal(resolveSubagentModel({ ...call, kind: "implement", defaultKind: "search" }).model, "opus");
  assert.equal(resolveSubagentModel({ ...call, model: "sonnet", defaultKind: "search" }).source, "named");
  // And it cannot buy a flagship: the mode exists to spend less.
  assert.throws(() => resolveSubagentModel({ runner: "claude", coordinatorModel: "opus", defaultKind: "implement" }), /flagship brain/);
  assert.throws(() => resolveSubagentModel({ ...call, defaultKind: "enormous" }), /needs its brain named/);
});

// The seam between the mode (0.8 C) and the task-shape downgrade (0.8 B): both answer the same
// question — what an unqualified delegation runs on — and only one of them may answer it.
test("the session mode is read before the task shape, so the two defaults never argue", () => {
  const call = { runner: "claude", coordinatorModel: "fable" };
  const building = "design and write the retry layer";
  const looking = "find every caller of runExternal";

  // Mode on: it answers, whatever the task reads as, and it answers silently — the owner was already
  // told once, by /savetoken. A second sentence per delegation would be the same notice twice.
  for (const task of [building, looking]) {
    const chosen = resolveSubagentModel({ ...call, task, defaultKind: "search" });
    assert.deepEqual(chosen, { model: "haiku", kind: "search", source: "mode" }, task);
    assert.equal(chosen.note, undefined, "the mode has already said what it does");
  }

  // Mode off: the task shape gets the question back, and only then does hcode explain itself.
  const inferred = resolveSubagentModel({ ...call, task: looking });
  assert.equal(inferred.source, "inferred");
  assert.match(inferred.note, /smallest tier/);
  assert.throws(() => resolveSubagentModel({ ...call, task: building }), /needs its brain named in the call/);

  // Neither default can widen anything: applyMode owns exactly two fields, and permission is not one.
  const cfg = { mode: "ask", model: "fable", sandbox: "auto" };
  applyMode(cfg, "savetoken");
  assert.deepEqual(cfg, { mode: "ask", model: "fable", sandbox: "auto", saveToken: true, subagentDefaultKind: "search" });
  assert.match(modeNotice("default"), /smallest tier/, "the off notice must not promise a refusal hcode no longer makes");
});

test("the codex tier table names models the installed CLI still has", () => {
  // codex-cli 0.151.0: luna is the high-throughput tier, terra the balanced one, sol the quality-first
  // flagship. gpt-5.1-codex* survives there only as a migration key, so a tier must not resolve to it.
  assert.deepEqual(SUBAGENT_TIERS.codex, { search: "gpt-5.6-luna", mechanical: "gpt-5.6-terra", implement: "gpt-5.6-sol" });
  for (const model of Object.values(SUBAGENT_TIERS.codex)) assert.doesNotMatch(model, /gpt-5\.1/);
});
