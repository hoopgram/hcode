import { test } from "node:test";
import assert from "node:assert/strict";
import { selfArgv, selfCommand, isNixRuntime, runtimeLabel } from "../src/runtime.js";

test("source and native relaunch use one explicit argv contract", () => {
  assert.deepEqual(selfCommand(["_task-worker", "task-deadbeef"], { native: false, execPath: "/node", sourceEntry: "/src/bin/hcode.js" }), {
    command: "/node", args: ["/src/bin/hcode.js", "_task-worker", "task-deadbeef"], kind: "source",
  });
  assert.deepEqual(selfCommand(["_task-worker", "task-deadbeef"], { native: true, execPath: "/opt/hcode" }), {
    command: "/opt/hcode", args: ["_task-worker", "task-deadbeef"], kind: "native",
  });
  assert.deepEqual(selfArgv(["--version"], { native: true, execPath: "/opt/hcode" }), ["/opt/hcode", "--version"]);
});

test("Nix is an immutable native installation, not a self-updating binary", () => {
  assert.equal(isNixRuntime("/nix/store/abc-hcode/bin/hcode"), true);
  assert.equal(isNixRuntime("/Users/me/.local/bin/hcode"), false);
  assert.match(runtimeLabel(), /source|native|nix/);
});
