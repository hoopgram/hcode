import test from "node:test";
import assert from "node:assert/strict";
import { BREATHING_CADENCE_MS, breathingFrame, createInputState, reduceInput } from "../src/input-state.js";

test("paste, queue and Ctrl-C are pure replayable input state", () => {
  const events = [{ type: "buffer.set", value: "draft " }, { type: "paste.start" }, { type: "paste.append", value: "第一行\r\n" },
    { type: "paste.append", value: "second\0" }, { type: "paste.end" }, { type: "queue.set", count: 2 }, { type: "interrupt" }, { type: "interrupt" }];
  const replay = () => events.reduce(reduceInput, createInputState()); const first = replay();
  assert.deepEqual(first, replay()); assert.equal(first.buffer, "draft 第一行\nsecond"); assert.equal(first.queueCount, 2); assert.equal(first.interruptCount, 2); assert.equal(first.pasting, false);
});

test("slash selection wraps and completion is a reducer fact", () => {
  let state = createInputState(); state = reduceInput(state, { type: "slash.matches", names: ["help", "config", "context"] });
  state = reduceInput(state, { type: "slash.move", delta: -1 }); assert.equal(state.slash.selection, 2);
  state = reduceInput(state, { type: "slash.complete", takesArgs: true }); assert.equal(state.buffer, "/context "); assert.equal(state.slash.selection, 0);
});

test("120/240/480 breathing is deterministic; reduced and plain are static", () => {
  assert.deepEqual(BREATHING_CADENCE_MS, { stream: 120, active: 240, calm: 480 });
  for (const [cadence, interval] of Object.entries(BREATHING_CADENCE_MS)) {
    assert.equal(breathingFrame({ cadence, elapsedMs: interval }).phase, 1); assert.equal(breathingFrame({ cadence, elapsedMs: interval * 4 }).phase, 0);
  }
  for (const mode of [{ reduced: true }, { plain: true }, { reduced: true, plain: true }]) {
    assert.deepEqual(breathingFrame({ ...mode, cadence: "stream", elapsedMs: 9999 }), { glyph: "●", phase: 0, intervalMs: null, animated: false });
  }
});
