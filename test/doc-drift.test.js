// Doc drift: the docs describe the file tree by hand, so nothing forces them to stay honest as
// files are added, renamed or removed. This test is that force. It never edits a doc; a red run
// means a human (or agent) must update ARCHITECTURE.md's File table, or the referencing doc, in
// the same commit as the code change — exactly the rule ARCHITECTURE.md §8 states.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderUiMap } from "../scripts/local-ui.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

// Strip fenced code blocks first: a shell example may legitimately reference a path outside this
// package (e.g. `nixos/apps/mind/test/runner.mjs`), and that is not a doc-drift claim about this
// package's own files. Only inline `code spans` are treated as file-existence claims.
const stripFences = text => text.replace(/```[\s\S]*?```/g, "");

const PATH_RE = /(?:bin|src|test|scripts)\/[\w.-]+\.(?:js|mjs)/g;

// Every inline `code span` path shaped like bin/x.js, src/x.js, test/x.js or scripts/x.mjs found
// in the given text (fenced blocks excluded, glob patterns like `src/*.js` excluded — `*` is not
// a valid path-segment character so PATH_RE never matches it).
function pathsIn(text) {
  const found = new Set();
  const spanRe = /`([^`\n]+)`/g;
  let span;
  while ((span = spanRe.exec(stripFences(text)))) {
    for (const match of span[1].matchAll(PATH_RE)) found.add(match[0]);
  }
  return found;
}

function realFiles(dir, ext) {
  return fs.readdirSync(path.join(root, dir))
    .filter(name => name.endsWith(ext))
    .map(name => `${dir}/${name}`);
}

test("ARCHITECTURE.md File table lists exactly the real src/*.js files, both directions", () => {
  const architecture = read("ARCHITECTURE.md");
  const marker = "## 8. File table";
  const start = architecture.indexOf(marker);
  assert.ok(start >= 0, "ARCHITECTURE.md must have a '## 8. File table' section");
  const tableSection = architecture.slice(start);

  const documented = [...pathsIn(tableSection)].filter(p => p.startsWith("src/")).sort();
  const real = realFiles("src", ".js").sort();

  const missingFromDocs = real.filter(f => !documented.includes(f));
  const extraInDocs = documented.filter(f => !real.includes(f));

  assert.deepEqual(missingFromDocs, [], `src/*.js present on disk but missing from the File table: ${missingFromDocs.join(", ")}`);
  assert.deepEqual(extraInDocs, [], `File table lists src/*.js that do not exist on disk: ${extraInDocs.join(", ")}`);
});

test("every bin/src/test/scripts path in backticks across the core docs exists on disk", () => {
  const files = ["START-HERE.md", "HCODE.md", "ARCHITECTURE.md", "DEVELOPING.md"];
  const missing = [];
  for (const doc of files) {
    for (const ref of pathsIn(read(doc))) {
      if (!fs.existsSync(path.join(root, ref))) missing.push(`${doc} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `referenced paths that do not exist:\n${missing.join("\n")}`);
});

test("UI-MAP.md is exactly what scripts/local-ui.mjs's renderUiMap() would generate now", () => {
  // renderUiMap() re-reads every anchor's current line number from the real src files, so this
  // fails the moment UI-MAP.md's committed line numbers drift from the code, before `npm run
  // local:ui` is ever run to refresh them.
  const expected = renderUiMap(root);
  const actual = read("UI-MAP.md");
  assert.equal(actual, expected, "UI-MAP.md is stale; run `npm run local:ui` (or `node scripts/local-ui.mjs`) to refresh it");
});
