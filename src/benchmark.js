// Public, fixed and cheap hcode benchmark. The default lane is deterministic and
// offline. `--live` adds one coding task and one planning task per runner with a
// shared nominal effort tier; it never treats equal tier names as equal compute.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { Session } from "./session.js";
import { estimateTokens, maybeCompact } from "./agent.js";
import { HOME, VERSION } from "./config.js";
import { externalRunnerEnv, findBinary } from "./runners.js";
import { selfCommand } from "./runtime.js";

export const BENCHMARK_VERSION = "hcode-public-v1";
const MAX_CAPTURE = 2 * 1024 * 1024;
const PLAN_LABELS = ["Objective", "Constraints", "Workstreams", "Dependencies", "Risks", "Acceptance", "Owner gates", "Stop condition"];
const PLAN_SECTION_SYNTAX = "line start, optional Markdown heading/emphasis, exact label, optional colon";
const PLAN_CONCEPTS = {
  v2Resumability: /(?:\bv2\b[\s\S]{0,140}(?:resum|compatib|read)|(?:resum|compatib|read)[\s\S]{0,140}\bv2\b)/i,
  overlapProtocol: /(?:dual[- ]?(?:read|write)|mixed[- ]version|old and new|coexist|overlap)/i,
  secretExclusion: /(?:secret[\s\S]{0,120}(?:never|redact|reject|scan|zero)|(?:redact|reject|scan)[\s\S]{0,120}secret)/i,
  idempotentSideEffects: /(?:idempoten|outbox|replay)[\s\S]{0,160}(?:side effect|duplicate|completion|ledger)|side effect[\s\S]{0,160}(?:idempoten|duplicate|completion|ledger)/i,
  losslessRollback: /rollback[\s\S]{0,180}(?:no |never |preserv|retain|completed|drill|revert|flag)/i,
  ownerControl: /(?:owner[\s\S]{0,100}(?:approve|sign)|(?:approval|sign.?off|go.?no.?go)[\s\S]{0,100}(?:gate|owner)|gate[\s\S]{0,100}(?:approval|approve|sign))/i,
};
const CODING_POINTS = { tests: 70, implementationChanged: 10, scopedChange: 10, reportsVerification: 5, conciseHandoff: 5 };
const LIVE_MODELS = { hcode: "configured coordinator brain", codex: "gpt-5.6-luna", claude: "claude-sonnet-5" };
const COMMAND_TEMPLATES = {
  hcode: "hcode -p --mode <auto|read> --effort low --max-turns <6|1> --max-tokens 1536 --cwd <fresh-fixture> <fixed-prompt>",
  codex: "codex exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox <workspace-write|read-only> -C <fresh-fixture> -m gpt-5.6-luna -c model_reasoning_effort=low <fixed-prompt>",
  claude: "claude -p <fixed-prompt> --safe-mode --no-session-persistence --model claude-sonnet-5 --effort low --max-budget-usd <cap> --permission-mode <acceptEdits|plan> --allowedTools <fixture-only, Bash(npm test)> --disallowedTools WebFetch,WebSearch,NotebookEdit",
};
const NETWORK_CONTRACT = "off for task tools; only each owner-authenticated model transport remains available";
const FIXTURE = {
  "package.json": JSON.stringify({ name: "hcode-public-range-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/ranges.js": `export function summarizeIds(values) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array");
  return values.join(", ");
}
`,
  "test/ranges.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { summarizeIds } from "../src/ranges.js";

test("sorts, deduplicates and compacts consecutive ids", () => {
  assert.equal(summarizeIds([5, 3, 4, 4, 9, 10, 12]), "3-5, 9-10, 12");
});
test("supports negative and empty ranges", () => {
  assert.equal(summarizeIds([-1, -2, 0, 2]), "-2-0, 2");
  assert.equal(summarizeIds([]), "(none)");
});
test("does not mutate input and rejects unsafe values", () => {
  const input = [3, 1, 2]; const before = [...input];
  assert.equal(summarizeIds(input), "1-3"); assert.deepEqual(input, before);
  for (const value of ["1", 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => summarizeIds([value]), TypeError);
  assert.throws(() => summarizeIds(null), TypeError);
});
`,
};
export const CODING_PROMPT = `Public benchmark ${BENCHMARK_VERSION}. Work only in this fixture; network is forbidden.
Fix src/ranges.js so summarizeIds(values):
1. accepts only an array of safe integers and throws TypeError otherwise;
2. never mutates the input;
3. sorts ascending, removes duplicates, and compresses every consecutive run of two or more as start-end;
4. returns "(none)" for an empty array.
Read the tests, make the smallest implementation change, run npm test, then report what changed and the test result.`;
export const PLANNING_PROMPT = `Public benchmark ${BENCHMARK_VERSION}. Do not use tools. Plan a no-downtime migration of an append-only coding-agent session format from v2 to v3. Existing sessions must remain resumable, secrets must never enter events, old and new clients overlap for one release, and rollback must not lose completed side effects. Return exactly eight concise labeled sections: Objective, Constraints, Workstreams, Dependencies, Risks, Acceptance, Owner gates, Stop condition.`;

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const scoringContract = () => JSON.stringify({ coding: CODING_POINTS, planningSections: PLAN_LABELS, planningSectionSyntax: PLAN_SECTION_SYNTAX, planningConcepts: Object.fromEntries(Object.entries(PLAN_CONCEPTS).map(([name, pattern]) => [name, pattern.source])) });
const publicContract = () => JSON.stringify({ repetitions: 1, nominalEffort: "low", liveModels: LIVE_MODELS, commandTemplates: COMMAND_TEMPLATES, network: NETWORK_CONTRACT, scoring: JSON.parse(scoringContract()) });
const fixtureHash = () => sha(Object.entries(FIXTURE).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => `${name}\0${body}`).join("\0") + `\0${CODING_PROMPT}\0${PLANNING_PROMPT}\0${publicContract()}`);
export function benchmarkManifest() {
  return {
    version: BENCHMARK_VERSION,
    fixtureSha256: fixtureHash(),
    repetitions: 1,
    nominalEffort: "low",
    caveat: "Effort names are aligned controls, not proof of equal compute across providers.",
    liveModels: { ...LIVE_MODELS },
    codingTask: CODING_PROMPT,
    planningTask: PLANNING_PROMPT,
    scoring: JSON.parse(scoringContract()),
    commandTemplates: { ...COMMAND_TEMPLATES },
    network: NETWORK_CONTRACT,
    offline: ["240-turn repeated compaction", "32-child evidence ledger", "grader self-check"],
    resourceMetrics: ["wallMs", "firstOutputMs", "sampledCpuSeconds", "peakRssBytes"],
    resourceCaveat: "CPU is sampled for the runner process tree; firstOutputMs is first process output, which may be runner metadata rather than model text.",
    gpu: { available: false, reason: "macOS exposes no safe unprivileged per-process GPU attribution; use Instruments for an owner-run GPU trace" },
  };
}

function ownTemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function removeOwnTemp(dir, prefix) {
  const real = fs.realpathSync(dir); const base = fs.realpathSync(os.tmpdir()) + path.sep;
  if (!real.startsWith(base) || !path.basename(real).startsWith(prefix)) throw new Error("refused to remove a non-benchmark directory");
  fs.rmSync(real, { recursive: true, force: true });
}
export function createCodingFixture(root) {
  for (const [name, body] of Object.entries(FIXTURE)) {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  }
  return root;
}
function walk(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name); const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}
function snapshot(root) { return Object.fromEntries(walk(root).map(name => [name, sha(fs.readFileSync(path.join(root, name)))])); }
function runFile(file, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  delete env.NODE_TEST_CONTEXT; // a benchmark's nested fixture suite is independent of hcode's own node:test worker
  return new Promise(resolve => execFile(file, args, { ...opts, env, timeout: opts.timeout || 20_000, maxBuffer: MAX_CAPTURE }, (error, stdout = "", stderr = "") => resolve({ code: error?.code === undefined ? 0 : Number(error.code) || 1, stdout, stderr })));
}
function runtimeVersions() {
  const version = name => {
    const bin = findBinary(name, process.env);
    if (!bin) return "not installed";
    try { return execFileSync(bin, ["--version"], { encoding: "utf8", env: externalRunnerEnv(process.env), timeout: 10_000, maxBuffer: 64 * 1024 }).trim().slice(0, 200); }
    catch { return "unavailable"; }
  };
  return { hcode: VERSION, node: process.version, codex: version("codex"), claude: version("claude") };
}
export async function scoreCodingFixture(root, initial = null, answer = "") {
  initial ||= Object.fromEntries(Object.entries(FIXTURE).map(([name, body]) => [name, sha(body)]));
  const test = await runFile(process.execPath, ["--test"], { cwd: root });
  const after = snapshot(root); const changed = Object.keys(after).filter(name => initial[name] !== after[name]);
  const unexpected = Object.keys(after).filter(name => !(name in initial));
  const testsPass = test.code === 0;
  const points = {
    tests: testsPass ? CODING_POINTS.tests : 0,
    implementationChanged: changed.includes("src/ranges.js") ? CODING_POINTS.implementationChanged : 0,
    scopedChange: unexpected.length === 0 && changed.every(name => name === "src/ranges.js") ? CODING_POINTS.scopedChange : 0,
    reportsVerification: /(?:npm test|node --test|tests? pass|verified)/i.test(answer) ? CODING_POINTS.reportsVerification : 0,
    conciseHandoff: String(answer).trim().length >= 20 ? CODING_POINTS.conciseHandoff : 0,
  };
  return { pass: testsPass, score: Object.values(points).reduce((a, b) => a + b, 0), points, changed, unexpected, testTail: (test.stdout + test.stderr).slice(-2000) };
}

export function scorePlan(text) {
  const source = String(text || "");
  const positions = PLAN_LABELS.map(label => source.search(new RegExp(`(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*{1,2}|_{1,2})?${label}(?:\\*{1,2}|_{1,2})?(?:\\s*:|\\s*$)`, "im")));
  const found = PLAN_LABELS.filter((_, index) => positions[index] >= 0); const missing = PLAN_LABELS.filter((_, index) => positions[index] < 0);
  const ordered = positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]));
  const concepts = Object.fromEntries(Object.entries(PLAN_CONCEPTS).map(([name, pattern]) => [name, pattern.test(source)]));
  const conceptCount = Object.values(concepts).filter(Boolean).length;
  const sectionScore = found.length / PLAN_LABELS.length * 50; const conceptScore = conceptCount / Object.keys(PLAN_CONCEPTS).length * 50;
  return { pass: missing.length === 0 && ordered && conceptCount === Object.keys(PLAN_CONCEPTS).length, score: Math.round(sectionScore + conceptScore), found, missing, ordered, concepts };
}

export function runContextBenchmark({ turns = 240, budget = 8000 } = {}) {
  const root = ownTemp("hcode-bench-context-"); const started = Date.now(); const rss0 = process.memoryUsage().rss;
  try {
    const session = new Session(root, null, { model: "claude-sonnet-5", tokenBudget: budget }); let compactions = 0;
    for (let i = 0; i < turns; i++) {
      const prompt = `request ${i} FACT-${i} ${"x".repeat(850)}`;
      session.startTurn(prompt); session.message("user", prompt); session.message("assistant", [{ type: "text", text: `done ${i}` }]); session.endTurn("end_turn");
      if (maybeCompact(session, { model: "claude-sonnet-5", tokenBudget: budget })) compactions++;
    }
    maybeCompact(session, { model: "claude-sonnet-5", tokenBudget: budget });
    const reopened = new Session(root, session.id); const tokens = estimateTokens(session.messages); const latest = JSON.stringify(session.messages).includes(`FACT-${turns - 1}`);
    return { pass: compactions > 0 && tokens < budget * 0.8 && latest && estimateTokens(reopened.messages) === tokens,
      turns, budget, compactions, estimatedTokens: tokens, summaryChars: session.compaction?.summary.length || 0, events: session.events.length,
      transcriptBytes: fs.statSync(session.file).size, wallMs: Date.now() - started, rssDeltaBytes: process.memoryUsage().rss - rss0 };
  } finally { removeOwnTemp(root, "hcode-bench-context-"); }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runCoordinatorBenchmark({ children = 32 } = {}) {
  const root = ownTemp("hcode-bench-fanout-"); const started = Date.now();
  try {
    const session = new Session(root); const ids = [];
    await Promise.all(Array.from({ length: children }, async (_, index) => {
      const child = session.childSpawn({ runner: index % 2 ? "codex" : "claude", task: `inspect shard ${index}`, cwd: root, policy: { mode: "read", sandbox: "runner" } });
      ids.push(child.childId); await wait(2 + index % 5);
      session.childReport({ childId: child.childId, status: "done", summary: `evidence:${index}:complete`, usage: { in: 10, out: 4 } });
      session.childMerge({ childId: child.childId, outcome: "skipped", files: [] });
    }));
    const reports = session.events.filter(event => event.type === "child.report"); const unique = new Set(ids).size;
    const evidence = new Set(reports.map(event => event.summary.match(/evidence:(\d+):complete/)?.[1]).filter(Boolean)).size;
    return { pass: reports.length === children && unique === children && evidence === children, lane: "deterministic event-ledger simulation", children, reports: reports.length, unique, evidence, wallMs: Date.now() - started };
  } finally { removeOwnTemp(root, "hcode-bench-fanout-"); }
}

function psRows() {
  return new Promise(resolve => execFile("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout = "") => {
    if (error) return resolve([]);
    resolve(stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 4 && row.every(Number.isFinite)));
  }));
}
function descendants(rows, rootPid) {
  const wanted = new Set([rootPid]); let grew = true;
  while (grew) { grew = false; for (const [pid, ppid] of rows) if (wanted.has(ppid) && !wanted.has(pid)) { wanted.add(pid); grew = true; } }
  return rows.filter(([pid]) => wanted.has(pid));
}
export function runMeasured(command, args, { cwd, env, timeoutMs = 6 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", firstOutputMs = null, peakRssBytes = 0, cpuSeconds = 0, samples = 0, sampling = false, settled = false, forceKill = null;
    const add = (which, data) => { if (firstOutputMs === null) firstOutputMs = Date.now() - started; const text = data.toString(); if (which === "out") stdout = (stdout + text).slice(-MAX_CAPTURE); else stderr = (stderr + text).slice(-MAX_CAPTURE); };
    child.stdout.on("data", data => add("out", data)); child.stderr.on("data", data => add("err", data));
    const intervalMs = 250; let samplePromise = null;
    const sample = () => {
      if (sampling) return samplePromise;
      sampling = true;
      samplePromise = (async () => {
        try { const rows = descendants(await psRows(), child.pid); peakRssBytes = Math.max(peakRssBytes, rows.reduce((sum, row) => sum + row[3] * 1024, 0)); cpuSeconds += rows.reduce((sum, row) => sum + row[2], 0) / 100 * intervalMs / 1000; samples++; }
        finally { sampling = false; samplePromise = null; }
      })();
      return samplePromise;
    };
    const timer = setInterval(sample, intervalMs); timer.unref?.();
    void sample();
    const stopTimers = () => { clearInterval(timer); clearTimeout(deadline); if (forceKill) clearTimeout(forceKill); };
    const killGroup = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
    let timedOut = false; const deadline = setTimeout(() => {
      timedOut = true; killGroup("SIGTERM");
      forceKill = setTimeout(() => killGroup("SIGKILL"), 2000); forceKill.unref?.();
    }, timeoutMs); deadline.unref?.();
    child.once("error", error => { if (settled) return; settled = true; stopTimers(); reject(error); });
    child.once("close", async code => { if (settled) return; settled = true; stopTimers(); await samplePromise; resolve({ code: code ?? 1, timedOut, wallMs: Date.now() - started, firstOutputMs, sampledCpuSeconds: Math.round(cpuSeconds * 1000) / 1000, peakRssBytes, samples, stdout, stderr }); });
  });
}

function parseJsonLines(raw) { return String(raw).split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
export function extractText(id, run) {
  if (id === "hcode") return run.stdout.trim();
  const rows = parseJsonLines(run.stdout);
  if (id === "codex") return rows.map(row => row.item || row.msg || row).filter(item => /agent_message/.test(item.type || "")).map(item => item.text || item.message || "").join("\n").trim();
  const result = rows.filter(row => row.type === "result").at(-1); if (typeof result?.result === "string") return result.result.trim();
  return rows.filter(row => row.type === "stream_event" && row.event?.delta?.type === "text_delta").map(row => row.event.delta.text).join("").trim();
}
export function extractUsage(id, run, sessionsDir = null) {
  if (id === "hcode" && sessionsDir) {
    let input = 0, output = 0;
    for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(name => name.endsWith(".jsonl")) : []) for (const line of fs.readFileSync(path.join(sessionsDir, name), "utf8").split("\n")) {
      let row; try { row = JSON.parse(line); } catch { continue; } if (row.type === "turn.end") { input += Number(row.usage?.in || 0); output += Number(row.usage?.out || 0); }
    }
    return { input, output, costUsd: null };
  }
  const rows = parseJsonLines(run.stdout);
  if (id === "codex") { const usage = rows.map(row => (row.item || row.msg || row).usage).filter(Boolean).at(-1) || {}; return { input: Number(usage.input_tokens || 0), output: Number(usage.output_tokens || 0), costUsd: null }; }
  const result = rows.filter(row => row.type === "result").at(-1) || {}; const usage = result.usage || {};
  return { input: Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0), output: Number(usage.output_tokens || 0), costUsd: Number.isFinite(Number(result.total_cost_usd)) ? Number(result.total_cost_usd) : null };
}
function runnerCommand(id, cfg, cwd, prompt, { plan = false, budgetUsd = 0.75 } = {}) {
  const effort = "low";
  if (id === "hcode") {
    const home = ownTemp("hcode-bench-home-"); const sessionsDir = path.join(home, "sessions");
    const env = { ...process.env, NO_COLOR: "1", HCODE_HOME: home, HCODE_SESSIONS: sessionsDir, HCODE_BASE_URL: cfg.baseUrl, HCODE_API_KEY: cfg.apiKey, HCODE_MODEL: cfg.model, HCODE_EFFORT: effort, HCODE_TIMEOUT_MS: plan ? "180000" : "360000" };
    return { ...selfCommand(["-p", "--mode", plan ? "read" : "auto", "--effort", effort, "--max-turns", plan ? "1" : "6", "--max-tokens", "1536", "--cwd", cwd, prompt]), env, sessionsDir, cleanup: home };
  }
  const env = { ...externalRunnerEnv(process.env), NO_COLOR: "1" };
  if (id === "codex") return { command: findBinary("codex", process.env), args: ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", plan ? "read-only" : "workspace-write", "-C", cwd, "-m", "gpt-5.6-luna", "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, prompt], env };
  const cap = Math.max(0.05, Math.min(0.25, budgetUsd * 0.2));
  const args = ["-p", prompt, "--safe-mode", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "claude-sonnet-5", "--effort", effort, "--max-budget-usd", String(cap), "--permission-mode", plan ? "plan" : "acceptEdits"];
  if (plan) args.push("--tools", "");
  else args.push("--allowedTools", "Read,Glob,Grep,LS,Edit,Write,MultiEdit,Bash(npm test)");
  args.push("--disallowedTools", "WebFetch,WebSearch,NotebookEdit");
  return { command: findBinary("claude", process.env), args, env, cashCapUsd: cap };
}
async function liveOne(id, cfg, prompt, options) {
  const root = ownTemp(`hcode-bench-${id}-`); const plan = options.plan;
  let command = null;
  try {
    if (!plan) createCodingFixture(root);
    const initial = !plan ? snapshot(root) : null; command = runnerCommand(id, cfg, root, prompt, options);
    if (!command.command) return { runner: id, skipped: true, reason: `${id} is not installed` };
    const run = await runMeasured(command.command, command.args, { cwd: root, env: command.env, timeoutMs: plan ? 3 * 60_000 : 6 * 60_000 });
    const answer = extractText(id, run); const usage = extractUsage(id, run, command.sessionsDir);
    const evaluation = plan ? scorePlan(answer) : await scoreCodingFixture(root, initial, answer);
    return { runner: id, model: id === "hcode" ? cfg.model : id === "codex" ? "gpt-5.6-luna" : "claude-sonnet-5", effort: "low", cashCapUsd: command.cashCapUsd ?? null,
      exitCode: run.code, timedOut: run.timedOut, wallMs: run.wallMs, firstOutputMs: run.firstOutputMs, sampledCpuSeconds: run.sampledCpuSeconds,
      peakRssBytes: run.peakRssBytes, samples: run.samples, usage, evaluation,
      answer: answer.slice(0, 32 * 1024), answerTruncated: answer.length > 32 * 1024, stderrTail: run.stderr.slice(-1000) };
  } finally {
    if (command?.cleanup) removeOwnTemp(command.cleanup, "hcode-bench-home-");
    removeOwnTemp(root, `hcode-bench-${id}-`);
  }
}

export async function runLiveBenchmark(cfg, { budgetUsd = 0.75 } = {}) {
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0 && budgetUsd <= 1)) throw new Error("--budget-usd must be greater than 0 and no more than 1");
  if (!cfg.apiKey || !cfg.baseUrl) throw new Error("the hcode coordinator brain is not connected");
  const coding = [], planning = [];
  for (const id of ["hcode", "codex", "claude"]) coding.push(await liveOne(id, cfg, CODING_PROMPT, { budgetUsd, plan: false }));
  for (const id of ["hcode", "codex", "claude"]) planning.push(await liveOne(id, cfg, PLANNING_PROMPT, { budgetUsd, plan: true }));
  const knownCostUsd = [...coding, ...planning].reduce((sum, row) => sum + Number(row.usage?.costUsd || 0), 0);
  const pass = [...coding, ...planning].every(row => !row.skipped && row.exitCode === 0 && row.evaluation?.pass);
  return { pass, budgetUsd, knownCostUsd: Math.round(knownCostUsd * 1e6) / 1e6,
    costCaveat: "Claude has a hard per-call dollar cap. Codex and the connected hcode brain may use subscription/quota paths that expose tokens but no exact incremental cash cost.", coding, planning };
}

export async function runBenchmark(cfg, { live = false, budgetUsd = 0.75, reportDir = path.join(HOME, "benchmarks") } = {}) {
  const startedAt = new Date().toISOString();
  const goodPlan = ["Objective: migrate v2 sessions safely", "Constraints: preserve v2 resumability and exclude secrets", "Workstreams: dual-read overlap with secret rejection", "Dependencies: idempotency ledger for completed side effects", "Risks: rollback could duplicate a side effect", "Acceptance: rollback drill preserves completed effects", "Owner gates: owner approves each release gate", "Stop condition: stop on lost effects or leaked secrets"].join("\n");
  const report = { manifest: benchmarkManifest(), startedAt, machine: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model || "unknown", cores: os.cpus().length, memoryBytes: os.totalmem(), node: process.version },
    provenance: { runnerVersions: runtimeVersions(), executionOrder: ["hcode:code", "codex:code", "claude:code", "hcode:plan", "codex:plan", "claude:plan"], repetitions: 1,
      state: "Each task gets a fresh workspace and no persistent session; local CLI caches and remote provider state are uncontrolled, so no cold/warm claim is made." },
    offline: { context: runContextBenchmark(), coordination: await runCoordinatorBenchmark(), graders: { planGood: scorePlan(goodPlan), starterRejected: false } } };
  const fixture = ownTemp("hcode-bench-grader-");
  try { createCodingFixture(fixture); report.offline.graders.starterRejected = !(await scoreCodingFixture(fixture)).pass; }
  finally { removeOwnTemp(fixture, "hcode-bench-grader-"); }
  if (live) report.live = await runLiveBenchmark(cfg, { budgetUsd });
  const gradersPass = report.offline.graders.planGood.pass && report.offline.graders.planGood.score === 100 && report.offline.graders.starterRejected;
  report.finishedAt = new Date().toISOString(); report.pass = report.offline.context.pass && report.offline.coordination.pass && gradersPass && (!report.live || report.live.pass);
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const file = path.join(reportDir, `${startedAt.replace(/[:.]/g, "-")}-${BENCHMARK_VERSION}.json`); report.reportFile = file;
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return report;
}

export function formatBenchmark(report) {
  const rows = [`Hoop Code public benchmark ${report.manifest.version}`, `fixture  ${report.manifest.fixtureSha256}`, `report   ${report.reportFile || "not written"}`,
    `context  ${report.offline.context.pass ? "PASS" : "FAIL"} · ${report.offline.context.turns} turns · ${report.offline.context.compactions} compactions · ${report.offline.context.estimatedTokens}/${report.offline.context.budget} tokens`,
    `agents   ${report.offline.coordination.pass ? "PASS" : "FAIL"} · ${report.offline.coordination.children} simulated children · ${report.offline.coordination.evidence} complete evidence reports (ledger capacity, not live agent quality)`,
    `graders  ${report.offline.graders.planGood.pass && report.offline.graders.starterRejected ? "PASS" : "FAIL"} · known-good plan ${report.offline.graders.planGood.score}/100 · broken starter rejected ${report.offline.graders.starterRejected}`];
  if (report.live) {
    rows.push(`live     ${report.live.pass ? "PASS" : "FAIL"} · known cost $${report.live.knownCostUsd.toFixed(4)} / owner ceiling $${report.live.budgetUsd.toFixed(2)}`);
    for (const row of report.live.coding) rows.push(`  code ${row.runner.padEnd(6)} ${row.skipped ? "SKIP " + row.reason : `${row.evaluation.pass ? "PASS" : "FAIL"} · score ${row.evaluation.score} · ${row.wallMs} ms · peak RSS ${Math.round(row.peakRssBytes / 1048576)} MB`}`);
    for (const row of report.live.planning) rows.push(`  plan ${row.runner.padEnd(6)} ${row.skipped ? "SKIP " + row.reason : `${row.evaluation.pass ? "PASS" : "FAIL"} · score ${row.evaluation.score} · ${row.wallMs} ms`}`);
    rows.push(report.live.costCaveat);
  }
  rows.push(report.manifest.gpu.reason);
  return rows.join("\n");
}
