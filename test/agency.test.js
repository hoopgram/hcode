import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadAgencyCanon, classifyEscalation, decideEscalation, AGENCY_CANON_SHA256, applyAgencyGrant } from "../src/agency.js";
import { systemPrompt } from "../src/agent.js";
import { toolDefs, createTools } from "../src/tools.js";
import { startFakeModel, text, tool } from "./fake-model.js";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";

// These tests exercise hcode's own direct model call against a fake brain, so the runner is pinned:
// the default runner is now the first external CLI on PATH, and a codex or claude the developer
// happens to have installed would otherwise silently run the turn (and reach the network).
process.env.HCODE_RUNNER = "hcode";   // "direct" under its on-the-wire name

const cfg = { cwd: process.cwd(), mode: "all", effort: "high", model: "deepseek-v4-pro", fullAgency: true, agencyCanon: loadAgencyCanon() };

test("canonical Full Agency text is exact and is injected before hcode's own system prompt", () => {
  const prompt = systemPrompt(cfg);
  assert.equal(prompt.slice(0, cfg.agencyCanon.length), cfg.agencyCanon);
  assert.match(prompt, /Permission mode: all/);
  assert.equal(AGENCY_CANON_SHA256.length, 64);
  assert.ok(toolDefs({ agency: true }).some(tool => tool.name === "escalate_hard_gate"));
  assert.ok(!toolDefs().some(tool => tool.name === "escalate_hard_gate"));
});

test("broker sends a proven hard gate upward but sends ordinary hesitation back to the agent", async () => {
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-agency-"));
  const hard = decideEscalation({ kind: "new_public_exposure", summary: "open port", proposed_action: "publish service", recommendation: "wait for owner", target: "tcp/443", public_before: false, public_after: true }, { root: outbox });
  assert.equal(hard.state, "STOP"); assert.ok(fs.existsSync(hard.outbox));
  const hesitation = classifyEscalation({ kind: "technical_uncertainty", summary: "choose test name", proposed_action: "rename test", recommendation: "pick the clearer name" });
  assert.equal(hesitation.state, "CONTINUE"); assert.match(hesitation.reason, /decide within scope/);
  assert.equal(fs.readdirSync(outbox).length, 1, "ordinary hesitation must not enter the owner outbox");
  const tools = createTools({ root: process.cwd(), fullAgency: true });
  assert.match(await tools.escalate_hard_gate({ kind: "technical_uncertainty", summary: "implementation order", proposed_action: "pick A", recommendation: "pick A" }), /CONTINUE/);
});

test("missing evidence is UNOBSERVED, not a fabricated gate", () => {
  assert.equal(classifyEscalation({ kind: "overspend", summary: "maybe costs", proposed_action: "run", recommendation: "measure" }).state, "UNOBSERVED");
  assert.equal(classifyEscalation({ kind: "owner_intent_conflict", summary: "maybe conflict", proposed_action: "act", recommendation: "locate instruction" }).state, "UNOBSERVED");
});

test("owner-intent conflict cannot be self-certified by the model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-intents-")); const action = "replace owner data";
  const record = Buffer.from(JSON.stringify({ forbiddenActionDigests: [createHash("sha256").update(action).digest("hex")] }));
  fs.writeFileSync(path.join(root, "intent-7.json"), record);
  const digest = createHash("sha256").update(record).digest("hex");
  const claimed = { kind: "owner_intent_conflict", summary: "conflict", proposed_action: action, recommendation: "stop", owner_intent_id: "intent-7", owner_intent_digest: digest, conflict_evidence: "registered exact action" };
  assert.equal(classifyEscalation(claimed).state, "UNOBSERVED", "model-supplied fields alone are never proof");
  assert.equal(decideEscalation(claimed, { intentRoot: root, root: path.join(root, "out") }).state, "STOP");
  assert.equal(decideEscalation({ ...claimed, proposed_action: "different action" }, { intentRoot: root, root: path.join(root, "out2") }).state, "UNOBSERVED");
});

test("codex and claude agency wrappers pass full-access flags and exact canonical preamble", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-agency-wrapper-"));
  const capture = path.join(root, "args.json");
  for (const name of ["codex", "claude"]) {
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, { mode: 0o755 });
    const run = spawnSync(process.execPath, [new URL("../bin/hcode.js", import.meta.url).pathname, "agency", name, "hello"], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HCODE_HOME: path.join(root, "home") }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const args = fs.readFileSync(capture, "utf8");
    assert.match(args, name === "codex" ? /--dangerously-bypass-approvals-and-sandbox/ : /--dangerously-skip-permissions/);
    assert.match(args, /FULL AGENCY/); assert.match(args, /超额花真钱/);
  }
});

