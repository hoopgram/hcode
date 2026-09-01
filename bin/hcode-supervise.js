#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { recordAttempt, publishCircuitStatus, resetCircuit } from "../src/retry-circuit.js";

const argv = process.argv.slice(2); const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const stateFile = value("--state"); const statusFile = value("--status"); const session = value("--session") || "hcode";
const threshold = Number(value("--threshold") || 3); const delayMs = Number(value("--delay-ms") || 5000);
const maxDelayMs = Number(value("--max-delay-ms") || 300000);
const resumeCommand = value("--resume-command") || `hcode-supervise --resume --state ${stateFile} --status ${statusFile}`;
if (!stateFile || !statusFile) { console.error("usage: hcode-supervise --state FILE --status FILE [--session NAME] [--threshold 3] [--resume] -- COMMAND ..."); process.exit(64); }
if (argv.includes("--resume")) { resetCircuit(stateFile, statusFile); console.error(`circuit reset; resume with: ${resumeCommand}`); process.exit(0); }
const split = argv.indexOf("--"); const command = split >= 0 ? argv.slice(split + 1) : [];
if (!command.length) { console.error("missing command after --"); process.exit(64); }

while (true) {
  const child = spawn(command[0], command.slice(1), { stdio: ["inherit", "pipe", "pipe"] }); let tail = "";
  const forward = (stream, target) => stream.on("data", chunk => { target.write(chunk); tail = (tail + chunk.toString("utf8")).slice(-65536); });
  forward(child.stdout, process.stdout); forward(child.stderr, process.stderr);
  const [rc, signal] = await once(child, "exit"); const code = Number.isInteger(rc) ? rc : 128;
  if (signal) tail += `\nsignal:${signal}`;
  const state = recordAttempt(stateFile, { rc: code, output: tail, threshold }); publishCircuitStatus(statusFile, state, { session, resumeCommand });
  if (state.state === "circuit-open") { console.error(`CIRCUIT OPEN: ${state.fingerprint} repeated ${state.consecutive}/${state.threshold}; work board red; session/objective preserved. Resume: ${resumeCommand}`); process.exit(75); }
  if (state.state === "unobserved") { console.error(`UNOBSERVED: failure class is unknown; automatic retry stopped; session/objective preserved. Resume after inspection: ${resumeCommand}`); process.exit(76); }
  const wait = code === 0 ? delayMs : Math.min(maxDelayMs, delayMs * (2 ** Math.min(20, state.consecutive - 1)));
  await new Promise(resolve => setTimeout(resolve, wait));
}
