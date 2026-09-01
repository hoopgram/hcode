import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeProject, projectDiff, contextSummary } from "../src/project-commands.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-project-"));

test("/init creates HCODE.md once and never overwrites owner text", () => {
  const root = tmp(); const first = initializeProject(root);
  assert.equal(first.created, true); assert.match(fs.readFileSync(first.file, "utf8"), /Project.*Commands.*Boundaries/s);
  fs.writeFileSync(first.file, "owner text\n");
  const second = initializeProject(root); assert.equal(second.created, false);
  assert.equal(fs.readFileSync(first.file, "utf8"), "owner text\n");
});

test("/diff uses fixed Git arguments and includes staged and unstaged changes", async () => {
  const root = tmp(); const bin = tmp();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
case "$*" in
  "status --short") printf ' M src/a.js\\n' ;;
  *"--cached"*) printf '%s\\n' '+ staged' ;;
  *) printf '%s\\n' '- old' '+ new' ;;
esac
`, { mode: 0o755 });
  const result = await projectDiff(root, { env: { PATH: bin }, timeoutMs: 5000 });
  assert.match(result, /Status.*src\/a\.js/s); assert.match(result, /Unstaged.*- old.*\+ new/s); assert.match(result, /Staged.*\+ staged/s);
});

test("/context reports budget and compaction without exposing content", () => {
  const session = { messages: [{ role: "user", content: "private" }], events: [{ type: "turn.start" }], compaction: { droppedSeq: [1, 9] } };
  const result = contextSummary(session, {}, { estimatedTokens: 250, budget: 1000, instructionChars: 123 });
  assert.match(result, /250 tokens \/ 1000 budget \(25%\)/); assert.match(result, /through seq 9/); assert.doesNotMatch(result, /private/);
});
