import test from "node:test";
import assert from "node:assert/strict";
import { parsePullOptions, verificationCommands } from "../scripts/local-pull.mjs";

test("local pull requires named Git coordinates and defaults to balanced", () => {
  assert.deepEqual(parsePullOptions(["--remote", "origin", "--branch", "hcode-local-next"]), {
    remote: "origin", branch: "hcode-local-next", exact: "", profile: "balanced",
  });
  assert.throws(() => parsePullOptions(["--remote", "https://example.test/repo", "--branch", "main"]), /named --remote/);
  assert.throws(() => parsePullOptions(["--remote", "origin", "--branch", "../main"]), /safe --branch/);
  assert.throws(() => parsePullOptions(["--remote", "origin", "--branch", "main", "--profile", "official"]), /profile/);
});

test("verification profiles add evidence without inventing another installer", () => {
  assert.deepEqual(verificationCommands("fast"), [["npm", ["run", "check"]]]);
  assert.equal(verificationCommands("balanced").filter(([, args]) => args[0] === "test").length, 1);
  assert.equal(verificationCommands("full").filter(([, args]) => args[0] === "test").length, 2);
  assert.deepEqual(verificationCommands("full").at(-1), ["npm", ["pack", "--dry-run", "--json"]]);
});
