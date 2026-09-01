import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { activeWallMs, CoordinatorKernel, CoordinatorStore, createContract } from "./coordinator.js";
import { Session } from "./session.js";
import { findBinary, runExternal } from "./runners.js";
import { runFixedCommand } from "./fixed-command.js";
import { escapeControls } from "./ui.js";

const workRoot = cwd => path.join(cwd, ".hcode", "work");
export function latestWorkId(cwd) {
  let rows; try { rows = fs.readdirSync(workRoot(cwd), { withFileTypes: true }); } catch { return null; }
  return rows.filter(x => x.isDirectory() && /^work-[a-z0-9]{8,32}$/.test(x.name)).map(x => ({ id: x.name, at: fs.statSync(path.join(workRoot(cwd), x.name)).mtimeMs })).sort((a, b) => b.at - a.at)[0]?.id || null;
}
export function openWork(cwd, id = latestWorkId(cwd)) { return id ? new CoordinatorStore(cwd, id) : null; }

export function proposeWork({ cwd, objective, runners }) {
  const ready = runners.filter(r => ["claude", "codex"].includes(r.id) && r.enabled && r.available).slice(0, 2);
  if (!ready.length) throw new Error("no owner-installed child runner is ready; hcode can continue as a single agent");
  const lanes = ready.map((runner, index) => ({ id: `${runner.id}-${index + 1}`, runner: runner.id, task: index === 0
    ? `Inspect the objective and current workspace read-only. Return evidence, risks and exact verification suggestions. Objective: ${objective}`
    : `Independently attack the proposed objective read-only. Find conflicts, missing acceptance and failure paths. Objective: ${objective}`,
    mode: "read", dependsOn: [], ownership: [], verify: ["git diff --check"] }));
  return createContract({ v: 1, id: "work-" + crypto.randomBytes(5).toString("hex"), objective: String(objective).trim(), cwd,
    constraints: ["work only in the selected project", "network off", "children are evidence, hcode is final speaker"],
    acceptance: ["every child returns structured evidence", "hcode independently validates the recorded runner result"], ownerGates: [{ id: "plan", question: "Approve this bounded plan?", preApproved: false }],
    budget: { wallMs: 6 * 60 * 60_000, maxChildren: lanes.length, maxConcurrent: Math.min(2, lanes.length), childTimeoutMs: 2 * 60 * 60_000, heartbeatTimeoutMs: 15 * 60_000, maxRetries: 0, maxTokens: null, maxCostUsd: null },
    lanes, status: "proposed", stopReason: null });
}

const elapsed = (state, now = Date.now()) => Math.round(activeWallMs(state, now) / 1000);
export function formatWork(store, { columns = process.stdout.columns || 80, now = Date.now() } = {}) {
  if (!store) return "No coordinated work yet. Use /plan <goal>.";
  const s = store.state, b = store.contract.budget; const narrow = columns < 60;
  const rows = [`work ${store.id}`, `objective  ${escapeControls(store.contract.objective)}`, `phase ${s.status} · elapsed ${elapsed(s, now)}s · children ${Object.values(s.lanes).filter(x => x.status !== "proposed").length}/${b.maxChildren} · concurrent ≤${b.maxConcurrent}`,
    `budget wall ${Math.round(b.wallMs / 1000)}s · child ${Math.round(b.childTimeoutMs / 1000)}s · tokens ${s.usage.tokens || "unknown"} · cost ${s.usage.costUsd === null ? "unknown" : "$" + s.usage.costUsd.toFixed(4)}`];
  for (const lane of Object.values(s.lanes)) rows.push(narrow ? `${lane.id} ${lane.status}${lane.waitingOn ? ` ${lane.waitingOn}` : ""}` : `${lane.id.padEnd(18)} ${lane.runner.padEnd(7)} ${lane.mode.padEnd(5)} ${lane.status}${lane.waitingOn ? ` · waiting ${lane.waitingOn}` : ""} · evidence ${lane.evidence.length}`);
  const gates = Object.values(s.gates || {}); if (gates.length) rows.push(`gates ${gates.map(gate => `${gate.id}:${gate.status}`).join(" · ")}`);
  rows.push(`evidence ${s.evidence.length}`, `risk ${Object.values(s.lanes).some(x => x.status === "rejected" || x.status === "orphaned") ? "needs review" : "none recorded"}`, `stop ${s.stopReason || "—"}`);
  return rows.join("\n");
}
export function formatPlan(contract) {
  return [`Plan ${contract.id}`, `Objective: ${escapeControls(contract.objective)}`, ...contract.lanes.map((l, i) => `${i + 1}. ${l.runner} · ${l.mode} · ${escapeControls(l.task)}${l.ownership.length ? ` · owns ${l.ownership.join(",")}` : ""}${l.verify?.length ? ` · verify ${l.verify.join(" && ")}` : ""}`),
    `Bounds: ${contract.budget.maxChildren} children, ${contract.budget.maxConcurrent} at once, ${Math.round(contract.budget.wallMs / 1000)}s wall, network off`, "Approve only this bounded plan: /plan approve"].join("\n");
}

