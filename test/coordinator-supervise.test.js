import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinatorKernel, CoordinatorStore, createContract, ownershipConflicts } from "../src/coordinator.js";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-supervise-"));
const contract = (cwd, lanes, budget = {}) => createContract({
  v: 1, id: "work-deadbeef", objective: "bounded work", cwd, constraints: [], acceptance: ["evidence verified"], ownerGates: ["plan"],
  budget: { wallMs: 1000, maxChildren: lanes.length, maxConcurrent: Math.min(2, lanes.length), childTimeoutMs: 200, maxRetries: 0, maxCostUsd: null, ...budget },
  lanes, status: "proposed", stopReason: null,
});
const lane = (id, mode = "read", ownership = [], dependsOn = []) => ({ id, runner: id === "a" ? "claude" : "codex", task: id, mode, ownership, dependsOn, verify: mode === "write" ? ["node --test"] : [] });
const receipt = (cwd, id = "check") => ({ v: 1, status: "pass", verifier: "hcode", verifiedAt: 1234,
  commands: [{ id, command: "node --test", cwd, exitCode: 0 }], evidence: ["tool:test"], attack: { cases: ["failure path rejected"], unresolved: [] } });

test("ownership conflicts are refused before spawn, including parent paths", () => {
  const cwd = root();
  assert.deepEqual(ownershipConflicts(contract(cwd, [lane("a", "write", ["src/"]), lane("b", "write", ["src/x.js"])])), [["a", "b", "src"]]);
  assert.deepEqual(ownershipConflicts(contract(cwd, [lane("a", "read"), lane("b", "write", ["src/"])])), []);
});

test("scheduler defaults to two concurrent lanes, verifies evidence, and hcode alone completes", async () => {
  const cwd = root(); const c = contract(cwd, [lane("a"), lane("b")]); const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" });
  let active = 0, peak = 0;
  const kernel = new CoordinatorKernel(store, { sandbox: { degraded: false }, execute: async ({ lane, signal }) => {
    active++; peak = Math.max(peak, active); await new Promise((resolve, reject) => { const t = setTimeout(resolve, 25); signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("cancelled")); }); }); active--;
    return { status: "succeeded", summary: `${lane.id} child claim`, evidence: [{ kind: "test", command: "node --test", ok: true }], usage: { tokens: 4, costUsd: null } };
  }, verify: async ({ evidence, contract }) => ({ receipt: receipt(contract.cwd, `evidence-${evidence.length}`) }) });
  const state = await kernel.run();
  assert.equal(peak, 2); assert.equal(state.status, "completed"); assert.ok(Object.values(state.lanes).every(x => x.status === "verified"));
  assert.match(state.stopReason, /acceptance/);
});

test("missing evidence, degraded mutation and wall budget fail closed", async () => {
  for (const [name, options, expected] of [
    ["evidence", { sandbox: { degraded: false }, execute: async () => ({ status: "succeeded", summary: "trust me", evidence: [] }) }, /evidence/],
    ["sandbox", { sandbox: { degraded: true }, execute: async () => { throw new Error("must not spawn"); } }, /sandbox/],
  ]) {
    const cwd = root(); const c = contract(cwd, [lane("a", "write", ["src/"])]); const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" });
    const state = await new CoordinatorKernel(store, { ...options, verify: async ({ contract }) => ({ receipt: receipt(contract.cwd) }) }).run();
    assert.equal(state.status, "failed", name); assert.match(state.stopReason, expected);
  }
  const cwd = root(); const c = contract(cwd, [lane("a")], { wallMs: 5, childTimeoutMs: 100 }); const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" });
  const state = await new CoordinatorKernel(store, { sandbox: { degraded: false }, execute: async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")))) }).run();
  assert.equal(state.status, "failed"); assert.match(state.stopReason, /budget|timeout/);
});

test("one failed child is retried only within the declared bound", async () => {
  const cwd = root(); const c = contract(cwd, [lane("a")], { maxRetries: 1 }); const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" }); let calls = 0;
  const state = await new CoordinatorKernel(store, { sandbox: { degraded: false }, execute: async () => {
    calls++; if (calls === 1) throw new Error("crash"); return { status: "succeeded", summary: "recovered", evidence: [{ kind: "test", ok: true }] };
  }, verify: async ({ contract }) => ({ receipt: receipt(contract.cwd) }) }).run();
  assert.equal(calls, 2); assert.equal(state.status, "completed"); assert.equal(state.lanes.a.attempts, 2);
});

test("completed requires pass receipts with rerunnable verification and an Attack case", async () => {
  for (const [status, commands, attack] of [
    ["fail", [{ id: "test", command: "node --test", exitCode: 1 }], { cases: ["failed"], unresolved: [] }],
    ["blocked-by-environment", [], { cases: ["sandbox unavailable"], unresolved: [] }],
    ["not-run", [], { cases: [], unresolved: [] }],
    ["pass", [{ id: "test", command: "node --test", exitCode: 0 }], { cases: [], unresolved: [] }],
  ]) {
    const cwd = root(); const c = contract(cwd, [lane("a")]); const store = new CoordinatorStore(cwd, c); store.append("plan.approved", { by: "owner" });
    const state = await new CoordinatorKernel(store, { sandbox: { degraded: false }, execute: async () => ({ status: "succeeded", evidence: [{ kind: "test", ok: true }] }),
      verify: async () => ({ receipt: { v: 1, status, verifier: "hcode", verifiedAt: 1234, commands: commands.map(x => ({ ...x, cwd })), evidence: ["tool:test"], attack } }) }).run();
    assert.notEqual(state.status, "completed", status);
  }
});

test("a forged completed event without receipt references fails closed", () => {
  const cwd = root(); const store = new CoordinatorStore(cwd, contract(cwd, [lane("a")]));
  store.append("plan.approved", { by: "owner" }); store.append("work.stopped", { status: "completed", reason: "trust me" });
  assert.equal(store.state.status, "needs-review"); assert.match(store.state.stopReason, /receipt/i);
});
