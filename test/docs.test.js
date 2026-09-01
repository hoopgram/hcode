import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("the public development entrance is linked and ships with source/npm", () => {
  const developing = read("DEVELOPING.md");
  const readme = read("README.md");
  const architecture = read("ARCHITECTURE.md");
  const pkg = JSON.parse(read("package.json"));

  assert.match(developing, /HoopOS/);
  assert.match(developing, /ARCHITECTURE\.md/);
  assert.match(readme, /\[DEVELOPING\.md\]\(DEVELOPING\.md\)/);
  assert.match(architecture, /DEVELOPING\.md/);
  assert.ok(pkg.files.includes("DEVELOPING.md"));
});
