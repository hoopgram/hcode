import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFailure, errorFingerprint, publishCircuitStatus, recordAttempt, resetCircuit } from "../src/retry-circuit.js";

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-circuit-"));

test("same deterministic error opens after exactly three attempts and publishes red", () => {
  const dir = fixture(), stateFile = path.join(dir, "state.json"), statusFile = path.join(dir, "status.json");
  const output = "model_fallback_below_minimum: context is below agentic floor";
  const one = recordAttempt(stateFile, { rc: 1, output, now: 1 });
  const two = recordAttempt(stateFile, { rc: 1, output, now: 2 });
  const three = recordAttempt(stateFile, { rc: 1, output, now: 3 });
  assert.equal(one.state, "retrying"); assert.equal(two.state, "retrying"); assert.equal(three.state, "circuit-open");
  publishCircuitStatus(statusFile, three, { session: "hcode-007", resumeCommand: "resume-007" });
  const status = JSON.parse(fs.readFileSync(statusFile)); assert.equal(status.state, "blocked"); assert.equal(status.severity, "red"); assert.equal(status.resumeCommand, "resume-007");
});

test("one transient failure and changing failures do not falsely open the circuit", () => {
  const dir = fixture(), file = path.join(dir, "state.json");
  const quota = recordAttempt(file, { rc: 1, output: "candidate capability probe failed (HTTP 429)" });
  assert.equal(quota.state, "waiting-quota"); assert.equal(quota.failureClass, "quota");
  assert.equal(recordAttempt(file, { rc: 0, output: "ok" }).consecutive, 0);
  assert.equal(recordAttempt(file, { rc: 1, output: "connection reset" }).state, "waiting-transient");
  assert.equal(recordAttempt(file, { rc: 1, output: "connection refused" }).consecutive, 1);
  assert.notEqual(errorFingerprint("connection reset", 1), errorFingerprint("connection refused", 1));
});

test("429 wins over capability wording, deterministic faults circuit, and unknown is UNOBSERVED", () => {
  assert.equal(classifyFailure("UNOBSERVED: candidate capability probe failed (HTTP 429)", 1), "quota");
  assert.equal(classifyFailure("capability manifest missing", 1), "deterministic");
  assert.equal(classifyFailure("frobnicator returned purple", 1), "unknown");
  const dir = fixture(), file = path.join(dir, "state.json"), status = path.join(dir, "status.json");
  const unknown = recordAttempt(file, { rc: 1, output: "frobnicator returned purple" });
  publishCircuitStatus(status, unknown, { session: "hcode-x", resumeCommand: "inspect-then-resume" });
  const shown = JSON.parse(fs.readFileSync(status)); assert.equal(shown.state, "UNOBSERVED"); assert.equal(shown.failureClass, "unknown");
});

test("explicit resume clears the red projection and repetition memory", () => {
  const dir = fixture(), state = path.join(dir, "state.json"), status = path.join(dir, "status.json");
  fs.writeFileSync(status, "{}\n"); resetCircuit(state, status, { now: 9 });
  assert.equal(JSON.parse(fs.readFileSync(status)).state, "running");
  assert.equal(JSON.parse(fs.readFileSync(state)).consecutive, 0); assert.equal(fs.existsSync(status), true);
});
