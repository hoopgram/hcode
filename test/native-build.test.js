import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactName, hostTarget, NODE_VERSION, selectedTargets, TARGETS } from "../scripts/build-native.mjs";

test("native release matrix and names are deterministic", () => {
  assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(TARGETS), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  assert.equal(artifactName("0.10.0", "darwin-arm64"), "hcode-v0.10.0-darwin-arm64");
  assert.deepEqual(selectedTargets("linux-x64,darwin-arm64,linux-x64"), ["linux-x64", "darwin-arm64"]);
  assert.throws(() => selectedTargets("freebsd-x64"), /--target/);
  assert.ok(Object.hasOwn(TARGETS, hostTarget()));
  assert.ok(Object.values(TARGETS).every(hash => /^[a-f0-9]{64}$/.test(hash)));
});
