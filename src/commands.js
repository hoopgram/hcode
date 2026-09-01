// One discoverable command catalog for the slash popup and /help. Commands may
// still have rich handlers in cli.js, but names and owner-facing descriptions
// live here once so the menu and help cannot drift apart.
import { displayWidth } from "./frame.js";

export const SLASH_COMMANDS = [
  { name: "help", description: "Show commands and keyboard help", group: "Start" },
  { name: "config", description: "Open model, permission and display settings", group: "Start" },
  { name: "status", description: "Show workspace, brain, permission and session", group: "Start" },
  { name: "quota", description: "Spend pool + provider quota buckets (UNOBSERVED shown honestly)", group: "Start" },
  { name: "init", description: "Create a starter HCODE.md without overwriting", group: "Start" },
  { name: "update", description: "Fast-forward hcode's own source checkout, in the background", group: "Start" },
  { name: "model", description: "View or choose the model for this session", group: "Session", takesArgs: true },
  { name: "effort", description: "Choose low, medium or high reasoning effort", group: "Session", takesArgs: true },
  { name: "permissions", description: "Choose the permission, and read or edit the rules", group: "Session" },
  { name: "permission", description: "Show or set session agency level 0-9", group: "Session", takesArgs: true },
  { name: "mode", description: "Choose a permission for this session", group: "Session", takesArgs: true },
  { name: "savetoken", description: "Delegate by default and keep answers short", group: "Session" },
  { name: "usedefault", description: "Cancel token-saving mode for this session", group: "Session" },
  { name: "policy", description: "Inspect project policy and sandbox state", group: "Session" },
  { name: "context", description: "Show context usage and compaction budget", group: "Session" },
  { name: "compact", description: "Keep important context and free older detail", group: "Session" },
  { name: "handoff", description: "File a structured handoff ledger with a restart line", group: "Session", takesArgs: true },
  { name: "continue", description: "Resume the newest handoff ledger and its mode", group: "Session", takesArgs: true },
  { name: "handoffs", description: "List the handoff ledgers still active", group: "Session" },
  { name: "clear", description: "Start fresh; keep the old session resumable", group: "Session" },
  { name: "rewind", description: "Go back to an earlier point and put the files back (esc esc)", group: "Session" },
  { name: "resume", description: "Resume a saved conversation", group: "Session", takesArgs: true },
  { name: "sessions", description: "List recent conversations", group: "Session" },
  { name: "review", description: "Review current changes without editing", group: "Work" },
  { name: "diff", description: "Show staged and unstaged Git changes", group: "Work" },
  { name: "plan", description: "Propose or approve one bounded coordinated plan", group: "Work", takesArgs: true },
  { name: "work", description: "Show objective, lanes, budget, evidence and stop reason", group: "Work" },
  { name: "gate", description: "List or decide a durable owner gate", group: "Work", takesArgs: true },
  { name: "guard", description: "Patrol registered agents and owner doors", group: "Work", takesArgs: true },
  { name: "agents", description: "Show installed Codex and Claude subagents", group: "Work" },
  { name: "tasks", description: "Show background subagent conversations", group: "Work" },
  { name: "claude", description: "Start a Claude Code background task", group: "Work", takesArgs: true },
  { name: "codex", description: "Start a Codex background task", group: "Work", takesArgs: true },
  { name: "btw", description: "Ask a subagent aside; the answer stays out of this context", group: "Work", takesArgs: true },
  { name: "attach", description: "List subagents, or open one's transcript", group: "Work", takesArgs: true },
  { name: "mcp", description: "List Codex and Claude MCP connectors", group: "Connect" },
  { name: "connectors", description: "Alias for /mcp", group: "Connect" },
  { name: "brain", description: "Choose how the hcode coordinator connects", group: "Connect" },
  { name: "login", description: "Connect a HoopGram account", group: "Connect", takesArgs: true },
  { name: "logout", description: "Revoke this machine's HoopGram session", group: "Connect" },
  { name: "account", description: "Show entitlement, expiry and connection source", group: "Connect" },
  { name: "doctor", description: "Diagnose brain, sandbox, policy and agents", group: "Inspect" },
  { name: "usage", description: "Show token use for the latest turn", group: "Inspect" },
  { name: "cost", description: "Token use across saved sessions, biggest first", group: "Inspect", takesArgs: true },
  { name: "verbose", description: "Show or hide detailed tool activity", group: "Inspect", takesArgs: true },
  { name: "tune", description: "Propose settings your own history argues for (never applies them)", group: "Inspect", takesArgs: true },
  { name: "command", description: "Save a prompt as your own slash command, or list them", group: "Inspect", takesArgs: true },
  { name: "exit", description: "Leave Hoop Code", group: "Leave", aliases: ["quit", "q"] },
];

export const BUILTIN_NAMES = SLASH_COMMANDS.flatMap(command => [command.name, ...(command.aliases || [])]);

