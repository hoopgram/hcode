// Polyglot lane: Aider's public polyglot benchmark (Exercism practice exercises,
// hidden unit tests, pass@2) run head-to-head through hcode, Codex, Claude Code
// and GLM (Claude Code against z.ai) as products — each runner gets the same
// prompt, the same fresh workspace
// and a second attempt with the failing test output, exactly like the published
// harness. No docker: only node (jest) and a pytest interpreter are needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";
import { externalRunnerEnv, findBinary } from "./runners.js";
import { runMeasured, extractText, extractUsage } from "./benchmark.js";

export const POLYGLOT_VERSION = "hcode-polyglot-v1";
export const POLYGLOT_REPO = "https://github.com/Aider-AI/polyglot-benchmark";
const BIN = fileURLToPath(new URL("../bin/hcode.js", import.meta.url));
const LANGS = {
  javascript: { test: (ws, tools) => ({ command: tools.jest, args: ["--ci", "--silent", "--rootDir", ws, ...fs.readdirSync(ws).filter(f => f.endsWith(".spec.js"))] }) },
  python: { test: (ws, tools, files) => ({ command: tools.python, args: ["-m", "pytest", "-x", "-q", "--no-header", "-p", "no:cacheprovider", ...files] }) },
};
const RUNNERS = ["hcode", "codex", "claude", "glm"];
const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const zaiKeyFile = () => path.join(os.homedir(), ".config", "zai", "api_key");

export function listExercises(root, { langs = Object.keys(LANGS), n = 0 } = {}) {
  const all = [];
  for (const lang of langs) {
    if (!LANGS[lang]) throw new Error(`unsupported language ${lang} (javascript, python)`);
    const dir = path.join(root, lang, "exercises", "practice");
    if (!fs.existsSync(dir)) throw new Error(`no ${lang} exercises under ${root} — clone ${POLYGLOT_REPO} there`);
    for (const name of fs.readdirSync(dir).sort()) {
      const meta = path.join(dir, name, ".meta", "config.json"); if (!fs.existsSync(meta)) continue;
      const config = JSON.parse(fs.readFileSync(meta, "utf8"));
      all.push({ id: `${lang}/${name}`, lang, name, dir: path.join(dir, name), solution: config.files?.solution || [], test: config.files?.test || [] });
    }
  }
  if (!n || n >= all.length) return all;
  // deterministic, evenly spread subset (so --n 10 is the same 10 on every machine)
  const step = all.length / n; return Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]);
}

function readDocs(dir) {
  const docs = path.join(dir, ".docs"); const parts = [];
  for (const name of ["introduction.md", "instructions.md", "instructions.append.md"]) { const file = path.join(docs, name); if (fs.existsSync(file)) parts.push(fs.readFileSync(file, "utf8").trim()); }
  return parts.join("\n\n");
}
export function firstPrompt(exercise) {
  return `${readDocs(exercise.dir)}\n\n####\n\nUse the above instructions to modify the supplied files: ${exercise.solution.join(", ")}\nDon't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\nOnly use standard libraries, don't suggest installing any packages.\n`;
}
export function secondPrompt(exercise, testOutput) {
  return `\n${testOutput.slice(-6000)}\n\nSee the testing errors above.\nThe tests are correct.\nFix the code in ${exercise.solution.join(", ")} to resolve the errors.\n`;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".meta" || entry.name === "node_modules") continue;
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst); else fs.copyFileSync(src, dst);
  }
}
export function prepareWorkspace(exercise, root, tools) {
  const ws = fs.mkdtempSync(path.join(root, `${exercise.lang}-${exercise.name}-`));
  copyTree(exercise.dir, ws);
  if (exercise.lang === "javascript" && tools.nodeModules) fs.symlinkSync(tools.nodeModules, path.join(ws, "node_modules"), "dir");
  return ws;
}
// Exercism ships JS specs with every test but the first skipped (xtest/xit/xdescribe); the
// benchmark grades against all of them, as the published harness does.
function unskip(ws) {
  for (const name of fs.readdirSync(ws).filter(f => f.endsWith(".spec.js"))) { const file = path.join(ws, name); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\bx(test|it|describe)\(/g, "$1(")); }
}
export async function runTests(exercise, ws, tools) {
  // the model may have edited the tests; grade against the originals
  for (const name of exercise.test) fs.copyFileSync(path.join(exercise.dir, name), path.join(ws, name));
  if (exercise.lang === "javascript") unskip(ws);
  const { command, args } = LANGS[exercise.lang].test(ws, tools, exercise.test);
  const run = await runMeasured(command, args, { cwd: ws, env: { ...process.env, CI: "1", NO_COLOR: "1" }, timeoutMs: 120_000 });
  return { pass: run.code === 0 && !run.timedOut, output: (run.stdout + "\n" + run.stderr).trim(), wallMs: run.wallMs };
}

