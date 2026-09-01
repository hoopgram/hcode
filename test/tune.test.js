import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { BIG_FILE_BYTES, allowRule, formatTune, readSessionEvidence, requestShape, tuneReport } from "../src/tune.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-tune-"));

// A synthetic history with a known answer: three shapes of evidence, each above its threshold, plus
// noise below it that must NOT be proposed.
function seedSessions(dir, { copies = 3 } = {}) {
  for (let n = 0; n < copies; n++) {
    const session = new Session(dir, null, { cwd: "/w", model: "m" });
    session.startTurn(`run the suite for src/parser-${n}.js and report`);
    const ran = session.toolCall("bash", { command: `npm test -- src/parser-${n}.js` }, ["write"]);
    session.approval(ran.id, "allow", "owner");
    session.setCallState(ran.id, "done");
    const big = session.toolCall("read_file", { path: "src/composer.js" }, ["read"]);
    session.setCallState(big.id, "done");
    session.toolResult(big.id, true, "x".repeat(40_000));
    const ranged = session.toolCall("read_file", { path: "src/composer.js", offset: 100, limit: 40 }, ["read"]);
    session.setCallState(ranged.id, "done");
    session.toolResult(ranged.id, true, "x".repeat(40_000));         // a ranged read is not a whole read
    session.endTurn("end_turn", { in: 10, out: 10 });
  }
  // Noise: one-off request, one policy-granted approval, one small whole-file read.
  const odd = new Session(dir, null, { cwd: "/w", model: "m" });
  odd.startTurn("something nobody ever asks twice");
  const auto = odd.toolCall("bash", { command: "git status" }, ["write"]);
  odd.approval(auto.id, "allow", "policy");
  odd.setCallState(auto.id, "done");
  const small = odd.toolCall("read_file", { path: "README.md" }, ["read"]);
  odd.setCallState(small.id, "done");
  odd.toolResult(small.id, true, "short");
  odd.endTurn("end_turn", { in: 1, out: 1 });
  return dir;
}

test("/tune counts the three classes of evidence and ignores what is below the threshold", () => {
  const dir = seedSessions(tmp());
  const report = tuneReport(dir);
  assert.equal(report.sessions, 4);
  assert.equal(report.turns, 4);

  assert.deepEqual(report.approvals.map(row => [row.key, row.count]), [["bash:npm test *", 3]]);
  assert.match(report.approvals[0].sample, /^\d{14}-[0-9a-f]{4}:\d+$/, "a pointer you can open");
  assert.match(report.approvals[0].examples[0], /^bash /);

  assert.deepEqual(report.requests.map(row => [row.key, row.count]), [["run the suite for <path> and report", 3]]);
  assert.equal(report.requests[0].examples.length, 3);

  assert.deepEqual(report.reads.map(row => [row.key, row.count]), [["src/composer.js", 3]]);
  assert.equal(report.reads[0].bytes, 120_000);
});

test("the report proposes and never applies, and says so in the first two lines", () => {
  const dir = seedSessions(tmp());
  const printed = formatTune(tuneReport(dir));
  assert.match(printed.split("\n")[1], /Proposals only\. hcode changed nothing/);
  assert.match(printed, /3×\s+"bash:npm test \*"/);
  assert.match(printed, /add to \.hcode\/policy\.json: \{"allow": \["bash:npm test \*"\]\}/);
  assert.match(printed, /\/command new run-suite <the prompt, with \$ARGUMENTS where the path goes>/);
  assert.match(printed, /src\/composer\.js {2}40KB average, 120KB total/);
  assert.match(printed, /delegate the search/);
  // Nothing on disk changed: /tune is a reader.
  assert.equal(fs.readdirSync(dir).every(name => name.endsWith(".jsonl")), true);
});

test("thin data is said plainly instead of being filled with a plausible guess", () => {
  const empty = tmp();
  assert.match(formatTune(tuneReport(empty)), /Not enough history to propose anything yet \(0 session\(s\), 0 turn\(s\)/);
  assert.match(formatTune(tuneReport(empty)), /a suggestion from one afternoon would be a guess with a number next to it/);

  // Enough turns to report, but no pattern in any of the three classes.
  const dir = tmp();
  for (let n = 0; n < 4; n++) {
    const session = new Session(dir, null, { cwd: "/w" });
    session.startTurn(`a completely different question number ${"abcd"[n]}`);
    session.endTurn("end_turn", { in: 1, out: 1 });
  }
  const printed = formatTune(tuneReport(dir));
  assert.match(printed, /nothing was approved 2\+ times the same way \(0 distinct owner approval shape\(s\) seen\)/);
  assert.match(printed, /nothing was asked 3\+ times in the same shape \(4 distinct request shape\(s\) seen\)/);
  assert.match(printed, /no file over 20KB was read whole 2\+ times/);
});

test("an allow rule is one the owner can read and that will match again", () => {
  assert.equal(allowRule("bash", { command: "git commit -m \"fix the thing\"" }), "bash:git commit *");
  assert.equal(allowRule("bash", { command: "/usr/local/bin/npm test" }), "bash:npm test *");
  assert.equal(allowRule("bash", { command: "ls" }), "bash:ls *");
  assert.equal(allowRule("bash", { command: "  " }), "");
  assert.equal(allowRule("write_file", { path: "src/deep/a.js" }), "write_file:src/**");
  assert.equal(allowRule("edit_file", { path: "top.js" }), "edit_file:*");
  assert.equal(allowRule("delegate_agent", {}), "delegate_agent");
});

test("a request shape is what stays the same between two askings of the same thing", () => {
  assert.equal(requestShape("Run the tests for src/a.js\nand tell me"), "run the tests for <path>");
  assert.equal(requestShape("run the tests for src/b.js"), "run the tests for <path>");
  assert.equal(requestShape("bump the version to 12."), "bump the version to <n>");
  assert.equal(requestShape(""), "");
});

test("a rewritten tail is counted once, exactly as /cost counts it", () => {
  const dir = tmp();
  const session = new Session(dir, null, { cwd: "/w" });
  session.startTurn("check the parser");
  session.endTurn("end_turn", { in: 1, out: 1 });
  const raw = fs.readFileSync(session.file, "utf8");
  fs.appendFileSync(session.file, raw.split("\n").filter(line => line.includes("turn.start")).join("\n") + "\n");
  fs.appendFileSync(session.file, "{ this line is not json\n");     // and a half-written line is survivable
  const evidence = readSessionEvidence(session.file);
  assert.equal(evidence.turns, 1);
  assert.equal([...evidence.requests.values()][0].count, 1);
  assert.equal(BIG_FILE_BYTES, 20_000);
});

test("--days excludes a session's rows, not just its counts", () => {
  const dir = seedSessions(tmp());
  const now = Date.now() + 40 * 86_400_000;                          // every seeded session is old now
  const report = tuneReport(dir, { days: 7, now });
  assert.equal(report.sessions, 0);
  assert.equal(report.skipped, 4);
  assert.deepEqual([report.approvals, report.requests, report.reads], [[], [], []]);
});
