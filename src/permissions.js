// Session permission chooser, and the one screen where the owner reads and edits their standing rules.
//
// Persistent project policy accepts all four modes, `all` included. In 0.9.4 `all` is the visible
// Full Agency default: the first real interactive launch asks whether to remember the choice or ask
// again next time. The fixed gates stay outside the mode, and a remembered value lives in the same
// <cwd>/.hcode/policy.json that loadPolicy() reads. Pipes and unattended launches never open a chooser.
//
// The rule list lives on the same screen, deliberately: mode and rules are one question ("how much does
// hcode ask me?") and splitting them into two menus makes the answer harder to see. It stays a flat
// numbered list — no nested editor, no per-rule form, no wizard. A number moves one rule one notch
// (deny → ask → allow → gone) and `+ <tool> <pattern> <action>` adds one. Everything else is a file the
// owner already owns. Restraint here is the feature: a permission screen nobody can hold in their head is
// a permission screen nobody reads, and an unread rule book is not a gate.
import { selectOption } from "./select.js";
import { clearPolicyMode, savePolicyMode } from "./policy.js";
import { cycleAction, parseRuleLine, ruleSubject, saveRules } from "./rules.js";

export const SESSION_MODES = ["read", "ask", "auto", "all"];

const CHOICES = new Map([
  ["1", "read"], ["r", "read"], ["read", "read"],
  ["2", "ask"], ["a", "ask"], ["ask", "ask"],
  ["3", "auto"], ["u", "auto"], ["auto", "auto"],
  ["4", "all"], ["all", "all"], ["bypass", "all"],
]);

// The four modes, in one sentence each. A permission screen is read under pressure, in the middle
// of something else; anything a sentence longer is a sentence the owner skips.
export const MODE_LINES = [
  "Read only — look, never touch.",
  "Ask first — confirm each write and command.",
  "Approve for me — work freely inside this project and its network policy.",
  "Full agency (recommended) — act end to end. Fixed hard gates remain.",
];

export const permissionMenu = (current, sandbox) => [
  "Permissions",
  ...MODE_LINES.map((line, index) => `  ${index + 1}. ${line}`),
  "",
  `current: ${current} · sandbox: ${sandbox}`,
  "Full agency never unlocks secret paths, money/identity, publishing or deletion,",
  "including root/home deletion and owner-intent conflicts. Bash network stays fixed.",
  "Public search is query-only; Codex and Claude keep separate logins.",
].join("\n");

// The arrow-key menu (composer sessions). Same four modes, same boundaries, chosen by moving
// and pressing Enter instead of typing a number.
export const MODE_OPTIONS = [
  { mode: "read", label: "Read only", description: "Look, never touch." },
  { mode: "ask", label: "Ask first", description: "Confirm each write and command." },
  { mode: "auto", label: "Approve for me", description: "Work freely inside this project and its network policy." },
  { mode: "all", label: "Full agency (recommended)", description: "Act end to end. Secrets, money, publishing, deletion and owner-intent conflicts remain hard gates." },
];

// How long the answer holds. Default is the session, because the smaller promise is the one an owner
// can make without reading a file first; "from now on" is a second, deliberate keystroke.
export const SCOPE_OPTIONS = [
  { mode: "session", label: "This session", description: "Ends when hcode exits.", keys: ["s", "session"] },
  { mode: "project", label: "From now on (this project)", description: "Remembered in this project's .hcode/policy.json.", keys: ["p", "project"] },
  { mode: "prompt", label: "Ask every startup", description: "Forget the project default and ask again next launch.", keys: ["e", "every", "prompt"] },
];

async function chooseScope({ ask, select, show }) {
  const index = await selectOption({
    title: "How long?", options: SCOPE_OPTIONS, initial: 0, select, ask, show,
    fallbackPrompt: "How long? 1 this session / 2 from now on / 3 ask every startup (Enter: this session)\n> ",
  });
  return index === 1 ? "project" : index === 2 ? "prompt" : "session";
}

