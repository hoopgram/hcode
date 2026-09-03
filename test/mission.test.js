import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.js";
import { runMission, objectivePrompt } from "../src/mission.js";
import { startFakeModel, text } from "./fake-model.js";

// These tests exercise hcode's own direct model call against a fake brain, so the runner is pinned:
// the default runner is now the first external CLI on PATH, and a codex or claude the developer
// happens to have installed would otherwise silently run the turn (and reach the network).
process.env.HCODE_RUNNER = "hcode";   // "direct" under its on-the-wire name
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-mission-"));
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "hcode.js");
const runCli = (args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, NO_COLOR: "1", ...env }, cwd: tmp(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
  child.on("close", status => resolve({ status, stdout, stderr }));
});

test("truncated turns automatically continue under one durable objective", async () => {
  const dir = tmp(); const session = new Session(dir); let calls = 0;
  const result = await runMission({ session, mission: "finish the long repair", budget: { steps: 10, tokens: 1000, wallMs: 10000 },
    runTurn: async prompt => { calls++; assert.match(prompt, calls === 1 ? /finish the long repair/ : /Durable objective/); return { truncated: calls < 3, steps: 2, usage: { input: 10, output: 5 }, text: calls === 3 ? "done" : "" }; } });
  assert.equal(result.stopped, undefined); assert.equal(calls, 3); assert.equal(result.continuations, 2);
  assert.equal(session.events.filter(e => e.type === "objective.started").length, 1);
  assert.equal(session.events.filter(e => e.type === "objective.checkpoint").length, 2);
});

test("budget exhaustion shouts a durable reason and next step instead of dying quietly", async () => {
  const dir = tmp(); const session = new Session(dir);
  const result = await runMission({ session, mission: "keep going", budget: { steps: 4, tokens: 1000, wallMs: 10000 },
    runTurn: async () => ({ truncated: true, steps: 4, usage: { input: 10, output: 5 }, text: "" }) });
  assert.equal(result.stopped, true); assert.equal(result.budget, "steps"); assert.match(result.nextStep, /resume objective/);
  const stopped = session.events.find(e => e.type === "objective.stopped");
  assert.equal(stopped.reason, "budget"); assert.equal(stopped.budget, "steps"); assert.match(stopped.nextStep, /more steps budget/);
});

test("objective survives compaction and a fresh process reopening the session", () => {
  const dir = tmp(); const session = new Session(dir);
  session.emit("objective.started", { objective: { v: 1, mission: "ship verified", acceptance: ["tests pass"], checkpoint: "continue" } });
  session.emit("compaction", { summary: "old chat compressed", keeps: [], droppedSeq: [1, 1], estTokens: 10, budget: 10 });
  const reopened = new Session(dir, session.id);
  assert.equal(reopened.objective.mission, "ship verified"); assert.match(objectivePrompt(reopened.objective), /tests pass/);
});

test("print-mode CLI crosses the real HTTP/session boundary and continues max_tokens automatically", async () => {
  const home = tmp(); const model = await startFakeModel((_messages, _req, n) => text(n === 1 ? "checkpoint\n" : "finished\n", n === 1 ? "max_tokens" : "end_turn"));
  try {
    const result = await runCli(["-p", "--max-turns", "1", "--mission-steps", "3", "finish long task"], { HCODE_HOME: home, HCODE_SESSIONS: path.join(home, "sessions"), HCODE_BASE_URL: model.base, HCODE_API_KEY: "fake", HCODE_MODEL: "fake" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /checkpoint[\s\S]*finished/); assert.equal(model.calls.length, 2);
    const file = fs.readdirSync(path.join(home, "sessions")).find(x => x.endsWith(".jsonl"));
    const events = fs.readFileSync(path.join(home, "sessions", file), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(e => e.type === "objective.started").length, 1); assert.equal(events.filter(e => e.type === "objective.checkpoint").length, 0);
    assert.equal(events.filter(e => e.type === "turn.start").length, 1, "default Full Agency renews the step budget inside one durable turn");
    assert.equal(events.filter(e => e.type === "agency.auto-continue").length, 1); assert.equal(events.some(e => e.type === "objective.stopped"), false);
  } finally { model.close(); }
});

test("print-mode CLI exits loud and leaves a durable stop event when objective budget is spent", async () => {
  const home = tmp(); const model = await startFakeModel(() => text("partial\n", "max_tokens"));
  try {
    const result = await runCli(["-p", "--max-turns", "1", "--mission-steps", "1", "bounded task"], { HCODE_HOME: home, HCODE_SESSIONS: path.join(home, "sessions"), HCODE_BASE_URL: model.base, HCODE_API_KEY: "fake", HCODE_MODEL: "fake" });
    assert.equal(result.status, 1); assert.match(result.stderr, /objective stopped: budget steps budget exhausted; next:/);
    const file = fs.readdirSync(path.join(home, "sessions")).find(x => x.endsWith(".jsonl"));
    const events = fs.readFileSync(path.join(home, "sessions", file), "utf8").trim().split("\n").map(JSON.parse);
    const stopped = events.find(e => e.type === "objective.stopped"); assert.equal(stopped.reason, "budget"); assert.equal(stopped.budget, "steps"); assert.match(stopped.nextStep, /resume objective/);
  } finally { model.close(); }
});
