// 0.8 B: the four consequence gates — power divided by what a call does, not by which tool did it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyConsequences, gateClasses, gateSentence, flagshipGate, GATE_CLASSES, GATE_LABELS, GATE_PATTERNS } from "../src/gates.js";
import { loadPolicy, decide } from "../src/policy.js";
import { risksOf } from "../src/tools.js";
import { spendGateFor, startTask } from "../src/tasks.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-gates-"));
const write = (dir, body) => {
  const file = path.join(dir, ".hcode", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
};

// ---- the pattern table -------------------------------------------------------------------------------
test("every consequence class has hits, names itself, and survives being buried in a pipeline", () => {
  const samples = {
    spend: ["hcloud server create --type cx22 --name box", "terraform apply -auto-approve", "curl https://api.openai.com/v1/messages -d @body.json", "claude -p 'review this'"],
    irreversible: ["rm -rf build", "git push --force origin main", "git reset --hard HEAD~3", "dd if=/dev/zero of=disk.img"],
    exposure: ["git push origin main", "npm publish", "gh release create v1.0.0", "docker push ghcr.io/me/app:1"],
    deletion: ["rm notes.txt", "git branch -D feature", "kubectl delete pod api-0", "find . -name '*.log' -delete"],
  };
  assert.deepEqual(Object.keys(samples), GATE_CLASSES, "every built-in class is covered by a sample");
  for (const [cls, commands] of Object.entries(samples)) {
    for (const command of commands) {
      const hits = classifyConsequences(command);
      assert.ok(gateClasses(hits).includes(cls), `${command} should hit ${cls} (got ${gateClasses(hits).join(",") || "nothing"})`);
      assert.ok(hits.every(hit => hit.why && hit.why.length > 10), `${command} must say why`);
      // the gate reads segments, so a harmless first command cannot carry a consequence past it
      assert.ok(gateClasses(classifyConsequences(`mkdir -p out && ${command}`)).includes(cls), `${command} behind a prefix`);
    }
  }
});

test("one command may have two honest consequences, and both are said out loud", () => {
  const wipe = classifyConsequences("rm -rf dist");
  assert.deepEqual(gateClasses(wipe), ["irreversible", "deletion"]);
  const sentence = gateSentence(wipe);
  assert.match(sentence, /cannot be undone/); assert.match(sentence, /deletes things/);
  assert.match(sentence, /and/, "the classes are joined, not stacked");
  // a force push is both the thing others will see and the thing that cannot be taken back
  assert.deepEqual(gateClasses(classifyConsequences("git push --force origin main")), ["irreversible", "exposure"]);
});

test("reading about a dangerous command is not doing one", () => {
  for (const command of ["grep -rn 'git push' src", "echo 'rm -rf /'", "ls -la", "git status", "npm test", "cat README.md", "git log --oneline -5"]) {
    assert.deepEqual(classifyConsequences(command), [], command);
  }
});

test("the classification is a pattern table, not a model call, and every class carries a label", () => {
  assert.deepEqual(Object.keys(GATE_PATTERNS), GATE_CLASSES);
  for (const cls of GATE_CLASSES) {
    assert.ok(GATE_LABELS[cls], cls);
    const table = GATE_PATTERNS[cls];
    assert.ok(table.patterns.length + Object.keys(table.verbs).length > 0, cls);
    for (const entry of table.patterns) assert.ok(entry.re instanceof RegExp && entry.why, `${cls}: every row is a regex plus a sentence`);
  }
});

// ---- enforcement --------------------------------------------------------------------------------------
test("a gate asks in every mode, names its class, and is not something a mode switches off", () => {
  const cwd = tmp(); const home = tmp();
  const policy = loadPolicy(cwd, { home });
  for (const [command, classes] of [["npm publish", ["exposure"]], ["rm -rf build", ["irreversible", "deletion"]], ["terraform apply", ["spend"]]]) {
    for (const mode of ["ask", "auto", "all"]) {
      const verdict = decide({ policy, mode, name: "bash", input: { command }, risk: risksOf("bash", { command }, cwd), root: cwd });
      assert.equal(verdict.decision, "ask", `${command} in ${mode}`);
      assert.deepEqual(verdict.gates, classes, command);
      assert.match(verdict.why, /^this command /);
    }
  }
});

test("a class cannot be switched off wholesale, only covered one named command at a time", () => {
  const cwd = tmp(); const home = tmp();
  // the shapes an owner might reach for to silence a whole class — none of them is a setting
  write(cwd, { gates: false, rules: [{ tool: "bash", action: "allow" }] });
  const policy = loadPolicy(cwd, { home });
  const at = (mode, command) => decide({ policy, mode, name: "bash", input: { command }, risk: risksOf("bash", { command }, cwd), root: cwd });
  assert.equal(at("auto", "rm -rf build").decision, "ask", "a blanket allow does not repeal the class");
  assert.equal(at("all", "npm publish").decision, "ask");

  // what does work is naming the command you already thought about
  write(cwd, { rules: [{ tool: "bash", command: "rm -rf build*", action: "allow", why: "build output, rebuilt by npm run build" }] });
  const named = loadPolicy(cwd, { home });
  const covered = decide({ policy: named, mode: "auto", name: "bash", input: { command: "rm -rf build" }, risk: risksOf("bash", { command: "rm -rf build" }, cwd), root: cwd });
  assert.equal(covered.decision, "allow");
  assert.match(covered.why, /rebuilt by npm run build/);
  // and only that command: the neighbour still asks
  assert.equal(decide({ policy: named, mode: "auto", name: "bash", input: { command: "rm -rf src" }, risk: risksOf("bash", { command: "rm -rf src" }, cwd), root: cwd }).decision, "ask");
});

test("a deny rule still outranks a gate's ask — the rule book is above the gates", () => {
  const cwd = tmp(); const home = tmp();
  write(cwd, { rules: [{ tool: "bash", command: "npm publish*", action: "deny", why: "this package is not mine to publish" }] });
  const policy = loadPolicy(cwd, { home });
  const verdict = decide({ policy, mode: "all", name: "bash", input: { command: "npm publish" }, risk: ["write", "network"], root: cwd });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.why, /not mine to publish/);
});

