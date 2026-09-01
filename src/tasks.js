// Persistent background conversations with owner-installed Claude Code and Codex CLIs.
// hcode owns a small registry and append-only transcript; each turn runs in a detached worker and
// resumes the foreign CLI's own conversation id. No provider credential is copied into task state.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { HOME } from "./config.js";
import { Session } from "./session.js";
import { runExternal, lastForeignSession, listRunners, assertSafeExternalWorkspace } from "./runners.js";
import { isFlagship, resolveSubagentModel, subagentTiers } from "./subagents.js";
import { flagshipGate } from "./gates.js";
import { applyAgencyGrant } from "./agency.js";
import { selfCommand } from "./runtime.js";

const ROOT = path.join(HOME, "tasks");
const ID = /^task-[a-z0-9]{8}$/;

const taskDir = id => {
  if (!ID.test(String(id || ""))) throw new Error("invalid task id");
  return path.join(ROOT, id);
};
const stateFile = id => path.join(taskDir(id), "state.json");

function writeState(state) {
  const dir = taskDir(state.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stateFile(state.id); const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
  return state;
}

export function readTask(id) {
  const state = JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
  if (state.v !== 1 || state.id !== id || !["claude", "codex"].includes(state.runner)) throw new Error("invalid task state");
  return state;
}

export function listTasks(limit = 20) {
  let names = []; try { names = fs.readdirSync(ROOT); } catch { return []; }
  return names.filter(name => ID.test(name)).map(name => { try { return readTask(name); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

function launch(id, env = process.env) {
  const self = selfCommand(["_task-worker", id]);
  const child = spawn(self.command, self.args, {
    detached: true, stdio: "ignore", cwd: "/", env,
  });
  child.unref();
  return child.pid;
}

function runnerReady(runner, env = process.env) {
  const found = listRunners(env).find(item => item.id === runner);
  if (!found?.enabled) throw new Error(`${runner} is disabled; run hcode runner add ${runner}`);
  if (!found.available) throw new Error(`${runner} is not installed or not on PATH`);
}

// Which spend gate, if any, this brain trips. `--allow-flagship` says the owner meant that model; this
// says they still get asked whether to pay for it, because naming a thing and buying it are two decisions.
export function spendGateFor({ runner, model, coordinatorModel = "" }) {
  return isFlagship(model, { coordinator: coordinatorModel }) ? flagshipGate({ model, coordinatorModel, runner }) : null;
}

// A background conversation is a subagent too, so it obeys the same rule as delegate_agent: the brain is
// named in the call (model) or taken from the declared tier (kind), never left to the foreign CLI's default.
export function startTask({ runner, prompt, cwd, mode = "ask", effort = "high", policy, model = "", kind = "", allowFlagship = false, spendApproved = false, coordinatorModel = "", tiers = null, allowUnsafeWorkspace = false, agencyLevel = null, agencyBudgetUsd = null, unattended = false, env = process.env }) {
  if (!["claude", "codex"].includes(runner)) throw new Error("task runner must be claude or codex");
  if (!String(prompt || "").trim()) throw new Error("task needs a prompt");
  const chosen = resolveSubagentModel({ runner, model, kind, task: prompt, coordinatorModel, allowFlagship, tiers: tiers || subagentTiers(), syntax: "command" });
  // The spend gate is thrown, not silently obeyed, so a caller that cannot ask a human fails loudly
  // instead of quietly billing one. The caller retries with spendApproved once the owner has said yes.
  const gate = spendGateFor({ runner, model: chosen.model, coordinatorModel });
  if (gate && !spendApproved) throw Object.assign(new Error(`refused: ${gate.why} — that spends money, so it needs your yes and not only --allow-flagship`),
    { code: "spend_gate", details: { model: chosen.model, runner, class: gate.class, why: gate.why } });
  runnerReady(runner, env);
  const root = path.resolve(cwd);
  if (!allowUnsafeWorkspace) assertSafeExternalWorkspace(root);
  const id = `task-${crypto.randomBytes(4).toString("hex")}`;
  const now = Date.now();
  // the agency grant crosses into the frozen state through the same ruler the interactive session
  // uses — otherwise `hcode --agency 8 task start/send` dies in argv and the task runs "ask" forever
  const ruled = applyAgencyGrant({ mode }, { agencyLevel, agencyBudgetUsd: agencyLevel === 9 ? agencyBudgetUsd : null, unattended });
  const state = writeState({ v: 1, id, runner, cwd: root, mode: ruled.mode, effort, model: chosen.model, kind: chosen.kind, status: "queued", prompt: String(prompt).trim(), createdAt: now, updatedAt: now, turns: 0,
    ...(ruled.agencyLevel != null ? { agencyLevel: ruled.agencyLevel, unattended: Boolean(ruled.unattended), ...(ruled.agencyBudgetUsd != null ? { agencyBudgetUsd: ruled.agencyBudgetUsd } : {}) } : {}),
    policy: { sandbox: policy?.sandbox || "auto", network: policy?.network || { default: "off", allow: [] }, allow: policy?.allow || [] }, workspaceApproved: Boolean(allowUnsafeWorkspace) });
  launch(id, env);
  return state;
}

export function sendTask(id, prompt, env = process.env, { agencyLevel = undefined, agencyBudgetUsd = null, unattended = undefined } = {}) {
  const state = readTask(id);
  if (["queued", "running", "stopping"].includes(state.status)) throw new Error(`${id} is still ${state.status}`);
  if (!String(prompt || "").trim()) throw new Error("task needs a prompt");
  runnerReady(state.runner, env);
  let next = { ...state, prompt: String(prompt).trim(), status: "queued", error: undefined, workerPid: undefined, updatedAt: Date.now() };
  if (agencyLevel !== undefined) {   // latest explicit grant wins, like /permission; absent flag keeps the frozen one
    const ruled = applyAgencyGrant({ mode: state.mode }, { agencyLevel, agencyBudgetUsd: agencyLevel === 9 ? agencyBudgetUsd : null, unattended: unattended === undefined ? Boolean(state.unattended) : Boolean(unattended) });
    next = { ...next, mode: ruled.mode, agencyLevel: ruled.agencyLevel ?? null, unattended: Boolean(ruled.unattended), agencyBudgetUsd: ruled.agencyBudgetUsd ?? null };
  }
  const out = writeState(next);
  launch(id, env);
  return out;
}

export function stopTask(id) {
  const state = readTask(id);
  if (!["queued", "running"].includes(state.status) || !state.workerPid) return writeState({ ...state, status: "stopped", updatedAt: Date.now() });
  writeState({ ...state, status: "stopping", updatedAt: Date.now() });
  try { process.kill(state.workerPid, "SIGTERM"); } catch { /* already gone */ }
  return readTask(id);
}

export function taskTranscript(id) {
  const file = path.join(taskDir(id), "output.md");
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

export function taskSummary(state) {
  const age = Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000));
  return `${state.id}  ${state.runner.padEnd(6)}  ${String(state.model || "?").padEnd(20)}  ${String(state.status).padEnd(8)}  ${state.turns} turn${state.turns === 1 ? " " : "s"}  ${age}s ago  ${state.cwd}`;
}

export async function runTaskWorker(id, { env = process.env } = {}) {
  let state = readTask(id);
  if (state.status !== "queued") throw new Error(`${id} is not queued`);
  const controller = new AbortController();
  const stopping = () => controller.abort();
  process.once("SIGTERM", stopping); process.once("SIGINT", stopping);
  state = writeState({ ...state, status: "running", workerPid: process.pid, startedAt: Date.now(), updatedAt: Date.now() });
  const sessionsDir = path.join(taskDir(id), "sessions");
  const sessionId = state.sessionId || null;
  const session = new Session(sessionsDir, sessionId, { cwd: state.cwd, runner: state.runner });
  if (!state.sessionId) state = writeState({ ...state, sessionId: session.id, updatedAt: Date.now() });
  const outputFile = path.join(taskDir(id), "output.md");
  fs.appendFileSync(outputFile, `\n## ${new Date().toISOString()} · ${state.runner}${state.model ? " " + state.model : ""}\n\n> ${state.prompt.replace(/\n/g, "\n> ")}\n\n`, { mode: 0o600 });
  try {
    const cfg = { cwd: state.cwd, runner: state.runner, mode: state.mode, effort: state.effort || "high", runnerModel: state.model || null, runnerPromptViaStdin: true, timeoutMs: 0 };
    // re-derive the mode from the frozen grant (one ruler; old states without a grant are untouched)
    applyAgencyGrant(cfg, { agencyLevel: state.agencyLevel ?? null, unattended: state.unattended ?? false, agencyBudgetUsd: state.agencyBudgetUsd ?? null });
    const result = await runExternal({ id: state.runner, cfg, policy: state.policy, session, prompt: state.prompt, resume: lastForeignSession(session, state.runner), signal: controller.signal,
      allowUnsafeWorkspace: state.workspaceApproved, env,
      onText: text => fs.appendFileSync(outputFile, text),
    });
    fs.appendFileSync(outputFile, "\n");
    const final = readTask(id);
    writeState({ ...final, status: result.cancelled ? "stopped" : "done", turns: (final.turns || 0) + 1, foreignSession: result.foreignSession || final.foreignSession, prompt: undefined, workerPid: undefined, finishedAt: Date.now(), updatedAt: Date.now() });
    return result.cancelled ? 130 : 0;
  } catch (error) {
    const final = readTask(id);
    fs.appendFileSync(outputFile, `\n[hcode task failed] ${String(error.message).replace(/[\r\n]+/g, " ")}\n`);
    writeState({ ...final, status: controller.signal.aborted ? "stopped" : "failed", error: String(error.message).slice(0, 500), prompt: undefined, workerPid: undefined, finishedAt: Date.now(), updatedAt: Date.now() });
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGTERM", stopping); process.removeListener("SIGINT", stopping);
  }
}