export const STARTUP_OPTIONS = [
  { mode: "all", label: "Full agency (recommended)", description: "Finish ordinary work without repeated prompts; the five hard gates always stop." },
  { mode: "ask", label: "Ask before changes", description: "Search and read freely; confirm writes and commands." },
  { mode: "auto", label: "Auto within policy", description: "Act inside project policy, but without the Full Agency continuation contract." },
  { mode: "read", label: "Read only", description: "Inspect and explain; never change the workspace." },
];

export async function chooseStartupPermission({ cwd = null, ask, select, show = () => {}, saveMode = savePolicyMode }) {
  const subtitle = "菊守边界，刀行其事 · secrets, money, publishing, deletion and owner intent remain gated";
  let index;
  if (select) index = await selectOption({ title: "How should hcode work?", subtitle, options: STARTUP_OPTIONS, initial: 0, select });
  else {
    show(["菊与刀 · How should hcode work?", ...STARTUP_OPTIONS.map((option, i) => `  ${i + 1}. ${option.label} — ${option.description}`), "", subtitle].join("\n"));
    const raw = String(await ask("Choose 1-4 (Enter: full agency)\n> ") || "").trim();
    index = raw ? Number(raw) - 1 : 0;
  }
  if (!Number.isInteger(index) || index < 0 || index >= STARTUP_OPTIONS.length) return { mode: "all", changed: false, error: "Choose 1-4." };
  const mode = STARTUP_OPTIONS[index].mode;
  let remember;
  if (select) remember = await selectOption({
    title: "Next startup", subtitle: "You can change this later with /permissions.", initial: 0, select,
    options: [
      { label: "Remember for this project", description: "Open directly in this mode next time." },
      { label: "Ask me every startup", description: "Use it now, then ask again next launch." },
    ],
  });
  else {
    const raw = String(await ask("Next startup: 1 remember for this project / 2 ask me again (Enter: remember)\n> ") || "").trim();
    remember = raw === "2" ? 1 : 0;
  }
  const result = { mode, changed: true, startup: true };
  if (remember === 1) return result;
  if (!cwd) return { ...result, saveError: "no project directory to remember this in; hcode will ask again next startup" };
  try { return { ...result, saved: saveMode(cwd, mode) }; }
  catch (error) { return { ...result, saveError: `could not remember this for the project (${error.message}); hcode will ask again next startup` }; }
}

// ---- the rule rows ---------------------------------------------------------------------------------
export const ruleRow = rule => `${rule.action.padEnd(5)} ${String(rule.tool).padEnd(11)} ${ruleSubject(rule).slice(0, 34).padEnd(34)} ${rule.source}`;

export function rulesBlock(rules = [], offset = MODE_OPTIONS.length) {
  if (!rules.length) return `Rules  none yet. \`+ bash "git push*" ask\` adds one; deny always beats ask beats allow.`;
  return ["Rules (deny beats ask beats allow, in every mode)",
    ...rules.map((rule, i) => `  ${offset + i + 1}. ${ruleRow(rule)}`)].join("\n");
}

const ruleRange = rules => {
  const first = MODE_OPTIONS.length + 1;
  return rules.length > 1 ? `${first}-${MODE_OPTIONS.length + rules.length}` : String(first);
};

export const permissionsScreen = (current, sandbox, rules = []) => [
  permissionMenu(current, sandbox), "",
  rulesBlock(rules), "",
  `1-4 sets the permission${rules.length ? ` · ${ruleRange(rules)} moves a rule deny→ask→allow→gone` : ""}`,
  "+ <tool> <pattern> <deny|ask|allow> adds one · Enter keeps everything",
].join("\n");

