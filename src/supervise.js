// Long-lived coordinator supervision. The append-only work ledger is authoritative; this module
// only drives bounded transitions and publishes an atomic, owner-readable projection for Hoop OS.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME } from "./config.js";
import { CoordinatorStore } from "./coordinator.js";
import { selfArgv, selfCommand } from "./runtime.js";

const WORK_ID = /^work-[a-z0-9]{8,32}$/;
const GATE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const safe = (value, label, pattern) => { const text = String(value || ""); if (!pattern.test(text)) throw new Error(`invalid ${label}`); return text; };
const alive = pid => { try { process.kill(pid, 0); return Number.isInteger(pid) && pid > 1; } catch { return false; } };

export function statusRoot(home = HOME) { return path.join(home, "work-status"); }
export function supervisorFile(store) { return path.join(store.dir, "supervisor.json"); }

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
}

const publicStatus = state => {
  if (state.status === "waiting") return Object.values(state.lanes).some(lane => String(lane.waitingOn || "").startsWith("gate:")) ? "waiting-owner" : "waiting-agent";
  if (state.status === "verifying") return "running";
  return state.status;
};

export function projectWorkStatus(store) {
  const { state, contract } = store;
  return {
    v: 1, workId: store.id, cwd: contract.cwd, objective: contract.objective, status: publicStatus(state), updatedAt: state.updatedAt || Date.now(),
    lanes: Object.values(state.lanes).map(lane => ({ id: lane.id, runner: lane.runner, status: lane.status,
      waitingOn: lane.waitingOn || (lane.status === "waiting" ? "owner" : lane.dependsOn.find(id => state.lanes[id]?.status !== "verified") ? `lane:${lane.dependsOn.find(id => state.lanes[id]?.status !== "verified")}` : null),
      lastActivityAt: lane.lastActivityAt || null, tmuxSession: lane.tmuxSession || null, evidenceCount: lane.evidence.length })),
    gates: Object.values(state.gates).map(gate => ({ id: gate.id, status: gate.status, question: gate.question, evidence: gate.evidence || [], requestedAt: gate.requestedAt || null, decidedAt: gate.decidedAt || null, by: gate.by || null })),
  };
}

export function writeWorkStatus(store, { home = HOME } = {}) {
  const status = projectWorkStatus(store);
  atomicJson(path.join(statusRoot(home), `${store.id}.json`), status);
  return status;
}

export function requestGate(store, gateId, { laneId, question, evidence = [] } = {}) {
  const id = safe(gateId, "gate id", GATE_ID); const gate = store.state.gates[id];
  if (!gate) throw new Error(`unknown gate ${id}`);
  if (gate.status === "pre-approved" || gate.status === "approved") return gate;
  if (gate.status === "rejected") throw new Error(`gate ${id} was rejected`);
  if (laneId && !store.state.lanes[laneId]) throw new Error(`unknown lane ${laneId}`);
  if (gate.status !== "requested") store.append("gate.requested", { gateId: id, laneId, question: String(question || gate.question).slice(0, 1000), evidence: evidence.map(String).slice(0, 50) });
  return store.state.gates[id];
}

export function decideGate(store, gateId, decision, { by = "owner", note = "" } = {}) {
  const id = safe(gateId, "gate id", GATE_ID); const gate = store.state.gates[id];
  if (!gate) throw new Error(`unknown gate ${id}`);
  if (!["approve", "reject"].includes(decision)) throw new Error("gate decision must be approve or reject");
  if (gate.status !== "requested") throw new Error(`gate ${id} is ${gate.status}, not requested`);
  store.append(decision === "approve" ? "gate.approved" : "gate.rejected", { gateId: id, by: String(by).slice(0, 120), note: String(note).slice(0, 1000) });
  return store.state.gates[id];
}

export function formatGates(store) {
  const rows = Object.values(store.state.gates);
  return rows.length ? rows.map(gate => `${gate.id}  ${gate.status}  ${gate.question}${gate.note ? ` · ${gate.note}` : ""}`).join("\n") : "(no owner gates)";
}

