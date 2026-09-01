// Hoop Code is a quiet workbench on the owner's machine, not a full-screen TUI.
// PAPER = stable human-readable content, KEY = an owner decision, GHOST = machine facts.
// Build plain semantic text first; ANSI is an optional projection for an interactive sink only.
import { WAITING_ROTATION_MS, musing, waitingStart, waitingWord } from "./musings.js";
import { presence, TICK_MS } from "./presence.js";
import { matchedCommandToken } from "./commands.js";
import { wrapText } from "./frame.js";
import { VERSION } from "./config.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

// The second is the unit the meter is read in, so it is the rate the waiting row repaints at —
// the same beat presence uses to say an elapsed clock has moved, borrowed rather than guessed.
export const TURN_METER_MS = Math.max(200, Number(TICK_MS) || 1000);

// ---- the one clock and the one meter -----------------------------------------------------------
// `4m 34s · ↓ 109.7k tokens`, and exactly that wherever presence is painted: the waiting word above
// the input box, the helper rows under it, the line a plain terminal rewrites with a carriage
// return. One formatter, because two would agree until the first of them learned about hours.
//
// Under a minute the minutes are not written at all. A leading `0m ` is a column of zeroes a reader
// has to look past to find the one number that is actually moving, and the whole point of this
// string is that a glance answers "is this stuck?".
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
// Tokens stay exact for as long as exact is readable — 999 is 999 — and become one decimal of a
// thousand after that. Rounding starts where a person stops counting, not where the number gets big.
export function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
// No tokens yet means no token half. `↓ 0 tokens` is a number pretending to be news; the clock
// alone is the honest thing to say about work that has started and not yet spent anything.
export function formatSpend(elapsedMs, tokens) {
  const clock = formatElapsed(elapsedMs);
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  return n ? `${clock} · ↓ ${formatTokens(n)} tokens` : clock;
}

export function supportsColor(stream, env = process.env) {
  return Boolean(stream?.isTTY) && !has(env, "NO_COLOR") && String(env?.TERM || "").toLowerCase() !== "dumb";
}

// Input colour follows the terminal instead of assuming the page is light. HCODE_INPUT_THEME is
// the explicit escape hatch for terminals that answer no background query; COLORFGBG is the cheap
// standard hint. "auto" means the composer will ask OSC 11 without blocking startup, while the
// readline fallback stays on the terminal's own unpainted background rather than guessing wrong.
export function inputTheme(env = process.env) {
  const forced = String(env?.HCODE_INPUT_THEME || "").toLowerCase();
  if (forced === "dark" || forced === "light") return forced;
  const background = String(env?.COLORFGBG || "").split(";").at(-1) || "";
  const index = Number(background);
  if (background && Number.isInteger(index) && index >= 0 && index <= 15) return [0, 1, 2, 3, 4, 5, 6, 8].includes(index) ? "dark" : "light";
  return "auto";
}

export function themeFromRgb(red, green, blue) {
  const channel = value => {
    const raw = String(value || ""); const parsed = Number.parseInt(raw, 16);
    return Number.isFinite(parsed) && raw.length ? parsed / (16 ** raw.length - 1) : 0;
  };
  const [r, g, b] = [red, green, blue].map(channel);
  return 0.299 * r + 0.587 * g + 0.114 * b >= 0.55 ? "light" : "dark";
}

export function inputStyle(theme = "auto") {
  // Pure yellow on a light field has so little contrast that terminals may protect readability
  // by replacing it with black. Keep the luminous yellow on dark, and use a clear gold on light.
  if (theme === "dark") return Object.freeze({ row: "\x1b[48;5;235m\x1b[38;5;252m", text: "\x1b[38;5;252m", command: "\x1b[1;38;2;255;214;10m" });
  if (theme === "light") return Object.freeze({ row: "\x1b[48;5;254m\x1b[38;5;236m", text: "\x1b[38;5;236m", command: "\x1b[1;38;2;169;120;0m" });
  return Object.freeze({ row: "\x1b[49m\x1b[39m", text: "\x1b[39m", command: "\x1b[1;38;2;169;120;0m" });
}

// Colour here is a semantic role, never decoration: one meaning gets one ink everywhere it is
// painted, and the whole set stays inside a warm, quiet band so a busy turn reads as one surface
// rather than as confetti. Who is speaking is gold (brand 208 for the mark, 214 for a decision
// the owner must make). What hcode is doing is cool and recessive: soft cyan 75 marks a tool call
// and lavender 140 marks work still running, so a page of them does not compete with the answer.
// How it ended keeps the plain outcomes: green 71 done, red 203 failed, amber 214 cancelled or
// worth attention. What is merely true is dim 245. Warm sand 179 is reserved for the states that
// are presence rather than progress — the waiting word and the musing.
export function createPalette(enabled = false) {
  const paint = (code, value) => enabled ? `\x1b[${code}m${value}\x1b[0m` : String(value);
  return {
    dim: value => paint("38;5;245", value),
    bold: value => paint("1", value),
    gold: value => paint("38;5;214", value),
    red: value => paint("38;5;203", value),
    green: value => paint("38;5;71", value),
    cyan: value => paint("38;5;75", value),
    yellow: value => paint("38;5;214", value),
    brand: value => paint("1;38;5;208", value),
    key: value => paint("1;38;5;214", value),
    command: value => paint("1;38;2;169;120;0", value),
    sand: value => paint("38;5;179", value),
    lavender: value => paint("38;5;140", value),
  };
}

