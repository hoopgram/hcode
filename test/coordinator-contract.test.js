import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinatorStore, contractHash, createContract, reduceCoordinator, validateContract } from "../src/coordinator.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-coordinate-"));
const base = root => ({
  v: 1, id: "work-abc12345", objective: "verify two bounded lanes", cwd: root,
  constraints: ["network off"], acceptance: ["tests pass"], ownerGates: ["plan"],
  budget: { wallMs: 60_000, maxChildren: 2, maxConcurrent: 2, childTimeoutMs: 20_000, maxRetries: 1, maxCostUsd: null },
  lanes: [
    { id: "inspect", runner: "claude", task: "inspect", mode: "read", dependsOn: [], ownership: [] },
    { id: "change", runner: "codex", task: "change", mode: "write", dependsOn: ["inspect"], ownership: ["src/"], verify: ["node --test"] },
  ], status: "proposed", stopReason: null,
});

test("TaskContract rejects unknown fields, illegal status, cycles and negative budgets", () => {
  const root = temp();
  assert.equal(validateContract(base(root)).id, "work-abc12345");
  assert.throws(() => validateContract({ ...base(root), surprise: true }), /unknown contract field/);
  assert.throws(() => validateContract({ ...base(root), status: "finished-ish" }), /invalid contract status/);
  assert.throws(() => validateContract({ ...base(root), budget: { ...base(root).budget, wallMs: -1 } }), /budget.wallMs/);
  assert.throws(() => validateContract({ ...base(root), budget: { ...base(root).budget, maxChildren: 4, maxConcurrent: 4 } }), /hard limit/);
  const cyclic = base(root); cyclic.lanes[0].dependsOn = ["change"];
  assert.throws(() => validateContract(cyclic), /dependency cycle/);
});

test("contract is canonical, immutable across compaction, and replay is deterministic", () => {
  const root = temp(); const contract = createContract(base(root));
  const store = new CoordinatorStore(root, contract);
  store.append("plan.approved", { by: "owner" });
  store.append("lane.queued", { laneId: "inspect" });
  store.append("lane.running", { laneId: "inspect", attempt: 1, pid: 999999, idempotencyKey: "work-abc12345:inspect:1" });
  fs.appendFileSync(store.file, "{broken tail");
  const reopened = new CoordinatorStore(root, contract.id);
  assert.equal(reopened.contractHash, contractHash(contract));
  assert.equal(reopened.state.lanes.inspect.status, "orphaned");
  assert.equal(reopened.state.status, "needs-review");
  assert.deepEqual(reduceCoordinator(contract, reopened.events).contract, contract);
});
