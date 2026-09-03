import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isUiFastPath, nextPatch, parseOptions, renderUiMap } from "../scripts/local-ui.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("local UI versions advance once and only accept the bounded lane", () => {
  assert.equal(nextPatch("0.10.4"), "0.10.5");
  assert.throws(() => nextPatch("0.10.4-local"), /x\.y\.z/);
  for (const file of ["src/ui.js", "src/composer.js", "UI-MAP.md", "test/ui.test.js"]) assert.equal(isUiFastPath(file), true);
  for (const file of ["src/policy.js", "src/tools.js", "../mind/code.mjs", ".hcode/config.json"]) assert.equal(isUiFastPath(file), false);
});

test("local UI options make geometry and owner-visible intent explicit", () => {
  assert.deepEqual(parseOptions(["--note", "lighter field", "--agent", "Codex", "--geometry"]), { note: "lighter field", agent: "Codex", geometry: true, resume: false });
  assert.throws(() => parseOptions([]), /requires --note/);
  assert.equal(parseOptions(["--resume"]).resume, true);
});

test("UI-MAP line pointers are generated from stable symbols and cannot drift silently", () => {
  const expected = renderUiMap(root);
  assert.equal(fs.readFileSync(path.join(root, "UI-MAP.md"), "utf8"), expected);
  assert.match(expected, /src\/ui\.js:\d+.*formatWelcomeDate/);
  assert.match(expected, /src\/composer\.js:\d+.*INPUT_FRAME/);
  assert.match(expected, /src\/composer\.js:\d+.*statusRows\(action\)/);
  assert.match(expected, /src\/ui\.js:\d+.*createUI/);
  assert.match(expected, /test\/render-property\.test\.js:\d+.*real PTYs keep the idle and busy footer/);
  assert.match(expected, /test\/render-property\.test\.js/);
});