// One screen, one answer. Returns {mode, changed, rules?} — `rules` present when the book was edited and
// written back to the settings.json each rule came from.
export async function openPermissions({ current = "ask", sandbox = "unknown", book = null, cwd = null, ask, select, show = () => {}, info = () => {}, warn = () => {}, save = saveRules, saveMode = savePolicyMode }) {
  const rules = book?.rules || [];
  if (select) {
    const options = [
      ...MODE_OPTIONS.map(option => ({ ...option, current: option.mode === current })),
      ...rules.map(rule => ({ label: ruleRow(rule), description: `${rule.why || "standing rule"} · Enter moves it to ${cycleAction(rule.action) || "gone"} (${rule.source} settings.json)` })),
    ];
    const index = await selectOption({ title: "Permissions", subtitle: `sandbox: ${sandbox}`, options, initial: Math.max(0, options.findIndex(option => option.current)), select });
    if (index === null) return { mode: current, changed: false };
    if (index < MODE_OPTIONS.length) return confirmPermissionMode({ current, mode: options[index].mode, cwd, ask, select, show, saveMode });
    return { mode: current, changed: false, ...applyRuleChoice(book, index - MODE_OPTIONS.length, { save, info }) };
  }
  show(permissionsScreen(current, sandbox, rules));
  const raw = String(await ask("Choose, or Enter to keep everything\n> ") || "").trim();
  if (!raw) return { mode: current, changed: false };
  if (raw.startsWith("+")) {
    if (!book) { warn("No rule book is loaded for this workspace."); return { mode: current, changed: false }; }
    let added;
    try { added = parseRuleLine(raw); } catch (error) { return { mode: current, changed: false, error: error.message }; }
    book.rules.push({ ...added, source: "project", file: book.projectFile, id: `project:${book.rules.filter(rule => rule.source === "project").length}` });
    save(book);
    info(`added to project settings.json: ${ruleRow(book.rules[book.rules.length - 1])}`);
    return { mode: current, changed: false, rules: book.rules };
  }
  const number = Number(raw.toLowerCase());
  if (Number.isInteger(number) && number > MODE_OPTIONS.length && number <= MODE_OPTIONS.length + rules.length) {
    return { mode: current, changed: false, ...applyRuleChoice(book, number - MODE_OPTIONS.length - 1, { save, info }) };
  }
  const mode = CHOICES.get(raw.toLowerCase());
  if (!mode) return { mode: current, changed: false, error: `Choose read, ask, auto, all${rules.length ? `, a rule number ${MODE_OPTIONS.length + 1}-${MODE_OPTIONS.length + rules.length}` : ""} or \`+ <tool> <pattern> <action>\`.` };
  return confirmPermissionMode({ current, mode, cwd, ask, show, saveMode });
}

// deny → ask → allow → gone. Written back immediately: a rule the owner changed but did not save is a
// rule they think is in force and is not.
export function applyRuleChoice(book, index, { save = saveRules, info = () => {} } = {}) {
  const rule = book?.rules?.[index];
  if (!rule) return {};
  const next = cycleAction(rule.action);
  const before = ruleRow(rule);
  if (next) rule.action = next; else book.rules.splice(index, 1);
  save(book);
  info(next ? `${before.trim()} → ${next}` : `removed: ${before.trim()}`);
  return { rules: book.rules };
}

export async function choosePermissionMode({ current = "ask", sandbox = "unknown", cwd = null, ask, select, show = () => {}, saveMode = savePolicyMode }) {
  if (select) {
    const options = MODE_OPTIONS.map(option => ({ ...option, current: option.mode === current }));
    const index = await selectOption({ title: "Permissions", subtitle: `sandbox: ${sandbox}`, options, initial: Math.max(0, options.findIndex(option => option.current)), select });
    if (index === null) return { mode: current, changed: false };
    return confirmPermissionMode({ current, mode: options[index].mode, cwd, ask, select, show, saveMode });
  }
  show(permissionMenu(current, sandbox));
  const raw = String(await ask("Choose 1-4, or Enter to keep the current mode\n> ") || "").trim().toLowerCase();
  if (!raw) return { mode: current, changed: false };
  const mode = CHOICES.get(raw);
  if (!mode) return { mode: current, changed: false, error: "Choose read, ask, auto or all." };
  return confirmPermissionMode({ current, mode, cwd, ask, select, show, saveMode });
}

