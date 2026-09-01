import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinatorStore } from "../src/coordinator.js";
import { formatPlan, formatWork, latestWorkId, openWork, proposeWork } from "../src/work.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-work-ui-"));
const runners = [{ id: "claude", enabled: true, available: true }, { id: "codex", enabled: true, available: true }];

test("/plan creates one bounded contract and requires explicit owner approval", () => {
  const cwd = temp(); const contract = proposeWork({ cwd, objective: "inspect safely", runners });
  assert.equal(contract.status, "proposed"); assert.equal(contract.lanes.length, 2); assert.ok(contract.lanes.every(x => x.mode === "read"));
  assert.match(formatPlan(contract), /\/plan approve/);
  const store = new CoordinatorStore(cwd, contract); assert.equal(latestWorkId(cwd), contract.id); assert.equal(openWork(cwd).contractHash, store.contractHash);
});

test("/work stays readable at 40, 80 and 120 columns and escapes terminal controls", () => {
  const cwd = temp(); const store = new CoordinatorStore(cwd, proposeWork({ cwd, objective: "bad\u001b[2J objective", runners }));
  store.append("plan.approved", { by: "owner" }); store.append("work.started"); store.append("gate.requested", { gateId: "review", laneId: "claude-1", question: "Continue?", evidence: [] });
  for (const columns of [40, 80, 120]) {
    const text = formatWork(store, { columns, now: Date.now() + 1000 });
    for (const fact of ["objective", "phase", "budget", "evidence", "risk", "stop"]) assert.match(text, new RegExp(fact));
    assert.doesNotMatch(text, /\u001b\[2J/); assert.match(text, /\\x1b/);
    assert.match(text, /waiting gate:review/); assert.match(text, /gates .*review:requested/);
  }
});
