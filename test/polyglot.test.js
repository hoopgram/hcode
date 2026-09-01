import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listExercises, firstPrompt, secondPrompt, prepareWorkspace, runTests, summarize, formatPolyglot, runnerCommand, POLYGLOT_VERSION } from "../src/polyglot.js";

// a two-exercise python track shaped like the aider polyglot clone
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-polyglot-test-"));
  for (const [name, fn] of [["leap", "leap_year"], ["two-fer", "two_fer"]]) {
    const dir = path.join(root, "python", "exercises", "practice", name); fs.mkdirSync(path.join(dir, ".meta"), { recursive: true }); fs.mkdirSync(path.join(dir, ".docs"));
    fs.writeFileSync(path.join(dir, ".meta", "config.json"), JSON.stringify({ files: { solution: [`${fn}.py`], test: [`${fn}_test.py`], example: [".meta/example.py"] } }));
    fs.writeFileSync(path.join(dir, ".docs", "instructions.md"), `# ${name}\n\nReturn 42.`);
    fs.writeFileSync(path.join(dir, `${fn}.py`), `def ${fn}():\n    pass\n`);
    fs.writeFileSync(path.join(dir, `${fn}_test.py`), `from ${fn} import ${fn}\n\ndef test_answer():\n    assert ${fn}() == 42\n`);
    fs.writeFileSync(path.join(dir, ".meta", "example.py"), `def ${fn}():\n    return 42\n`);
  }
  return root;
}
function pytestAvailable(python) { try { execFileSync(python, ["-m", "pytest", "--version"], { stdio: "ignore" }); return true; } catch { return false; } }

