import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-benchmark-home-"));
process.env.HCODE_HOME = home;
const {
  BENCHMARK_VERSION,
  benchmarkManifest,
  createCodingFixture,
  scoreCodingFixture,
  scorePlan,
  runContextBenchmark,
  runCoordinatorBenchmark,
  runMeasured,
  runBenchmark,
} = await import("../src/benchmark.js");

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("public benchmark manifest fixes the fixture, effort and honest measurement boundaries", () => {
  const manifest = benchmarkManifest();
  assert.equal(manifest.version, BENCHMARK_VERSION);
  assert.match(manifest.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.nominalEffort, "low");
  assert.equal(manifest.gpu.available, false);
  assert.match(manifest.caveat, /not proof of equal compute/);
  assert.match(manifest.resourceCaveat, /runner process tree/);
  assert.equal(Object.keys(manifest.scoring.planningConcepts).length, 6);
  assert.match(manifest.commandTemplates.codex, /gpt-5\.6-luna/);
  assert.match(manifest.commandTemplates.hcode, /--max-tokens 1536/);
});

test("benchmark graders accept a known-good answer and reject the broken starter", async () => {
  const goodPlan = ["# Objective", "Migrate v2 while sessions remain resumable.", "Constraints: secrets are never persisted", "Workstreams: dual-read overlap for old and new clients", "Dependencies: idempotency ledger for completed side effects", "Risks: rollback may duplicate a side effect", "Acceptance: rollback drill preserves completed work", "Owner gates: owner signs off each release", "Stop condition: stop if a v2 session cannot resume or secrets leak"].join("\n");
  assert.deepEqual(scorePlan(goodPlan).score, 100);
  const boldPlan = goodPlan.replace(/^# /, "").replace(/^(Objective|Constraints|Workstreams|Dependencies|Risks|Acceptance|Owner gates|Stop condition)(:)?/gm, "**$1**$2");
  assert.equal(scorePlan(boldPlan).score, 100);
  assert.equal(scorePlan("Objective: only one section").pass, false);
  const headingsOnly = ["Objective:", "Constraints:", "Workstreams:", "Dependencies:", "Risks:", "Acceptance:", "Owner gates:", "Stop condition:"].join("\n");
  assert.equal(scorePlan(headingsOnly).pass, false);
  assert.equal(scorePlan(headingsOnly).score, 50);

  const root = tmp("hcode-benchmark-fixture-");
  createCodingFixture(root);
  assert.equal((await scoreCodingFixture(root)).pass, false);
  fs.writeFileSync(path.join(root, "src", "ranges.js"), `export function summarizeIds(values) {
  if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value))) throw new TypeError("values must contain safe integers");
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (!sorted.length) return "(none)";
  const result = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    result.push(end > i ? \`${"${sorted[i]}"}-${"${sorted[end]}"}\` : String(sorted[i]));
    i = end + 1;
  }
  return result.join(", ");
}
`);
  const scored = await scoreCodingFixture(root, null, "Changed the implementation and npm test passes.");
  assert.equal(scored.pass, true, scored.testTail);
  assert.equal(scored.score, 100);
  assert.deepEqual(scored.changed, ["src/ranges.js"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("offline context and coordinator lanes survive long history and distinct child evidence", async () => {
  const context = runContextBenchmark();
  assert.equal(context.pass, true);
  assert.ok(context.compactions > 0);
  assert.ok(context.estimatedTokens < context.budget * 0.8);
  const coordination = await runCoordinatorBenchmark({ children: 8 });
  assert.equal(coordination.pass, true);
  assert.equal(coordination.evidence, 8);
  assert.match(coordination.lane, /simulation/);
});

test("resource sampler records a process tree and forcibly bounds a hung runner", async () => {
  const measured = await runMeasured(process.execPath, ["-e", "console.log('ready'); setTimeout(() => {}, 300)"], { timeoutMs: 2000 });
  assert.equal(measured.code, 0);
  assert.equal(measured.timedOut, false);
  assert.ok(measured.firstOutputMs !== null);
  assert.ok(measured.samples >= 1);
  const timed = await runMeasured(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  assert.ok(timed.wallMs < 3500);
});

test("offline benchmark is zero-call, passes its self-check and writes a private report", async () => {
  const reportDir = tmp("hcode-benchmark-reports-");
  const report = await runBenchmark({}, { reportDir });
  assert.equal(report.pass, true);
  assert.equal(report.live, undefined);
  assert.equal(report.offline.graders.planGood.score, 100);
  assert.equal(report.offline.graders.planGood.ordered, true);
  assert.equal(report.offline.graders.starterRejected, true);
  assert.equal(fs.statSync(report.reportFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(report.reportFile, "utf8")).manifest.fixtureSha256, benchmarkManifest().fixtureSha256);
  fs.rmSync(reportDir, { recursive: true, force: true });
});
