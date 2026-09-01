import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brainVerdicts, executeDecision, guardOnce, guardStatus, hasOwnerDoor, mechanicalDecision, normalizeRegistry, parseInterval, parseVerdicts, priorNudges, VERDICT_SCHEMA } from "../src/guard.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-guard-"));
const registry = cwd => normalizeRegistry({ v: 1, idleMinutes: 30, sessions: [{ name: "agent-one", type: "codex", resumeId: "resume-1", cwd, expected: "working" }] });

test("guard registry is bounded and the verdict schema is strict", () => {
  const cwd = temp(), r = registry(cwd);
  assert.equal(r.sessions[0].resumeId, "resume-1"); assert.equal(VERDICT_SCHEMA.items.additionalProperties, false);
  assert.deepEqual(parseVerdicts('[{"session":"agent-one","verdict":"working","reason":"fresh","action":"none","message":""}]', r)[0].action, "none");
  assert.equal(parseVerdicts('```json\n[{"session":"agent-one","verdict":"working","reason":"fresh","action":"none","message":""}]', r)[0].action, "none", "complete JSON survives a missing closing fence");
  const warnings = [];
  assert.equal(parseVerdicts({ guardVerdictText: '[{"session":"agent-one"', stopReason: "max_tokens" }, r, { warn: x => warnings.push(x) })[0].action, "none");
  assert.equal(parseVerdicts('[{"session":"other","verdict":"working","reason":"x","action":"none","message":""}]', r, { warn: x => warnings.push(x) })[0].action, "none");
  assert.equal(parseVerdicts("[]", r, { warn: x => warnings.push(x) })[0].action, "none");
  assert.equal(warnings.length, 3); assert.match(warnings[0], /max_tokens.*safe no-action/i);
  assert.throws(() => normalizeRegistry({ sessions: [{ name: "bad name", type: "codex", cwd }] }), /invalid/);
  assert.equal(parseInterval("15m"), 900000); assert.throws(() => parseInterval("1s"), /30s/);
});

test("truncated, empty and wrong-type brain verdicts each shout and complete a safe patrol", async () => {
  const cases = { truncated: '[{"session":"agent-one"', empty: "", wrongType: '{"session":"agent-one"}' };
  for (const [name, bad] of Object.entries(cases)) {
    const cwd = temp(), home = temp(), warnings = [], r = registry(cwd);
    const result = await guardOnce({ registry: r, home, tmux: "/run/current-system/sw/bin/false", decide: async () => parseVerdicts(bad, r, { warn: x => warnings.push(x) }) });
    assert.equal(result.decisions[0].action, "none", name); assert.equal(result.results[0].delivered, false, name);
    assert.equal(warnings.length, 1, name); assert.match(warnings[0], /invalid brain verdict.*safe no-action/i, name);
    const audit = fs.readFileSync(path.join(home, "guard", "audit.jsonl"), "utf8"); assert.match(audit, /brain verdict was invalid/, name);
  }
});

test("a provider error shouts and becomes safe no-action verdicts instead of killing the patrol", async () => {
  const cwd = temp(), r = registry(cwd), warnings = [];
  const raw = await brainVerdicts({ runner: "hcode", maxTokens: 20 }, {
    facts: [], mechanical: [], schema: VERDICT_SCHEMA,
    stream: async () => { const error = new Error("secret provider body"); error.status = 429; throw error; },
  });
  const verdicts = parseVerdicts(raw, r, { warn: message => warnings.push(message) });
  assert.equal(verdicts[0].action, "none");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /provider unavailable status=429.*safe no-action/i);
  assert.doesNotMatch(warnings[0], /secret provider body/);
});