const reportFromSession = (session, text, usage = {}) => {
  const results = [...session.results.values()];
  return { status: "succeeded", summary: escapeControls(text).slice(0, 4000), evidence: results.map(r => ({ kind: "tool_result", callId: r.callId, tool: session.calls.get(r.callId)?.tool || "unknown", ok: r.ok, bytes: r.bytes })), usage: { tokens: Number(usage.input || 0) + Number(usage.output || 0), costUsd: null } };
};
export function externalWorkExecutor({ cfg, policy, runners }) {
  return async ({ contract, lane, signal, heartbeat }) => {
    const runner = runners().find(r => r.id === lane.runner);
    if (!runner?.available || !runner.enabled) throw new Error(`${lane.runner} unavailable`);
    if (lane.mode === "write") {
      const git = findBinary("git"); if (!git) throw new Error("mutating lane requires Git for a known clean baseline");
      const clean = spawnSync(git, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).hcode"], { cwd: contract.cwd, encoding: "utf8", timeout: 5000 });
      if (clean.status !== 0 || clean.stdout.trim()) throw new Error("mutating lane refused: Git baseline is dirty or unknown");
    }
    const sessions = path.join(workRoot(contract.cwd), contract.id, "children", lane.id); const session = new Session(sessions, null, { cwd: contract.cwd, runner: lane.runner });
    const result = await runExternal({ id: lane.runner, cfg: { ...cfg, cwd: contract.cwd, runner: lane.runner, mode: lane.mode === "write" ? "auto" : "read", timeoutMs: contract.budget.childTimeoutMs, runnerPromptViaStdin: true },
      policy: { ...policy, network: { default: "off", allow: [] } }, session, prompt: lane.task, signal,
      system: `You are a bounded child lane (${lane.id}). You are not the coordinator and must not address the owner as the final speaker. Stay inside the assigned task. Return changes, observed tool evidence, tests and risks; claims without observed evidence will be rejected.`,
      onText: () => heartbeat?.(), onEvent: () => heartbeat?.() });
    if (lane.mode === "write") {
      const git = findBinary("git"); const changed = spawnSync(git, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".", ":(exclude).hcode"], { cwd: contract.cwd, encoding: "utf8", timeout: 5000 });
      if (changed.status !== 0) throw new Error("could not verify mutating lane ownership");
      const files = changed.stdout.split("\0").filter(Boolean).map(row => row.slice(3)).map(name => name.includes(" -> ") ? name.split(" -> ").at(-1) : name);
      const allowed = name => lane.ownership.some(owner => { const p = owner.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""); return p === "." || name === p || name.startsWith(p + "/"); });
      const outside = files.filter(name => !allowed(name)); if (outside.length) throw new Error(`ownership violation: ${outside.slice(0, 5).join(", ")}`);
    }
    return reportFromSession(session, result.text, result.usage);
  };
}
export async function runApprovedWork(store, { cfg, policy, runners, sandbox }) {
  const execute = externalWorkExecutor({ cfg, policy, runners });
  const verify = async ({ lane, evidence, contract }) => {
    const base = { v: 1, verifier: "hcode", verifiedAt: Date.now(), evidence: evidence.map((item, index) => `${item.kind || "evidence"}:${item.callId || item.tool || index}`),
      attack: { cases: ["absent or failed child evidence is rejected", "nonzero verification commands are rejected"], unresolved: [] } };
    if (!evidence.length || !evidence.every(item => item.ok === true)) return { receipt: { ...base, status: "not-run", commands: [] } };
    const shell = findBinary("sh"); if (!shell) return { receipt: { ...base, status: "blocked-by-environment", commands: [] } };
    const commands = [];
    for (const command of lane.verify) {
      const result = await runFixedCommand(shell, ["-lc", command], { cwd: contract.cwd, timeoutMs: contract.budget.childTimeoutMs, maxBytes: 100_000 });
      commands.push({ id: `verify-${commands.length + 1}`, command, cwd: contract.cwd, exitCode: Number.isInteger(result.code) ? result.code : result.ok ? 0 : 1 });
      if (!result.ok) return { receipt: { ...base, status: "fail", commands } };
    }
    return { receipt: { ...base, status: commands.length ? "pass" : "not-run", commands } };
  };
  return new CoordinatorKernel(store, { execute, verify, sandbox }).run();
}
