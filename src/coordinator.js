// Coordinator Kernel: a versioned contract plus append-only decisions. Conversation text is never
// authoritative here; compacting a chat cannot change objectives, gates, budgets, lanes or evidence.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CONTRACT_FIELDS = new Set(["v", "id", "objective", "cwd", "constraints", "acceptance", "ownerGates", "budget", "lanes", "status", "stopReason"]);
const BUDGET_FIELDS = new Set(["wallMs", "maxChildren", "maxConcurrent", "childTimeoutMs", "heartbeatTimeoutMs", "maxRetries", "maxTokens", "maxCostUsd"]);
const LANE_FIELDS = new Set(["id", "runner", "task", "mode", "dependsOn", "ownership", "verify"]);
const GATE_FIELDS = new Set(["id", "question", "preApproved"]);
const CONTRACT_STATUS = new Set(["proposed", "approved", "running", "waiting", "needs-review", "verifying", "completed", "failed", "cancelled"]);
const LANE_STATUS = new Set(["proposed", "approved", "queued", "running", "waiting", "succeeded", "failed", "cancelled", "orphaned", "verified", "rejected"]);
const ID = /^work-[a-z0-9]{8,32}$/;
const LANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const GATE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const own = (obj, allowed, label) => { for (const key of Object.keys(obj || {})) if (!allowed.has(key)) throw new Error(`unknown ${label} field: ${key}`); };
const strings = (value, label, { empty = true } = {}) => {
  if (!Array.isArray(value) || (!empty && !value.length) || !value.every(v => typeof v === "string" && v.trim())) throw new Error(`${label} must be ${empty ? "an" : "a non-empty"} array of strings`);
};
const natural = (value, label, { nullable = false, min = 0 } = {}) => {
  if (nullable && value === null) return;
  if (!Number.isInteger(value) || value < min) throw new Error(`${label} must be an integer >= ${min}`);
};
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
export const contractHash = contract => "sha256:" + crypto.createHash("sha256").update(canonical(contract)).digest("hex");

const RECEIPT_STATUS = new Set(["pass", "fail", "blocked-by-environment", "not-run"]);
export function verificationReceipt(input, { cwd } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("verification receipt must be an object");
  const receipt = structuredClone(input); delete receipt.id;
  own(receipt, new Set(["v", "status", "verifier", "verifiedAt", "commands", "evidence", "attack"]), "verification receipt");
  if (receipt.v !== 1 || !RECEIPT_STATUS.has(receipt.status)) throw new Error("invalid verification receipt status");
  if (typeof receipt.verifier !== "string" || !receipt.verifier.trim() || receipt.verifier.length > 120) throw new Error("invalid verification receipt verifier");
  if (!Number.isFinite(receipt.verifiedAt) || receipt.verifiedAt < 0) throw new Error("invalid verification receipt time");
  if (!Array.isArray(receipt.commands)) throw new Error("verification receipt commands must be an array");
  receipt.commands = receipt.commands.map((check, index) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("invalid verification command");
    own(check, new Set(["id", "command", "cwd", "exitCode"]), "verification command");
    if (typeof check.id !== "string" || !check.id.trim() || check.id.length > 120) throw new Error("invalid verification command id");
    if (typeof check.command !== "string" || !check.command.trim() || check.command.length > 4000) throw new Error("invalid verification command text");
    const checkCwd = fs.realpathSync(check.cwd || cwd || "");
    if (cwd && checkCwd !== fs.realpathSync(cwd)) throw new Error("verification command cwd differs from contract cwd");
    if (!Number.isInteger(check.exitCode) || check.exitCode < 0 || check.exitCode > 255) throw new Error("invalid verification command exit code");
    return { id: check.id.trim() || `check-${index + 1}`, command: check.command, cwd: checkCwd, exitCode: check.exitCode };
  });
  strings(receipt.evidence, "verification receipt evidence", { empty: false });
  if (!receipt.attack || typeof receipt.attack !== "object" || Array.isArray(receipt.attack)) throw new Error("verification receipt needs Attack results");
  own(receipt.attack, new Set(["cases", "unresolved"]), "verification Attack");
  strings(receipt.attack.cases, "verification Attack cases"); strings(receipt.attack.unresolved, "verification Attack unresolved");
  if (receipt.status === "pass" && (!receipt.commands.length || receipt.commands.some(check => check.exitCode !== 0))) throw new Error("pass receipt needs successful rerunnable commands");
  if (receipt.status === "pass" && (!receipt.attack.cases.length || receipt.attack.unresolved.length)) throw new Error("pass receipt needs a closed Attack gate");
  const id = "sha256:" + crypto.createHash("sha256").update(canonical(receipt)).digest("hex");
  return Object.freeze({ id, ...receipt });
}

