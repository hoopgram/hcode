import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { setMode, currentMode } from "../src/modes.js";
import {
  activeDir, archiveDir, archiveDone, continueFrom, contextHashes, formatContinue, formatLedgers,
  ledgerRoot, listLedgers, parseLedger, restartCommand, restartFlags, slugTask, suggestStatus,
  threadEvidence, writeLedger,
} from "../src/handoff.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-handoff-"));
const NOW = 1756600000000;   // 2025-08-31T00:26:40Z

// One thread with everything a ledger has to be able to say: what was asked, what changed, what ran,
// what never finished, what is still being waited on, and what it cost.
function seededSession(root, { finished = false } = {}) {
  const session = new Session(path.join(root, "s"), null, { cwd: root, model: "m" });
  session.startTurn("Fix the failing parser assertion\nand run the suite");
  session.message("user", "Fix the failing parser assertion");
  const written = session.toolCall("write_file", { path: "src/a.js", content: "x" }, ["write"]);
  session.setCallState(written.id, "done");
  const ran = session.toolCall("bash", { command: "npm test" }, []);
  session.setCallState(ran.id, "done");
  if (!finished) {
    const stuck = session.toolCall("edit_file", { path: "src/b.js" }, ["write"]);
    session.setCallState(stuck.id, "failed");
    const asked = session.toolCall("ask_user", { question: "Should src/b.js keep the old separator?" }, []);
    session.setCallState(asked.id, "pending");
  }
  session.message("assistant", [{ type: "text", text: "one assertion in src/b.js is still red" }]);
  session.endTurn("end_turn", { in: 1000, out: 200, cacheWrite: 300, cacheRead: 120000 });
  return session;
}

