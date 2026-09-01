// MCP/connector discovery goes through the owner-installed official CLIs. hcode
// never opens their config files or authentication stores and never receives a
// connector token. Only a fixed, read-only `mcp list` command is supported.
import { findBinary, externalRunnerEnv } from "./runners.js";
import { escapeControls } from "./ui.js";
import { runFixedCommand } from "./fixed-command.js";

const PROVIDERS = [
  { id: "codex", label: "Codex", args: ["mcp", "list"] },
  { id: "claude", label: "Claude Code", args: ["mcp", "list"] },
];

export function redactConnectorOutput(value) {
  let text = String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  text = text.replace(/((?:api[_-]?key|token|secret|password|authorization|bearer|[A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD))\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]");
  text = text.replace(/\b([A-Z][A-Z0-9_]{2,}\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/g, "$1[redacted]");
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_.-]+)\b/g, "[redacted]");
  return escapeControls(text).trim();
}

export async function listMcpConnectors({ env = process.env, cwd = process.cwd(), timeoutMs = 15_000 } = {}) {
  const clean = externalRunnerEnv(env);
  return Promise.all(PROVIDERS.map(async provider => {
    const binary = findBinary(provider.id, env);
    if (!binary) return { ...provider, available: false, ok: false, reason: "not installed", output: "" };
    const result = await runFixedCommand(binary, provider.args, { cwd, env: clean, timeoutMs, maxBytes: 32_000 });
    const output = redactConnectorOutput(result.output);
    return { ...provider, available: true, ok: result.ok, partial: !result.ok && Boolean(output), reason: result.reason || (result.code === 0 ? "" : `exited ${result.code}`), output };
  }));
}

export function connectorsTable(rows) {
  return rows.map(row => {
    const state = !row.available ? "[not installed]" : row.ok ? "[ready]" : row.partial ? `[partial · ${row.reason || "failed"}]` : `[${row.reason || "failed"}]`;
    return `${row.label} ${state}${row.output ? `\n${row.output.split("\n").map(line => "  " + line).join("\n")}` : ""}`;
  }).join("\n\n") + "\n\nManage connectors with the owner CLI (`codex mcp …` or `claude mcp …`). hcode reads no connector config or token.";
}