export function validateContract(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("contract must be an object");
  input = structuredClone(input);
  input.ownerGates = (input.ownerGates || []).map(gate => typeof gate === "string"
    ? { id: gate, question: gate === "plan" ? "Approve this bounded plan?" : gate, preApproved: false }
    : gate);
  if (input.budget) input.budget.heartbeatTimeoutMs ??= 15 * 60_000;
  own(input, CONTRACT_FIELDS, "contract");
  if (input.v !== 1) throw new Error("unsupported contract version");
  if (!ID.test(input.id || "")) throw new Error("invalid contract id");
  if (typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 4000) throw new Error("invalid objective");
  if (typeof input.cwd !== "string" || !path.isAbsolute(input.cwd)) throw new Error("cwd must be absolute");
  strings(input.constraints, "constraints"); strings(input.acceptance, "acceptance", { empty: false });
  if (!Array.isArray(input.ownerGates)) throw new Error("ownerGates must be an array");
  const gateIds = new Set();
  for (const gate of input.ownerGates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) throw new Error("ownerGates entries must be normalized objects");
    own(gate, GATE_FIELDS, "owner gate");
    if (!GATE_ID.test(gate.id || "") || gateIds.has(gate.id)) throw new Error("invalid or duplicate owner gate id");
    if (typeof gate.question !== "string" || !gate.question.trim() || gate.question.length > 1000) throw new Error(`invalid question for gate ${gate.id}`);
    if (typeof gate.preApproved !== "boolean") throw new Error(`invalid preApproved for gate ${gate.id}`);
    gateIds.add(gate.id);
  }
  if (!CONTRACT_STATUS.has(input.status)) throw new Error("invalid contract status");
  if (input.stopReason !== null && typeof input.stopReason !== "string") throw new Error("invalid stopReason");
  own(input.budget, BUDGET_FIELDS, "budget");
  for (const key of ["wallMs", "maxChildren", "maxConcurrent", "childTimeoutMs", "heartbeatTimeoutMs", "maxRetries"]) natural(input.budget?.[key], `budget.${key}`, { min: key === "maxRetries" ? 0 : 1 });
  if (input.budget.maxConcurrent > 3) throw new Error("budget.maxConcurrent hard limit is 3");
  if (input.budget.wallMs > 24 * 60 * 60_000) throw new Error("budget.wallMs hard limit is 24h");
  if (input.budget.childTimeoutMs > 12 * 60 * 60_000) throw new Error("budget.childTimeoutMs hard limit is 12h");
  if (input.budget.heartbeatTimeoutMs > 60 * 60_000) throw new Error("budget.heartbeatTimeoutMs hard limit is 1h");
  if (input.budget.maxChildren < input.budget.maxConcurrent) throw new Error("budget.maxChildren must cover maxConcurrent");
  if ("maxTokens" in input.budget) natural(input.budget.maxTokens, "budget.maxTokens", { nullable: true, min: 1 });
  if ("maxCostUsd" in input.budget && input.budget.maxCostUsd !== null && (!Number.isFinite(input.budget.maxCostUsd) || input.budget.maxCostUsd < 0)) throw new Error("budget.maxCostUsd must be non-negative or null");
  if (!Array.isArray(input.lanes) || !input.lanes.length || input.lanes.length > input.budget.maxChildren) throw new Error("lanes must fit maxChildren");
  const ids = new Set();
  for (const lane of input.lanes) {
    own(lane, LANE_FIELDS, "lane");
    if (!LANE_ID.test(lane.id || "") || ids.has(lane.id)) throw new Error("invalid or duplicate lane id"); ids.add(lane.id);
    if (!['hcode', 'claude', 'codex'].includes(lane.runner)) throw new Error(`invalid runner for ${lane.id}`);
    if (typeof lane.task !== "string" || !lane.task.trim() || lane.task.length > 4000) throw new Error(`invalid task for ${lane.id}`);
    if (!['read', 'write'].includes(lane.mode)) throw new Error(`invalid mode for ${lane.id}`);
    strings(lane.dependsOn, `${lane.id}.dependsOn`); strings(lane.ownership, `${lane.id}.ownership`);
    if (lane.verify !== undefined) strings(lane.verify, `${lane.id}.verify`);
    if (lane.mode === "read" && lane.ownership.length) throw new Error(`read lane ${lane.id} cannot own writes`);
    if (lane.mode === "write" && (!lane.ownership.length || !lane.verify?.length)) throw new Error(`write lane ${lane.id} needs ownership and independent verification`);
    for (const p of lane.ownership) if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) throw new Error(`invalid ownership path in ${lane.id}`);
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => { if (visiting.has(id)) throw new Error("lane dependency cycle"); if (visited.has(id)) return; visiting.add(id); const lane = input.lanes.find(x => x.id === id); for (const dep of lane.dependsOn) { if (!ids.has(dep)) throw new Error(`unknown dependency ${dep}`); visit(dep); } visiting.delete(id); visited.add(id); };
  for (const id of ids) visit(id);
  return structuredClone(input);
}