test("listExercises reads the clone layout and --n picks a deterministic spread", () => {
  const root = fixture();
  const all = listExercises(root, { langs: ["python"] });
  assert.deepEqual(all.map(e => e.id), ["python/leap", "python/two-fer"]);
  assert.deepEqual(all[0].solution, ["leap_year.py"]);
  assert.deepEqual(listExercises(root, { langs: ["python"], n: 1 }).map(e => e.id), ["python/leap"]);
  assert.throws(() => listExercises(root, { langs: ["rust"] }), /unsupported language/);
  assert.throws(() => listExercises(root, { langs: ["javascript"] }), /no javascript exercises/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("prompts follow the published harness: instructions, file list, then failing tests on the retry", () => {
  const root = fixture(); const [leap] = listExercises(root, { langs: ["python"] });
  const first = firstPrompt(leap);
  assert.match(first, /Return 42\./); assert.match(first, /modify the supplied files: leap_year\.py/); assert.match(first, /Only use standard libraries/);
  const second = secondPrompt(leap, "E   assert None == 42");
  assert.match(second, /assert None == 42/); assert.match(second, /The tests are correct/); assert.match(second, /Fix the code in leap_year\.py/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the grader rejects the starter, accepts the reference solution and restores an edited test file", { skip: !pytestAvailable(process.env.HCODE_POLYGLOT_PYTHON || "python3") && "pytest not installed" }, async () => {
  const root = fixture(); const [leap] = listExercises(root, { langs: ["python"] });
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-polyglot-ws-"));
  const tools = { python: process.env.HCODE_POLYGLOT_PYTHON || "python3", nodeModules: null, jest: null, workRoot };
  const ws = prepareWorkspace(leap, workRoot, tools);
  assert.ok(!fs.existsSync(path.join(ws, ".meta")), "the reference solution never enters the workspace");
  assert.equal((await runTests(leap, ws, tools)).pass, false);
  fs.writeFileSync(path.join(ws, "leap_year_test.py"), "def test_answer():\n    assert True\n");   // a runner that 'fixes' the tests gains nothing
  assert.equal((await runTests(leap, ws, tools)).pass, false);
  fs.copyFileSync(path.join(leap.dir, ".meta", "example.py"), path.join(ws, "leap_year.py"));
  assert.equal((await runTests(leap, ws, tools)).pass, true);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workRoot, { recursive: true, force: true });
});

test("summary counts pass@1 and pass@2 per runner and the table names the failures", () => {
  const rows = [
    { runner: "hcode", id: "python/leap", lang: "python", model: "m", pass1: true, pass2: true, wallMs: 10000, input: 100, output: 50, costUsd: 0, attempts: [{}] },
    { runner: "hcode", id: "python/two-fer", lang: "python", model: "m", pass1: false, pass2: true, wallMs: 30000, input: 300, output: 150, costUsd: 0, attempts: [{}, {}] },
    { runner: "codex", id: "python/leap", lang: "python", model: "c", pass1: false, pass2: false, wallMs: 5000, input: 1, output: 1, costUsd: 0, attempts: [{ timedOut: true }, {}] },
    { runner: "claude", id: "python/leap", lang: "python", skipped: "claude is not installed", attempts: [] },
  ];
  const summary = summarize(rows);
  const hcode = summary.find(s => s.runner === "hcode");
  assert.equal(hcode.n, 2); assert.equal(hcode.pass1Pct, 50); assert.equal(hcode.pass2Pct, 100); assert.equal(hcode.meanWallS, 20);
  assert.equal(summary.find(s => s.runner === "codex").timedOut, 1);
  assert.equal(summary.find(s => s.runner === "claude").skipped, 1);
  const text = formatPolyglot({ version: POLYGLOT_VERSION, exercises: ["python/leap", "python/two-fer"], summary, rows, reportFile: "/r.json" });
  assert.match(text, /hcode .* 2 +50% +100%/); assert.match(text, /codex: python\/leap \(timed out\)/); assert.match(text, /1 skipped/);
});

test("runner commands: hcode gets an isolated home, Codex writes only in the workspace, Claude is cash-capped and offline", () => {
  const cfg = { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "m", effort: "low" };
  const h = runnerCommand("hcode", cfg, "/ws", "p", { budgetUsd: 0.5 });
  assert.ok(h.env.HCODE_HOME !== process.env.HCODE_HOME && h.env.HCODE_HOME.includes("hcode-polyglot-home-")); assert.ok(h.args.includes("--cwd") && h.args.includes("auto")); fs.rmSync(h.cleanup, { recursive: true, force: true });
  assert.equal(h.env.HCODE_EFFORT, "low");  // the lane passes the session's effort down; before, the child silently ran the config default
  const c = runnerCommand("codex", cfg, "/ws", "p", {}); assert.ok(c.args.includes("workspace-write") && c.args.includes("--ephemeral"));
  const cl = runnerCommand("claude", cfg, "/ws", "p", { budgetUsd: 5 }); assert.ok(cl.args.includes("--max-budget-usd") && cl.args[cl.args.indexOf("--max-budget-usd") + 1] === "4"); assert.ok(cl.args.join(" ").includes("WebFetch,WebSearch"));
  assert.equal(cl.args[cl.args.indexOf("--model") + 1], "opus");  // always pinned — an inherited default made the pilot unreproducible
});

test("glm runner: Claude Code against z.ai with a pinned model, or a named skip without the key", () => {
  const cfg = { model: "m" };
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-glm-home-"));
  try {
    process.env.HOME = fakeHome;
    const missing = runnerCommand("glm", cfg, "/ws", "p", {});
    assert.equal(missing.command, null); assert.match(missing.reason, /z\.ai API key/);
    fs.mkdirSync(path.join(fakeHome, ".config", "zai"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".config", "zai", "api_key"), "zk-test\n");
    const g = runnerCommand("glm", cfg, "/ws", "p", {});
    assert.equal(g.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(g.env.ANTHROPIC_AUTH_TOKEN, "zk-test");
    assert.equal(g.args[g.args.indexOf("--model") + 1], "glm-5.3"); assert.equal(g.model, "glm-5.3");
    const pinned = runnerCommand("glm", cfg, "/ws", "p", { models: { glm: "glm-5.3-flash" } });
    assert.equal(pinned.model, "glm-5.3-flash");
  } finally { process.env.HOME = realHome; fs.rmSync(fakeHome, { recursive: true, force: true }); }
});