test("real hcode loop has full access, refuses hesitation, self-decides, and escalates a proven gate", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-agency-e2e-"));
  fs.mkdirSync(path.join(root, ".hcode")); fs.writeFileSync(path.join(root, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  const model = await startFakeModel((messages, request, n) => {
    if (n === 1) return { blocks: [tool("ask_user", { question: "Which reversible test name should I choose?" }, "ask")], stop: "tool_use" };
    if (n === 2) return { blocks: [tool("write_file", { path: "decision.txt", content: "self-decided\n" }, "write")], stop: "tool_use" };
    if (n === 3) return { blocks: [tool("escalate_hard_gate", { kind: "new_public_exposure", summary: "publish a new endpoint", proposed_action: "make tcp/443 public", recommendation: "request owner decision", target: "tcp/443", public_before: false, public_after: true }, "gate")], stop: "tool_use" };
    return text("stopped before the public side effect");
  });
  t.after(() => model.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-agency-home-"));
  const live = { ...cfg, cwd: root, baseUrl: model.base, apiKey: "fake", model: "fake", maxTokens: 100, maxTurns: 6, bashTimeoutMs: 1000, sessionsDir: path.join(home, "sessions"), agencyOutbox: path.join(home, "escalations") };
  const session = new Session(live.sessionsDir); const result = await runAgent({ cfg: live, settings: {}, session, prompt: "make the reversible choice, then consider publishing", quiet: true });
  assert.equal(fs.readFileSync(path.join(root, "decision.txt"), "utf8"), "self-decided\n", "mode=all must execute ordinary reversible work without approval");
  assert.equal(result.text, "stopped before the public side effect");
  assert.ok(model.calls.every(call => call.system.startsWith(live.agencyCanon)), "every model round must carry the exact charter as system preamble");
  assert.ok(model.calls[0].tools.some(item => item.name === "escalate_hard_gate"));
  const events = fs.readFileSync(session.file, "utf8");
  const rows = events.trim().split("\n").map(line => JSON.parse(line));
  const gateResult = rows.find(row => row.type === "item" && row.item?.kind === "tool_result" && row.item?.output?.includes("new_public_exposure"));
  assert.match(events, /agency_hesitation_refused/); assert.equal(JSON.parse(gateResult.item.output).state, "STOP");
});

test("applyAgencyGrant: one ruler for level→gate mapping; the grant survives --resume (2026-08-28 layer one)", () => {
  const mk = () => ({ mode: "ask" });
  // levels 0-2 keep ask semantics; 3+ act with all; 7+ is full agency; 9 carries the budget
  const l0 = applyAgencyGrant(mk(), { agencyLevel: 0 });
  assert.equal(l0.mode, "ask"); assert.equal(l0.fullAgency, false);
  const l3 = applyAgencyGrant(mk(), { agencyLevel: 3 });
  assert.equal(l3.mode, "all"); assert.equal(l3.fullAgency, false);
  const l8 = applyAgencyGrant(mk(), { agencyLevel: 8, unattended: true });
  assert.equal(l8.mode, "all"); assert.equal(l8.fullAgency, true); assert.equal(l8.unattended, true);
  const l9 = applyAgencyGrant(mk(), { agencyLevel: 9, agencyBudgetUsd: 25 });
  assert.equal(l9.mode, "all"); assert.equal(l9.agencyBudgetUsd, 25);
  assert.equal(applyAgencyGrant(mk(), { agencyLevel: 12 }).mode, "ask", "out-of-range grant is a no-op");
  assert.equal(applyAgencyGrant(mk(), null).mode, "ask", "null grant is a no-op");
  // the session roundtrip: a grant stamped on turn.start is readable back after reopen
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-ag-"));
  const s1 = new Session(dir, null, { cwd: dir });
  s1.startTurn("mission", { mode: "all", effort: "high", runner: "hcode", agencyLevel: 8, unattended: true });
  const s2 = new Session(dir, s1.id);
  const grant = s2.agencyGrant();
  assert.deepEqual(grant, { agencyLevel: 8, unattended: true, agencyBudgetUsd: null });
  const resumed = applyAgencyGrant({ mode: "ask" }, grant);
  assert.equal(resumed.mode, "all"); assert.equal(resumed.fullAgency, true); assert.equal(resumed.unattended, true);
  // /permission's level change is the latest word
  const s3 = new Session(dir, null, { cwd: dir });
  s3.startTurn("a", { mode: "all", runner: "hcode", agencyLevel: 8 });
  s3.emit("agency.level.changed", { level: 3, budgetUsd: null, scope: "session" });
  assert.equal(new Session(dir, s3.id).agencyGrant().agencyLevel, 3);
});