// The owner's own commands join the same catalog the popup and /help read. They are spliced into this
// very array rather than a copy of it, because a composer captured this array when it was constructed
// and a command saved mid-session has to appear in the list without a restart.
export function setCustomCommands(commands = []) {
  for (let i = SLASH_COMMANDS.length - 1; i >= 0; i--) if (SLASH_COMMANDS[i].custom) SLASH_COMMANDS.splice(i, 1);
  const reserved = new Set(BUILTIN_NAMES);
  for (const command of commands) {
    if (!command?.name || reserved.has(command.name)) continue;       // a built-in always wins
    SLASH_COMMANDS.push({ name: command.name, description: command.description || String(command.body || "").replace(/\s+/g, " ").slice(0, 60),
      group: "Yours", takesArgs: true, custom: true, scope: command.scope });
  }
  return SLASH_COMMANDS.filter(command => command.custom);
}

// The one key table. `?` renders it into the composer's panel, /help prints the same rows and the
// README table is copied from it — there is no second list to drift. Keys hcode deliberately does
// not bind are named in the README with the reason: a key that does nothing is worse than a key
// that is not offered.
export const KEY_HELP = Object.freeze([
  ["Send", [
    ["Enter", "send the message"],
    ["Shift-Enter", "newline without sending"],
    ["Ctrl-J / \\ Enter", "newline fallback when a terminal cannot distinguish Shift-Enter"],
    ["Tab", "complete the slash command the list has selected"],
    ["↑ / ↓", "step through the slash list, or through what you sent before"],
    ["Ctrl-R", "search backwards through what you sent before"],
    ["Ctrl-G", "write the message in $EDITOR and come back with it"],
    ["Ctrl-V", "paste an image from the clipboard"],
  ]],
  ["Edit the line", [
    ["← / →", "move one character"],
    ["Ctrl-A / Ctrl-E", "go to the start / end of the line"],
    ["Alt-B / Alt-F", "move back / forward one word"],
    ["Alt-D", "delete the word after the cursor"],
    ["Ctrl-W / Alt-⌫", "delete the word before the cursor"],
    ["Ctrl-U / Ctrl-K", "delete to the start / end of the line"],
  ]],
  ["The page", [
    ["?", "this key table, when the input line is empty"],
    ["Ctrl-O", "read the transcript back: ↑↓ and PgUp/PgDn page, / searches, Esc leaves"],
    ["Ctrl-F", "open a subagent's conversation: same panel, and it follows while the helper works"],
    ["Ctrl-L", "repaint the screen from the transcript"],
    ["Ctrl-T", "background tasks and coordinated work (/tasks)"],
  ]],
  ["Stop", [
    ["Esc", "stop the running turn, or close what is open"],
    ["Esc Esc", "rewind to an earlier point (idle only)"],
    ["Ctrl-C", "cancel the running turn; Ctrl-C twice in a row exits"],
    ["Ctrl-D", "exit, on an empty line"],
  ]],
]);

// One row per key, the label column sized to the widest label. `ink` off gives the plain rows
// /help prints; on gives the coloured ones the panel paints.
export function keyHelpRows(table = KEY_HELP, { ink = true, indent = "  " } = {}) {
  const width = Math.max(...table.flatMap(([, keys]) => keys.map(([label]) => displayWidth(label))));
  const rows = [];
  for (const [group, keys] of table) {
    if (rows.length) rows.push("");
    rows.push(ink ? `\x1b[1m${group}\x1b[0m` : group);
    for (const [label, what] of keys) {
      const pad = " ".repeat(width - displayWidth(label) + 2);
      rows.push(ink ? `${indent}\x1b[38;5;214m${label}\x1b[0m${pad}\x1b[2m${what}\x1b[0m` : `${indent}${label}${pad}${what}`);
    }
  }
  return rows;
}

export function commandMatches(value, commands = SLASH_COMMANDS) {
  const query = String(value || "").replace(/^\//, "").trim().toLowerCase();
  if (!query) return commands.slice(0, 8);
  const names = commands.filter(command => command.name.startsWith(query) || command.aliases?.some(alias => alias.startsWith(query)));
  return (names.length ? names : commands.filter(command => command.description.toLowerCase().includes(query))).slice(0, 8);
}

export function findCommand(value, commands = SLASH_COMMANDS) {
  const name = String(value || "").replace(/^\//, "").trim().split(/\s+/, 1)[0].toLowerCase();
  return commands.find(command => command.name === name || command.aliases?.includes(name)) || null;
}

// The exact slash token the owner has actually matched — shared by the live input and the committed
// owner line, so a command does not change meaning or colour when Enter moves it into the transcript.
// Prefixes and unknown names deliberately return nothing: blue means "hcode knows this command",
// never merely "this text starts with a slash".
export function matchedCommandToken(value, commands = SLASH_COMMANDS) {
  const token = /^\/[^\s]+/.exec(String(value || ""))?.[0] || "";
  return token && findCommand(token, commands) ? token : "";
}

export function commandsHelp(commands = SLASH_COMMANDS) {
  const groups = new Map();
  for (const command of commands) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  const rows = ["Inside a session (type / to search):"];
  for (const [group, entries] of groups) {
    rows.push("", group);
    for (const command of entries) rows.push(`  /${command.name.padEnd(12)} ${command.description}`);
  }
  rows.push("", "Keys (press ? on an empty line for this table inside a session)", ...keyHelpRows(KEY_HELP, { ink: false, indent: "  " }).map(row => row ? `  ${row}` : row));
  rows.push("", "A pasted block keeps all its line breaks and stays one message.");
  return rows.join("\n");
}