// Compatibility for the tables and doctor. Unlike the old import-time flag, each call observes
// the current stdout capability and NO_COLOR/TERM state.
const stdoutPaint = name => value => createPalette(supportsColor(process.stdout, process.env))[name](value);
export const color = {
  dim: stdoutPaint("dim"), bold: stdoutPaint("bold"), gold: stdoutPaint("gold"),
  red: stdoutPaint("red"), green: stdoutPaint("green"), cyan: stdoutPaint("cyan"), yellow: stdoutPaint("yellow"),
  sand: stdoutPaint("sand"), lavender: stdoutPaint("lavender"),
};

// Never let untrusted text control the terminal, and never hide bytes from an owner decision.
// Newlines remain layout; every other C0/C1 control becomes a visible byte escape.
export function escapeControls(value) {
  let visible = "";
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (character === "\n") visible += character;
    else if (code <= 0x1f || code >= 0x7f && code <= 0x9f) visible += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code >= 0xd800 && code <= 0xdfff) visible += `\\u{${code.toString(16)}}`;
    else visible += character;
  }
  return visible;
}
const needsDisplayEscape = value => {
  if (Array.isArray(value)) return value.some(needsDisplayEscape);
  if (value && typeof value === "object") return Object.values(value).some(needsDisplayEscape);
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (character !== "\n" && (code <= 0x1f || code >= 0x7f && code <= 0x9f || code >= 0xd800 && code <= 0xdfff)) return true;
  }
  return false;
};
const safeText = escapeControls;
const safeBlock = value => safeText(value).trim();
const inline = value => safeText(value)
  .replace(/\s+/g, " ")
  .trim();

const renderInlineMarkdown = (value, p) => {
  const code = [];
  let text = safeText(value).replace(/`([^`\n]+)`/g, (_, body) => {
    const marker = `\u0000CODE${code.length}\u0000`;
    code.push(p.cyan(body));
    return marker;
  });
  text = text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `${p.cyan(label)} ${p.dim(`<${url}>`)}`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, body) => p.bold(body))
    .replace(/__([^_\n]+)__/g, (_, body) => p.bold(body))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_, lead, body) => `${lead}${body}`)
    .replace(/(^|[^_])_([^_\n]+)_/g, (_, lead, body) => `${lead}${body}`)
    .replace(/~~([^~\n]+)~~/g, "$1");
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)] || "");
};

// A conservative terminal projection of common Markdown. Unknown syntax remains visible as text;
// control bytes are escaped before any styling is applied.
export function renderMarkdown(value, { palette = createPalette(false) } = {}) {
  const source = safeText(value).replace(/\r\n?/g, "\n");
  const rows = source.split("\n");
  const rendered = [];
  let fence = false;
  for (const row of rows) {
    if (/^\s*```/.test(row)) { fence = !fence; continue; }
    if (fence) { rendered.push(palette.dim("│ ") + palette.cyan(row)); continue; }
    const heading = row.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) { rendered.push(palette.bold(renderInlineMarkdown(heading[2], palette))); continue; }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(row)) { rendered.push(palette.dim("─".repeat(48))); continue; }
    const task = row.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (task) { rendered.push(`${task[1]}${task[2].toLowerCase() === "x" ? palette.green("✓") : "○"} ${renderInlineMarkdown(task[3], palette)}`); continue; }
    const bullet = row.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) { rendered.push(`${bullet[1]}${palette.gold("•")} ${renderInlineMarkdown(bullet[2], palette)}`); continue; }
    const quote = row.match(/^\s*>\s?(.*)$/);
    if (quote) { rendered.push(`${palette.dim("│")} ${renderInlineMarkdown(quote[1], palette)}`); continue; }
    rendered.push(renderInlineMarkdown(row, palette));
  }
  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

const visiblePath = (value, env) => {
  const full = inline(value);
  const home = String(env?.HOME || "").replace(/\/$/, "");
  return home && (full === home || full.startsWith(home + "/")) ? "~" + full.slice(home.length) : full;
};

