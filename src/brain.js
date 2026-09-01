// Brain readiness and owner choice. hcode is always the coordinator; Codex and Claude are
// optional subagents, never alternate primary brains selected by first-run setup.
import fs from "node:fs";
import path from "node:path";
import { HOME, ON_HOOP, readJson } from "./config.js";
import { listRunners } from "./runners.js";

const LABELS = { hcode: "Hoop Code" };

export function brainState(cfg, runners = listRunners()) {
  const external = Object.fromEntries(runners.filter(r => r.id !== "hcode").map(r => [r.id, r]));
  return { id: "hcode", label: LABELS.hcode, ready: Boolean(cfg.apiKey), external };
}

export function needsBrainSetup(cfg, runners = listRunners()) {
  return !brainState(cfg, runners).ready;
}

export function brainChoices(cfg, runners = listRunners()) {
  const choices = [{
    id: "hoopgram", label: "HoopGram account", status: "browser sign-in",
    detail: "hoopgram.ai account approval; a Hoop desktop login is separate; provider keys remain on the server",
  }];
  choices.push({ id: "byok", label: "My API provider", status: cfg.apiKey ? "configured" : "setup needed",
    ...(cfg.apiKey ? { runner: "hcode", selectable: true } : {}), detail: cfg.apiKey ? "provider settings already exist on this machine" : "advanced: configure HCODE_API_KEY outside this prompt" });
  choices.push({ id: "connect", label: "My self-hosted Hoop", status: ON_HOOP ? "local" : "advanced",
    ...(ON_HOOP ? { runner: "hcode", selectable: true } : {}), detail: ON_HOOP ? "this machine already has its local Hoop brain" : "connects with your existing SSH identity" });
  return choices;
}

export function resolveBrainChoice(value, choices) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
  return choices.find(choice => choice.id === raw) || null;
}

function saveConfig(patch, home = HOME) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.json");
  const current = readJson(file, {}) || {};
  const next = { ...current, ...patch };
  const temp = path.join(home, `.config-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  return file;
}

export function forgetDefaultHoop(home = HOME) {
  return saveConfig({ defaultHoop: "" }, home);
}

export function saveRunner(runner, home = HOME) {
  if (runner !== "hcode") throw new Error("Codex and Claude are subagents; only hcode can be the saved coordinator");
  return saveConfig({ runner }, home);
}

// Remember only the public Hoop name so plain `hcode` can reopen its own SSH
// tunnel next time.  No API key, SSH key, token, host fingerprint or password is
// copied into hcode's config; ssh continues to own authentication.
// `bridge` remembers that this Hoop's sshd forbids port forwarding (the stdio bridge was
// needed), so the next reconnect skips the doomed -L handshake. It is a public fact about
// the server's hardening, not a credential.
export function saveDefaultHoop(name, home = HOME, { bridge = false } = {}) {
  if (!/^[a-z0-9]([a-z0-9-]{1,18}[a-z0-9])?$/.test(String(name || "")) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(name || ""))) throw new Error("invalid Hoop name");
  return saveConfig({ runner: "hcode", defaultHoop: String(name), hoopBridge: Boolean(bridge) }, home);
}
