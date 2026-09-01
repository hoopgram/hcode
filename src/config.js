// Configuration: command line > environment (HCODE_* then ANTHROPIC_*) > ~/.hcode/config.json > defaults.
// On a Hoop the defaults already point at the local keyproxy, so `hcode` works with no setup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE_REVISION = process.env.HCODE_BUILD_REVISION || "";
export const VERSION = "0.10.3" + (/^[0-9a-f]{40}$/.test(SOURCE_REVISION) ? `+git.${SOURCE_REVISION.slice(0, 12)}` : "");
export const HOME = process.env.HCODE_HOME || path.join(os.homedir(), ".hcode");
// Tests exercise both sides of the locality contract even when the gate itself runs on a Hoop.
// This test-only switch can only remove the local default; it cannot grant access or credentials.
export const ON_HOOP = process.env.HCODE_TEST_OFF_HOOP === "1" ? false : fs.existsSync("/etc/hoopgram/product.json");

const DEFAULTS = {
  baseUrl: ON_HOOP ? "http://127.0.0.1:8092" : "https://api.anthropic.com",
  apiKey: ON_HOOP ? "gram-local" : "",
  model: ON_HOOP ? "deepseek-v4-pro" : "claude-sonnet-5",
  // Defaults may only contain models known to be capable of continuing an agentic task.
  // A tiny local brain remains owner-selectable, but is never a silent automatic fallback.
  // Vendor-diverse by design: the primary and the first fallback live on DIFFERENT providers
  // (deepseek pool → z.ai BYO), because a provider outage or a drained pool takes out every
  // model behind that provider's key at once (2026-08-28: pro and flash died together on 429).
  // The same-provider lighter model stays as the second fallback for pure rate-limit cases.
  fallbackModels: ON_HOOP ? ["glm-5.3", "deepseek-v4-flash"] : [],
  fallbackMinContextTokens: 16000,
  effort: "high",          // portable reasoning tier: low | medium | high
  mode: "all",            // read | ask | auto | all; full agency inside the fixed hard gates
  maxTokens: 8192,
  maxTurns: 40,
  missionStepBudget: 400,
  missionTokenBudget: 1000000,
  missionWallMs: 6 * 60 * 60 * 1000,
  bashTimeoutMs: 120000,
  tokenBudget: 120000,    // context budget (tokens) before automatic compaction
  contextRotTokens: 10000, // preventive compact+flush threshold; never wait for the max window
  timeoutMs: 15 * 60 * 1000, // one model call, total (a slow local brain may need minutes before the first byte)
  runner: "hcode",        // always the persisted coordinator; external values are one-shot compatibility only
  hoopUrl: ON_HOOP ? "http://127.0.0.1:8095" : "",
  hoopName: ON_HOOP ? os.hostname() : "",
};

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// USD per million tokens, one figure per billed class. hcode's gateways publish no price list, so a
// dollar figure can only ever be what the owner told it: with nothing set here the session meter and
// /cost both stay in relative cost units rather than inventing money. A malformed value is dropped
// whole — half a price list would be worse than none.
export const PRICE_CLASSES = ["input", "cacheWrite", "cacheRead", "output"];
export function readPrices(raw) {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prices = {};
  for (const key of PRICE_CLASSES) {
    const number = Number(value[key] ?? 0);
    if (!Number.isFinite(number) || number < 0) return null;
    prices[key] = number;
  }
  return PRICE_CLASSES.some(key => prices[key] > 0) ? Object.freeze(prices) : null;
}

