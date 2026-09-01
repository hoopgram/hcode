#!/usr/bin/env node
// Durable owner-decision watchdog shared by the standalone public tree and the Nix wrapper.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function take(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`, fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`decision-watch: bad state reset safely: ${error.message}`);
    return {};
  }
}

const session = take("--session", "hcode-007");
const stateFile = take("--state", `/var/lib/hcode/${session}-decision-watch.json`);
const tuiState = take("--tui-state", "/home/gram/.local/bin/tui-state.sh");
const notifier = take("--notifier", "/nix/store/7sp83wgpampj4c9iydszxsxjaz6k6bvm-health-notify.py");
const python = take("--python", "/run/current-system/sw/bin/python3");
const thresholdMs = Number(take("--threshold-ms", "120000"));
const now = Number(process.env.HCODE_DECISION_WATCH_NOW_MS || Date.now());
if (!Number.isFinite(thresholdMs) || thresholdMs < 1) throw new Error("threshold must be positive");

const observed = spawnSync(tuiState, [session], { encoding: "utf8", timeout: 10000 });
if (observed.status !== 0 || observed.error) {
  console.error(`decision-watch: UNOBSERVED: tui-state failed rc=${observed.status ?? "spawn"}`);
  process.exit(1);
}
const state = observed.stdout.trim();
if (!state || state === "unknown" || state === "gone") {
  console.error(`decision-watch: UNOBSERVED: tui-state returned ${state || "empty output"}`);
  process.exit(1);
}
const saved = load(stateFile);
if (state !== "decision") {
  atomic(stateFile, { schemaVersion: 1, session, state, observedAtMs: now, decisionSinceMs: null, notifiedAtMs: null });
  console.log(`${session}: ${state}`);
  process.exit(0);
}

const since = Number(saved.decisionSinceMs) || now;
const row = { schemaVersion: 1, session, state: "decision", observedAtMs: now, decisionSinceMs: since, notifiedAtMs: saved.notifiedAtMs || null };
if (now - since < thresholdMs || row.notifiedAtMs) {
  atomic(stateFile, row);
  console.log(`${session}: decision waiting ${now - since}ms`);
  process.exit(0);
}
const incident = `hcode-owner-decision-${session}`;
const title = `hcode ${session} is waiting for an owner decision`;
const body = `${session} has remained in owner-decision state for ${Math.floor((now - since) / 1000)} seconds. The work board is red; inspect the durable hcode decision event.`;
const sent = spawnSync(python, [notifier, "--send", incident, title, body], { encoding: "utf8", timeout: 40000 });
if (sent.status !== 0 || sent.error) {
  atomic(stateFile, row);
  console.error(`decision-watch: notification failed rc=${sent.status ?? "spawn"}`);
  process.exit(1);
}
row.notifiedAtMs = now;
atomic(stateFile, row);
console.log(`${session}: decision notification accepted`);
