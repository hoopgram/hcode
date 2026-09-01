// 0.8 B: the typed rule book (rules.js) and the one place it is enforced — policy.decide, which the
// tool loop calls before anything runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRules, matchRules, parseRule, parseRuleLine, cycleAction, saveRules, ruleMatches, commandToRegex } from "../src/rules.js";
import { loadPolicy, decide } from "../src/policy.js";
import { risksOf } from "../src/tools.js";
import { openPermissions, permissionsScreen, ruleRow } from "../src/permissions.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-rules-"));
const write = (dir, name, body) => {
  const file = path.join(dir, ".hcode", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
};
const writeHome = (home, body) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify(body, null, 2)); return home; };

// ---- schema ------------------------------------------------------------------------------------------
test("a rule is four declared fields, and a malformed one is dropped with a named problem", () => {
  const ok = parseRule({ tool: "bash", command: "git push*", action: "ask", why: "goes to a remote" }, { source: "project" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.rule.action, "ask"); assert.equal(ok.rule.tool, "bash"); assert.equal(ok.rule.command, "git push*");

  // a command pattern with no tool is a bash rule; nobody should have to write it twice
  assert.equal(parseRule({ command: "rm *", action: "deny" }, { source: "user" }).rule.tool, "bash");

  for (const [raw, pattern] of [
    [{ tool: "bash", action: "maybe" }, /action must be deny\|ask\|allow/],
    [{ tool: "bash" }, /action must be/],
    [{ tool: "bash", action: "deny", mode: "auto" }, /unknown field "mode"/],
    [{ tool: 3, action: "deny" }, /tool must be a non-empty string/],
    ["not an object", /must be an object/],
  ]) {
    const parsed = parseRule(raw, { source: "project", index: 0 });
    assert.ok(parsed.problems.some(problem => pattern.test(problem)), JSON.stringify(raw) + " → " + parsed.problems.join("; "));
  }
  // an unknown field is reported but does not silently disable the rule it was written beside
  const stray = parseRule({ tool: "bash", action: "deny", gates: false }, { source: "project" });
  assert.equal(stray.rule.action, "deny", "there is no setting that switches the built-in classes off");
});

// ---- merging -----------------------------------------------------------------------------------------
test("project and user rules merge into one book and deny outranks ask outranks allow", () => {
  const cwd = tmp(); const home = tmp();
  writeHome(home, { rules: [{ tool: "bash", command: "git push --force*", action: "deny", why: "never from a machine I share" }] });
  write(cwd, "settings.json", { rules: [
    { tool: "bash", command: "git push*", action: "allow" },
    { tool: "write_file", path: "src/**", action: "allow" },
    { tool: "write_file", path: "src/secrets/**", action: "ask" },
  ] });
  const book = loadRules(cwd, { home });
  assert.deepEqual(book.problems, []);
  assert.equal(book.rules.length, 4);
  assert.deepEqual(book.rules.map(rule => rule.source), ["user", "project", "project", "project"]);

  // the user's deny wins over the project's allow even though the project file was read last and its
  // pattern is not less specific: precedence is by consequence, never by file order.
  const forced = matchRules(book.rules, "bash", { command: "git push --force origin main" });
  assert.equal(forced.action, "deny"); assert.equal(forced.source, "user");
  assert.equal(matchRules(book.rules, "bash", { command: "git push origin main" }).action, "allow");
  // two project rules match src/secrets/k.js; ask beats allow
  assert.equal(matchRules(book.rules, "write_file", { path: "src/secrets/k.js" }).action, "ask");
  assert.equal(matchRules(book.rules, "write_file", { path: "src/app.js" }).action, "allow");
  assert.equal(matchRules(book.rules, "read_file", { path: "src/app.js" }), null);
});

test("a command rule matches the whole line and every segment, so a harmless prefix hides nothing", () => {
  const rule = { tool: "bash", command: "rm -rf *", action: "deny", source: "user" };
  assert.ok(ruleMatches(rule, "bash", { command: "rm -rf build" }));
  assert.ok(ruleMatches(rule, "bash", { command: "npm run build && rm -rf dist" }), "a segment counts");
  assert.ok(ruleMatches(rule, "bash", { command: "echo hi; rm -rf node_modules" }));
  assert.ok(!ruleMatches(rule, "bash", { command: "rm build/one.js" }));
  assert.ok(!ruleMatches(rule, "write_file", { path: "rm -rf x" }), "a bash pattern never matches another tool");
  // a command glob spans slashes; a path glob does not
  assert.ok(commandToRegex("rm *").test("rm /tmp/a/b"));
  assert.ok(ruleMatches({ tool: "*", action: "ask" }, "read_file", { path: "x" }), "no pattern means every call of that tool");
});

// ---- enforcement -------------------------------------------------------------------------------------
test("deny is not reachable from any mode, any allow list, or any earlier always", () => {
  const cwd = tmp(); const home = tmp();
  writeHome(home, { rules: [{ tool: "bash", command: "git push*", action: "deny", why: "this machine never pushes" }] });
  // every other lever an owner or the model could pull, all pointing the other way
  write(cwd, "policy.json", { mode: "auto", allow: ["bash:git *"], network: { default: "on" } });
  const policy = loadPolicy(cwd, { home });
  policy.allow.push("bash:git *");
  const input = { command: "git push origin main" };
  for (const mode of ["read", "ask", "auto", "all"]) {
    const verdict = decide({ policy, mode, name: "bash", input, risk: risksOf("bash", input, cwd), root: cwd });
    assert.equal(verdict.decision, "deny", mode);
    assert.match(verdict.why, /this machine never pushes/);
    assert.match(verdict.why, /holds in every mode/);
  }
});

test("an ask rule outranks auto, and a named allow rule carries past the network default", () => {
  const cwd = tmp(); const home = tmp();
  write(cwd, "settings.json", { rules: [
    { tool: "write_file", path: "migrations/**", action: "ask", why: "migrations get a second look" },
    { tool: "bash", command: "git push origin gh-pages*", action: "allow", why: "the docs site is meant to be public" },
  ] });
  const policy = loadPolicy(cwd, { home });
  const at = (mode, name, input) => decide({ policy, mode, name, input, risk: risksOf(name, input, cwd), root: cwd });

  assert.equal(at("auto", "write_file", { path: "migrations/001.sql", content: "x" }).decision, "ask");
  assert.match(at("auto", "write_file", { path: "migrations/001.sql", content: "x" }).why, /second look/);
  assert.equal(at("auto", "write_file", { path: "src/a.js", content: "x" }).decision, "allow");

  // the owner named this one push, so it goes past network-off; anything else stays behind a gate
  assert.equal(at("auto", "bash", { command: "git push origin gh-pages" }).decision, "allow");
  assert.notEqual(at("auto", "bash", { command: "git push origin main" }).decision, "allow");
});

// ---- the screen --------------------------------------------------------------------------------------
test("/permissions shows the rules in one screen and a number moves one a notch", async () => {
  const cwd = tmp(); const home = tmp();
  write(cwd, "settings.json", { allow: ["bash:git status"], rules: [{ tool: "bash", command: "git push*", action: "ask" }] });
  const book = loadRules(cwd, { home });
  const screen = permissionsScreen("ask", "bwrap", book.rules);
  assert.match(screen, /1\. Read only/); assert.match(screen, /4\. Full agency/);
  assert.match(screen, /5\. ask {3}bash/);
  assert.ok(screen.split("\n").length <= 20, "the whole thing has to fit on one screen");
  assert.ok(screen.split("\n").every(line => line.length <= 100), "and inside a terminal");

  assert.deepEqual(["deny", "ask", "allow", ""].map(cycleAction), ["ask", "allow", "", "deny"]);

  const said = [];
  const result = await openPermissions({ current: "ask", sandbox: "bwrap", book, ask: async () => "5", show: () => {}, info: text => said.push(text) });
  assert.equal(result.mode, "ask");
  assert.equal(book.rules[0].action, "allow", "ask → allow");
  assert.match(said.join("\n"), /→ allow/);
  // written straight back to the file it came from, with the neighbouring keys intact
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".hcode", "settings.json"), "utf8"));
  assert.deepEqual(saved.rules, [{ tool: "bash", command: "git push*", action: "allow" }]);
  assert.deepEqual(saved.allow, ["bash:git status"], "the 0.1.0 allow list is not eaten by a rule edit");

  // a fourth notch removes it rather than making the owner open a JSON file
  await openPermissions({ current: "ask", sandbox: "bwrap", book, ask: async () => "5", show: () => {}, info: () => {} });
  await openPermissions({ current: "ask", sandbox: "bwrap", book, ask: async () => "5", show: () => {}, info: () => {} });
  assert.deepEqual(book.rules, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, ".hcode", "settings.json"), "utf8")).rules, undefined);
});