const modeLabel = mode => ({ read: "read only", ask: "ask before changes", auto: "auto within policy", all: "full agency" })[mode] || inline(mode);
const risks = risk => (risk || []).filter(value => value !== "read");
const duration = ms => {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}s`;
  const seconds = Math.round(n / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const resultSummary = (value, failed = false) => {
  const lines = String(value ?? "").split("\n").map(inline).filter(Boolean);
  if (!lines.length) return "";
  const chosen = failed ? lines[0] : lines.at(-1);
  return lines.length === 1 ? chosen : `${chosen} (${lines.length} lines)`;
};

// Work that is still running is lavender — the one ink in the set that belongs to nothing else,
// because "this has not finished" is the state an owner scanning a page of agents needs to find
// first. Everything that has finished keeps its plain outcome colour.
const statusStyle = {
  working: "lavender", done: "green", failed: "red", cancelled: "yellow",
  "not run": "red", reused: "cyan", attention: "yellow", decision: "key", plan: "cyan",
};
const statusMark = Object.freeze({ working: "◌", done: "✓", failed: "✗", cancelled: "▲", "not run": "○", reused: "↺", attention: "▲", decision: "◆", plan: "•" });
const status = (palette, name) => palette[statusStyle[name] || "dim"](statusMark[name] || "•");

// Shared by `hcode account` and the account block on `status`. Never receives or prints accessToken —
// describeHoopSession() in auth.js does not return it. "active"/"expired" are read from the locally
// cached session, not a fresh server check; the wording says so instead of implying a live probe.
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
function accountFacts(info) {
  if (!info || !info.connected) {
    return { header: "HoopGram account", lines: ["not connected on this machine", "run `hcode login <hoop>` to sign in through hoopgram.ai"] };
  }
  const expiresAt = iso(info.expiresAt) || "unknown";
  const signedInAt = iso(info.issuedAt);
  const entitlement = info.entitlement === "active"
    ? `active — this machine's local session cache, last confirmed with hoopgram.ai at sign-in${signedInAt ? ` (${signedInAt})` : ""}`
    : info.entitlement === "expired"
      ? `expired — session ended ${expiresAt}; run \`hcode login ${inline(info.hoop)}\` again`
      : `unknown — local session record is incomplete; run \`hcode login ${inline(info.hoop)}\` again`;
  return {
    header: "HoopGram account",
    lines: [
      `account: ${inline(info.hoop)}.hoopgram.ai`,
      `entitlement: ${entitlement}`,
      `session expires: ${expiresAt}`,
      `connected through: ${inline(info.source || "unknown")} (signed in via ${inline(info.authBase || "hoopgram.ai")})`,
    ],
  };
}

export function renderDiff(oldText, newText, maxLines = 40, palette = null) {
  const p = palette || {
    red: color.red, green: color.green, dim: color.dim,
  };
  const before = safeText(oldText).split("\n");
  const after = safeText(newText).split("\n");
  const rows = [...before.map(line => p.red("- " + line)), ...after.map(line => p.green("+ " + line))];
  return (rows.length > maxLines
    ? [...rows.slice(0, maxLines), p.dim(`  ... ${rows.length - maxLines} more lines`)]
    : rows).join("\n");
}

