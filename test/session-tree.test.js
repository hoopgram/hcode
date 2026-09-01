import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSessionTree, projectSessionTree, reduceSessionTree } from "../src/session-tree.js";
const receipt = "sha256:" + "a".repeat(64);
const item = { id: "review", workId: "work-feedface", runner: "codex", status: "waiting-owner", waitingOn: "gate:ship", gates: [{ id: "ship", status: "requested" }], receipts: [] };

test("follow/takeover/release/gate/receipt replay to the shared session-tree fixture", () => {
  let state = createSessionTree([item]); const events = [{ type: "follow", id: "review" }, { type: "takeover", id: "review", by: "owner" },
    { type: "release", id: "review", by: "owner" }, { type: "receipt.added", id: "review", receiptId: receipt }];
  state = events.reduce(reduceSessionTree, state); const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/session-tree-v1.json", import.meta.url)));
  assert.deepEqual(projectSessionTree(state), fixture); assert.deepEqual(projectSessionTree(events.reduce(reduceSessionTree, createSessionTree([item]))), fixture);
});

test("session tree projects gates but cannot approve one for the owner", () => {
  const state = createSessionTree([item]); assert.throws(() => reduceSessionTree(state, { type: "gate.updated", id: "review", gateId: "ship", status: "approved", by: "agent" }), /owner/);
  const approved = reduceSessionTree(state, { type: "gate.updated", id: "review", gateId: "ship", status: "approved", by: "owner" }); assert.equal(approved.sessions.review.gates[0].status, "approved");
  assert.throws(() => reduceSessionTree(state, { type: "takeover", id: "review", by: "agent" }), /owner/);
});