export function loadConfig(cli = {}) {
  const file = readJson(path.join(HOME, "config.json"), {}) || {};
  const env = process.env;
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");
  const fallbackValue = cli.fallbackModels !== undefined ? cli.fallbackModels
    : env.HCODE_FALLBACK_MODELS !== undefined ? env.HCODE_FALLBACK_MODELS
    : file.fallbackModels !== undefined ? file.fallbackModels : DEFAULTS.fallbackModels;
  const fallbackModels = (Array.isArray(fallbackValue) ? fallbackValue : String(fallbackValue || "").split(","))
    .map(value => String(value).trim()).filter(Boolean);
  const cfg = {
    baseUrl: pick(cli.baseUrl, env.HCODE_BASE_URL, env.ANTHROPIC_BASE_URL, file.baseUrl, DEFAULTS.baseUrl),
    apiKey: pick(cli.apiKey, env.HCODE_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, file.apiKey, DEFAULTS.apiKey),
    model: pick(cli.model, env.HCODE_MODEL, env.ANTHROPIC_MODEL, file.model, DEFAULTS.model),
    fallbackModels,
    fallbackMinContextTokens: Number(pick(cli.fallbackMinContextTokens, env.HCODE_FALLBACK_MIN_CONTEXT_TOKENS, file.fallbackMinContextTokens, DEFAULTS.fallbackMinContextTokens)),
    effort: pick(cli.effort, env.HCODE_EFFORT, file.effort, DEFAULTS.effort),
    mode: pick(cli.mode, env.HCODE_MODE, file.mode, DEFAULTS.mode),
    maxTokens: Number(pick(cli.maxTokens, env.HCODE_MAX_TOKENS, file.maxTokens, DEFAULTS.maxTokens)),
    maxTurns: Number(pick(cli.maxTurns, env.HCODE_MAX_TURNS, file.maxTurns, DEFAULTS.maxTurns)),
    missionStepBudget: Number(pick(cli.missionStepBudget, env.HCODE_MISSION_STEP_BUDGET, file.missionStepBudget, DEFAULTS.missionStepBudget)),
    missionTokenBudget: Number(pick(cli.missionTokenBudget, env.HCODE_MISSION_TOKEN_BUDGET, file.missionTokenBudget, DEFAULTS.missionTokenBudget)),
    missionWallMs: Number(pick(cli.missionWallMs, env.HCODE_MISSION_WALL_MS, file.missionWallMs, DEFAULTS.missionWallMs)),
    bashTimeoutMs: Number(pick(file.bashTimeoutMs, DEFAULTS.bashTimeoutMs)),
    tokenBudget: Number(pick(cli.tokenBudget, env.HCODE_TOKEN_BUDGET, file.tokenBudget, DEFAULTS.tokenBudget)),
    contextRotTokens: Number(pick(cli.contextRotTokens, env.HCODE_CONTEXT_ROT_TOKENS, file.contextRotTokens, DEFAULTS.contextRotTokens)),
    timeoutMs: Number(pick(cli.timeoutMs, env.HCODE_TIMEOUT_MS, file.timeoutMs, DEFAULTS.timeoutMs)),
    // A stored 0.3.0 external runner is deliberately not restored: Codex/Claude are subagents now.
    // An explicit one-shot --runner/HCODE_RUNNER remains as a compatibility escape hatch.
    runner: pick(cli.runner, env.HCODE_RUNNER, DEFAULTS.runner),
    hoopUrl: pick(cli.hoopUrl, env.HCODE_HOOP_URL, file.hoopUrl, DEFAULTS.hoopUrl),
    hoopName: pick(cli.hoopName, env.HCODE_HOOP_NAME, file.hoopName, DEFAULTS.hoopName),
    defaultHoop: pick(cli.defaultHoop, env.HCODE_DEFAULT_HOOP, file.defaultHoop, ""),
    hoopBridge: Boolean(file.hoopBridge),   // remembered: this Hoop's sshd forbids -L, go straight to the stdio bridge
    agentId: pick(cli.agentId, env.HCODE_AGENT_ID, file.agentId, ""),
    taskId: pick(cli.taskId, env.HCODE_TASK_ID, file.taskId, ""),
    cwd: path.resolve(cli.cwd || process.cwd()),
    // Mind's Code shell reads this same append-only v2 stream by conversation id.
    // Explicit config still wins, so non-Hoop and owner-selected session stores stay unchanged.
    sessionsDir: pick(env.HCODE_SESSIONS, file.sessionsDir, ON_HOOP && fs.existsSync(path.join(os.homedir(), "mind")) ? path.join(os.homedir(), "mind", "hcode-sessions") : path.join(HOME, "sessions")),
    prices: readPrices(pick(env.HCODE_PRICES, file.prices)),
  };
  if (!["read", "ask", "auto", "all"].includes(cfg.mode)) throw new Error(`bad --mode ${cfg.mode} (read|ask|auto|all)`);
  if (!["hcode", "claude", "codex"].includes(cfg.runner)) throw new Error(`bad --runner ${cfg.runner} (hcode|claude|codex)`);
  if (!["low", "medium", "high"].includes(cfg.effort)) throw new Error(`bad --effort ${cfg.effort} (low|medium|high)`);
  if (!(Number.isInteger(cfg.maxTurns) && cfg.maxTurns >= 1 && cfg.maxTurns <= 100)) throw new Error("maxTurns must be an integer from 1 to 100");
  if (!(Number.isInteger(cfg.missionStepBudget) && cfg.missionStepBudget >= cfg.maxTurns)) throw new Error("missionStepBudget must be an integer ≥ maxTurns");
  if (!(Number.isInteger(cfg.missionTokenBudget) && cfg.missionTokenBudget >= cfg.maxTokens)) throw new Error("missionTokenBudget must be an integer ≥ maxTokens");
  if (!(Number.isInteger(cfg.missionWallMs) && cfg.missionWallMs >= 1000)) throw new Error("missionWallMs must be an integer ≥ 1000");
  if (!(cfg.tokenBudget >= 4000)) throw new Error("tokenBudget must be ≥ 4000");
  if (!(Number.isInteger(cfg.contextRotTokens) && cfg.contextRotTokens >= 4000 && cfg.contextRotTokens <= 100000)) throw new Error("contextRotTokens must be an integer from 4000 to 100000");
  if (!(cfg.timeoutMs >= 100)) throw new Error("HCODE_TIMEOUT_MS must be ≥ 100");
  if (cfg.fallbackModels.some(model => !/^[A-Za-z0-9._:/-]{1,120}$/.test(model))) throw new Error("fallbackModels contains an invalid model id");
  if (!(Number.isInteger(cfg.fallbackMinContextTokens) && cfg.fallbackMinContextTokens >= 4000)) throw new Error("fallbackMinContextTokens must be an integer ≥ 4000");
  cfg.fallbackModels = [...new Set(cfg.fallbackModels)].filter(model => model !== cfg.model).slice(0, 8);
  cfg.modeExplicit = Boolean(cli.mode || env.HCODE_MODE || file.mode);
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, "");
  cfg.hoopUrl = String(cfg.hoopUrl || "").replace(/\/+$/, "");
  return cfg;
}

// 0.1.0 project-level allow list: .hcode/settings.json { "allow": [...] } — still honoured; 0.2.0 reads
// .hcode/policy.json (policy.js) which supersedes it.
export function loadProjectSettings(cwd) {
  return readJson(path.join(cwd, ".hcode", "settings.json"), {}) || {};
}

// Was the key taken from the environment / CLI (so doctor can say where it came from without printing it)?
export function keySource(cli = {}) {
  const env = process.env;
  if (cli.apiKey) return "--api-key";
  for (const k of ["HCODE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) if (env[k]) return k;
  if ((readJson(path.join(HOME, "config.json"), {}) || {}).apiKey) return "~/.hcode/config.json";
  return ON_HOOP ? "Hoop keyproxy" : "";
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

// A local / offline brain (keyproxy → llama.cpp, Qwen, …) is slow and small: the kernel sends it a lean prompt.
export function isLocalBrain(cfg) {
  return cfg.provider === "local" || cfg.leanPrompt === true || /qwen|local|llama|gguf|phi|gemma|mistral-7b/i.test(String(cfg.model || ""));
}