test("the fixed boundaries still come first: a secret path is denied before any gate is consulted", () => {
  const cwd = tmp(); const home = tmp();
  write(cwd, { rules: [{ tool: "bash", command: "*", action: "allow" }] });
  const policy = loadPolicy(cwd, { home });
  const at = command => decide({ policy, mode: "all", name: "bash", input: { command }, risk: risksOf("bash", { command }, cwd), root: cwd });
  assert.equal(at("cat ~/.hcode/config.json").decision, "deny");
  assert.equal(at("rm -rf /").decision, "deny");
  assert.match(at("rm -rf /").why, /root or home/);
});

// ---- the spend gate on delegation ----------------------------------------------------------------------
test("a flagship helper is the spend gate, and all mode does not pay for it quietly", () => {
  const cwd = tmp(); const home = tmp();
  const policy = loadPolicy(cwd, { home });
  const input = { agent: "codex", task: "write the parser", allow_flagship: true };
  for (const mode of ["ask", "auto", "all"]) {
    const verdict = decide({ policy, mode, name: "delegate_agent", input, risk: ["external"], root: cwd });
    assert.equal(verdict.decision, "ask", mode);
    assert.deepEqual(verdict.gates, ["spend"]);
    assert.match(verdict.why, /spends money/);
  }
  // an ordinary helper keeps the shape it had: all mode covers it
  assert.equal(decide({ policy, mode: "all", name: "delegate_agent", input: { agent: "codex", task: "look" }, risk: ["external"], root: cwd }).decision, "allow");
});

test("--allow-flagship names the brain; it does not buy it", () => {
  assert.equal(spendGateFor({ runner: "claude", model: "haiku", coordinatorModel: "claude-fable-5" }), null);
  const gate = spendGateFor({ runner: "claude", model: "fable", coordinatorModel: "claude-fable-5" });
  assert.equal(gate.class, "spend");
  assert.match(gate.why, /costs what the coordinator/);
  assert.equal(flagshipGate({ model: "" }), null);

  // a background conversation on a flagship brain refuses rather than quietly billing, and says how to proceed
  const cwd = tmp();
  let thrown = null;
  try { startTask({ runner: "claude", prompt: "do the thing", cwd, model: "fable", allowFlagship: true, coordinatorModel: "claude-fable-5", env: {} }); }
  catch (error) { thrown = error; }
  assert.ok(thrown, "a flagship background conversation does not start on --allow-flagship alone");
  assert.equal(thrown.code, "spend_gate");
  assert.equal(thrown.details.model, "fable");
  assert.equal(thrown.details.class, "spend");
  assert.match(thrown.message, /--allow-flagship/, "the refusal says what it is not enough to have passed");
});
