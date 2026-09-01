import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARGUMENTS, customCommandsHelp, expandCustomCommand, findCustomCommand, formatCommandFile,
  loadCustomCommands, parseCommandFile, parseCommandNew, projectCommandDir, saveCustomCommand, userCommandDir,
} from "../src/custom-commands.js";
import { BUILTIN_NAMES, SLASH_COMMANDS, commandMatches, commandsHelp, setCustomCommands } from "../src/commands.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-cmd-"));

test("/command new writes a readable markdown file the owner can edit by hand", () => {
  const cwd = tmp();
  const saved = saveCustomCommand({ cwd, name: "ship", body: `Run the suite, then summarise ${ARGUMENTS} in three lines.`, description: "release check", builtins: BUILTIN_NAMES });
  assert.equal(saved.file, path.join(projectCommandDir(cwd), "ship.md"));
  assert.equal(saved.existed, false);
  assert.equal(fs.readFileSync(saved.file, "utf8"), "---\ndescription: release check\n---\n\nRun the suite, then summarise $ARGUMENTS in three lines.\n");
  assert.match(saved.message, /Saved \/ship .*ship\.md\. Type \/ship <arguments> to run it\./);
  assert.equal(saveCustomCommand({ cwd, name: "ship", body: "different", builtins: BUILTIN_NAMES }).existed, true);

  const loaded = loadCustomCommands(cwd, { home: tmp(), builtins: BUILTIN_NAMES });
  assert.equal(loaded.length, 1);
  assert.deepEqual([loaded[0].name, loaded[0].scope, loaded[0].body, loaded[0].shadowed], ["ship", "project", "different", false]);
});

test("a bad name, an empty prompt and an oversized one are refused with the fix in the message", () => {
  const cwd = tmp();
  assert.throws(() => saveCustomCommand({ cwd, name: "Ship It", body: "x" }), /is not a command name/);
  assert.throws(() => saveCustomCommand({ cwd, name: "9lives", body: "x" }), /is not a command name/);
  assert.throws(() => saveCustomCommand({ cwd, name: "../escape", body: "x" }), /is not a command name/);
  assert.throws(() => saveCustomCommand({ cwd, name: "ship", body: "   " }), /needs the prompt to store/);
  assert.throws(() => saveCustomCommand({ cwd, name: "ship", body: "x".repeat(8001) }), /at most 8000 characters/);
  assert.equal(fs.existsSync(projectCommandDir(cwd)), false);            // nothing was written on the way out
});

test("a built-in always wins, and the collision is reported at both ends", () => {
  const cwd = tmp();
  const saved = saveCustomCommand({ cwd, name: "cost", body: "my own cost report", builtins: BUILTIN_NAMES });
  assert.equal(saved.shadowed, true);
  assert.match(saved.message, /a built-in always wins, so this file will not run/);
  const commands = loadCustomCommands(cwd, { home: tmp(), builtins: BUILTIN_NAMES });
  assert.equal(commands[0].shadowed, true);
  assert.equal(findCustomCommand("/cost", commands), null);              // never dispatched
  assert.match(customCommandsHelp(commands, { cwd }), /\[shadowed by the built-in \/cost\]/);
  // …and it never reaches the slash popup either.
  setCustomCommands(commands);
  assert.deepEqual(commandMatches("/cost").filter(c => c.custom), []);
  setCustomCommands([]);
});

test("a project command wins over a user command of the same name, and says which it shadows", () => {
  const cwd = tmp(); const home = tmp();
  saveCustomCommand({ cwd, home, scope: "user", name: "review", body: "the personal one" });
  saveCustomCommand({ cwd, home, scope: "project", name: "audit", body: "project only" });
  saveCustomCommand({ cwd, home, scope: "project", name: "review", body: "the project one" });
  assert.equal(fs.existsSync(path.join(userCommandDir(home), "review.md")), true);
  const commands = loadCustomCommands(cwd, { home, builtins: BUILTIN_NAMES });
  assert.deepEqual(commands.map(c => [c.name, c.scope, c.body]), [["audit", "project", "project only"], ["review", "project", "the project one"]]);
  assert.match(commands[1].shadows, /review\.md$/);
  assert.match(customCommandsHelp(commands, { cwd }), /\[shadows .*review\.md\]/);
  assert.match(customCommandsHelp([], { cwd, home }), /No custom commands yet/);
});

test("running one is exactly having typed its body, with $ARGUMENTS the only substitution", () => {
  const withArgs = { name: "ship", body: `check ${ARGUMENTS} then release ${ARGUMENTS}` };
  assert.equal(expandCustomCommand(withArgs, " the parser "), "check the parser then release the parser");
  assert.equal(expandCustomCommand(withArgs, ""), "check  then release ");
  const without = { name: "audit", body: "read the diff" };
  assert.equal(expandCustomCommand(without, ""), "read the diff");
  assert.equal(expandCustomCommand(without, "src/a.js"), "read the diff\n\nsrc/a.js");   // args are appended, not dropped
});

test("the command file format is the one the owner already writes by hand", () => {
  assert.deepEqual(parseCommandFile("---\ndescription: does a thing\nmodel: ignored-but-kept\n---\n\nthe prompt\n"),
    { description: "does a thing", body: "the prompt" });
  assert.deepEqual(parseCommandFile("just a prompt\n"), { description: "", body: "just a prompt" });
  assert.equal(formatCommandFile({ body: "no description" }), "no description\n");
  // A file with frontmatter but no body is not a command, so it is not loaded at all.
  const cwd = tmp();
  fs.mkdirSync(projectCommandDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(projectCommandDir(cwd), "empty.md"), "---\ndescription: nothing\n---\n");
  fs.writeFileSync(path.join(projectCommandDir(cwd), "Bad Name.md"), "body");
  assert.deepEqual(loadCustomCommands(cwd, { home: tmp() }), []);
});

test("/command new parses its flags off the first line and keeps the rest of the paste as the prompt", () => {
  assert.deepEqual(parseCommandNew("ship run the suite"), { scope: "project", name: "ship", body: "run the suite" });
  assert.deepEqual(parseCommandNew("--user ship run it"), { scope: "user", name: "ship", body: "run it" });
  assert.deepEqual(parseCommandNew("ship line one\nline two\n\nline three"), { scope: "project", name: "ship", body: "line one\nline two\n\nline three" });
  assert.deepEqual(parseCommandNew("SHIP x"), { scope: "project", name: "ship", body: "x" });
  assert.deepEqual(parseCommandNew(""), { scope: "project", name: "", body: "" });
});

test("custom commands join the same catalog the popup and /help read, and leaving replaces them", () => {
  const before = SLASH_COMMANDS.length;
  setCustomCommands([{ name: "ship", body: "release it", scope: "project" }, { name: "help", body: "cannot win" }]);
  assert.equal(SLASH_COMMANDS.length, before + 1);                       // the built-in name was refused
  assert.deepEqual(commandMatches("/shi").map(c => c.name), ["ship"]);
  assert.match(commandsHelp(), /Yours\n {2}\/ship {9}release it/);
  setCustomCommands([{ name: "audit", body: "read the diff" }]);
  assert.equal(SLASH_COMMANDS.length, before + 1);                       // replaced, never accumulated
  assert.deepEqual(commandMatches("/shi").map(c => c.name), []);
  setCustomCommands([]);
  assert.equal(SLASH_COMMANDS.length, before);
});
