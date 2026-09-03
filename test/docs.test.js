import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("the public development entrance is linked and ships with source/npm", () => {
  const start = read("START-HERE.md");
  const developing = read("DEVELOPING.md");
  const readme = read("README.md");
  const architecture = read("ARCHITECTURE.md");
  const pkg = JSON.parse(read("package.json"));

  assert.match(start, /DEVELOPING\.md/);
  assert.match(start, /ARCHITECTURE\.md/);
  assert.match(start, /exact base is reachable/);
  assert.match(start, /heartbeat and completion evidence/);
  assert.match(developing, /HoopOS/);
  assert.match(developing, /START-HERE\.md/);
  assert.match(developing, /ARCHITECTURE\.md/);
  assert.match(developing, /UI-MAP\.md/);
  assert.match(readme, /\[START-HERE\.md\]\(START-HERE\.md\)/);
  assert.match(readme, /\[DEVELOPING\.md\]\(DEVELOPING\.md\)/);
  assert.match(architecture, /DEVELOPING\.md/);
  assert.ok(pkg.files.includes("DEVELOPING.md"));
  assert.ok(pkg.files.includes("UI-MAP.md"));
  assert.ok(pkg.files.includes("scripts/local-ui.mjs"));
  for (const file of ["START-HERE.md", "AGENTS.md", "CLAUDE.md", "HCODE.md", "scripts/local-pull.mjs"]) assert.ok(pkg.files.includes(file));
  assert.equal(pkg.scripts["local:ui"], "node scripts/local-ui.mjs");
  assert.equal(pkg.scripts["local:pull"], "node scripts/local-pull.mjs");
});