export function tmuxSessionName(workId, laneId) {
  return `hcode-${safe(workId, "work id", WORK_ID).slice(5)}-${safe(laneId, "lane id", GATE_ID)}`.slice(0, 70);
}
export function startTmuxLane({ workId, laneId, command, cwd, tmux = "tmux" }) {
  const session = tmuxSessionName(workId, laneId);
  const result = spawnSync(tmux, ["new-session", "-d", "-s", session, "--", ...command], { cwd, encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(`tmux lane failed to start: ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  return session;
}
export function stopTmuxLane(session, tmux = "tmux") {
  if (!/^hcode-[a-z0-9-]{3,70}$/.test(String(session || ""))) throw new Error("refusing to stop a tmux session not owned by hcode");
  const result = spawnSync(tmux, ["kill-session", "-t", session], { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

export class WorkSupervisor {
  constructor(store, { now = () => Date.now(), resume = async () => null, start = async () => null, writeStatus = writeWorkStatus } = {}) {
    this.store = store; this.now = now; this.resume = resume; this.start = start; this.publish = writeStatus; this.seenEvidence = new Map();
  }
  async tick() {
    const { store } = this; const now = this.now(); const timeout = store.contract.budget.heartbeatTimeoutMs;
    for (const lane of Object.values(store.state.lanes)) {
      if (lane.status === "running" && lane.lastActivityAt && now - lane.lastActivityAt > timeout) {
        store.append("lane.orphaned", { laneId: lane.id, error: `no runner activity for ${timeout} ms`, lastActivityAt: lane.lastActivityAt });
        store.append("work.stopped", { status: "needs-review", reason: `${lane.id}: heartbeat timeout` });
      }
    }
    for (const lane of Object.values(store.state.lanes)) {
      if (lane.status === "waiting" && !String(lane.waitingOn || "").startsWith("gate:")) {
        const previous = this.seenEvidence.get(lane.id) ?? lane.evidence.length;
        const rounds = lane.evidence.length > previous ? 0 : (lane.evidenceRounds || 0) + 1;
        this.seenEvidence.set(lane.id, lane.evidence.length);
        if (rounds >= 2) {
          store.append("work.stopped", { status: "needs-review", reason: `${lane.id}: two rounds produced no new evidence; supervisor stopped` });
        } else {
          store.append("lane.waiting", { laneId: lane.id, attempt: lane.attempts, waitingOn: "agent", evidenceRounds: rounds, lastActivityAt: now });
          await this.resume({ store, lane, prompt: "Continue according to the immutable contract. Return only new evidence, verification results, or a precise blocker." });
        }
      }
    }
    for (const lane of Object.values(store.state.lanes)) {
      if (["approved", "queued"].includes(lane.status) && lane.dependsOn.every(id => store.state.lanes[id]?.status === "verified")) await this.start({ store, lane });
    }
    if (Object.values(store.state.lanes).length && Object.values(store.state.lanes).every(lane => lane.status === "verified") && store.state.status !== "completed") {
      const receipts = Object.values(store.state.lanes).map(lane => lane.verificationReceipt?.id).filter(Boolean);
      store.append("work.stopped", { status: "completed", reason: "acceptance verified; hcode supervisor stopped after Attack gate", receipts });
    }
    return this.publish(store);
  }
}

export function readSupervisor(store) { try { return JSON.parse(fs.readFileSync(supervisorFile(store), "utf8")); } catch { return null; } }
export function supervisorState(store) { const state = readSupervisor(store); return state ? { ...state, running: alive(state.pid) } : { running: false }; }
export function launchSupervisor(store, { env = process.env, tmux = false } = {}) {
  const current = supervisorState(store); if (current.running) return current;
  let pid, tmuxSession = null;
  if (tmux) {
    tmuxSession = tmuxSessionName(store.id, "supervisor");
    const launched = spawnSync("tmux", ["new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", tmuxSession, "--", ...selfArgv(["_work-supervisor", store.id, store.contract.cwd, "--tmux"])], { cwd: store.contract.cwd, env, encoding: "utf8", timeout: 5000 });
    if (launched.status !== 0 || !Number.isInteger(Number(launched.stdout.trim()))) throw new Error(`tmux supervisor failed to start: ${(launched.stderr || "unknown error").trim()}`);
    pid = Number(launched.stdout.trim());
  } else {
    const self = selfCommand(["_work-supervisor", store.id, store.contract.cwd]);
    const child = spawn(self.command, self.args, { detached: true, stdio: "ignore", cwd: store.contract.cwd, env });
    child.unref(); pid = child.pid;
  }
  const state = { v: 1, pid, workId: store.id, startedAt: Date.now(), tmux, tmuxSession };
  atomicJson(supervisorFile(store), state); return { ...state, running: true };
}
export function stopSupervisor(store) {
  const state = readSupervisor(store); if (!state || !alive(state.pid)) return { running: false };
  if (state.tmuxSession) stopTmuxLane(state.tmuxSession); else process.kill(state.pid, "SIGTERM");
  return { ...state, running: false };
}

export async function runSupervisorWorker(store, { tickMs = 30_000, tick } = {}) {
  let stopped = false; const stop = () => { stopped = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    while (!stopped) {
      store.load();
      await (tick ? tick(store) : new WorkSupervisor(store).tick());
      if (["completed", "failed", "cancelled"].includes(store.state.status)) break;
      await new Promise(resolve => setTimeout(resolve, tickMs));
    }
    return stopped ? 130 : 0;
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
