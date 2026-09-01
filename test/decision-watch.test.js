import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const watcher = new URL("../../../tools/hcode-decision-watch.mjs", import.meta.url).pathname;
function executable(file, body) { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); }
function run(root, now, state = "decision") {
  const tui = path.join(root, "tui"), notify = path.join(root, "notify"), calls = path.join(root, "calls");
  executable(tui, `printf '%s\\n' '${state}'`);
  executable(notify, `printf '%s\\n' "$*" >> '${calls}'`);
  return spawnSync(process.execPath, [watcher, "--session", "test", "--state", path.join(root, "state.json"), "--tui-state", tui, "--notifier", notify, "--python", "/bin/sh", "--threshold-ms", "100"], { encoding: "utf8", env: { ...process.env, HCODE_DECISION_WATCH_NOW_MS: String(now) } });
}

test("persistent decision notifies once after threshold, transient decision does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-decision-"));
  assert.equal(run(root, 1000).status, 0);
  assert.equal(fs.existsSync(path.join(root, "calls")), false);
  assert.equal(run(root, 1099).status, 0);
  assert.equal(fs.existsSync(path.join(root, "calls")), false);
  assert.equal(run(root, 1100).status, 0);
  assert.equal(fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").length, 1);
  assert.equal(run(root, 1200).status, 0);
  assert.equal(fs.readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").length, 1);
  assert.equal(run(root, 1300, "running").status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "state.json"))).decisionSinceMs, null);
});

test("unobserved tui state is a hard failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-decision-"));
  const tui = path.join(root, "tui"); executable(tui, "exit 7");
  const result = spawnSync(process.execPath, [watcher, "--state", path.join(root, "state.json"), "--tui-state", tui], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNOBSERVED/);
  assert.equal(run(root, 1000, "unknown").status, 1);
});
