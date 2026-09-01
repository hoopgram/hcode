import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-tasks-"));
const home = path.join(root, "home"), cwd = path.join(root, "work"), bin = path.join(root, "bin");
fs.mkdirSync(home); fs.mkdirSync(cwd); fs.mkdirSync(bin);
process.env.HCODE_HOME = home;
const fake = path.join(bin, "claude");
fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => {
  if (input.includes("hold")) { console.log(JSON.stringify({type:"stream_event",session_id:"foreign-1",event:{type:"content_block_delta",delta:{type:"text_delta",text:"holding"}}})); setInterval(() => {}, 1000); return; }
  console.log(JSON.stringify({type:"stream_event",session_id:"foreign-1",event:{type:"content_block_delta",delta:{type:"text_delta",text:args.includes("--resume")?"continued":"started"}}}));
  console.log(JSON.stringify({type:"result",session_id:"foreign-1",usage:{input_tokens:3,output_tokens:1}}));
});
`);
fs.chmodSync(fake, 0o755);
const fakeCodex = path.join(bin, "codex");
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
console.log(JSON.stringify({type:"item.completed",thread_id:"codex-1",item:{type:"agent_message",text:"codex background"}}));
console.log(JSON.stringify({type:"turn.completed",thread_id:"codex-1",usage:{input_tokens:2,output_tokens:1}}));
`);
fs.chmodSync(fakeCodex, 0o755);
const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
process.env.PATH = env.PATH;
const { startTask, sendTask, stopTask, readTask, listTasks, taskTranscript } = await import("../src/tasks.js");

async function done(id, turns) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const state = readTask(id);
    if (state.status === "done" && state.turns === turns) return state;
    if (state.status === "failed") throw new Error(state.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("background task did not finish");
}

async function status(id, wanted) {
  const until = Date.now() + 8000;
  while (Date.now() < until) { const state = readTask(id); if (state.status === wanted) return state; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`background task did not become ${wanted}`);
}

test("background Claude conversation survives the worker and resumes on the next message", async () => {
  const state = startTask({ runner: "claude", prompt: "inspect", cwd, mode: "read", policy: { sandbox: "none", network: { default: "off", allow: [] }, allow: [] }, env, kind: "search" });
  assert.equal(state.model, "haiku");
  await done(state.id, 1);
  assert.match(taskTranscript(state.id), /started/); assert.equal(listTasks()[0].id, state.id);
  assert.match(taskTranscript(state.id), /· claude haiku/);
  sendTask(state.id, "continue", env); const second = await done(state.id, 2);
  assert.equal(second.foreignSession, "foreign-1"); assert.match(taskTranscript(state.id), /continued/);
  assert.equal(fs.statSync(path.join(home, "tasks", state.id, "state.json")).mode & 0o777, 0o600);
});

test("Claude and Codex background conversations run concurrently without becoming the coordinator", async () => {
  const policy = { sandbox: "none", network: { default: "off", allow: [] }, allow: [] };
  const claude = startTask({ runner: "claude", prompt: "parallel a", cwd, mode: "read", policy, env, kind: "search" });
  const codex = startTask({ runner: "codex", prompt: "parallel b", cwd, mode: "read", policy, env, kind: "mechanical" });
  const [a, b] = await Promise.all([done(claude.id, 1), done(codex.id, 1)]);
  assert.notEqual(a.id, b.id); assert.equal(a.runner, "claude"); assert.equal(b.runner, "codex");
  assert.match(taskTranscript(codex.id), /codex background/); assert.equal(b.foreignSession, "codex-1");
});

test("a running background conversation can be stopped and stays stopped", async () => {
  const state = startTask({ runner: "claude", prompt: "hold", cwd, mode: "read", policy: { sandbox: "none", network: { default: "off", allow: [] }, allow: [] }, env, model: "sonnet" });
  await status(state.id, "running"); stopTask(state.id); const stopped = await status(state.id, "stopped");
  assert.equal(stopped.workerPid, undefined); assert.match(taskTranscript(state.id), /> hold/);
});

test("the supervisor's --agency flag crosses into task state and rules the worker (张良 layer one, task path, 2026-08-28)", async () => {
  const policy = { sandbox: "none", network: { default: "off", allow: [] }, allow: [] };
  // real shape: `hcode --agency 8 …` then `task send` — before this fix the flag died in argv, the
  // frozen state ran mode "ask" forever, and every foreign child was read-only (007's stalls)
  // `kind` is not incidental: the hcode line never lets a subagent inherit the foreign CLI's own
  // default brain, so a task still declares its tier even when the agency grant is what is under test.
  const state = startTask({ runner: "claude", prompt: "agency freezes into state", cwd, mode: "ask", kind: "search", agencyLevel: 8, unattended: true, policy, env });
  assert.equal(state.mode, "all", "the one ruler normalizes the freeze");
  assert.equal(state.agencyLevel, 8);
  assert.equal(state.unattended, true);
  await done(state.id, 1);
  const sessionsDir = path.join(home, "tasks", state.id, "sessions");
  const raw = fs.readFileSync(path.join(sessionsDir, fs.readdirSync(sessionsDir)[0]), "utf8");
  assert.match(raw, /"mode":"all"/, "the worker re-derived its mode from the frozen grant");
  assert.match(raw, /"agencyLevel":8/, "the worker trail records the grant");
  // a later explicit grant wins; with no flag the stored grant carries
  const next = sendTask(state.id, "continue", env, { agencyLevel: 9, agencyBudgetUsd: 2 });
  assert.equal(next.mode, "all"); assert.equal(next.agencyLevel, 9); assert.equal(next.agencyBudgetUsd, 2);
  await done(state.id, 2);
  const kept = sendTask(state.id, "again", env);
  assert.equal(kept.agencyLevel, 9, "no new flag: the stored grant carries");
  await done(state.id, 3);
});
