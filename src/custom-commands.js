// Custom commands (0.8 C): a prompt you type more than twice should be a command, and making it one
// should cost a single line.
//
// `/command new deploy <prompt>` writes `.hcode/commands/deploy.md` in the project (or
// `~/.hcode/commands/deploy.md` with --user), and `/deploy <args>` runs that prompt afterwards.
// Nothing executes and nothing is fetched: the file is markdown the owner can read, edit in an editor,
// diff and commit, and running one is exactly the same as having typed its body. `$ARGUMENTS` is the
// only substitution, so a command file can never reach anything the owner did not put in it.
//
// The same directory layout and frontmatter Claude Code uses, on purpose: the owner's existing command
// files can be copied in as they are.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";

export const COMMAND_DIR = path.join(".hcode", "commands");
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_COMMANDS = 40;
export const MAX_CHARS = 8000;
export const ARGUMENTS = "$ARGUMENTS";

export const projectCommandDir = cwd => path.join(cwd, COMMAND_DIR);
export const userCommandDir = (home = HOME) => path.join(home, "commands");

// `---\ndescription: …\n---` at the top, exactly like a skill or a Claude Code command file. Anything
// that is not a recognised key is left in the body rather than dropped, so nothing is ever lost.
export function parseCommandFile(text) {
  const raw = String(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { description: "", body: raw.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { description: String(meta.description || "").slice(0, 120), body: raw.slice(match[0].length).trim() };
}

export function formatCommandFile({ description = "", body = "" }) {
  const head = description ? `---\ndescription: ${description.replace(/\n/g, " ").slice(0, 120)}\n---\n\n` : "";
  return head + String(body).trim() + "\n";
}

function readDir(dir, scope) {
  let names; try { names = fs.readdirSync(dir).filter(f => f.endsWith(".md")).sort(); } catch { return []; }
  const rows = [];
  for (const file of names.slice(0, MAX_COMMANDS)) {
    const name = file.replace(/\.md$/, "");
    if (!NAME_RE.test(name)) continue;
    let text; try { text = fs.readFileSync(path.join(dir, file), "utf8"); } catch { continue; }
    const truncated = text.length > MAX_CHARS;
    const parsed = parseCommandFile(truncated ? text.slice(0, MAX_CHARS) : text);
    if (!parsed.body) continue;
    rows.push({ name, scope, file: path.join(dir, file), truncated, ...parsed });
  }
  return rows;
}

// Project before user: a repository's own command wins over a personal one of the same name, the same
// way .hcode/policy.json wins over ~/.hcode/config.json.
export function loadCustomCommands(cwd, { home = HOME, builtins = [] } = {}) {
  const seen = new Map();
  for (const row of [...readDir(projectCommandDir(cwd), "project"), ...readDir(userCommandDir(home), "user")]) {
    if (!seen.has(row.name)) seen.set(row.name, row);
    else seen.get(row.name).shadows = row.file;                 // recorded so /command list can say so
  }
  const reserved = new Set(builtins);
  for (const row of seen.values()) row.shadowed = reserved.has(row.name);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// A built-in always wins, so a file that collides is loaded, listed and reported — never dispatched.
export function findCustomCommand(line, commands) {
  const name = String(line || "").replace(/^\//, "").trim().split(/\s+/, 1)[0].toLowerCase();
  const found = commands.find(command => command.name === name);
  return found && !found.shadowed ? found : null;
}

export function expandCustomCommand(command, args = "") {
  const text = String(args || "").trim();
  return command.body.includes(ARGUMENTS)
    ? command.body.split(ARGUMENTS).join(text)
    : (text ? `${command.body}\n\n${text}` : command.body);
}

// `/command new [--user] <name> <prompt…>` — the prompt may run over many lines (one pasted block is
// one message), so only the first line is parsed for flags and everything after the name is the body.
export function parseCommandNew(text) {
  const raw = String(text || "");
  const newline = raw.indexOf("\n");
  const head = newline === -1 ? raw : raw.slice(0, newline);
  const words = head.trim().split(/\s+/).filter(Boolean);
  const out = { scope: "project", name: "", body: "" };
  let i = 0;
  for (; i < words.length; i++) {
    if (words[i] === "--user" || words[i] === "-u") out.scope = "user";
    else if (words[i] === "--project" || words[i] === "-p") out.scope = "project";
    else break;
  }
  out.name = String(words[i] || "").toLowerCase();
  const rest = words.slice(i + 1).join(" ");
  out.body = (rest + (newline === -1 ? "" : "\n" + raw.slice(newline + 1))).trim();
  return out;
}

export function saveCustomCommand({ cwd, home = HOME, scope = "project", name, body, description = "", builtins = [] }) {
  if (!NAME_RE.test(String(name || ""))) throw new Error(`"${String(name).slice(0, 40)}" is not a command name (a lowercase letter, then letters, digits or dashes, up to 32 characters)`);
  const text = String(body || "").trim();
  if (!text) throw new Error(`/command new ${name} needs the prompt to store; ${ARGUMENTS} in it is replaced by whatever follows /${name}`);
  if (text.length > MAX_CHARS) throw new Error(`a command is at most ${MAX_CHARS} characters (this one is ${text.length}); put the long form in a skill instead`);
  const dir = scope === "user" ? userCommandDir(home) : projectCommandDir(cwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.md`);
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, formatCommandFile({ description, body: text }), { mode: 0o600 });
  const shadowed = builtins.includes(name);
  return { file, name, scope, existed, shadowed,
    message: `${existed ? "Updated" : "Saved"} /${name} → ${file}${shadowed ? ` — but /${name} is a built-in command and a built-in always wins, so this file will not run. Rename it to use it.` : `. Type /${name}${text.includes(ARGUMENTS) ? " <arguments>" : ""} to run it.`}` };
}

export function customCommandsHelp(commands, { cwd = "", home = HOME } = {}) {
  if (!commands.length) return `No custom commands yet. /command new <name> <prompt> writes one to ${projectCommandDir(cwd || ".")}; --user writes it to ${userCommandDir(home)} for every project.`;
  const rows = commands.map(command => `  /${command.name.padEnd(14)} ${command.scope.padEnd(8)} ${command.body.includes(ARGUMENTS) ? "takes args " : "           "}${(command.description || command.body.replace(/\s+/g, " ")).slice(0, 60)}`
    + (command.shadowed ? "  [shadowed by the built-in /" + command.name + "]" : "")
    + (command.shadows ? "  [shadows " + command.shadows + "]" : ""));
  return ["Your commands (project files win over user files; a built-in wins over both)", ...rows,
    "", `/command new [--user] <name> <prompt> writes one · /command show <name> prints one · ${ARGUMENTS} is replaced by what follows the command`].join("\n");
}