export function createContract(input) {
  const contract = structuredClone(input);
  contract.cwd = fs.realpathSync(contract.cwd);
  return Object.freeze(validateContract(contract));
}

export function reduceCoordinator(contract, events) {
  const state = { contract, status: contract.status, stopReason: contract.stopReason, startedAt: null, updatedAt: null, waitingStartedAt: null, waitingMs: 0, evidence: [], usage: { tokens: 0, costUsd: null }, lanes: {}, gates: {} };
  for (const gate of contract.ownerGates) state.gates[gate.id] = { ...gate, status: gate.preApproved ? "pre-approved" : "pending", evidence: [], requestedAt: null, decidedAt: null, by: null, note: null };
  for (const lane of contract.lanes) state.lanes[lane.id] = { ...lane, status: "proposed", attempts: 0, evidence: [], risk: [], waitingOn: null, lastActivityAt: null, tmuxSession: null, verificationReceipt: null };
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    state.updatedAt = ev.ts;
    if (ev.type === "plan.approved") { state.status = "approved"; for (const lane of Object.values(state.lanes)) lane.status = "approved"; }
    else if (ev.type === "work.started") { state.status = "running"; state.startedAt ||= ev.ts; }
    else if (ev.type.startsWith("lane.")) {
      const lane = state.lanes[ev.laneId]; if (!lane) continue;
      const status = ev.type.slice(5); if (LANE_STATUS.has(status)) lane.status = status;
      if (ev.attempt) lane.attempts = Math.max(lane.attempts, ev.attempt);
      for (const key of ["pid", "idempotencyKey", "lastActivityAt", "summary", "error", "waitingOn", "tmuxSession", "evidenceRounds"]) if (ev[key] !== undefined) lane[key] = ev[key];
      if (["queued", "running", "succeeded", "verified", "failed", "cancelled", "orphaned", "rejected"].includes(status) && ev.waitingOn === undefined) lane.waitingOn = null;
      if (ev.evidence) { lane.evidence.push(...ev.evidence); state.evidence.push(...ev.evidence.map(item => ({ laneId: ev.laneId, ...item }))); }
    } else if (ev.type === "gate.requested") {
      const gate = state.gates[ev.gateId] ||= { id: ev.gateId, question: ev.question, preApproved: false, status: "pending", evidence: [], requestedAt: null, decidedAt: null, by: null, note: null };
      if (gate.status === "pre-approved") continue;
      Object.assign(gate, { status: "requested", question: ev.question || gate.question, evidence: Array.isArray(ev.evidence) ? ev.evidence : [], requestedAt: ev.ts });
      if (ev.laneId && state.lanes[ev.laneId]) { state.lanes[ev.laneId].status = "waiting"; state.lanes[ev.laneId].waitingOn = `gate:${ev.gateId}`; }
      state.status = "waiting"; state.waitingStartedAt ||= ev.ts;
    } else if (ev.type === "gate.approved" || ev.type === "gate.rejected") {
      const gate = state.gates[ev.gateId]; if (!gate || !["requested", "pending"].includes(gate.status)) continue;
      gate.status = ev.type.slice(5); gate.decidedAt = ev.ts; gate.by = ev.by; gate.note = ev.note || null;
      for (const lane of Object.values(state.lanes)) if (lane.waitingOn === `gate:${ev.gateId}`) { lane.waitingOn = null; lane.status = gate.status === "approved" ? "queued" : "rejected"; }
      if (state.waitingStartedAt) { state.waitingMs += Math.max(0, ev.ts - state.waitingStartedAt); state.waitingStartedAt = null; }
      state.status = gate.status === "approved" ? "running" : "needs-review";
    } else if (ev.type === "verification.receipt") {
      const lane = state.lanes[ev.laneId]; if (lane) {
        try { lane.verificationReceipt = verificationReceipt(ev.receipt, { cwd: contract.cwd }); lane.status = lane.verificationReceipt.status === "pass" ? "verified" : "rejected"; }
        catch (error) { lane.verificationReceipt = null; lane.status = "rejected"; lane.error = `invalid verification receipt: ${error.message}`; }
      }
    } else if (ev.type === "verification") { const lane = state.lanes[ev.laneId]; if (lane) lane.status = ev.ok ? "succeeded" : "rejected"; }
    else if (ev.type === "work.stopped") {
      if (ev.status === "completed") {
        const expected = Object.values(state.lanes).map(lane => lane.verificationReceipt?.id).filter(Boolean).sort();
        const cited = Array.isArray(ev.receipts) ? ev.receipts.map(String).sort() : [];
        const valid = expected.length === Object.keys(state.lanes).length && expected.length === cited.length && expected.every((id, index) => id === cited[index]);
        state.status = valid ? "completed" : "needs-review"; state.stopReason = valid ? ev.reason : "completion refused: pass VerificationReceipt v1 references are incomplete";
      } else { state.status = ev.status; state.stopReason = ev.reason; }
    }
    if (ev.usage) { state.usage.tokens += Number(ev.usage.tokens || 0); if (Number.isFinite(ev.usage.costUsd)) state.usage.costUsd = (state.usage.costUsd || 0) + ev.usage.costUsd; }
  }
  return state;
}