export function runnerCommand(id, cfg, ws, prompt, { budgetUsd = 2, models = {} } = {}) {
  if (id === "hcode") {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-polyglot-home-")); const sessionsDir = path.join(home, "sessions");
    const env = { ...process.env, NO_COLOR: "1", HCODE_HOME: home, HCODE_SESSIONS: sessionsDir, HCODE_BASE_URL: cfg.baseUrl, HCODE_API_KEY: cfg.apiKey, HCODE_MODEL: models.hcode || cfg.model, HCODE_EFFORT: cfg.effort || "high", HCODE_TIMEOUT_MS: "300000" };
    return { command: process.execPath, args: [BIN, "-p", "--mode", "auto", "--max-turns", "40", "--cwd", ws, prompt], env, sessionsDir, cleanup: home, model: models.hcode || cfg.model };
  }
  const env = { ...externalRunnerEnv(process.env), NO_COLOR: "1" };
  if (id === "codex") {
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", ws];
    if (models.codex) args.push("-m", models.codex);
    return { command: findBinary("codex", process.env), args: [...args, prompt], env, model: models.codex || "codex default" };
  }
  // claude and glm share the Claude Code CLI; glm points it at z.ai's Anthropic-compatible
  // endpoint (the owner's czo/czs setup). The model is always pinned — an inherited default
  // from ~/.claude/settings.json made the pilot unreproducible across machines.
  const cap = Math.max(0.05, Math.min(4, budgetUsd));
  const claudeArgs = model => ["-p", prompt, "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--max-budget-usd", String(cap),
    "--allowedTools", "Read,Glob,Grep,LS,Edit,Write,MultiEdit,Bash", "--disallowedTools", "WebFetch,WebSearch,NotebookEdit", "--model", model];
  if (id === "glm") {
    const key = fs.existsSync(zaiKeyFile()) ? fs.readFileSync(zaiKeyFile(), "utf8").trim() : "";
    if (!key) return { command: null, reason: "glm needs a z.ai API key in ~/.config/zai/api_key" };
    const model = models.glm || "glm-5.3";
    return { command: findBinary("claude", process.env), args: claudeArgs(model), model,
      env: { ...env, CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude-zai"), ANTHROPIC_BASE_URL: ZAI_BASE_URL, ANTHROPIC_AUTH_TOKEN: key } };
  }
  const model = models.claude || "opus";
  return { command: findBinary("claude", process.env), args: claudeArgs(model), env, model };
}

// last events of the hcode session ledger, kept for diagnosing a non-zero exit (the temp home is deleted right after)
function sessionTail(sessionsDir) {
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;
  const out = [];
  for (const name of fs.readdirSync(sessionsDir).filter(n => n.endsWith(".jsonl"))) for (const line of fs.readFileSync(path.join(sessionsDir, name), "utf8").split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    out.push(JSON.stringify(row).slice(0, 300));
  }
  return out.slice(-12);
}
async function attempt(id, cfg, ws, prompt, options) {
  const command = runnerCommand(id, cfg, ws, prompt, options);
  if (!command.command) return { skipped: true, reason: command.reason || `${id} is not installed` };
  try {
    const run = await runMeasured(command.command, command.args, { cwd: ws, env: command.env, timeoutMs: options.timeoutMs || 10 * 60_000 });
    return { exitCode: run.code, timedOut: run.timedOut, wallMs: run.wallMs, usage: extractUsage(id, run, command.sessionsDir), answer: extractText(id, run).slice(0, 8000), stderrTail: run.stderr.slice(-800), model: command.model, sessionTail: sessionTail(command.sessionsDir) };
  } finally { if (command.cleanup) fs.rmSync(command.cleanup, { recursive: true, force: true }); }
}

export async function runExercise(id, exercise, cfg, tools, options) {
  const ws = prepareWorkspace(exercise, tools.workRoot, tools);
  const row = { runner: id, id: exercise.id, lang: exercise.lang, attempts: [], pass1: false, pass2: false, wallMs: 0, input: 0, output: 0, costUsd: 0 };
  try {
    let prompt = firstPrompt(exercise);
    for (let k = 1; k <= 2; k++) {
      const a = await attempt(id, cfg, ws, prompt, options);
      if (a.skipped) { row.skipped = a.reason; return row; }
      const tests = await runTests(exercise, ws, tools);
      row.attempts.push({ ...a, testPass: tests.pass, testTail: tests.output.slice(-1500) });
      row.wallMs += a.wallMs; row.input += a.usage.input; row.output += a.usage.output; row.costUsd += Number(a.usage.costUsd || 0); row.model = a.model;
      if (tests.pass) { if (k === 1) row.pass1 = true; row.pass2 = true; break; }
      prompt = secondPrompt(exercise, tests.output);
    }
    return row;
  } finally { if (!options.keep) fs.rmSync(ws, { recursive: true, force: true }); }
}

export function summarize(rows) {
  const by = {};
  for (const row of rows) {
    const s = by[row.runner] ||= { runner: row.runner, model: row.model, n: 0, skipped: 0, pass1: 0, pass2: 0, wallMs: 0, input: 0, output: 0, costUsd: 0, timedOut: 0, langs: {} };
    if (row.skipped) { s.skipped++; continue; }
    s.n++; s.pass1 += row.pass1 ? 1 : 0; s.pass2 += row.pass2 ? 1 : 0; s.wallMs += row.wallMs; s.input += row.input; s.output += row.output; s.costUsd += row.costUsd;
    s.timedOut += row.attempts.some(a => a.timedOut) ? 1 : 0;
    const l = s.langs[row.lang] ||= { n: 0, pass2: 0 }; l.n++; l.pass2 += row.pass2 ? 1 : 0;
  }
  return Object.values(by).map(s => ({ ...s, pass1Pct: s.n ? Math.round(1000 * s.pass1 / s.n) / 10 : 0, pass2Pct: s.n ? Math.round(1000 * s.pass2 / s.n) / 10 : 0, meanWallS: s.n ? Math.round(s.wallMs / s.n / 100) / 10 : 0 }));
}

export function resolveTools(root, opts = {}) {
  const nodeModules = opts.nodeModules || path.join(root, "javascript", "node_modules");
  const jest = path.join(nodeModules, ".bin", "jest");
  const python = opts.python || process.env.HCODE_POLYGLOT_PYTHON || "python3";
  return { nodeModules: fs.existsSync(nodeModules) ? nodeModules : null, jest: fs.existsSync(jest) ? jest : null, python, workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "hcode-polyglot-")) };
}

