// Typed policy rules: the owner's rule book, written down instead of asked for.
//
// A rule is a declarative row — what it matches (tool name, bash command pattern, path pattern) and what
// hcode does about it (deny / ask / allow). Rules live in `.hcode/settings.json` at two levels:
//
//   ~/.hcode/settings.json   {"rules":[{"tool":"bash","command":"git push --force*","action":"deny"}]}
//   <project>/.hcode/settings.json
//
// The two files are merged into one list. Precedence is by consequence, not by file order and not by how
// specific a pattern looks: **deny beats ask beats allow**, always. That is the whole conflict resolution,
// and it is the only thing an owner has to remember. A user-level deny cannot be undone by a project-level
// allow — a repository cannot talk its way past a decision its owner made once for every repository.
//
// These rules are enforced by the broker (policy.js `decide`, called at the single tool throat point in
// agent.js) — not by a sentence in the system prompt. A rule the model could talk its way out of is a
// reminder; this one it cannot reach, because `.hcode/` is on the secret-path blacklist and the decision
// happens after the model has already said what it wants to run.
//
// This module also owns the small matching vocabulary the rule book is written in (glob, command glob,
// command segmentation); policy.js re-exports `globToRegex` so its long-standing importers are unchanged.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";

export const ACTIONS = ["deny", "ask", "allow"];
export const RULE_FIELDS = new Set(["tool", "command", "path", "action", "why"]);
// deny first: the ranking *is* the merge, so two files never need an ordering rule between them.
const RANK = { deny: 0, ask: 1, allow: 2 };
export const SETTINGS_FILE = "settings.json";