export function activeWallMs(state, now = Date.now()) {
  if (!state.startedAt) return 0;
  const openWait = state.waitingStartedAt ? Math.max(0, now - state.waitingStartedAt) : 0;
  return Math.max(0, now - state.startedAt - state.waitingMs - openWait);
}

const alive = pid => { if (!Number.isInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
export class CoordinatorStore {
  constructor(root, contractOrId) {
    this.root = fs.realpathSync(root);
    this.id = typeof contractOrId === "string" ? contractOrId : contractOrId.id;
    if (!ID.test(this.id)) throw new Error("invalid contract id");
    this.dir = path.join(this.root, ".hcode", "work", this.id); this.file = path.join(this.dir, "events.jsonl"); this.contractFile = path.join(this.dir, "contract.json");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (typeof contractOrId === "string") this.contract = validateContract(JSON.parse(fs.readFileSync(this.contractFile, "utf8")));
    else { this.contract = createContract(contractOrId); fs.writeFileSync(this.contractFile, JSON.stringify(this.contract, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    this.contractHash = contractHash(this.contract); this.events = []; this.seq = 0; this.load();
    const running = Object.values(this.state.lanes).filter(l => l.status === "running" && !alive(l.pid));
    for (const lane of running) this.append("lane.orphaned", { laneId: lane.id, error: "process unavailable after recovery" });
    if (running.length) this.append("work.stopped", { status: "needs-review", reason: `${running.length} orphaned lane(s) require review` });
  }
  load() {
    this.events = []; this.seq = 0;
    let raw = ""; try { raw = fs.readFileSync(this.file, "utf8"); } catch { /* new */ }
    const seen = new Set();
    for (const line of raw.split("\n")) { if (!line.trim()) continue; let ev; try { ev = JSON.parse(line); } catch { continue; } if (ev.v !== 1 || !Number.isInteger(ev.seq) || seen.has(ev.seq)) continue; seen.add(ev.seq); this.seq = Math.max(this.seq, ev.seq); this.events.push(ev); }
    this.state = reduceCoordinator(this.contract, this.events);
  }
  append(type, fields = {}) {
    const lock = path.join(this.dir, "events.lock"); const deadline = Date.now() + 5000; let fd;
    for (;;) {
      try { fd = fs.openSync(lock, "wx", 0o600); break; }
      catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error("coordinator event ledger is busy");
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.unlinkSync(lock); } catch { /* another writer released it */ }
        pause(5);
      }
    }
    try {
      this.load();
      const ev = { v: 1, seq: ++this.seq, ts: Date.now(), type, ...fields };
      let separator = "";
      try {
        const stat = fs.statSync(this.file);
        if (stat.size > 0) { const fd = fs.openSync(this.file, "r"); const byte = Buffer.alloc(1); try { fs.readSync(fd, byte, 0, 1, stat.size - 1); } finally { fs.closeSync(fd); } if (byte[0] !== 10) separator = "\n"; }
      } catch { /* first event */ }
      fs.appendFileSync(this.file, separator + JSON.stringify(ev) + "\n", { mode: 0o600 }); this.events.push(ev); this.state = reduceCoordinator(this.contract, this.events);
      try { this.onChange?.(this); } catch { /* the durable ledger remains authoritative if its optional projection fails */ }
      return ev;
    } finally { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch { /* released */ } } }
  }
}

const normalizedOwner = value => String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
export function ownershipConflicts(contract) {
  const writes = contract.lanes.filter(lane => lane.mode === "write"); const conflicts = [];
  for (let i = 0; i < writes.length; i++) for (let j = i + 1; j < writes.length; j++) {
    for (const left of writes[i].ownership.map(normalizedOwner)) for (const right of writes[j].ownership.map(normalizedOwner)) {
      if (left === right || left.startsWith(right + "/") || right.startsWith(left + "/")) conflicts.push([writes[i].id, writes[j].id, left.length < right.length ? left : right]);
    }
  }
  return conflicts;
}

const withDeadline = (promise, ms, controller) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { controller.abort(); reject(new Error(`child timeout after ${ms} ms`)); }, ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

// Execution is injected so the same state machine drives owner-installed CLIs and deterministic fake runners.
// Only this coordinator may turn verified child evidence into completed work.
export class CoordinatorKernel {
  constructor(store, { execute, verify = async () => ({ ok: false, detail: "no verifier" }), sandbox = { degraded: true }, now = () => Date.now() } = {}) {
    if (typeof execute !== "function") throw new Error("coordinator needs an executor");
    this.store = store; this.execute = execute; this.verify = verify; this.sandbox = sandbox; this.now = now; this.controllers = new Map(); this.cancelled = false;
  }
  cancel(reason = "cancelled by owner") { this.cancelled = true; for (const controller of this.controllers.values()) controller.abort(); this.store.append("work.stopped", { status: "cancelled", reason }); }
  async run() {
    const { contract } = this.store;
    if (!["approved", "running"].includes(this.store.state.status)) throw new Error("owner-approved plan required");
    const overlaps = ownershipConflicts(contract);
    if (overlaps.length) { this.store.append("work.stopped", { status: "failed", reason: `ownership conflict: ${overlaps.map(x => x.join("/")).join(", ")}` }); return this.store.state; }
    if (this.sandbox.degraded && contract.lanes.some(l => l.mode === "write")) { this.store.append("work.stopped", { status: "failed", reason: "sandbox degraded: mutating child was not spawned" }); return this.store.state; }
    if (contract.budget.maxCostUsd !== null && !this.execute.costBounded) { this.store.append("work.stopped", { status: "failed", reason: "cost budget cannot be enforced before spawn" }); return this.store.state; }
    if (!this.store.state.startedAt) this.store.append("work.started", {});
    const pending = new Set(contract.lanes.filter(lane => this.store.state.lanes[lane.id]?.status !== "verified").map(lane => lane.id)); const active = new Map();
    const launch = lane => {
      pending.delete(lane.id); const attempt = (this.store.state.lanes[lane.id]?.attempts || 0) + 1; const idempotencyKey = `${contract.id}:${lane.id}:${attempt}`;
      if (this.store.events.some(ev => ev.type === "lane.running" && ev.idempotencyKey === idempotencyKey)) return;
      const controller = new AbortController(); this.controllers.set(lane.id, controller);
      this.store.append("lane.queued", { laneId: lane.id }); this.store.append("lane.running", { laneId: lane.id, attempt, idempotencyKey, lastActivityAt: this.now() });
      const promise = withDeadline(Promise.resolve().then(() => this.execute({ contract, lane, attempt, signal: controller.signal,
        heartbeat: () => this.store.append("lane.running", { laneId: lane.id, attempt, idempotencyKey, lastActivityAt: this.now() }) })), contract.budget.childTimeoutMs, controller)
        .then(async report => {
          const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
          if (report?.status !== "succeeded") throw new Error(report?.error || "child did not succeed");
          this.store.append("lane.succeeded", { laneId: lane.id, attempt, summary: String(report.summary || "").slice(0, 4000), evidence, usage: report.usage || { tokens: 0, costUsd: null } });
          if (!evidence.length) { this.store.append("verification", { laneId: lane.id, ok: false, detail: "child supplied no evidence" }); throw new Error("missing child evidence"); }
          const checked = await this.verify({ contract, lane, report, evidence, signal: controller.signal });
          let receipt;
          try { receipt = verificationReceipt(checked?.receipt, { cwd: contract.cwd }); }
          catch (error) { this.store.append("verification", { laneId: lane.id, ok: false, detail: String(error.message).slice(0, 2000) }); throw new Error(`independent verification did not produce VerificationReceipt v1: ${error.message}`); }
          this.store.append("verification.receipt", { laneId: lane.id, receipt });
          if (receipt.status !== "pass") throw new Error(`independent verification ${receipt.status}`);
        }).catch(error => {
          const current = this.store.state.lanes[lane.id];
          if (!["rejected", "orphaned"].includes(current?.status)) {
            if (!this.cancelled && attempt <= contract.budget.maxRetries) { this.store.append("lane.waiting", { laneId: lane.id, attempt, error: String(error.message).slice(0, 500) }); pending.add(lane.id); }
            else this.store.append(this.cancelled ? "lane.cancelled" : "lane.failed", { laneId: lane.id, attempt, error: String(error.message).slice(0, 500) });
          }
        }).finally(() => { active.delete(lane.id); this.controllers.delete(lane.id); });
      active.set(lane.id, promise);
    };
    while ((pending.size || active.size) && !this.cancelled) {
      if (activeWallMs(this.store.state, this.now()) >= contract.budget.wallMs) { for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(active.values()); this.store.append("work.stopped", { status: "failed", reason: "wall budget exhausted" }); return this.store.state; }
      const stale = Object.values(this.store.state.lanes).find(l => l.status === "running" && l.lastActivityAt && this.now() - l.lastActivityAt > contract.budget.heartbeatTimeoutMs);
      if (stale) { this.controllers.get(stale.id)?.abort(); this.store.append("lane.orphaned", { laneId: stale.id, error: "runner heartbeat timeout", lastActivityAt: stale.lastActivityAt }); await Promise.allSettled(active.values()); this.store.append("work.stopped", { status: "needs-review", reason: `${stale.id}: heartbeat timeout` }); return this.store.state; }
      const failed = Object.values(this.store.state.lanes).find(l => ["failed", "rejected", "orphaned"].includes(l.status));
      if (failed) { for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled(active.values()); this.store.append("work.stopped", { status: "failed", reason: `${failed.id}: ${failed.error || failed.status}` }); return this.store.state; }
      let progressed = false;
      for (const id of [...pending]) {
        if (active.size >= contract.budget.maxConcurrent) break;
        const lane = contract.lanes.find(x => x.id === id);
        const dependencies = lane.dependsOn.map(dep => this.store.state.lanes[dep]?.status);
        if (dependencies.every(status => status === "verified")) { launch(lane); progressed = true; }
      }
      if (active.size) await Promise.race([...active.values(), new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, contract.budget.wallMs - activeWallMs(this.store.state, this.now())))))]);
      else if (!progressed && pending.size) { this.store.append("work.stopped", { status: "failed", reason: "no runnable lane" }); return this.store.state; }
    }
    if (this.cancelled) return this.store.state;
    const verified = Object.values(this.store.state.lanes).every(l => l.status === "verified");
    const rejected = Object.values(this.store.state.lanes).find(l => l.status === "rejected");
    const receipts = Object.values(this.store.state.lanes).map(lane => lane.verificationReceipt?.id).filter(Boolean);
    this.store.append("work.stopped", { status: verified ? "completed" : "failed", reason: verified ? "acceptance verified; hcode stopped after Attack gate" : rejected ? `${rejected.id}: evidence rejected` : "verification incomplete", receipts });
    return this.store.state;
  }
}