export async function runPolyglot(cfg, { exercises: root, langs, n = 0, runners = RUNNERS, budgetUsd = 2, models = {}, reportDir = path.join(HOME, "benchmarks"), resume = null, keep = false, timeoutMs, onRow = () => {} } = {}) {
  if (!root || !fs.existsSync(root)) throw new Error(`--exercises <dir> must point at a clone of ${POLYGLOT_REPO}`);
  const list = listExercises(root, { langs, n });
  const tools = resolveTools(root);
  if (list.some(e => e.lang === "javascript") && !tools.jest) throw new Error(`jest not found — run "npm install" in ${path.join(root, "javascript")} using any exercise's package.json`);
  if (runners.includes("hcode") && !(cfg.apiKey && cfg.baseUrl)) throw new Error("the hcode coordinator brain is not connected");
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const rowsFile = resume || path.join(reportDir, `${startedAt.replace(/[:.]/g, "-")}-${POLYGLOT_VERSION}.jsonl`);
  const done = new Set(); const rows = [];
  if (resume && fs.existsSync(resume)) for (const line of fs.readFileSync(resume, "utf8").split("\n")) { try { const row = JSON.parse(line); rows.push(row); done.add(`${row.runner}:${row.id}`); } catch {} }
  const options = { budgetUsd, models, keep, timeoutMs };
  // runners in parallel, exercises sequential inside each runner (their timings share the machine — no wall-time claim across runners)
  await Promise.all(runners.map(async id => {
    for (const exercise of list) {
      if (done.has(`${id}:${exercise.id}`)) continue;
      const row = await runExercise(id, exercise, cfg, tools, options);
      rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + "\n", { mode: 0o600 }); onRow(row);
    }
  }));
  if (!keep) fs.rmSync(tools.workRoot, { recursive: true, force: true });
  const report = { version: POLYGLOT_VERSION, startedAt, finishedAt: new Date().toISOString(), exercises: list.map(e => e.id), runners, summary: summarize(rows), rows, rowsFile, machine: { platform: process.platform, arch: process.arch, node: process.version } };
  const file = rowsFile.replace(/\.jsonl$/, ".json"); fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); report.reportFile = file;
  return report;
}

export function formatPolyglot(report) {
  const lines = [`polyglot ${report.version} — ${report.exercises.length} exercises, pass@2 = solved within two attempts (second attempt sees the failing tests)`];
  lines.push("runner   model                      n   pass@1   pass@2   mean s   tokens in/out      cost");
  for (const s of report.summary) lines.push(`${s.runner.padEnd(8)} ${String(s.model || "").slice(0, 26).padEnd(26)} ${String(s.n).padStart(3)}   ${String(s.pass1Pct + "%").padStart(6)}   ${String(s.pass2Pct + "%").padStart(6)}   ${String(s.meanWallS).padStart(6)}   ${String(s.input).padStart(8)}/${String(s.output).padEnd(8)} ${s.costUsd ? "$" + s.costUsd.toFixed(2) : "n/a"}${s.timedOut ? `  (${s.timedOut} timed out)` : ""}${s.skipped ? `  (${s.skipped} skipped)` : ""}`);
  const failed = report.rows.filter(r => !r.skipped && !r.pass2);
  if (failed.length) { lines.push("", "failed (runner: exercise):"); for (const r of failed) lines.push(`  ${r.runner}: ${r.id}${r.attempts.some(a => a.timedOut) ? " (timed out)" : ""}`); }
  lines.push("", `report: ${report.reportFile}`);
  return lines.join("\n");
}