// ---- the matching vocabulary ------------------------------------------------------------------------
// Path-shaped glob: `*` stops at a directory separator, `**/` spans directories. (Moved here from
// policy.js so the rule engine has no import cycle with the broker that consumes it.)
export function globToRegex(pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }     // "**/" = zero or more directories
      else { re += ".*"; i += 1; }                                   // trailing "**" = anything
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === ".") re += "\\.";
    else if ("+^$(){}|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

// Command-shaped glob: a command line is not a path, so `*` here spans everything, slashes included.
// `git push*` and `git push *` both match `git push origin main`.
export function commandToRegex(pattern) {
  let re = "^";
  for (const c of String(pattern)) {
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (".+^$(){}|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

// Split on ; && || | and newlines, outside quotes. Shared with the broker's risk classifier and the
// consequence gates: a rule that matches `rm -rf build` must also catch `mkdir x && rm -rf build`.
export function commandSegments(command) {
  // A backslash-newline is removed by the shell before parsing. Preserve that exact semantic so a
  // continued argv/path line can never be mistaken for a fresh executable action.
  command = String(command).replace(/\\\r?\n/g, " ");
  const out = []; let cur = ""; let q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) { cur += c; if (c === q && command[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "\n" || c === ";" || c === "|" || (c === "&" && command[i + 1] === "&")) { if (cur.trim()) out.push(cur.trim()); cur = ""; if (c === "&") i++; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- reading the rule book --------------------------------------------------------------------------
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

// One row, checked field by field. A malformed rule is dropped with a named problem rather than silently
// reinterpreted: a rule the owner cannot see the effect of is worse than no rule.
export function parseRule(raw, { source = "", file = "", index = 0 } = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: [`${source} rule ${index + 1} must be an object`] };
  for (const key of Object.keys(raw)) if (!RULE_FIELDS.has(key)) problems.push(`${source} rule ${index + 1}: unknown field "${key}" (tool, command, path, action, why)`);
  const action = String(raw.action || "").trim().toLowerCase();
  if (!ACTIONS.includes(action)) return { problems: [...problems, `${source} rule ${index + 1}: action must be deny|ask|allow (got ${JSON.stringify(raw.action)})`] };
  const rule = { action, source, file, tool: "*" };
  for (const key of ["tool", "command", "path"]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !raw[key]) { problems.push(`${source} rule ${index + 1}: ${key} must be a non-empty string`); continue; }
    rule[key] = raw[key];
  }
  if (raw.why !== undefined) {
    if (typeof raw.why !== "string") problems.push(`${source} rule ${index + 1}: why must be a string`);
    else rule.why = raw.why.slice(0, 200);
  }
  if (rule.command !== undefined && rule.tool === "*") rule.tool = "bash";   // a command pattern is a bash rule
  return { rule, problems };
}

function rulesFrom(file, source) {
  const raw = readJson(file);
  const list = Array.isArray(raw?.rules) ? raw.rules : [];
  const rules = []; const problems = [];
  for (const [index, entry] of list.entries()) {
    const parsed = parseRule(entry, { source, file, index });
    problems.push(...parsed.problems);
    if (parsed.rule) rules.push({ ...parsed.rule, id: `${source}:${index}` });
  }
  return { rules, problems };
}

// The merged rule book. `home` is injectable so a test never touches the real ~/.hcode.
export function loadRules(cwd, { home = HOME } = {}) {
  const userFile = path.join(home, SETTINGS_FILE);
  const projectFile = path.join(cwd, ".hcode", SETTINGS_FILE);
  const user = rulesFrom(userFile, "user");
  const project = rulesFrom(projectFile, "project");
  return { rules: [...user.rules, ...project.rules], problems: [...user.problems, ...project.problems], userFile, projectFile };
}

// ---- matching -----------------------------------------------------------------------------------------
export function ruleMatches(rule, name, input = {}) {
  if (!globToRegex(String(rule.tool || "*")).test(String(name))) return false;
  if (rule.command !== undefined) {
    if (name !== "bash") return false;
    const command = String(input.command ?? "");
    if (!command) return false;
    const pattern = rule.command;
    const hit = subject => commandToRegex(pattern).test(subject)
      || (pattern.endsWith(" *") && subject.startsWith(pattern.slice(0, -2) + " "))
      || (pattern.endsWith("*") && subject === pattern.slice(0, -1).trimEnd());
    // whole line first, then every segment: `a && rm -rf b` cannot hide a rule behind a harmless prefix
    if (!hit(command.trim()) && !commandSegments(command).some(hit)) return false;
  }
  if (rule.path !== undefined) {
    const subject = String(input.path ?? "");
    if (!subject || !globToRegex(rule.path).test(subject)) return false;
  }
  return true;
}

// The one decision a rule book makes about one call: the strongest matching action wins, and within an
// action the first rule listed wins so the owner can read the reason off the top of the file.
export function matchRules(rules, name, input = {}) {
  let best = null;
  for (const rule of rules || []) {
    if (!ruleMatches(rule, name, input)) continue;
    if (!best || RANK[rule.action] < RANK[best.action]) best = rule;
    if (best.action === "deny") break;
  }
  return best;
}

export function ruleReason(rule) {
  if (!rule) return "";
  const subject = rule.command !== undefined ? `bash ${rule.command}` : rule.path !== undefined ? `${rule.tool} ${rule.path}` : rule.tool;
  return rule.why || `a ${rule.source} rule ${rule.action === "allow" ? "allows" : rule.action === "ask" ? "asks about" : "denies"} ${subject}`;
}

// ---- writing it back ------------------------------------------------------------------------------------
// /permissions edits rules in place. Only the `rules` key of each file is rewritten; whatever else the
// owner keeps in settings.json (the 0.1.0 `allow` list, subagentModels, …) is carried through untouched.
const strip = rule => {
  const out = { tool: rule.tool };
  if (rule.command !== undefined) out.command = rule.command;
  if (rule.path !== undefined) out.path = rule.path;
  out.action = rule.action;
  if (rule.why) out.why = rule.why;
  return out;
};

export function writeRules(file, rules) {
  const existing = readJson(file);
  const body = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const list = rules.map(strip);
  if (list.length) body.rules = list; else delete body.rules;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

// Persist a rule book after an edit: each rule goes home to the file it came from.
export function saveRules(book) {
  const written = [];
  for (const [file, source] of [[book.userFile, "user"], [book.projectFile, "project"]]) {
    const mine = book.rules.filter(rule => rule.source === source);
    const had = fs.existsSync(file);
    if (!mine.length && !had) continue;
    writeRules(file, mine);
    written.push(file);
  }
  return written;
}

// deny → ask → allow → gone → deny. One key press moves a rule one notch; a fourth removes it, so the
// owner never has to open a JSON file to take a rule back.
export function cycleAction(action) {
  const next = { deny: "ask", ask: "allow", allow: "", "": "deny" };
  return next[action] ?? "deny";
}

export function ruleSubject(rule) {
  if (rule.command !== undefined) return rule.command;
  if (rule.path !== undefined) return rule.path;
  return "(any input)";
}

// `+ bash "git push*" ask` — the one-line grammar for adding a rule without leaving the screen.
export function parseRuleLine(text) {
  const words = String(text || "").trim().replace(/^\+\s*/, "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = words.map(word => word.replace(/^["']|["']$/g, ""));
  if (clean.length < 2) throw new Error('a rule reads: + <tool> <pattern> <deny|ask|allow>, e.g. + bash "git push*" ask');
  const action = String(clean[clean.length - 1]).toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`the last word must be deny, ask or allow (got "${clean[clean.length - 1]}")`);
  const tool = clean[0];
  const pattern = clean.slice(1, -1).join(" ");
  const rule = { tool, action };
  if (pattern) { if (tool === "bash") rule.command = pattern; else rule.path = pattern; }
  return rule;
}