test("mechanical invariants: active and fresh do nothing, owner doors are quiet, two failed nudges escalate", () => {
  assert.equal(mechanicalDecision({ working: true, alive: true }).action, "none");
  assert.equal(mechanicalDecision({ working: false, alive: true, ageSeconds: 60 }, { idleMinutes: 30 }).action, "none");
  assert.equal(mechanicalDecision({ expected: "complete", alive: true, ageSeconds: 99999 }).action, "none");
  assert.equal(mechanicalDecision({ working: false, alive: true, ageSeconds: 4000 }, { ownerDoor: true }).verdict, "waiting-owner");
  assert.equal(mechanicalDecision({ working: false, alive: true, ageSeconds: 4000 }, { idleMinutes: 30, priorNudges: 0 }).action, "nudge");
  assert.equal(mechanicalDecision({ working: false, alive: true, ageSeconds: 4000 }, { idleMinutes: 30, priorNudges: 2 }).action, "door");
  assert.equal(mechanicalDecision({ type: "work", status: "running", ageSeconds: 4000 }, { idleMinutes: 30 }).action, "door");
  assert.equal(priorNudges([{ session: "a", action: "nudge", delivered: false }, { session: "a", action: "nudge", delivered: false }], "a"), 2);
  assert.equal(priorNudges([{ session: "a", action: "nudge", delivered: false }, { session: "a", action: "nudge", delivered: true }], "a"), 0);
  const dir = temp(), ledger = path.join(dir, "ledger.md"); fs.writeFileSync(ledger, "## 门卡\n- [等您] production\n"); assert.equal(hasOwnerDoor({ expected: "working", ledger }), true);
});

test("work-status is a third guarded type and an owner gate is never nudged", async () => {
  const home = temp(), cwd = temp(); fs.mkdirSync(path.join(home, "work-status"));
  fs.writeFileSync(path.join(home, "work-status", "work-feedface.json"), JSON.stringify({ v: 1, workId: "work-feedface", status: "waiting-owner", updatedAt: Date.now(), lanes: [{ id: "lane-one", waitingOn: "gate:ship" }] }));
  const r = normalizeRegistry({ sessions: [{ name: "lane-one", type: "work", workId: "work-feedface", cwd, expected: "working" }] });
  const result = await guardOnce({ registry: r, home, decide: null });
  assert.equal(result.decisions[0].verdict, "waiting-owner"); assert.equal(result.decisions[0].action, "none");
});

test("brain judgment cannot exceed the mechanical action bound", async () => {
  const cwd = temp(), bin = path.join(cwd, "tmux"); fs.writeFileSync(bin, "#!/bin/sh\nprintf 'agent-one\\tnode\\t0\\n'\n", { mode: 0o755 });
  await assert.rejects(() => guardOnce({ registry: registry(cwd), home: temp(), tmux: bin, decide: async () => [{ session: "agent-one", verdict: "dead", reason: "invented", action: "resume", message: "" }] }), /exceeds mechanical bound/);
});

test("nudge uses an empty cursor and requires newer registered-log evidence", async () => {
  const cwd = temp(), log = path.join(cwd, "agent.log"), calls = path.join(cwd, "calls"), state = path.join(cwd, "typed"), bin = path.join(cwd, "tmux"); fs.writeFileSync(log, "old");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in
  *has-session*) exit 0;;
  *display-message*) if [ -e '${state}' ]; then printf '8\\n'; else printf '0\\n'; fi;;
  *' -l '*) touch '${state}';;
  *Enter*) touch '${log}';;
esac\n`, { mode: 0o755 });
  const item = { ...registry(cwd).sessions[0], logPath: log };
  const row = await executeDecision(item, { verdict: "stalled", action: "nudge", reason: "idle", message: "continue" }, { tmux: bin, audit: path.join(cwd, "audit.jsonl"), wait: async () => null });
  assert.equal(row.delivered, true); const text = fs.readFileSync(calls, "utf8"); assert.match(text, /has-session/); assert.equal((text.match(/display-message/g) || []).length, 2); assert.match(text, /send-keys.*Enter/);
});

test("door writes only the registered ledger and audit; source has no pane-content, kill or git action", async () => {
  const cwd = temp(), ledger = path.join(cwd, "ledger.md"), audit = path.join(cwd, "audit.jsonl"); fs.writeFileSync(ledger, "# ledger\n");
  const row = await executeDecision({ ...registry(cwd).sessions[0], ledger }, { verdict: "stalled", action: "door", reason: "twice", message: "Please decide" }, { audit, now: () => 1724570101000 });
  assert.equal(row.delivered, true); assert.match(fs.readFileSync(ledger, "utf8"), /等主人.*Please decide/s); assert.equal(JSON.parse(fs.readFileSync(audit, "utf8")).action, "door");
  const source = fs.readFileSync(new URL("../src/guard.js", import.meta.url), "utf8");
  for (const forbidden of [["capture", "pane"].join("-"), ["kill", "session"].join("-"), "kill-server", "git push"]) assert.equal(source.includes(forbidden), false);
  assert.match(guardStatus(registry(cwd), [row]), /agent-one.*stalled\/door/);
});
