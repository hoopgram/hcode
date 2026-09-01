import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeWallMs, CoordinatorKernel, createContract, CoordinatorStore } from "../src/coordinator.js";
import { decideGate, projectWorkStatus, requestGate, startTmuxLane, stopTmuxLane, tmuxSessionName, WorkSupervisor, writeWorkStatus } from "../src/supervise.js";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-v2-"));
const lane = (id = "inspect", dependsOn = []) => ({ id, runner: "codex", task: "inspect", mode: "read", dependsOn, ownership: [], verify: [] });
const receipt = cwd => ({ v: 1, status: "pass", verifier: "hcode", verifiedAt: 1234,
  commands: [{ id: "test", command: "node --test", cwd, exitCode: 0 }], evidence: ["tool:test"], attack: { cases: ["negative fixture"], unresolved: [] } });
const contract = (cwd, overrides = {}) => createContract({
  v: 1, id: "work-feedface", objective: "supervise long work", cwd, constraints: [], acceptance: ["verified"],
  ownerGates: [{ id: "ship", question: "Ship the result?", preApproved: false }, { id: "safe", question: "Known safe?", preApproved: true }],
  budget: { wallMs: 6 * 60 * 60_000, maxChildren: 1, maxConcurrent: 1, childTimeoutMs: 2 * 60 * 60_000, heartbeatTimeoutMs: 15 * 60_000, maxRetries: 1, maxCostUsd: null },
  lanes: [lane()], status: "proposed", stopReason: null, ...overrides,
});

test("legacy owner gates normalize into the immutable contract and long-lived limits stay bounded", () => {
  const cwd = root(); const c = createContract({ ...contract(cwd), ownerGates: ["plan"], budget: { ...contract(cwd).budget, heartbeatTimeoutMs: undefined } });
  assert.deepEqual(c.ownerGates, [{ id: "plan", question: "Approve this bounded plan?", preApproved: false }]);
  assert.equal(c.budget.heartbeatTimeoutMs, 15 * 60_000);
  assert.throws(() => createContract({ ...c, budget: { ...c.budget, wallMs: 24 * 60 * 60_000 + 1 } }), /24h/);
});

test("owner gate decisions are append-only, pre-approved gates pass, and waiting time is outside active wall", () => {
  const cwd = root(); const store = new CoordinatorStore(cwd, contract(cwd)); store.append("plan.approved", { by: "owner" }); store.append("work.started");
  const requested = requestGate(store, "ship", { laneId: "inspect", evidence: ["report.json"] });
  assert.equal(requested.status, "requested"); assert.equal(store.state.status, "waiting"); assert.equal(store.state.lanes.inspect.waitingOn, "gate:ship");
  assert.equal(requestGate(store, "safe").status, "pre-approved");
  const waitAt = store.state.waitingStartedAt; store.append("gate.approved", { gateId: "ship", by: "owner", note: "checked", ts: waitAt + 5000 });
  assert.equal(store.state.gates.ship.status, "approved"); assert.equal(store.state.lanes.inspect.status, "queued"); assert.equal(store.state.waitingMs, 5000);
  assert.ok(activeWallMs(store.state, waitAt + 6000) >= 1000 && activeWallMs(store.state, waitAt + 6000) < 1100);
  assert.throws(() => decideGate(store, "ship", "reject"), /not requested/);
  assert.equal(store.events.filter(event => event.type.startsWith("gate.")).length, 2);
});

test("a kernel resumes after an approved gate without rerunning verified lanes", async () => {
  const cwd = root(); const store = new CoordinatorStore(cwd, contract(cwd)); store.append("plan.approved", { by: "owner" }); store.append("work.started"); requestGate(store, "ship", { laneId: "inspect" }); decideGate(store, "ship", "approve");
  let calls = 0; const state = await new CoordinatorKernel(store, { sandbox: { degraded: false }, execute: async ({ heartbeat }) => { calls++; heartbeat(); return { status: "succeeded", evidence: [{ kind: "test", ok: true }] }; }, verify: async ({ contract }) => ({ receipt: receipt(contract.cwd) }) }).run();
  assert.equal(state.status, "completed"); assert.equal(calls, 1);
  const reopened = new CoordinatorStore(cwd, store.id); assert.equal(reopened.state.status, "completed");
});

test("separate supervisor and owner processes cannot reuse a stale event sequence", () => {
  const cwd = root(); const first = new CoordinatorStore(cwd, contract(cwd)); const second = new CoordinatorStore(cwd, first.id);
  first.append("plan.approved", { by: "owner" }); second.append("gate.requested", { gateId: "ship", laneId: "inspect", question: "Ship?", evidence: [] });
  const reopened = new CoordinatorStore(cwd, first.id); assert.deepEqual(reopened.events.map(event => event.seq), [1, 2]); assert.equal(reopened.state.gates.ship.status, "requested");
});