test("the ledger is built from the event log alone and repeats itself exactly", () => {
  const root = tmp(); const session = seededSession(root);
  const first = writeLedger({ session, cfg: { cwd: root, model: "m", effort: "high", mode: "auto" }, task: "parser fix", now: NOW, env: {}, argv: ["node", "/usr/bin/hcode.js"] });
  assert.equal(first.file, path.join(root, "交接", "hcode", "active", "hcode-parser-fix.md"));
  const body = fs.readFileSync(first.file, "utf8");
  assert.equal(body.split("\n")[0], `0. 模式: default | 状态: active | 线程: ${session.id}`);   // line 0 is the contract
  assert.match(body, /## 1\..*\n\n- asked: Fix the failing parser assertion$/m);  // first line of the prompt only
  assert.match(body, /changed 1 file\(s\): src\/a\.js/);
  assert.match(body, /ran: `npm test`/);
  assert.match(body, /## 2\.[\s\S]*unfinished: edit_file src\/b\.js — failed/);
  assert.match(body, /waiting on an answer: Should src\/b\.js keep the old separator\?/);
  assert.match(body, /= 121300 carried in, 200 out/);
  assert.match(body, new RegExp(`hcode --resume ${session.id}`));
  assert.ok(first.bytes < 4000, `a ledger stays small (${first.bytes} bytes)`);
  const second = writeLedger({ session, cfg: { cwd: root, model: "m", effort: "high", mode: "auto" }, task: "parser fix", now: NOW, env: {}, argv: ["node", "/usr/bin/hcode.js"] });
  assert.equal(second.existed, true);                                            // one agent + one task = one file
  assert.equal(fs.readFileSync(second.file, "utf8"), body);
  assert.equal(fs.readdirSync(activeDir(ledgerRoot(root))).length, 1);
});

test("status comes from the evidence and the owner still overrides it", () => {
  const root = tmp();
  assert.equal(suggestStatus(threadEvidence(seededSession(root))), "active");                     // something is unfinished
  assert.equal(suggestStatus(threadEvidence(seededSession(tmp(), { finished: true }))), "done");
  const session = seededSession(tmp(), { finished: true });
  const forced = writeLedger({ session, cfg: { cwd: root }, task: "x", status: "active", now: NOW, env: {}, argv: [] });
  assert.match(fs.readFileSync(forced.file, "utf8").split("\n")[0], /状态: active/);
  assert.throws(() => writeLedger({ session, cfg: { cwd: root }, task: "x", status: "maybe" }), /status must be/);
});

test("the restart line is generated from the process and never carries a secret", () => {
  const line = restartCommand({
    cwd: path.join(os.homedir(), "proj", "hcode"),
    task: "parser fix",
    argv: ["/usr/bin/node", "/opt/hcode/bin/hcode.js"],
    env: { HCODE_MODEL: "deepseek-v4-pro", HCODE_SESSIONS: path.join(os.homedir(), ".hcode/sessions"),
      HCODE_API_KEY: "sk-do-not-leak-me", ANTHROPIC_API_KEY: "sk-nor-me", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/usr/bin" },
    flags: ["--model", "sonnet"],
    lookup: () => "/usr/local/bin/hcode",
  });
  assert.equal(line, "cd ~/proj/hcode && HCODE_SESSIONS=~/.hcode/sessions HCODE_MODEL=deepseek-v4-pro hcode --model sonnet \"/continue parser-fix\"");
  assert.doesNotMatch(line, /sk-|API_KEY|AUTH_TOKEN/);
  // No hcode on PATH: the line names the script that is actually running rather than a command that is not there.
  assert.match(restartCommand({ cwd: "/w", task: "t", argv: ["/usr/bin/node", "/opt/hcode/bin/hcode.js"], env: {}, lookup: () => null }),
    /node \/opt\/hcode\/bin\/hcode\.js "\/continue t"/);
  // A directory with a space keeps its shorthand instead of losing it: `~` cannot expand inside quotes.
  assert.match(restartCommand({ cwd: path.join(os.homedir(), "my projects"), task: "t", argv: [], env: {}, lookup: () => "x" }),
    /^cd "\$HOME\/my projects" && hcode/);
  assert.deepEqual(restartFlags({ model: "a", mode: "ask", effort: "high" }, { model: "b", mode: "ask", effort: "high" }), ["--model", "a"]);
});

test("a task name survives a filename and a shell argument", () => {
  assert.equal(slugTask("Fix the /parser; rm -rf $HOME"), "fix-the-parser-rm-rf-home");
  assert.equal(slugTask(""), "session");
  assert.equal(slugTask("交接 账本"), "交接-账本");
  assert.doesNotMatch(slugTask("a'b\"c`d"), /['"`]/);
});

test("/continue archives what is done, keeps what is not, and restores the recorded mode", () => {
  const root = tmp(); const home = ledgerRoot(root);
  const done = writeLedger({ session: seededSession(root, { finished: true }), cfg: { cwd: root }, task: "shipped", status: "done", mode: "savetoken", now: NOW, env: {}, argv: [] });
  const open = writeLedger({ session: seededSession(root), cfg: { cwd: root }, task: "parser", status: "active", mode: "savetoken", now: NOW, env: {}, argv: [] });
  // A file with no status line at all is left alone however it looks — an unreadable head never costs a file.
  const legacy = path.join(activeDir(home), "hcode-legacy.md");
  fs.writeFileSync(legacy, "no status line here\n");
  fs.utimesSync(legacy, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
  fs.utimesSync(open.file, new Date(NOW), new Date(NOW));

  const result = continueFrom(home, { now: NOW });
  assert.deepEqual(result.archived.map(row => row.name), ["hcode-shipped.md"]);
  assert.equal(fs.existsSync(done.file), false);
  assert.equal(fs.existsSync(path.join(archiveDir(home, NOW), "hcode-shipped.md")), true);
  assert.match(archiveDir(home, NOW), /archive\/2025-08$/);
  assert.equal(fs.existsSync(open.file), true);
  assert.equal(fs.existsSync(path.join(activeDir(home), "hcode-legacy.md")), true);
  assert.equal(result.ledger.name, "hcode-parser.md");
  assert.equal(result.ledger.mode, "savetoken");
  assert.equal(result.ledger.status, "active");

  const printed = formatContinue(result, { root: home });
  assert.match(printed, /archived: hcode-shipped\.md/);
  assert.match(printed, /goal: {2}asked: Fix the failing parser assertion/);
  assert.match(printed, /next: {2}unfinished: edit_file/);
  assert.match(printed, /open: {2}Should src\/b\.js keep the old separator\?/);
  // Nothing is left to file the second time round, and the still-open ledger is still the answer.
  const again = continueFrom(home, { now: NOW });
  assert.deepEqual(again.archived, []);
  assert.equal(again.ledger.name, "hcode-parser.md");
});

test("/continue <filter> picks by name and says so when nothing matches", () => {
  const root = tmp(); const home = ledgerRoot(root);
  writeLedger({ session: seededSession(root), cfg: { cwd: root }, task: "parser", now: NOW, env: {}, argv: [] });
  writeLedger({ session: seededSession(root), cfg: { cwd: root }, task: "renderer", now: NOW, env: {}, argv: [] });
  assert.equal(continueFrom(home, { filter: "render", now: NOW }).ledger.name, "hcode-renderer.md");
  assert.equal(continueFrom(home, { filter: "nothing-like-this", now: NOW }).ledger, null);
  assert.match(formatContinue(continueFrom(home, { filter: "nope", now: NOW }), { root: home, filter: "nope" }), /no active handoff matching "nope"/);
  assert.equal(listLedgers(home).length, 2);
  assert.match(formatLedgers(listLedgers(home), { root: home }), /hcode-parser\.md\s+active\s+default/);
  assert.match(formatLedgers([], { root: home }), /No handoff ledgers/);
});

test("a ledger parses back into the three lines /continue prints", () => {
  const ledger = parseLedger([
    "0. 模式: savetoken | 状态: done",
    "## 1. 目标与进度 / Goal and progress", "", "- asked: make it green", "- changed 1 file(s): a.js",
    "## 2. 下一步 / Next steps", "", "- run the suite",
    "## 4. 未决问题 / Open questions", "", "- who owns the release",
  ].join("\n"), "/x/hcode-thing.md");
  assert.equal(ledger.parsed, true);
  assert.equal(ledger.mode, "savetoken"); assert.equal(ledger.status, "done"); assert.equal(ledger.task, "thing");
  assert.equal(ledger.goal, "asked: make it green"); assert.equal(ledger.next, "run the suite"); assert.equal(ledger.open, "who owns the release");
  const broken = parseLedger("# not a ledger\n", "/x/hcode-y.md");
  assert.equal(broken.parsed, false); assert.equal(broken.status, ""); assert.equal(broken.mode, "default");
});

test("the mode a ledger records is the mode the thread recorded", () => {
  const root = tmp(); const session = seededSession(root);
  assert.equal(currentMode(session), "default");
  setMode(session, "savetoken");
  assert.equal(currentMode(session), "savetoken");
  const written = writeLedger({ session, cfg: { cwd: root }, task: "t", now: NOW, env: {}, argv: [] });
  assert.match(fs.readFileSync(written.file, "utf8").split("\n")[0], /模式: savetoken/);
  // The mode survives the round trip through the file, which is the whole reason it is on line 0.
  assert.equal(continueFrom(ledgerRoot(root), { now: NOW }).ledger.mode, "savetoken");
  assert.throws(() => setMode(session, "turbo"), /unknown mode/);
});

test("verified hashes cover the context files that are actually there", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "read AGENTS.md first\n");
  const rows = contextHashes(root);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^AGENTS\.md · sha256:[0-9a-f]{12} · 21 characters$/);
  assert.deepEqual(contextHashes(path.join(root, "nope")), []);
});

test("HCODE_HANDOFF_DIR moves the ledger without moving anything else", () => {
  const root = tmp();
  assert.equal(ledgerRoot(root, { handoffDir: "docs/handoffs" }), path.join(root, "docs/handoffs"));
  assert.equal(archiveDone(path.join(root, "never-created")).length, 0);      // a missing directory is not an error
});
