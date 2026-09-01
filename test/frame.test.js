import test from "node:test";
import assert from "node:assert/strict";
import { createFrameState, displayWidth, fitAnsi, FrameWriter, layoutFrame, reduceFrame, stripAnsi } from "../src/frame.js";

const sample = columns => {
  let state = createFrameState({ columns, rows: 24 });
  state = reduceFrame(state, { type: "transcript.committed", count: 7 });
  state = reduceFrame(state, { type: "live.replaced", rows: ["", "─".repeat(columns), "● 正在验证 coordinator receipt — owner evidence stays append-only and outside this live frame", "› 修复 🧑🏽‍💻"], cursorRow: 3, cursorColumn: 18 });
  return layoutFrame(state);
};

test("40/60/80/120 golden frames preserve bounded live facts", () => {
  const golden = {
    40: ["", "─".repeat(40), "● 正在验证 coordinator receipt — owner …", "› 修复 🧑🏽‍💻"],
    60: ["", "─".repeat(60), "● 正在验证 coordinator receipt — owner evidence stays appen…", "› 修复 🧑🏽‍💻"],
    80: ["", "─".repeat(80), "● 正在验证 coordinator receipt — owner evidence stays append-only and outside t…", "› 修复 🧑🏽‍💻"],
    120: ["", "─".repeat(120), "● 正在验证 coordinator receipt — owner evidence stays append-only and outside this live frame", "› 修复 🧑🏽‍💻"],
  };
  for (const columns of [40, 60, 80, 120]) {
    const frame = sample(columns); assert.deepEqual(frame.rows, golden[columns]); assert.equal(frame.transcriptCount, 7);
    assert.ok(frame.rows.every(row => displayWidth(row) <= columns)); assert.equal(frame.mode, "pinned");
  }
});

test("100 random resizes replay from bounded semantic state without transcript leakage", () => {
  let state = createFrameState({ columns: 80, rows: 24 });
  state = reduceFrame(state, { type: "transcript.committed", count: 999 });
  state = reduceFrame(state, { type: "live.replaced", rows: ["status", "中文 🧑🏽‍💻", "owner gate"], cursorRow: 2, cursorColumn: 99 });
  let seed = 0x5eed;
  for (let index = 0; index < 100; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const columns = 20 + seed % 141;
    seed = (seed * 1664525 + 1013904223) >>> 0; const rows = seed % 61;
    state = reduceFrame(state, { type: "resize", columns, rows }); const replayed = layoutFrame(state);
    assert.ok(replayed.rows.length <= 64); assert.ok(replayed.rows.every(row => displayWidth(row) <= columns)); assert.equal(replayed.transcriptCount, 999);
    assert.ok(!replayed.rows.join("\n").includes("999"));
  }
  const direct = reduceFrame(createFrameState(), { type: "live.replaced", rows: [...state.live.rows], cursorRow: state.live.cursorRow, cursorColumn: state.live.cursorColumn });
  const resized = reduceFrame(direct, { type: "resize", columns: state.columns, rows: state.rows });
  assert.deepEqual(layoutFrame(resized).rows, layoutFrame(state).rows);
});

test("graphemes and ANSI are clipped by cells and one FrameWriter owns output", () => {
  assert.equal(displayWidth("家🧑🏽‍💻é"), 5); const fitted = fitAnsi("\x1b[31m家🧑🏽‍💻abcdef\x1b[0m", 7);
  assert.ok(displayWidth(fitted) <= 7); assert.equal(stripAnsi(fitted), "家🧑🏽‍💻ab…"); assert.match(fitted, /\x1b\[0m$/);
  const sink = { text: "", write(value) { this.text += value; return true; } }; const writer = new FrameWriter(sink);
  writer.write("one"); writer.write("two"); assert.equal(writer.writes, 2); assert.equal(sink.text, "onetwo");
});