test("+ adds a rule from the same screen, and a bad line says how to write it", async () => {
  const cwd = tmp(); const home = tmp();
  const book = loadRules(cwd, { home });
  await openPermissions({ current: "ask", sandbox: "none", book, ask: async () => '+ bash "rm -rf *" deny', show: () => {}, info: () => {} });
  assert.equal(ruleRow(book.rules[0]).trim().startsWith("deny  bash"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".hcode", "settings.json"), "utf8")).rules, [{ tool: "bash", command: "rm -rf *", action: "deny" }]);
  // and it is in force immediately, without a restart
  const policy = loadPolicy(cwd, { home });
  assert.equal(decide({ policy, mode: "all", name: "bash", input: { command: "rm -rf x" }, risk: ["write", "destructive"], root: cwd }).decision, "deny");

  const bad = await openPermissions({ current: "ask", sandbox: "none", book, ask: async () => "+ bash something", show: () => {}, info: () => {} });
  assert.match(bad.error, /deny, ask or allow/);
  assert.deepEqual(parseRuleLine("+ write_file src/** ask"), { tool: "write_file", path: "src/**", action: "ask" });
});

test("saveRules sends each rule home to the file it came from", () => {
  const cwd = tmp(); const home = tmp();
  writeHome(home, { rules: [{ tool: "bash", command: "sudo *", action: "deny" }] });
  write(cwd, "settings.json", { rules: [{ tool: "write_file", path: "dist/**", action: "deny" }] });
  const book = loadRules(cwd, { home });
  book.rules[0].action = "ask";
  saveRules(book);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).rules, [{ tool: "bash", command: "sudo *", action: "ask" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, ".hcode", "settings.json"), "utf8")).rules, [{ tool: "write_file", path: "dist/**", action: "deny" }]);
});