export async function confirmPermissionMode({ current = "ask", mode, cwd = null, ask, select, show = () => {}, saveMode = savePolicyMode, clearMode = clearPolicyMode }) {
  if (!SESSION_MODES.includes(mode)) return { mode: current, changed: false, error: "Choose read, ask, auto or all." };
  if (mode !== "all") {
    const chosen = { mode, changed: mode !== current };
    const scope = await chooseScope({ ask, select, show });
    if (scope === "session") return chosen;
    if (scope === "prompt") {
      if (!cwd) return { ...chosen, saveError: "no project directory to clear; hcode will ask again only where no default is saved" };
      try { return { ...chosen, cleared: clearMode(cwd) }; }
      catch (error) { return { ...chosen, saveError: `could not clear the project default (${error.message})` }; }
    }
    // A remembered mode that was not actually written is the worst of both: the owner believes the
    // project is set and it is not. Say so, and keep the session change they already made.
    if (!cwd) return { ...chosen, saveError: "no project directory to remember this in; the mode holds for this session only" };
    try { return { ...chosen, saved: saveMode(cwd, mode) }; }
    catch (error) { return { ...chosen, saveError: `could not remember this for the project (${error.message}); the mode holds for this session only` }; }
  }

  // Full access is the loudest yes in the menu: one confirmation to enable it for this process at all
  // (unchanged from before), then — only if the owner also wants it to outlive the process — a second,
  // separate confirmation that spells out what "from now on" means for this one mode: every future
  // session opens already unlocked, nobody asked. Both confirmations default to No; the text path needs
  // a typed "yes", not an abbreviation.
  if (select) {
    // Still an explicit, separate decision — the menu opens on "No" and only the Yes row enables it.
    const index = await selectOption({
      title: "Enable full access for this session?",
      options: [
        { label: "No, stay in ask", description: "Every write and command keeps asking you first." },
        { label: "Yes, enable full access", description: "Commands and edits inside this project may run without another prompt. Fixed safety boundaries still apply. Ends when hcode exits." },
      ],
      initial: 0, select,
    });
    if (index !== 1) return { mode: "ask", changed: current !== "ask", declined: true };
  } else {
    show(`Full access is powerful. Commands and edits inside this project may run without another prompt.
The fixed safety boundaries above still apply. This choice ends when hcode exits.`);
    const confirmation = String(await ask("Enable full access for this session? Type yes to confirm [yes/no]\n> ") || "").trim().toLowerCase();
    if (confirmation !== "yes") return { mode: "ask", changed: current !== "ask", declined: true };
  }

  const enabled = { mode: "all", changed: current !== "all", confirmed: true };
  const scope = await chooseScope({ ask, select, show });
  if (scope === "session") return enabled;
  if (scope === "prompt") {
    if (!cwd) return { ...enabled, saveError: "no project directory to clear; hcode will ask again only where no default is saved" };
    try { return { ...enabled, cleared: clearMode(cwd) }; }
    catch (error) { return { ...enabled, saveError: `could not clear the project default (${error.message})` }; }
  }

  // "From now on" means something heavier for `all` than for the other three modes: every session that
  // starts here from now on is already fully unlocked before anyone is asked anything. Say that in so
  // many words, and make agreeing to it exactly as deliberate as the first confirmation above.
  let standing;
  if (select) {
    const index = await selectOption({
      title: "Full access every session, from now on?",
      options: [
        { label: "No, just this session", description: "Full access stays on for this session only." },
        { label: "Yes, standing full access", description: "From now on every session opens in full access automatically — no prompt, no per-session confirmation — until you come back to /permissions and change it." },
      ],
      initial: 0, select,
    });
    standing = index === 1;
  } else {
    show(`From now on means every future session opens in full access automatically — no prompt, no
per-session confirmation — until you come back to /permissions and change it.`);
    const confirmation = String(await ask("Type yes to make full access standing for this project [yes/no]\n> ") || "").trim().toLowerCase();
    standing = confirmation === "yes";
  }
  if (!standing) return enabled;
  if (!cwd) return { ...enabled, saveError: "no project directory to remember this in; the mode holds for this session only" };
  try { return { ...enabled, saved: saveMode(cwd, "all") }; }
  catch (error) { return { ...enabled, saveError: `could not remember this for the project (${error.message}); the mode holds for this session only` }; }
}
