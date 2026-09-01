import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listMcpConnectors, connectorsTable, redactConnectorOutput } from "../src/connectors.js";
import { runFixedCommand } from "../src/fixed-command.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-mcp-"));

test("MCP discovery uses fixed owner CLIs, strips broker env and redacts output", async () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
printf '\\033[31mcodex-local\\033[0m OPENAI_API_KEY=super-secret HCODE=%s\\n' "\${HCODE_API_KEY:-clean}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
printf 'No MCP servers configured\\n'
`, { mode: 0o755 });
  const rows = await listMcpConnectors({ env: { PATH: bin, HCODE_API_KEY: "must-not-leak" }, cwd: bin, timeoutMs: 5000 });
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.available && row.ok));
  const table = connectorsTable(rows);
  assert.match(table, /Codex \[ready\].*codex-local/s); assert.match(table, /Claude Code \[ready\]/);
  assert.match(table, /OPENAI_API_KEY=\[redacted\]/); assert.match(table, /HCODE=\[redacted\]/);
  assert.doesNotMatch(table, /super-secret|must-not-leak|HCODE=clean|\x1b/);
  assert.match(table, /reads no connector config or token/);
});

test("MCP output redaction covers token shapes, environment values, URLs and control bytes", () => {
  const visible = redactConnectorOutput("token: abcdef123456\nvalue sk-testtoken123456\nDATABASE_URL=postgres://owner:pass@db\nhttps://user:pass@example.test\nunsafe\u0007");
  assert.doesNotMatch(visible, /abcdef123456|sk-testtoken123456|postgres:\/\/owner:pass@db|user:pass/);
  assert.match(visible, /token: \[redacted\]/); assert.match(visible, /\\x07/);
});

test("fixed commands report a missing executable without throwing", async () => {
  const result = await runFixedCommand("/definitely/missing/hcode-command", [], { timeoutMs: 50 });
  assert.equal(result.ok, false); assert.match(result.reason, /ENOENT|no such file/i);
});

test("fixed connector commands stop on a deadline", async () => {
  const dir = tmp(); const slow = path.join(dir, "slow");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const started = Date.now(); const result = await runFixedCommand(slow, [], { cwd: dir, timeoutMs: 50 });
  assert.equal(result.ok, false); assert.match(result.reason, /timed out/); assert.ok(Date.now() - started < 1500);
});