test("work-status v1 is an atomic projection of reducer lanes and gates", () => {
  const cwd = root(), home = root(); const store = new CoordinatorStore(cwd, contract(cwd)); store.append("plan.approved", { by: "owner" });
  store.append("lane.running", { laneId: "inspect", attempt: 1, lastActivityAt: 1234, tmuxSession: "hcode-feedface-inspect" });
  requestGate(store, "ship", { laneId: "inspect", evidence: ["proof.txt"] });
  const projected = projectWorkStatus(store); const written = writeWorkStatus(store, { home });
  assert.deepEqual(written, projected); assert.equal(projected.status, "waiting-owner"); assert.deepEqual(projected.lanes[0], { id: "inspect", runner: "codex", status: "waiting", waitingOn: "gate:ship", lastActivityAt: 1234, tmuxSession: "hcode-feedface-inspect", evidenceCount: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "work-status", `${store.id}.json`))), projected);
  assert.equal(fs.readdirSync(path.join(home, "work-status")).filter(name => name.includes(".tmp")).length, 0);
});

test("shared S9 work-status fixture is the exact hcode v1 projection", () => {
  const cwd = root(); const store = new CoordinatorStore(cwd, contract(cwd));
  store.append("plan.approved", { by: "owner" }); store.append("work.started");
  store.append("lane.running", { laneId: "inspect", attempt: 1, lastActivityAt: 1724570100000, tmuxSession: "hcode-feedface-inspect" });
  store.append("gate.requested", { gateId: "ship", laneId: "inspect", question: "Ship the result?", evidence: ["reports/inspection.json"], ts: 1724570101000 });
  const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/work-status-v1.json", import.meta.url), "utf8"));
  fixture.cwd = fs.realpathSync(cwd); const projected = projectWorkStatus(store);
  assert.deepEqual(projected, fixture);
});

test("supervise tick orphans stale activity, continues once, then stops needs-review", async () => {
  const cwd = root(); const c = contract(cwd, { ownerGates: [], budget: { ...contract(cwd).budget, heartbeatTimeoutMs: 1000 } });
  const stale = new CoordinatorStore(cwd, c); stale.append("plan.approved", { by: "owner" }); stale.append("work.started"); stale.append("lane.running", { laneId: "inspect", attempt: 1, lastActivityAt: 1000 });
  await new WorkSupervisor(stale, { now: () => 3000, writeStatus: projectWorkStatus }).tick();
  assert.equal(stale.state.lanes.inspect.status, "orphaned"); assert.equal(stale.state.status, "needs-review");

  const cwd2 = root(); const waiting = new CoordinatorStore(cwd2, contract(cwd2, { ownerGates: [] })); waiting.append("plan.approved", { by: "owner" }); waiting.append("work.started"); waiting.append("lane.waiting", { laneId: "inspect", attempt: 1, waitingOn: "agent" });
  let resumes = 0; const supervisor = new WorkSupervisor(waiting, { now: () => 5000, resume: async () => { resumes++; }, writeStatus: projectWorkStatus });
  await supervisor.tick(); assert.equal(resumes, 1); assert.equal(waiting.state.lanes.inspect.evidenceRounds, 1);
  await supervisor.tick(); assert.equal(resumes, 1); assert.equal(waiting.state.status, "needs-review"); assert.match(waiting.state.stopReason, /two rounds.*no new evidence/i);
});

test("dependency handoff starts automatically and all verified lanes stop the supervisor", async () => {
  const cwd = root(); const lanes = [lane("first"), lane("second", ["first"])]; const c = contract(cwd, { lanes, budget: { ...contract(cwd).budget, maxChildren: 2 } });
  const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" }); store.append("verification.receipt", { laneId: "first", receipt: receipt(cwd) });
  const started = []; await new WorkSupervisor(store, { start: async ({ lane: item }) => { started.push(item.id); }, writeStatus: projectWorkStatus }).tick();
  assert.deepEqual(started, ["second"]); store.append("verification.receipt", { laneId: "second", receipt: receipt(cwd) }); await new WorkSupervisor(store, { writeStatus: projectWorkStatus }).tick();
  assert.equal(store.state.status, "completed");
});

test("tmux is a bounded observation window with owned naming and cleanup", () => {
  assert.equal(tmuxSessionName("work-feedface", "inspect"), "hcode-feedface-inspect");
  const cwd = root(), bin = path.join(cwd, "tmux"), calls = path.join(cwd, "calls");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`, { mode: 0o755 });
  const session = startTmuxLane({ workId: "work-feedface", laneId: "inspect", command: ["node", "worker.js"], cwd, tmux: bin });
  assert.equal(stopTmuxLane(session, bin), true); const text = fs.readFileSync(calls, "utf8");
  assert.match(text, /new-session -d -s hcode-feedface-inspect -- node worker\.js/); assert.match(text, /kill-session -t hcode-feedface-inspect/);
  const source = fs.readFileSync(new URL("../src/supervise.js", import.meta.url), "utf8");
  assert.equal(source.includes(["capture", "pane"].join("-")), false); assert.equal(source.includes(["send", "keys"].join("-")), false);
});
