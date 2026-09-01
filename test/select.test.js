import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOption } from "../src/select.js";

test("selectOption without a composer: numbered list, number or key answers, empty backs out", async () => {
  const shown = [];
  const options = [{ label: "read", keys: ["r"] }, { label: "ask", keys: ["a"], current: true, description: "confirm first" }];
  assert.equal(await selectOption({ title: "Mode", options, show: v => shown.push(v), ask: async () => "2" }), 1);
  assert.match(shown[0], /Mode\n  1\. read\n  2\. ask \(current\)\n     confirm first/);
  assert.equal(await selectOption({ title: "Mode", options, ask: async () => "R" }), 0);
  assert.equal(await selectOption({ title: "Mode", options, ask: async () => "" }), null);
  assert.equal(await selectOption({ title: "Mode", options, ask: async () => "9" }), null);
  assert.equal(await selectOption({ title: "Mode", options, select: async () => 7 }), null, "an out-of-range index from the menu is a back-out");
});
