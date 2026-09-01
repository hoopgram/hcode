import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const guardModule = process.env.HCODE_GUARD_SRC
  ? pathToFileURL(path.join(process.env.HCODE_GUARD_SRC, "guard.js"))
  : new URL("../../src/guard.js", import.meta.url);
const { guardOnce, normalizeRegistry, parseVerdicts } = await import(guardModule);

const bad = {
  valid: '[{"session":"probe","verdict":"working","reason":"known clean control","action":"none","message":""}]',
  truncated: '[{"session":"probe"',
  empty: "",
  wrongType: '{"session":"probe"}',
}[process.argv[2]];
if (bad === undefined) throw new Error("scenario must be valid, truncated, empty, or wrongType");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-guard-invalid-"));
const registry = normalizeRegistry({ v: 1, sessions: [{ name: "probe", type: "codex", cwd: process.cwd(), expected: "working", resumeId: "probe-resume" }] });
const warnings = [];
try {
  const result = await guardOnce({ registry, home, tmux: "/run/current-system/sw/bin/false",
    decide: async () => parseVerdicts(bad, registry, { warn: message => { warnings.push(message); console.error(message); } }) });
  const expectedWarnings = process.argv[2] === "valid" ? 0 : 1;
  if (warnings.length !== expectedWarnings || result.decisions[0]?.action !== "none" || result.results.length !== 1) throw new Error("patrol evidence missing");
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log(`GUARD_INVALID_SURVIVED scenario=${process.argv[2]} warnings=${warnings.length} results=${result.results.length} window=1s`);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