// `board` is the presence singleton by default and injected only by tests: like the composer, this
// reads the board and never owns it, so there is nothing here to keep in step with it.
export function createUI({ out = process.stdout, err = process.stderr, env = process.env, columns, presence: board = presence } = {}) {
  const paper = createPalette(supportsColor(out, env));
  const errorInk = createPalette(supportsColor(err, env));
  let composer = null;
  const write = value => composer ? composer.print(String(value), out) : out.write(String(value));
  const writeLine = (value = "") => write(String(value) + "\n");
  const writeError = value => composer ? composer.print(String(value) + "\n", err) : err.write(String(value) + "\n");
  const live = supportsColor(out, env);
  const width = Math.max(24, Number(columns || out.columns || 80));
  // Answers get the same two columns of margin the dialog gives everything else, and they stop
  // short of the right edge: a paragraph that touches both walls of the terminal is harder to
  // read than one that breathes, and a line that wraps at the edge wraps again on every zoom.
  const flowWidth = Math.max(24, Math.min(width - 4, 96));
  let assistantBuffer = null;
  let activeTool = false;
  let verbose = false;
  // The waiting word rotates while the model has the turn. It is decoration over an unchanged
  // fact ("nothing has come back yet"), so it never keeps the process alive on its own.
  let waitingTimer = null;
  let waitingIndex = 0;
  const stopWaiting = () => { if (waitingTimer) clearInterval(waitingTimer); waitingTimer = null; };
  const clearActivity = () => {
    stopWaiting();
    if (composer) {
      composer.clearActivity();
      activeTool = false;
      return;
    }
    if (!activeTool || !live) return;
    write("\r\x1b[2K");
    activeTool = false;
  };
  const activityLabel = label => {
    const raw = inline(label);
    if (/subagent|delegate|coordinat(?:e|ing|ion)/i.test(raw)) return "Coordinating";
    if (/\b(?:test(?:ing)?|check(?:ing)?|verif(?:y|ying)|lint(?:ing)?|build(?:ing)?)\b/i.test(raw)) return "Checking";
    if (/\b(?:grep|search(?:ing)?|find(?:ing)?)\b/i.test(raw)) return "Searching";
    if (/(?:\b(?:read(?:ing)?|list(?:ing)?|glob)\b|(?:read|list)_)/i.test(raw)) return "Reading";
    if (/(?:\b(?:edit(?:ing)?|writ(?:e|ing)|patch(?:ing)?)\b|(?:edit|write)_)/i.test(raw)) return "Editing";
    if (/^(\$|bash\b)|\b(?:run(?:ning)?|exec(?:uting)?|command)\b/i.test(raw)) return "Running";
    if (/\bwait(?:ing)?\b/i.test(raw)) return "Waiting";
    return "Working";
  };

  // Dialog shape on a live terminal: blank rows open and close the owner's line, the answer opens
  // with a speaker line (● hcode) and hangs two columns under it — so a turn reads as "who said
  // what". Every projected line goes through here, so headings, bullets, quotes and fenced code
  // all sit on the same left margin instead of one of them touching the wall. Plain sinks stay
  // verbatim: a pipe is not reading a dialog.
  const hang = value => live ? String(value).split("\n").map(line => line ? "  " + line : line).join("\n") : String(value);
  const noticeRows = value => safeText(value).split("\n").flatMap(line => wrapText(line, Math.max(16, flowWidth - 2)));
  const notice = (kind, message, { stderr = false } = {}) => {
    const marks = { error: ["✗", errorInk.red], warning: ["▲", errorInk.yellow], done: ["✓", paper.green], progress: ["◌", paper.lavender], info: ["•", paper.cyan] };
    const [mark, paint] = marks[kind] || marks.info;
    const rows = noticeRows(message);
    rows.forEach((line, index) => {
      const body = kind === "info" ? paper.dim(line) : line;
      const rendered = hang(`${index ? "  " : `${paint(mark)} `}${body}`);
      if (stderr) writeError(rendered); else writeLine(rendered);
    });
  };
  // One speaker line per turn: printed by whatever comes first (answer text or a tool), reset
  // when the next prompt is shown. Plain sinks never get one.
  let turnOpen = false;
  const speaker = (label = "hcode") => {
    if (!live || turnOpen) return;
    turnOpen = true;
    writeLine(`  ${paper.brand("●")} ${paper.bold(inline(label))}`);
  };
  const flushAssistantLine = value => {
    const rendered = renderMarkdown(value, { palette: paper });
    writeLine(hang(rendered));
  };
  const flushAssistantText = value => wrapText(value, flowWidth).forEach(flushAssistantLine);
  const displayTarget = value => {
    const text = inline(value || "");
    if (text.length <= 64) return text;
    const parts = text.split(/[\\/]/).filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail && tail.length < 61 ? `…/${tail}` : text.slice(0, 61) + "…";
  };
  const toolAction = (label, meta = {}) => {
    const name = String(meta.name || ""); const input = meta.input || {};
    const target = displayTarget(input.path || input.file_path || "");
    if (name === "read_file") return { active: `Reading ${target || "file"}`, done: `Read ${target || "file"}`, quiet: true, kind: "reading" };
    if (name === "list_dir") return { active: `Reading ${target || "workspace"}`, done: `Read ${target || "workspace"}`, quiet: true, kind: "reading" };
    if (name === "grep") { const pattern = inline(input.pattern || "").slice(0, 48); return { active: `Searching${pattern ? ` ${pattern}` : ""}`, done: `Searched${pattern ? ` ${pattern}` : ""}`, quiet: true, kind: "searching" }; }
    if (name === "glob") { const pattern = inline(input.pattern || "").slice(0, 48); return { active: `Searching${pattern ? ` ${pattern}` : " files"}`, done: `Searched${pattern ? ` ${pattern}` : " files"}`, quiet: true, kind: "searching" }; }
    if (name === "web_search") { const query = inline(input.query || "").slice(0, 56); return { active: `Searching the web${query ? ` · ${query}` : ""}`, done: `Searched the web${query ? ` · ${query}` : ""}`, kind: "searching" }; }
    if (name === "edit_file") return { active: `Editing ${target || "file"}`, done: `Edited ${target || "file"}`, kind: "editing", preview: true };
    if (name === "write_file") return { active: `Writing ${target || "file"}`, done: `Wrote ${target || "file"}`, kind: "editing" };
    if (name === "bash") { const command = inline(String(input.command || "").split("\n")[0]).slice(0, 68); return { active: `Running ${command || "command"}`, done: `Ran ${command || "command"}`, kind: "running" }; }
    if (name === "delegate_agent") { const agent = inline(input.agent || "subagent"); return { active: `Working with ${agent}`, done: `Heard back from ${agent}`, kind: "coordinating" }; }
    if (name === "update_plan") return { active: "Updating plan", done: "Updated plan", quiet: true, kind: "planning" };
    const title = activityLabel(label);
    const past = { Checking: "Checked", Searching: "Searched", Reading: "Read", Editing: "Edited", Running: "Ran", Coordinating: "Coordinated", Waiting: "Waited", Working: "Completed" }[title] || "Completed";
    return { active: title, done: past, quiet: ["Reading", "Searching", "Waiting"].includes(title), kind: title.toLowerCase() };
  };

  const terminal = {
    banner(cfg, sessionId, context = {}) {
      const details = typeof context === "string" ? { legacy: context } : context;
      const runner = inline(details.runner || cfg.runner || "hcode");

      // A live session starts on a clean screen: erase the visible page and the scrollback so
      // earlier shell history is not mistaken for part of this conversation. Plain sinks keep
      // every byte (nothing to clear, and scripts must not receive control sequences).
      if (live) { composer?.resetTranscript?.(); write("\x1b[2J\x1b[3J\x1b[H"); }
      // A greeting, then the machine facts, then one quiet line from the local Tao selection.
      // It is presented as the text itself, never as a claim about what the machine thought while
      // nobody was here. Warm enough to be noticed, quiet enough to be declined.
      const pad = line => "  " + line;
      const compact = `${visiblePath(cfg.cwd, env)} · ${runner === "hcode" ? "Hoop Code" : runner === "codex" ? "Codex" : "Claude Code"} · ${modeLabel(cfg.mode)}`;
      writeLine();
      writeLine(pad(paper.brand("○ Welcome to Hoop")));
      writeLine(pad("Your machine. Your work."));
      writeLine(pad(paper.dim(`hoop: ${inline(cfg.hoopName) || "not linked yet"}`)));
      writeLine(pad(paper.sand(`${VERSION} · 菊与刀`)));
      writeLine(pad(paper.dim(compact)));
      writeLine();
      writeLine(pad(paper.sand(`「${musing()}」`)));
      writeLine();
    },

    status(cfg, sessionId, context = {}) {
      const runner = inline(context.runner || cfg.runner || "hcode");
      writeLine(paper.bold("Current workspace"));
      writeLine(`workspace: ${visiblePath(cfg.cwd, env)}`);
      writeLine(`brain: ${runner === "hcode" ? "Hoop Code" : runner === "codex" ? "Codex" : "Claude Code"}${runner === "hcode" && cfg.model ? ` / model: ${inline(cfg.model)}` : ""} / effort: ${inline(cfg.effort || "high")}`);
      writeLine(`Hoop data: ${cfg.hoopUrl ? `${inline(cfg.hoopName || "connected Hoop")} / read only` : "not connected"}`);
      writeLine(`permission: ${modeLabel(cfg.mode)} / network: ${inline(context.network || cfg.policy?.network?.default || "off")}`);
      if (context.sandbox) writeLine(`sandbox: ${inline(context.sandbox)}`);
      if (sessionId) writeLine(`session: ${inline(sessionId)}`);
      if (context.account) {
        writeLine();
        const { header, lines } = accountFacts(context.account);
        writeLine(paper.bold(header));
        for (const line of lines) writeLine(line);
      }
    },

    account(info) {
      const { header, lines } = accountFacts(info);
      writeLine(paper.bold(header));
      for (const line of lines) writeLine(line);
    },

    brainPicker(choices, { required = false } = {}) {
      writeLine(paper.brand("○ Hoop Code"));
      writeLine(required ? paper.bold("Connect the Hoop Code coordinator.") : paper.bold("Change the coordinator connection."));
      writeLine(paper.dim("Codex and Claude remain optional subagents; see /agents."));
      writeLine();
      choices.forEach((choice, index) => {
        const selectable = Boolean(choice.selectable);
        writeLine(`  ${selectable ? paper.key(`${index + 1}.`) : `${index + 1}.`} ${paper.bold(choice.label)}  ${selectable ? paper.green(`[${choice.status}]`) : paper.dim(`[${choice.status}]`)}`);
        writeLine(paper.dim(`     ${choice.detail}`));
      });
      writeLine();
      return paper.key("Select a number, or [q]uit\n> ");
    },

    brainUnavailable(choices) {
      writeError(`${status(errorInk, "attention")} No brain is connected.`);
      const ready = choices.filter(choice => choice.selectable).map(choice => choice.label);
      if (ready.length) writeError(`Ready on this machine: ${ready.join(" / ")}. Run \`hcode setup\` to choose one.`);
      else writeError("Run `hcode setup` to connect a HoopGram account, API provider, or self-hosted Hoop. Codex/Claude remain subagents (`hcode runner list`).");
    },

    brainDisconnected(choices) {
      writeError(`${status(errorInk, "attention")} This brain is no longer connected.`);
      const ready = choices.filter(choice => choice.selectable).map(choice => choice.label);
      writeError(`${ready.length ? `Ready now: ${ready.join(" / ")}. ` : ""}Type /brain to switch.`);
    },

    workspacePermission(cwd, runner) {
      writeLine();
      writeLine(status(paper, "decision") + " Owner decision");
      writeLine(`${inline(runner)} will work directly in ${paper.bold(visiblePath(cwd, env))}.`);
      writeLine("This folder contains private or linked paths. The external coding agent may be able to read them.");
      writeLine("Allow access for this hcode session only?");
      writeLine("Press Enter without a choice: do not allow.");
      return `${paper.key("continue? [y]es / [n]o")}\n> `;
    },

    intro() {
      // Same left margin as the banner it follows: the opening of a session is one block, and a
      // line that starts two columns to the left of the one above it reads as a different voice.
      writeLine("  " + paper.bold("What should we build?"));
      writeLine("  " + paper.dim("/help for commands · /compact keeps the important context · /clear starts fresh"));
    },
    prompt() {
      if (!live) return "> ";
      turnOpen = false;
      // Blank rows, not rules, mark where the owner speaks. A full-width rule is committed to the
      // scrollback at the width it was drawn at, so every later zoom breaks it in half and the
      // transcript fills with fragments; whitespace reflows correctly forever. The field
      // background stays on the prefix and whatever readline echoes after it — never a painted
      // band across the terminal — and `after` resets it, then leaves one breathing row.
      // The same theme contract the composer's input band uses: an explicit/light-hinted/dark-hinted
      // terminal gets its matching field, and an unknown terminal keeps its own native background.
      const style = inputStyle(inputTheme(env));
      const field = `${style.row}\x1b[1m› \x1b[22m`;
      return { prompt: `\n${field}`, after: "\x1b[0m\n" };
    },
    question(text) { return `${paper.key("◆")} ${inline(text)}\n> `; },
    // The owner's submitted line, committed to the transcript in the same shape the composer
    // showed while typing: a blank row, the caret and their words, a blank row. Composer input
    // never echoes on its own (the live frame is redrawn), so without this the owner's words
    // would vanish from the scrollback the moment they were sent.
    ownerLine(text) {
      turnOpen = false;   // the owner's line starts a turn in composer sessions, where prompt() is never called
      const body = safeText(text).split("\n")
        .map((line, i) => {
          const token = i === 0 ? matchedCommandToken(line) : "";
          const spoken = token ? `${paper.command(token)}${paper.bold(line.slice(token.length))}` : paper.bold(line);
          return i === 0 ? `${paper.dim("›")} ${spoken}` : line ? `  ${spoken}` : "";
        })
        .join("\n");
      writeLine(); writeLine(body); writeLine();
    },

    assistantStart(label = "hcode") {
      clearActivity();
      assistantBuffer = "";
      if (live) speaker(label);
      else if (verbose && inline(label) !== "hcode") writeLine(paper.dim(`${inline(label)} response`));
    },
    assistantText(text) {
      if (assistantBuffer !== null && composer) {
        assistantBuffer += safeText(text);
        let newline;
        while ((newline = assistantBuffer.indexOf("\n")) >= 0) {
          flushAssistantText(assistantBuffer.slice(0, newline));
          assistantBuffer = assistantBuffer.slice(newline + 1);
        }
        // Some providers stream a whole paragraph without line breaks. Project it
        // as bounded display lines while preserving the exact text in the session.
        for (;;) {
          const lines = wrapText(assistantBuffer, flowWidth);
          if (lines.length <= 1) break;
          assistantBuffer = lines.pop();
          lines.forEach(flushAssistantLine);
        }
      }
      else if (assistantBuffer !== null) assistantBuffer += safeText(text);
      else write(safeText(text));
    },
    assistantEnd() {
      clearActivity();
      if (assistantBuffer !== null) {
        if (composer) {
          if (assistantBuffer) flushAssistantText(assistantBuffer);
        } else {
          const source = live ? wrapText(assistantBuffer, flowWidth).join("\n") : assistantBuffer;
          const rendered = renderMarkdown(source, { palette: paper });
          if (rendered) writeLine(hang(rendered));
        }
        writeLine();
      } else writeLine();
      assistantBuffer = null;
    },

    toolLabel(name, input = {}) {
      if (name === "delegate_agent") return `${inline(input.agent)} subagent: ${inline(input.task)}`;
      if (name === "update_plan") return `update plan: ${inline(input.goal)}`;
      if (name === "bash") return `$ ${inline(safeText(input.command).replace(/\n/g, " \\n "))}`;
      if (name === "grep") return `grep /${inline(input.pattern)}/ ${inline(input.path || ".")}`;
      if (name === "glob") return `glob ${inline(input.pattern)}`;
      if (name === "ask_user") return `ask: ${inline(input.question)}`;
      return `${inline(name)} ${inline(input.path || "")}`.trim();
    },
    toolStart(label, risk = [], meta = {}) {
      const tag = risks(risk);
      const action = toolAction(label, meta);
      stopWaiting();   // named work replaces the waiting word; a rotation still running would paint over it
      speaker();
      if (composer) {
        composer.setActivity(action.active, action.kind);
        activeTool = true;
      } else if (live) {
        clearActivity();
        // A tool call is hcode's own machinery, not its voice: a soft cyan mark over dim body
        // text, so a turn that runs ten of them stays a background hum under the gold answer.
        write(`\r\x1b[2K  ${paper.cyan("●")} ${paper.dim(action.active)}${verbose ? paper.dim(` · ${inline(label)}${tag.length ? ` · ${tag.join(", ")}` : ""}`) : ""}`);
        activeTool = true;
      } else if (verbose) writeLine(`${status(paper, "working")} ${inline(label)}`);
    },
    toolEnd(label, output, details = {}) {
      // Accept the old boolean third argument while callers move to the explicit lifecycle object.
      const opts = typeof details === "boolean" ? { state: details ? "failed" : "done" } : details;
      const state = opts.state === "denied" ? "not run" : opts.state || "done";
      const summary = resultSummary(output, state !== "done");
      const facts = [opts.durationMs === undefined ? "" : duration(opts.durationMs), summary].filter(Boolean).join(" / ");
      const action = toolAction(label, opts);
      clearActivity();
      if (state === "done" && action.quiet && !verbose) return;
      speaker();
      if (state === "done") {
        writeLine(hang(`${paper.green("•")} ${paper.bold(verbose ? inline(label) : action.done)}${verbose && facts ? ` · ${facts}` : opts.durationMs === undefined ? "" : ` · ${duration(opts.durationMs)}`}`));
        if (action.preview && opts.input && !verbose) writeLine(hang(renderDiff(opts.input.old_string, opts.input.new_string, 10, paper)));
      } else {
        const ending = state === "failed" ? "Failed" : state === "cancelled" ? "Cancelled" : "Not run";
        writeLine(hang(`${status(paper, state)} ${ending}: ${verbose ? inline(label) : action.active}${facts ? ` · ${facts}` : ""}`));
      }
    },
    toolDenied(label, why = "declined") {
      speaker();
      writeLine(hang(`${status(paper, "not run")} Not run: ${inline(label)} · ${inline(why)}`));
    },
    toolReplayed(label) {
      speaker();
      writeLine(hang(`${status(paper, "reused")} Reused ${inline(label)} · result from earlier in this turn`));
    },
    recovered(cancelled) {
      speaker();
      writeLine(hang(`${status(paper, "attention")} Resumed after an interruption.`));
      writeLine(hang(paper.dim("Actions that started but never finished were not run again:")));
      for (const call of cancelled) writeLine(hang(`${status(paper, "not run")} ${terminal.toolLabel(call.tool, call.input || {})}`));
      writeLine(hang(paper.dim("Check those actions before asking Hoop Code to continue.")));
    },

    // The protocol remains y/n/a. There is no selected action, countdown, or implicit consent.
    permission(name, input = {}, { risk = [], why = "", reason = "" } = {}) {
      let detail;
      if (name === "bash") detail = `run ${paper.bold(safeBlock(input.command))}`;
      else if (name === "edit_file") detail = `edit ${paper.bold(inline(input.path))}\n${renderDiff(input.old_string, input.new_string, 40, paper)}`;
      else if (name === "write_file") {
        const rawContent = String(input.content || "");
        const content = safeText(rawContent);
        detail = `${paper.bold(inline(input.path))} — write ${Buffer.byteLength(rawContent)} bytes`;
        if (content.split("\n").length <= 12) detail += "\n" + paper.green(content.split("\n").map(line => "+ " + line).join("\n"));
      } else if (name === "delegate_agent") {
        // The owner is approving spend, so the approval says which brain the call asked for — the id it
        // named, or the tier it declared. hcode resolves the tier to a model id when the call actually runs.
        const brain = inline(input.model || (input.kind ? `${input.kind} tier` : ""));
        detail = `ask ${paper.bold(inline(input.agent))}${brain ? ` on ${paper.bold(brain)}` : ""} to investigate read-only:\n${safeBlock(input.task)}`;
      }
      else detail = `${inline(name)} ${inline(JSON.stringify(input))}`;

      const tags = risks(risk);
      const explanations = [...new Set([reason, why].map(inline).filter(Boolean))];
      writeLine();
      writeLine(status(paper, "decision") + " Owner decision");
      if (needsDisplayEscape(input)) {
        writeLine(paper.yellow("safety: non-printing input is escaped below; execution uses the original characters."));
      }
      writeLine(`hcode wants to ${detail}`);
      if (tags.length || explanations.length) writeLine(`risk: ${tags.join(", ") || "write"}${explanations.length ? " / " + explanations.join(" / ") : ""}`);
      writeLine("Press Enter without a choice: do not run.");
      if (name === "delegate_agent") return `${paper.key("send task? [y]es / [n]o")}\n> `;
      return `${paper.key("allow? [y]es once / [n]o / [a]lways this session")}\n> `;
    },

    plan(value) {
      const plan = typeof value === "string" ? { goal: value, checkpoint: "", steps: [] } : value || {};
      writeLine(hang(`${status(paper, "plan")} ${paper.bold("Updated Plan")}`));
      if (plan.goal) for (const [index, line] of wrapText(`Goal  ${safeText(plan.goal)}`, Math.max(16, flowWidth - 2)).entries()) writeLine(hang(`${index ? "      " : "  "}${line}`));
      if (plan.checkpoint) for (const [index, line] of wrapText(`Checkpoint  ${safeText(plan.checkpoint)}`, Math.max(16, flowWidth - 2)).entries()) writeLine(hang(`${index ? "            " : "  "}${line}`));
      for (const step of Array.isArray(plan.steps) ? plan.steps.slice(0, 8) : []) {
        const state = String(step?.status || "pending");
        const mark = state === "completed" ? paper.green("✓") : state === "in_progress" ? paper.gold("◌") : paper.dim("□");
        const style = state === "in_progress" ? paper.bold : state === "completed" ? paper.dim : value => value;
        const lines = wrapText(safeText(step?.label || ""), Math.max(16, flowWidth - 6));
        lines.forEach((line, index) => writeLine(hang(`${index ? "    " : `  ${mark} `}${style(line)}`)));
      }
      writeLine();
    },
    usage(usage, ms, { stderr = false } = {}) {
      const count = value => Number(value) || 0;
      const rows = [["input (uncached)", count(usage.input)], ["cache write", count(usage.cacheWrite)], ["cache read", count(usage.cacheRead)], ["output", count(usage.output)]];
      const total = rows.reduce((sum, [, value]) => sum + value, 0);
      const lines = [`used: ${total} tokens / ${duration(ms)}`, ...rows.map(([label, value]) => `  ${label.padEnd(17)}${value}`)];
      for (const line of lines) {
        if (stderr) writeError(errorInk.dim(line));
        else writeLine(paper.dim(line));
      }
    },
    setVerbose(value) { verbose = Boolean(value); },
    isVerbose() { return verbose; },
    attachComposer(value) { composer = value || null; },
    hasComposer() { return Boolean(composer); },
    // Waiting is not one state with one name. The word rotates slowly through the postures of
    // attention so the wait reads as someone present, and it never claims more than posture.
    turnStart() {
      if (!composer && !live) return;
      clearActivity();
      waitingIndex = waitingStart();
      // Two things move on this row at two speeds, and they share one timer. The word rotates
      // slowly — a label that changes faster than it can be read is a spinner wearing words — while
      // the meter has to move every second to mean anything, so the interval runs at the second and
      // the word is swapped only when its own cadence comes round. A second interval for the same
      // row would be a second thing to forget to clear, and forgetting one is how a process ends up
      // held open by decoration.
      const rotateEvery = Math.max(1, Math.round(WAITING_ROTATION_MS / TURN_METER_MS));
      // Only a turn presence is actually watching has numbers. An unobserved turn keeps quiet
      // rather than showing a clock that started from nothing — the wait is still honest without it.
      const meter = () => {
        const turn = board.mainTurn;
        return turn?.active ? ` ${paper.dim(`(${formatSpend(turn.elapsedMs, turn.tokens)})`)}` : "";
      };
      const paint = () => write(`\r\x1b[2K${paper.sand(`● ${waitingWord(waitingIndex)}…`)}${meter()}`);
      // The composer paints its own meter (it redraws on presence's own tick), so the label is
      // handed over only when the word changes: setActivity restarts the breath, and a breath
      // restarted every second is not a breath.
      if (composer) composer.setActivity(waitingWord(waitingIndex), "thinking");
      else paint();
      activeTool = true;
      let ticks = 0;
      waitingTimer = setInterval(() => {
        const rotate = ++ticks % rotateEvery === 0;
        if (rotate) waitingIndex += 1;
        if (composer) { if (rotate) composer.setActivity(waitingWord(waitingIndex), "thinking"); return; }
        paint();
      }, TURN_METER_MS);
      waitingTimer.unref?.();
    },
    turnEnd() { clearActivity(); },
    error(message) { notice("error", message, { stderr: true }); },
    warn(message) { notice("warning", message, { stderr: true }); },
    block(message) { writeLine(safeText(message)); },
    done(message) { notice("done", message); },
    progress(message) { notice("progress", message); },
    info(message) { notice("info", message); },
  };
  return terminal;
}

export const ui = createUI();
