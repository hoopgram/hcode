import fs from "node:fs";
import path from "node:path";
import { findBinary } from "./runners.js";
import { runFixedCommand } from "./fixed-command.js";

const STARTER = `# HCODE.md

## Project

Describe what this project does and what “done” means.

## Commands

- Test: add the canonical test command
- Check: add the canonical lint/typecheck command

## Boundaries

- Read before editing and keep changes minimal.
- Do not publish, deploy, delete data, or touch secrets without owner approval.
`;

export function initializeProject(root) {
  const file = path.join(root, "HCODE.md");
  try {
    const fd = fs.openSync(file, "wx", 0o644);
    try { fs.writeFileSync(fd, STARTER); } finally { fs.closeSync(fd); }
    return { created: true, file, message: "Created HCODE.md. Fill in the project purpose and canonical test/check commands." };
  } catch (error) {
    if (error.code === "EEXIST") return { created: false, file, message: "HCODE.md already exists; nothing was overwritten." };
    throw error;
  }
}

export async function projectDiff(root, { env = process.env, timeoutMs = 5000 } = {}) {
  const git = findBinary("git", env);
  if (!git) return "Git is not installed or not on PATH.";
  const [status, unstaged, staged] = await Promise.all([
    runFixedCommand(git, ["status", "--short"], { cwd: root, env, timeoutMs }),
    runFixedCommand(git, ["diff", "--no-ext-diff", "--"], { cwd: root, env, timeoutMs, maxBytes: 100_000 }),
    runFixedCommand(git, ["diff", "--no-ext-diff", "--cached", "--"], { cwd: root, env, timeoutMs, maxBytes: 100_000 }),
  ]);
  if (![status, unstaged, staged].every(result => result.ok)) {
    const failed = [status, unstaged, staged].find(result => !result.ok);
    return `Could not read Git changes: ${failed.reason || failed.output.trim() || `exit ${failed.code}`}`;
  }
  const sections = [];
  if (status.output.trim()) sections.push("Status\n" + status.output.trimEnd());
  if (unstaged.output.trim()) sections.push("Unstaged\n" + unstaged.output.trimEnd());
  if (staged.output.trim()) sections.push("Staged\n" + staged.output.trimEnd());
  return sections.join("\n\n") || "Working tree is clean.";
}

// /handoff moved to handoff.js in 0.8: a handoff is a structured, filed work contract, not a one-off
// report file, and it needs a reader (/continue) as much as a writer.

export function contextSummary(session, cfg, { estimatedTokens, budget, instructionChars = 0 } = {}) {
  const percent = budget ? Math.min(999, Math.round(estimatedTokens / budget * 100)) : 0;
  return `Context\n  estimated   ${estimatedTokens} tokens${budget ? ` / ${budget} budget (${percent}%)` : ""}\n  messages    ${session.messages.length}\n  events      ${session.events.length}\n  instructions ${instructionChars} characters\n  compacted   ${session.compaction ? `yes · through seq ${session.compaction.droppedSeq[1]}` : "not yet"}`;
}
