// Persistent, zero-dependency terminal composer. It owns only ephemeral input
// state: messages still become append-only session events in cli.js, and the
// composer never writes drafts, popup state or animation frames to disk.
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { commandMatches, keyHelpRows, matchedCommandToken, SLASH_COMMANDS } from "./commands.js";
import { createFrameState, displayWidth, fitAnsi, FrameWriter, layoutFrame, reduceFrame, wrapText } from "./frame.js";
import { BREATHING_CADENCE_MS, createInputState, reduceInput } from "./input-state.js";
import { presence as sharedPresence } from "./presence.js";
import { formatSpend, inputStyle, inputTheme, themeFromRgb } from "./ui.js";
export { displayWidth } from "./frame.js";
export { KEY_HELP, keyHelpRows } from "./commands.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const BACKGROUND_PREFIX = "\x1b]11;";
const BACKGROUND_QUERY = "\x1b]11;?\x07";
const BACKGROUND_RESPONSE = /^\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i;
// The terminal modes the composer borrows while it is on screen, written as one pair on purpose:
// every way back out of raw mode writes MODES_OFF whole, so an exit, a $EDITOR handover and a
// crash all hand the owner's shell back exactly as it was found. A keyboard protocol left on is
// worse than one never asked for — the shell that inherits it cannot read its own keys.
//
// `\x1b[>4;1m` is xterm's modifyOtherKeys at level 1. Level 1 only adds an encoding for chords
// the terminal has no other way to spell; every byte this composer already reads — Ctrl-A/E/K/U/W,
// Ctrl-C/D/G/J/L/O/R/T/V, Alt-B/F/D, Enter, Tab, Backspace — keeps its legacy form. Level 2 would
// re-encode those same ordinary keys as `CSI 27;mod;code~`, so the whole control-byte table in
// handleCharacter() would go dark at once and a reset that failed to run would leave the owner
// typing into a shell that no longer understands Ctrl-C. What level 2 buys over level 1 is
// Shift-Enter on xterm proper, which exempts Enter from level 1 as a "well-known" key; one key is
// not worth every other key, and the kitty push below covers it wherever it can be covered at all.
//
// `\x1b[>1u` pushes flag 1 of the kitty keyboard protocol (disambiguate escape codes) — this is
// what actually delivers Shift-Enter as `CSI 13;2u` on kitty, ghostty, foot, WezTerm, Konsole and
// recent iTerm2. Under flag 1 an unmodified Enter is still `\r`, so sending a message is unchanged;
// only modified chords gain an encoding. `\x1b[<u` pops exactly the one entry that was pushed.
const MODES_ON = "\x1b[?2004h\x1b[?25l\x1b[>4;1m\x1b[>1u";
const MODES_OFF = "\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?25h";
export const ACTIVITY_PULSE_MS = BREATHING_CADENCE_MS.calm;
// How long the second Esc of a rewind has to arrive. Nothing waits on this window: the first Esc
// still does its own job immediately (close a menu, close the command list, stop the turn), and the
// pair only means "rewind" in the one case where a single Esc has nothing to do — an idle composer.
export const DOUBLE_ESCAPE_MS = 600;
// How many helper rows the input box will carry before it stops growing. Four is the whole budget:
// every row here is a row of the page the transcript no longer has, and a fifth helper is told
// about in a word (`… +3`) rather than in a line. A board that can push the conversation off the
// screen has stopped being furniture and become the application.
export const AGENT_ROWS_MAX = 4;
// One dim line so the panel can be found without being looked for. It is only ever painted when
// there is something to open — a hint under an empty board is furniture advertising itself.
export const AGENT_VIEW_HINT = "ctrl+f view agents";
export const INPUT_FRAME = Object.freeze({ rows: 3, sideCells: 2, cursorPrefixCells: 3, edge: "│", edgeInk: "\x1b[38;5;214m" });
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
// The transcript ring's default depth. A terminal is at most ~100 rows, so this is roughly
// twenty screens the composer can put back on the page, at a few hundred bytes a line.
export const TRANSCRIPT_LINES = 2000;
// What a line keeps on the way into the ring: colour, and nothing else. A replayed line must
// never move the cursor, erase the page or touch the scroll region — that is paint()'s and
// writeTranscriptLine()'s job alone, and a banner's own `\x1b[2J` would otherwise wipe the
// screen halfway through a replay.
const inkOnly = value => String(value).split(/(\x1b\[[0-?]*[ -/]*[@-~])/g)
  .map((part, index) => index % 2 ? (part.endsWith("m") ? part : "") : part.replace(/[\r\x1b]/g, ""))
  .join("");

export function supportsComposer(input = process.stdin, output = process.stdout, env = process.env) {
  return Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === "function")
    && !has(env, "NO_COLOR") && String(env?.TERM || "").toLowerCase() !== "dumb";
}

export function cleanPaste(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\x00/g, "");
}

// One line of the input, made safe to print. It is applied per character on purpose: the field
// has a cursor now, so the composer has to be able to render "everything before the cursor" and
// "everything after it" separately and still get exactly what `visible(buffer)` would give.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const visibleChar = character => character === "\t" ? "  " : character === "\n" ? " ↵ "
  : CONTROL.test(character) ? `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}` : character;
const visible = value => Array.from(String(value || "")).map(visibleChar).join("");
const stripAnsi = value => String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
// Word boundaries for Alt-B/Alt-F/Alt-D/Ctrl-W, counted in graphemes so a word never splits a
// CJK run in the middle of a character.
const WORD = /\p{L}|\p{N}|_/u;
export const wordLeft = (characters, from) => {
  let at = from;
  while (at > 0 && !WORD.test(characters[at - 1])) at--;
  while (at > 0 && WORD.test(characters[at - 1])) at--;
  return at;
};
export const wordRight = (characters, from) => {
  let at = from;
  while (at < characters.length && !WORD.test(characters[at])) at++;
  while (at < characters.length && WORD.test(characters[at])) at++;
  return at;
};
const cellWidth = character => {
  const code = character.codePointAt(0);
  if (code === 0x200d || (code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)
  ) ? 2 : 1;
};
const fitFromEnd = (value, width) => {
  const characters = Array.from(String(value || ""));
  let used = 0; let start = characters.length;
  while (start > 0 && used + cellWidth(characters[start - 1]) <= width) used += cellWidth(characters[--start]);
  return characters.slice(start).join("");
};
const fitFromStart = (value, width) => {
  const characters = Array.from(String(value || ""));
  let used = 0; let end = 0;
  while (end < characters.length && used + cellWidth(characters[end]) <= width) used += cellWidth(characters[end++]);
  return characters.slice(0, end).join("");
};

// A small beam moving through the word says "alive" without turning the whole frame into a
// spinner. The label never changes width; reduced-motion keeps one steady gold, and plain sinks
// keep the word itself. That invariant lets paint() replace just this row on each pulse.
export function goldenSweep(value, pulse = 0, { reduced = false, plain = false } = {}) {
  const text = String(value || "Working");
  if (plain) return text;
  if (reduced) return `\x1b[1;38;5;214m${text}\x1b[0m`;
  const characters = Array.from(text);
  const at = Number(pulse || 0) % (characters.length + 4) - 2;
  return characters.map((character, index) => {
    const distance = Math.abs(index - at);
    const ink = distance === 0 ? "1;38;2;255;225;92" : distance === 1 ? "1;38;5;220" : "1;38;5;179";
    return `\x1b[${ink}m${character}`;
  }).join("") + "\x1b[0m";
}


export class TerminalComposer extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, env = process.env, commands = SLASH_COMMANDS, columns, transcriptLines, presence = sharedPresence } = {}) {
    super();
    this.input = input;
    this.output = output;
    this.env = env;
    this.inputThemeMode = inputTheme(env);
    this.fieldTheme = this.inputThemeMode === "auto" ? null : this.inputThemeMode;
    this.commands = commands;
    // The board is read, never owned: the composer asks presence what is there each time it draws
    // and keeps no copy that could go stale. The only thing it holds is the subscription, and that
    // is held exactly as long as the terminal is.
    this.presence = presence;
    this.unwatch = null;
    this.columns = Math.max(32, Number(columns || output.columns || 80));
    this.rows = Math.max(0, Number(output.rows || 0));
    this.frameState = createFrameState({ columns: this.columns, rows: this.rows });
    this.inputState = createInputState();
    this.writer = new FrameWriter(output);
    this.pinned = this.rows >= 8 && !has(env, "HCODE_INLINE_COMPOSER");
    this.buffer = "";
    // Where the next character goes, counted in graphemes of `buffer`. Before 0.8 the field was
    // append-only and the cursor was always the end, so Ctrl-A/E, Alt-B/F and ← / → had nowhere
    // to point; everything that edits the buffer now goes through setBuffer() and carries it.
    this.cursor = 0;
    this.pasteTail = "";
    this.history = [];
    this.historyIndex = -1;
    this.selection = 0;
    this.busy = false;
    this.meter = null;
    this.queueCount = 0;
    this.activity = null;
    this.attachments = [];
    this.attachmentStatus = "";
    this.question = null;
    this.savedDraft = "";
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.pasting = false;
    this.paste = "";
    this.started = false;
    this.drawnRows = 0;
    this.paintedRows = [];
    this.cursorTail = 0;
    this.scrollBottom = 0;
    this.pulse = 0;
    this.pulseTimer = null;
    // Next transcript row (1-based) in pinned mode. Output fills the page from the top down,
    // like a document, and only starts scrolling once it reaches the input box — instead of
    // appearing at the bottom above the box with the banner stranded at the top. `scrollBottom + 1`
    // means "full": every row of the region is written on and the next line has to scroll.
    this.transcriptRow = 1;
    // The transcript ring: a bounded, oldest-first record of every line the composer has put on
    // the page. Without it a line that scrolled out of the region was gone for good, so a reflow
    // or a frame that gave rows back could only leave a blank band; with it the page is a
    // function of (ring, frame) and can be repainted at any width. Oldest lines are dropped once
    // the ring is full — the page still works, it just cannot grow back past what is left.
    const depth = Math.floor(Number(transcriptLines ?? env?.HCODE_TRANSCRIPT_LINES));
    this.transcriptLimit = Number.isFinite(depth) && depth >= 0 ? depth : TRANSCRIPT_LINES;
    this.transcript = [];
    this.transcriptHead = 0;
    this.transcriptDropped = 0;
    // An open arrow-key menu (select()); while set, keys drive the menu instead of the input.
    this.menu = null;
    // An open read-only panel: `?` (the key table) and Ctrl-O (the transcript) are the same widget.
    this.pager = null;
    // An open Ctrl-R reverse search over the input history.
    this.search = null;
    this.suspended = false;
    this.escapeTimer = null;
    this.lastEscape = 0;
    this.onData = data => this.feed(this.decoder.write(data));
    this.onResize = () => {
      const columns = Math.max(32, Number(this.output.columns || 80));
      const rows = Math.max(0, Number(this.output.rows || 0));
      // Any resize invalidates every row number the composer is holding. A width change makes
      // the terminal rewrap the whole page, our rules and key hint included — an 80-column rule
      // comes back as 64 + 16 and the transcript slides by however many rows that added — and a
      // height change moves the frame onto rows the transcript was using. So the page is wiped
      // and repainted from the ring at the new geometry, instead of the row-by-row patching
      // that left stray rule fragments behind on every zoom (0.4.0) or, once that was fixed by
      // giving up on the page, a blank screen where the conversation had been (0.6.0).
      this.drawnRows = 0;
      this.paintedRows = [];
      this.cursorTail = 0;
      this.resetScrollRegion();
      // The old page goes into the scrollback only when the ring cannot put it back; when it
      // can, the replay in paint() rewrites exactly these lines and a second copy is noise.
      const shown = Math.max(0, this.transcriptRow - 1);
      const restorable = this.transcript.length > 0 && this.transcriptTail(shown, columns).rows === shown;
      if (rows && !restorable) this.writer.write(`\x1b[${rows}S`);
      this.writer.write("\x1b[H\x1b[J");
      this.transcriptRow = 1;
      this.columns = columns;
      this.rows = rows;
      this.frameState = reduceFrame(this.frameState, { type: "resize", columns: this.columns, rows: this.rows });
      this.pinned = this.rows >= 8 && !has(this.env, "HCODE_INLINE_COMPOSER");
      this.draw();
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    this.output.on?.("resize", this.onResize);
    // A helper starting, finishing, or simply having been running one second longer is a change to
    // the frame, and presence is the only thing that knows. The subscription lives and dies with
    // the terminal for the same reason the resize listener does; presence's own tick is unref'd, so
    // watching a board nobody is looking at costs nothing and holds nothing open.
    this.unwatch = this.presence?.subscribe?.(() => this.onPresence()) || null;
    this.writer.write(MODES_ON + (this.inputThemeMode === "auto" ? BACKGROUND_QUERY : ""));
    this.draw();
  }

  // Presence changed. A panel reading one helper's conversation is re-read first — the helper is
  // still writing it — and then the whole frame is repainted through the one path that paints.
  // Nothing here writes to the terminal itself: draw() is the only door, and while $EDITOR has the
  // terminal there is no door at all.
  onPresence() {
    if (!this.started || this.suspended) return;
    this.refreshAgentPager();
    this.draw();
  }

  close() {
    if (!this.started) return;
    if (this.question) {
      const { resolve } = this.question;
      this.question = null;
      resolve("");
    }
    if (this.menu) { const { resolve } = this.menu; this.menu = null; resolve(null); }
    this.pager = null;
    this.search = null;
    this.stopPulse();
    this.unwatch?.(); this.unwatch = null;
    clearTimeout(this.escapeTimer); this.escapeTimer = null;
    const wasPinned = this.pinned;
    this.erase();
    this.resetScrollRegion();
    this.input.off("data", this.onData);
    this.output.off?.("resize", this.onResize);
    try { this.input.setRawMode(false); } catch { /* terminal already closed */ }
    const restore = `${wasPinned && this.rows ? `\x1b[${this.rows};1H\x1b[2K` : ""}${MODES_OFF}`;
    try { this.writer.write(restore); } catch { /* best effort when the terminal has already disappeared */ }
    this.input.pause?.();
    this.started = false;
  }

  setBusy(value) { this.busy = Boolean(value); this.draw(); }
  // cost.js remains the truth for the meter. The footer projects only the two facts the owner
  // needs continuously — model and context remaining — while /cost and /status keep the complete
  // token/cost account. Pull the already-formatted context phrase out whole; never recompute it.
  setMeter(value) {
    if (!value?.text) this.meter = null;
    else {
      const text = String(value.text); const context = /(?:^| · )(Context \d+% left)(?: · |$)/.exec(text)?.[1] || "";
      this.meter = { text, context, identity: value.identity && typeof value.identity === "object" ? { ...value.identity } : null, band: String(value.band || "calm") };
    }
    this.draw();
  }
  setQueueCount(value) { this.applyInput({ type: "queue.set", count: value }); this.draw(); }
  addAttachment(image) { this.attachments.push(image); this.attachmentStatus = ""; this.draw(); }
  setAttachmentStatus(value) { this.attachmentStatus = String(value || ""); this.draw(); }

  setActivity(label, kind = "work") {
    this.activity = label ? { label: String(label), kind, startedAt: Date.now() } : null;
    if (this.activity && !has(this.env, "HCODE_REDUCE_MOTION")) this.startPulse();
    else this.stopPulse();
    this.draw();
  }

  clearActivity() { this.activity = null; this.stopPulse(); this.draw(); }

  startPulse() {
    if (this.pulseTimer) return;
    const cadence = this.activity?.kind === "stream" ? "stream" : this.activity?.kind === "waiting" ? "calm" : "active";
    this.pulseTimer = setInterval(() => { this.pulse++; this.draw(); }, BREATHING_CADENCE_MS[cadence]);
    this.pulseTimer.unref?.();
  }

  stopPulse() { if (this.pulseTimer) clearInterval(this.pulseTimer); this.pulseTimer = null; this.pulse = 0; }

  applyInput(event) {
    this.inputState = reduceInput(this.inputState, event);
    this.buffer = this.inputState.buffer; this.paste = this.inputState.paste; this.pasting = this.inputState.pasting;
    this.queueCount = this.inputState.queueCount; this.selection = this.inputState.slash.selection;
    this.cursor = Math.max(0, Math.min(this.cursor, Array.from(this.buffer).length));   // the cursor never leaves the text
  }

  // Every buffer edit in one place, so the cursor can never end up outside the text it points into.
  // `cursor === null` means "put it at the end", which is what a fresh draft, a restored draft and
  // an accepted history line all want.
  chars() { return Array.from(this.buffer); }
  setBuffer(value, cursor = null) {
    const text = String(value ?? "");
    const size = Array.from(text).length;
    this.cursor = Math.max(0, Math.min(size, cursor === null ? size : Number(cursor) || 0));
    this.applyInput({ type: "buffer.set", value: text });
    this.buffer = text;
  }

  // What the input row shows and where the terminal cursor goes, given the room the box has.
  // With the cursor at the end this is exactly what the append-only field used to render; the
  // other two branches are what a cursor in the middle of a long line needs.
  inputView(max) {
    const characters = this.chars();
    const before = visible(characters.slice(0, this.cursor).join(""));
    const after = visible(characters.slice(this.cursor).join(""));
    const head = displayWidth(before); const tail = displayWidth(after);
    if (head + tail <= max) return { field: before + after, column: head };
    if (head < max) return { field: `${before}${fitFromStart(after, Math.max(0, max - head - 1))}…`, column: head };
    const room = Math.min(tail, Math.max(0, Math.floor(max / 4)));
    const shown = fitFromEnd(before, Math.max(1, max - 1 - room));
    return { field: `…${shown}${fitFromStart(after, room)}`, column: 1 + displayWidth(shown) };
  }

  async ask(prompt) {
    if (this.question) throw new Error("the composer is already waiting for an owner decision");
    this.pager = null; this.search = null;
    const normalized = typeof prompt === "object" ? String(prompt.prompt || "") : String(prompt || "");
    const rows = stripAnsi(normalized).split("\n").map(row => row.trim()).filter(row => row && row !== ">");
    this.savedDraft = this.buffer;
    this.setBuffer("");
    this.selection = 0;
    return new Promise(resolve => {
      this.question = { label: rows.at(-1) || "Your answer", resolve };
      this.draw();
    });
  }

  // Arrow-key chooser: title between two rules, one row per option with its description in a
  // second column (selected row bright, the rest dim), Enter confirms, Esc goes back. Resolves
  // the chosen index, or null when the owner backs out. Digits jump, j/k also move.
  select({ title = "", subtitle = "", options = [], initial = 0, hint = "" } = {}) {
    if (this.question || this.menu) throw new Error("the composer is already waiting for an owner decision");
    if (!options.length) return Promise.resolve(null);
    this.pager = null; this.search = null;
    this.savedDraft = this.buffer;
    this.setBuffer("");
    return new Promise(resolve => {
      this.menu = { title, subtitle, options, hint, index: Math.max(0, Math.min(options.length - 1, Number(initial) || 0)), resolve };
      this.draw();
    });
  }

  finishMenu(value) {
    if (!this.menu) return;
    const { resolve } = this.menu;
    this.menu = null;
    this.setBuffer(this.savedDraft);
    this.savedDraft = "";
    this.draw();
    resolve(value);
  }

  handleMenuKey(key) {
    const menu = this.menu;
    if (key === "\x1b[A" || key === "k") menu.index = (menu.index + menu.options.length - 1) % menu.options.length;
    else if (key === "\x1b[B" || key === "j") menu.index = (menu.index + 1) % menu.options.length;
    else if (key === "\r" || key === "\n") return this.finishMenu(menu.index);
    else if (key === "\x1b" || key === "q" || key === "\x03") return this.finishMenu(null);
    else if (/^[1-9]$/.test(key) && Number(key) <= menu.options.length) menu.index = Number(key) - 1;
    else return;
    this.draw();
  }

  // One footer row, in semantic order: the action the owner can take now, model, context remaining.
  // A fact is either present in full or absent. Narrow terminals stop at the last complete fact,
  // so terminal wrapping can never turn a model or budget into an unexplained fragment. The words
  // carry the meaning; colour is only a second channel for the context band.
  static BAND_INK = Object.freeze({ calm: "\x1b[38;5;6m", warn: "\x1b[38;5;3m", danger: "\x1b[1;38;5;1m" });

  statusRows(action) {
    const gutter = "  ";
    const width = Math.min(Math.max(0, this.columns - 4), 92);
    const facts = [
      { text: visible(action), ink: "\x1b[2m" },
      { text: visible(this.meter?.identity?.model), ink: "\x1b[33m" },
      { text: this.meter?.context || "", ink: TerminalComposer.BAND_INK[this.meter?.band] || TerminalComposer.BAND_INK.calm },
    ];
    const kept = [];
    for (const fact of facts) {
      if (!fact.text) continue;
      const candidate = [...kept.map(item => item.text), fact.text].join(" · ");
      if (displayWidth(candidate) > width) break;
      kept.push(fact);
    }
    const row = kept.map(fact => `${fact.ink}${fact.text}\x1b[0m`).join("\x1b[2m · \x1b[0m");
    return [`${gutter}${row}`];
  }

  // The ink of the input band: a light ground with dark text on it, the same field colour the
  // readline prompt in ui.js uses, so the place the owner speaks looks the same in both paths.
  // An indexed grey rather than ANSI black (30): a theme is free to repaint the sixteen legacy
  // colours, and a "black" some theme has made light is invisible on a near-white ground.
  // One row of the input band, painted edge to edge. ANSI has no alpha, so a background that
  // stops where the text stops leaves a transparent notch down the right of every row — which
  // reads as a rendering bug, not as a field. The row is padded to the full width before the ink
  // is reset, and it is rebuilt every draw, so a zoom simply paints a wider rectangle.
  fieldRow(content = "") {
    const inner = Math.max(0, this.columns - INPUT_FRAME.sideCells);
    const pad = Math.max(0, inner - displayWidth(content));
    const edge = `${INPUT_FRAME.edgeInk}${INPUT_FRAME.edge}\x1b[0m`;
    return `${edge}${inputStyle(this.fieldTheme || "auto").row}${content}${" ".repeat(pad)}\x1b[0m${edge}`;
  }

  // Colour only a command hcode can resolve exactly. The reset restores the field's own dark ink,
  // not the terminal default, because the whole row remains inside FIELD_INK. ANSI adds no cells,
  // so cursor and CJK width arithmetic continue to use the untouched plain `field` string.
  commandField(field) {
    const token = matchedCommandToken(this.buffer, this.commands);
    if (!token) return field;
    const shown = visible(token);
    if (!field.startsWith(shown)) return field;
    const style = inputStyle(this.fieldTheme || "auto");
    return `${style.command}${shown}\x1b[22m${style.text}${field.slice(shown.length)}`;
  }

  // The dim rule under a dialog's title; rebuilt only when the width changes. The input box no
  // longer uses one — whitespace reflows on a zoom and a rule does not — so what is left is
  // furniture inside the live frame, which is repainted at the current width every draw.
  dimRule(max = 96) {
    const width = Math.min(this.columns, max);
    if (this.ruleWidth !== width) { this.ruleWidth = width; this.rule = "\x1b[2m" + "─".repeat(width) + "\x1b[0m"; }
    return this.rule;
  }

  // The page was cleared by whoever draws the banner: the transcript starts again at row 1 and
  // the ring goes with it — nothing above is ours to put back. Listeners that mirror the
  // transcript hear it too. A resize no longer comes through here: the ring survives a reflow.
  resetTranscript() {
    this.transcriptRow = 1;
    this.transcript = [];
    this.transcriptHead = 0;
    this.transcriptDropped = 0;
    if (this.pager?.live) { this.pager.lines = []; this.pager.width = 0; }
    this.emit("transcript-reset");
  }

  // Append to the ring, dropping the oldest line once it is full. An open transcript view reads the
  // same lines, so it is told here rather than polling: a reader parked at the end keeps seeing the
  // newest output, and one who scrolled up stays exactly where they put themselves.
  remember(lines) {
    for (const raw of lines) {
      const line = inkOnly(raw);
      if (this.pager?.live) {
        this.pager.lines.push(line); this.pager.width = 0;
        const cap = Math.max(200, this.transcriptLimit);      // bounded like the ring it mirrors
        if (this.pager.lines.length > cap) this.pager.lines.splice(0, this.pager.lines.length - cap);
      }
      if (!this.transcriptLimit) { this.transcriptDropped++; continue; }
      if (this.transcript.length < this.transcriptLimit) { this.transcript.push(line); continue; }
      this.transcript[this.transcriptHead] = line;
      this.transcriptHead = (this.transcriptHead + 1) % this.transcriptLimit;
      this.transcriptDropped++;
    }
  }

  // The newest lines of the ring, oldest-first, that cover `rows` rendered rows at `columns`
  // (fewer when the ring holds less than that). `rows` is capped at what was asked for, so a
  // line taller than the room left reads as "the region is full", not as an overshoot.
  transcriptTail(rows, columns = this.columns) {
    const width = Math.max(1, Number(columns) || 1);
    const want = Math.max(0, Number(rows) || 0);
    const lines = []; let used = 0;
    for (let index = this.transcript.length - 1; index >= 0 && used < want; index--) {
      const line = this.transcript[(this.transcriptHead + index) % this.transcript.length];
      used += Math.max(1, Math.ceil(displayWidth(line) / width));
      lines.unshift(line);
    }
    return { lines, rows: Math.min(used, want) };
  }

  // Repaint the transcript region from the ring: clear the rows the composer owns and put the
  // tail back through the same path a live line takes. Only rows 1..scrollBottom are touched —
  // paint() writes the frame under them — and nothing is added back to the ring.
  replayTranscript(tail = this.transcriptTail(this.scrollBottom)) {
    if (!this.pinned || !this.scrollBottom) return;
    this.writer.write("\x1b[?25l");
    for (let row = this.scrollBottom; row >= 1; row--) this.writer.write(`\x1b[${row};1H\x1b[2K`);
    this.transcriptRow = 1;
    for (const line of tail.lines) this.writeTranscriptLine(line);
  }

  // One transcript line onto the page at the row the composer says is next, scrolling the region
  // explicitly when the line does not fit. Letting the line's own trailing newline scroll the
  // region instead — what 0.6.0 did — moved the page without telling the composer: it clamped
  // its next row to scrollBottom, so the bottom row of the region stayed blank for ever and the
  // page ran one line short of what a fresh repaint of the same state paints.
  writeTranscriptLine(line, sink = value => this.writer.write(value)) {
    const used = Math.max(1, Math.ceil(displayWidth(line) / this.columns));
    const need = Math.min(used, this.scrollBottom);
    const scroll = Math.max(0, need - (this.scrollBottom - this.transcriptRow + 1));
    if (scroll) { this.writer.write(`\x1b[${scroll}S`); this.transcriptRow = Math.max(1, this.transcriptRow - scroll); }
    for (let row = need - 1; row >= 0; row--) this.writer.write(`\x1b[${this.transcriptRow + row};1H\x1b[2K`);
    sink(line);
    this.transcriptRow = Math.min(this.scrollBottom + 1, this.transcriptRow + used);
  }

  menuRows() {
    const { title, subtitle, options, hint, index } = this.menu;
    const width = Math.min(this.columns, 96);
    // One short rule under the title, not a full-width box: the question is the title and the
    // rows, and furniture wider than the question only makes the question harder to find.
    const labels = options.map((option, i) => `${i + 1}. ${option.label}${option.current ? " (current)" : ""}`);
    const labelWidth = Math.min(Math.max(...labels.map(displayWidth)) + 2, Math.floor(width / 2));
    const descWidth = Math.max(16, width - 2 - labelWidth);
    const rows = ["", `  \x1b[1m${title}\x1b[0m`];
    if (subtitle) rows.push(`  \x1b[2m${subtitle}\x1b[0m`);
    rows.push(this.dimRule(64));
    let cursorRow = rows.length;
    options.forEach((option, i) => {
      const on = i === index;
      if (on) cursorRow = rows.length;
      const lines = wrapText(option.description || "", descWidth);
      const pad = " ".repeat(Math.max(1, labelWidth - displayWidth(labels[i])));
      const ink = on ? "\x1b[1m" : "\x1b[2m";
      rows.push(`${on ? "\x1b[38;5;214m›\x1b[0m" : " "} ${ink}${labels[i]}\x1b[0m${pad}${ink}${lines[0] || ""}\x1b[0m`);
      for (const line of lines.slice(1)) rows.push(`  ${" ".repeat(labelWidth)}${ink}${line}\x1b[0m`);
    });
    rows.push("", `\x1b[2m${hint || "Press enter to confirm or esc to go back"}\x1b[0m`);
    return { rows, cursorRow, cursorColumn: 1 };
  }

  // ---- the panel: `?` key help and Ctrl-O transcript ------------------------------------------
  // One read-only page over the input box, scrolled with the arrows and searched with `/`. Both
  // callers hand it plain lines; it owns nothing but where the window sits, so closing it leaves
  // the draft, the history and the ring exactly as they were.
  openPager({ title = "", lines = [], hint = "", note = "", searchable = false, follow = false, live = false } = {}) {
    if (this.question || this.menu) return false;
    this.pager = { title, lines: lines.map(String), hint, note, searchable, live, top: 0, follow, width: 0, view: [], query: "", typing: false, matches: [], match: -1 };
    this.draw();
    return true;
  }

  // Ctrl-O: read the page back. The ring is already the record of everything the composer put on
  // the screen, so this is the same lines through the same panel — no second buffer, no capture of
  // the terminal, and nothing the owner can scroll to that hcode did not itself print. It follows
  // new output while the reader is at the end, and stops following the moment they scroll up.
  openTranscript() {
    if (this.pager) { this.closePager(); return false; }
    const lines = this.transcriptLines();
    return this.openPager({
      title: "Transcript", searchable: true, follow: true, live: true,
      lines: lines.length ? lines : ["\x1b[2m(nothing has been printed on this page yet)\x1b[0m"],
      // The ring is bounded, so the view has to say what it cannot show rather than look complete.
      note: this.transcriptDropped ? `${this.transcriptDropped} older line${this.transcriptDropped === 1 ? "" : "s"} have left the ring` : "",
      hint: "↑↓ line · PgUp/PgDn page · g/G ends · / searches · esc or Ctrl-O closes",
    });
  }

  // The whole ring, oldest first.
  transcriptLines() {
    const out = [];
    for (let index = 0; index < this.transcript.length; index++) out.push(this.transcript[(this.transcriptHead + index) % this.transcript.length]);
    return out;
  }

  closePager() { if (!this.pager) return; this.pager = null; this.draw(); }

  // How many body rows the panel may use. The frame has to stay shorter than the terminal or
  // layoutFrame() drops to inline mode and the page stops being pinned, and reduceFrame keeps at
  // most 64 live rows — so the panel is bounded by both, never by the length of what it shows.
  pagerHeight() {
    const room = this.rows ? this.rows - 8 : 16;
    return Math.max(3, Math.min(56, room));
  }

  pagerView() {
    const p = this.pager; const width = Math.min(this.columns, 96);
    if (p.width !== width) {
      p.width = width;
      // Wrapped, not truncated: a transcript line read back has to be readable in full. `\x1b[0m`
      // closes any colour a wrap point split, so a row can never bleed into the one below it.
      p.view = p.lines.flatMap(line => wrapText(line, width).map(row => `${row}\x1b[0m`));
      this.pagerFind(p.query, p.top);
    }
    return p.view;
  }

  pagerFind(query, from = 0) {
    const p = this.pager; const needle = String(query || "").toLowerCase();
    p.query = String(query || "");
    p.matches = needle ? p.view.map((row, index) => [stripAnsi(row).toLowerCase().includes(needle), index]).filter(([hit]) => hit).map(([, index]) => index) : [];
    const at = p.matches.findIndex(index => index >= from);
    p.match = p.matches.length ? Math.max(0, at) : -1;      // nothing below the window: wrap to the first hit
    if (p.match >= 0) this.pagerShow(p.matches[p.match]);
  }

  // Put `row` on the page with a little context above it, then clamp to the ends. Jumping to a
  // match is a deliberate place to be, so it stops the panel following new output.
  pagerShow(row) {
    const p = this.pager; const height = this.pagerHeight();
    p.top = Math.max(0, Math.min(Math.max(0, p.view.length - height), row - Math.floor(height / 3)));
    p.follow = false;
  }

  pagerScroll(delta) {
    const p = this.pager; const height = this.pagerHeight();
    const end = Math.max(0, this.pagerView().length - height);
    p.top = Math.max(0, Math.min(end, p.top + delta));
    p.follow = p.top >= end;      // back at the bottom means "keep showing me the newest"
  }

  pagerStep(delta) {
    const p = this.pager;
    if (!p.matches.length) return;
    p.match = (p.match + delta + p.matches.length) % p.matches.length;
    this.pagerShow(p.matches[p.match]);
  }

  handlePagerKey(key) {
    const p = this.pager; const height = this.pagerHeight();
    if (p.typing) {
      if (key === "\r" || key === "\n") { p.typing = false; this.pagerFind(p.query, p.top); }
      else if (key === "\x1b" || key === "\x03") { p.typing = false; this.pagerFind("", p.top); }
      else if (key === "\x7f" || key === "\b") { p.query = Array.from(p.query).slice(0, -1).join(""); }
      else if (key === "\x15") p.query = "";
      else if (key >= " " && !key.startsWith("\x1b")) p.query += key;
      else return;
      this.draw();
      return;
    }
    if (key === "\x1b" || key === "q" || key === "\x03" || key === "\r" || key === "\n" || key === "\x0f" || key === "\x06") return this.closePager();
    if (key === "\x1b[A" || key === "k") this.pagerScroll(-1);
    else if (key === "\x1b[B" || key === "j") this.pagerScroll(1);
    else if (key === "\x1b[5~" || key === "b") this.pagerScroll(-height);
    else if (key === "\x1b[6~" || key === " ") this.pagerScroll(height);
    else if (key === "g" || key === "\x1b[H") { p.top = 0; p.follow = false; }
    else if (key === "G" || key === "\x1b[F") this.pagerScroll(this.pagerView().length);
    else if (key === "/" && p.searchable) { p.typing = true; p.query = ""; }
    else if (key === "n") this.pagerStep(1);
    else if (key === "N") this.pagerStep(-1);
    else return;
    this.draw();
  }

  pagerRows() {
    const p = this.pager; const rule = this.dimRule(); const height = this.pagerHeight();
    const view = this.pagerView();
    if (p.follow) p.top = Math.max(0, view.length - height);
    p.top = Math.max(0, Math.min(Math.max(0, view.length - height), p.top));
    const body = view.slice(p.top, p.top + height);
    const at = p.match >= 0 ? p.matches[p.match] : -1;
    const where = view.length ? `${p.top + 1}–${Math.min(view.length, p.top + height)} of ${view.length}` : "empty";
    const rows = ["", rule, `  \x1b[1m${p.title}\x1b[0m  \x1b[2m${where}${p.matches.length ? ` · match ${p.match + 1}/${p.matches.length}` : ""}${p.note ? ` · ${p.note}` : ""}\x1b[0m`, rule];
    for (let index = 0; index < height; index++) {
      const row = p.top + index;
      rows.push(index < body.length ? `${row === at ? "\x1b[38;5;214m›\x1b[0m" : " "} ${body[index]}` : "");
    }
    rows.push(rule);
    const hint = p.typing ? `\x1b[38;5;214m/\x1b[0m${visible(p.query)}\x1b[2m — enter searches, esc clears\x1b[0m`
      : `\x1b[2m${p.hint || `↑↓ line · PgUp/PgDn page · g/G ends${p.searchable ? " · / searches, n/N steps" : ""} · esc closes`}\x1b[0m`;
    rows.push(hint);
    return { rows, cursorRow: rows.length - 1, cursorColumn: p.typing ? 2 + displayWidth(visible(p.query)) : 1 };
  }

  // ---- the board: who else is working, and what they are saying -------------------------------
  // A subagent is something that is *there*. The rows under the input box are that fact made
  // visible — not a log of what happened, which the transcript already keeps, but the answer to
  // "what is going on right now" available without asking for it.
  //
  // Every ink here is the one the rest of hcode already gives that meaning (ui.js's palette):
  // lavender is work still running and belongs to nothing else, green/red/amber are the plain
  // outcomes. The mark carries the state, so the state costs no words; the kind is ordinary text
  // because it is a fact, not news; everything else is dim, because a board that shouts is a board
  // the owner turns off.
  static AGENT_INK = Object.freeze({ working: "\x1b[38;5;140m", done: "\x1b[38;5;71m", failed: "\x1b[38;5;203m", cancelled: "\x1b[38;5;214m" });

  // Spawn order inside each half, running first. The list must not reshuffle itself while it is
  // being read — a row that moves under the eye is worse than a row that is late.
  agents() {
    let rows;
    try { rows = this.presence?.list?.() || []; } catch { return []; }   // the board is never a reason the box cannot be drawn
    return [...rows.filter(row => row.state === "working"), ...rows.filter(row => row.state !== "working")];
  }

  // `○ claude  Reading frame.js…  4m 34s · ↓ 109.7k tokens`. What gives way when the column is
  // narrow is the activity, never the clock: the clock is the answer to "is this stuck?", and a
  // truncated number would be a lie where a truncated sentence is only a sentence with an ellipsis.
  agentRow(row, width = Math.min(this.columns, 96)) {
    const ink = TerminalComposer.AGENT_INK[row.state] || "\x1b[2m";
    const kind = visible(row.kind || "agent");
    const meter = formatSpend(row.elapsedMs, row.tokens);
    const said = visible(row.activity || row.title || row.summary || "");
    const room = width - displayWidth(`○ ${kind}`) - 2 - 2 - displayWidth(meter);
    const what = displayWidth(said) <= room ? said : room > 1 ? `${fitFromStart(said, room - 1)}…` : "";
    return [`${ink}○\x1b[0m ${kind}`, ...(what ? [`\x1b[2m${what}\x1b[0m`] : []), `\x1b[2m${meter}\x1b[0m`].join("  ");
  }

  // Zero helpers is zero rows: no heading, no empty state, no reserved band. A session that has
  // never delegated anything should look exactly like one that cannot.
  agentRows() {
    const rows = this.agents();
    if (!rows.length) return [];
    const width = Math.min(this.columns, 96);
    const shown = rows.slice(0, AGENT_ROWS_MAX);
    const out = shown.map(row => this.agentRow(row, width));
    if (rows.length > shown.length) out.push(`\x1b[2m… +${rows.length - shown.length}\x1b[0m`);
    out.push(`\x1b[2m${AGENT_VIEW_HINT}\x1b[0m`);
    return out;
  }

  // The waiting word says someone is present; this says what the presence has cost so far. Only a
  // turn presence is watching has numbers — an unobserved turn shows none rather than a clock
  // counting from nothing.
  mainTurnMeter() {
    let turn;
    try { turn = this.presence?.mainTurn; } catch { return ""; }
    return turn?.active ? ` \x1b[2m(${formatSpend(turn.elapsedMs, turn.tokens)})\x1b[0m` : "";
  }

  // Ctrl-F: read one helper back. Ctrl-O reads the page; this reads a conversation that never
  // reached the page, because a subagent's thread is a whole thread and the row above is its
  // one-line projection. With one helper there is nothing to choose and the panel simply opens;
  // with several the composer's own chooser asks, and Esc anywhere leaves the draft as it was found.
  openAgents() {
    if (this.pager) { this.closePager(); return false; }
    const rows = this.agents();
    if (!rows.length || this.question || this.menu) return false;
    if (rows.length === 1) return this.openAgent(rows[0]);
    this.select({
      title: "Subagents", subtitle: "whose conversation should I open?",
      options: rows.map(row => ({ label: `${row.kind} · ${row.state}`, description: row.title || row.activity || row.summary || "" })),
      hint: "enter opens the conversation · esc goes back",
    }).then(index => { if (index !== null && rows[index]) this.openAgent(rows[index]); })
      .catch(() => { /* reading a helper back is never a reason the composer stops taking keys */ });
    return true;
  }

  openAgent(row) {
    const opened = this.openPager({
      title: `${row.kind}${row.title ? ` · ${row.title}` : ""}`, searchable: true, follow: true,
      lines: this.agentTranscript(row.id),
      // A finished helper's panel says how it finished, because the row that led here is about to
      // scroll out of mind and "done" and "failed" are not the same conversation.
      note: row.state === "working" ? "still working" : row.state,
      hint: "↑↓ line · PgUp/PgDn page · g/G ends · / searches · esc or Ctrl-F closes",
    });
    if (opened) { this.pager.agent = row.id; this.draw(); }
    return opened;
  }

  // Four roles, four inks, each the one hcode already uses for that voice: the owner is bold
  // because a reader scanning a long thread is looking for the questions, the helper's own words
  // are plain body text, a tool is the soft cyan hcode gives its own machinery everywhere, and the
  // machinery's remarks about the run are dim. A blank row between turns — a wall of text is a
  // record, not a conversation. Every line goes through visible(): a helper's output is the least
  // trusted text on this screen and must never be able to move the cursor.
  static ROLE_INK = Object.freeze({ owner: "\x1b[1m", agent: "", tool: "\x1b[38;5;75m", meta: "\x1b[2m" });

  agentTranscript(id) {
    let rows;
    try { rows = this.presence?.transcript?.(id) || []; }
    catch (error) { rows = [{ role: "meta", text: `its conversation could not be read: ${error.message}` }]; }
    const lines = [];
    for (const row of rows) {
      const ink = TerminalComposer.ROLE_INK[row?.role] ?? "";
      if (lines.length) lines.push("");
      for (const line of String(row?.text ?? "").split("\n")) lines.push(ink ? `${ink}${visible(line)}\x1b[0m` : visible(line));
    }
    return lines.length ? lines : ["\x1b[2m(this helper has not said anything yet)\x1b[0m"];
  }

  // A helper that is still working keeps writing, and the panel is the same reader Ctrl-O is: it
  // stays at the end while the reader is at the end, and stops the moment they scroll up. Dropping
  // the cached width is what asks pagerView() to rebuild — the panel owns where the window sits,
  // and re-reading the lines must not move it.
  refreshAgentPager() {
    const p = this.pager;
    if (!p?.agent) return;
    p.lines = this.agentTranscript(p.agent);
    p.width = 0;
  }

  // ---- Ctrl-R: reverse search over what the owner sent before ---------------------------------
  // It never sends. Enter puts the match in the box with the cursor at the end, so the owner reads
  // it (and can edit it) before it becomes a message.
  startSearch() {
    if (this.question || this.pager) return;
    this.search = { query: "", saved: this.buffer, savedCursor: this.cursor, index: this.history.length, match: "" };
    this.draw();
  }

  searchBack(from) {
    const s = this.search; const needle = s.query.toLowerCase();
    for (let index = Math.min(from, this.history.length) - 1; index >= 0; index--) {
      if (!needle || this.history[index].toLowerCase().includes(needle)) { s.index = index; s.match = this.history[index]; return true; }
    }
    return false;
  }

  finishSearch(accept) {
    const s = this.search;
    this.search = null;
    this.setBuffer(accept && s.match ? s.match : s.saved, accept && s.match ? null : s.savedCursor);
    this.historyIndex = -1;
    this.draw();
  }

  handleSearchKey(key) {
    const s = this.search;
    if (key === "\x12") { this.searchBack(s.index); this.draw(); return; }
    if (key === "\r" || key === "\n") return this.finishSearch(true);
    if (key === "\x1b" || key === "\x03" || key === "\x07") return this.finishSearch(false);
    if (key === "\x7f" || key === "\b") s.query = Array.from(s.query).slice(0, -1).join("");
    else if (key === "\x15") s.query = "";
    else if (key >= " " && key !== "\x7f" && !key.startsWith("\x1b")) s.query += key;
    else return;
    s.index = this.history.length; s.match = "";
    this.searchBack(this.history.length);
    this.draw();
  }

  // Ctrl-L: throw the painted page away and rebuild it from the ring. Nothing else in hcode can
  // repair a screen some other program scribbled on, and the ring makes it lossless.
  redraw() {
    if (!this.started) return;
    this.drawnRows = 0;
    this.cursorTail = 0;
    this.resetScrollRegion();
    this.writer.write("\x1b[H\x1b[J");
    this.transcriptRow = 1;
    this.draw();
  }

  // Ctrl-G hands the terminal to $EDITOR: raw mode off and every borrowed mode given back —
  // bracketed paste, both keyboard protocols, the cursor. An editor that inherited hcode's
  // keyboard would read its own keys wrong, so this pairs with start() exactly. cli.js
  // spawns the editor — the composer still writes no draft to disk — and resume() takes the
  // terminal back and repaints from the ring, so whatever the editor left on screen is gone.
  suspend() {
    if (!this.started || this.suspended) return;
    this.suspended = true;
    this.stopPulse();
    this.erase();
    this.resetScrollRegion();
    this.input.off("data", this.onData);
    try { this.input.setRawMode(false); } catch { /* terminal already closed */ }
    this.writer.write(`${this.pinned && this.rows ? `\x1b[${this.rows};1H\x1b[2K` : ""}${MODES_OFF}`);
    this.input.pause?.();
  }

  resume() {
    if (!this.started || !this.suspended) return;
    this.suspended = false;
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("data", this.onData);
    this.writer.write(MODES_ON + (this.inputThemeMode === "auto" ? BACKGROUND_QUERY : ""));
    if (this.activity && !has(this.env, "HCODE_REDUCE_MOTION")) this.startPulse();
    this.redraw();
  }

  print(value, target = this.output) {
    const text = String(value || "");
    if (text) this.frameState = reduceFrame(this.frameState, { type: "transcript.committed", count: 1 });
    // Everything the composer prints is a whole line (a value without one gets a newline), so
    // the ring is line-addressed and a replay never has to guess where a row ends.
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    this.remember(lines);
    const sink = target === this.output ? value => this.writer.write(value) : value => target.write(value);
    if (this.pinned && this.scrollBottom) {
      this.writer.write("\x1b[?25l");
      for (const line of lines) this.writeTranscriptLine(line, sink);
    } else {
      this.erase();
      sink(text);
      if (text && !text.endsWith("\n")) sink("\n");
    }
    this.draw();
  }

  suggestions() {
    if (this.question || !this.buffer.startsWith("/") || /\s/.test(this.buffer)) return [];
    return commandMatches(this.buffer, this.commands);
  }

  feed(value) {
    this.pending += String(value || "");
    for (;;) {
      const background = BACKGROUND_RESPONSE.exec(this.pending);
      if (background) {
        this.pending = this.pending.slice(background[0].length);
        const detected = themeFromRgb(background[1], background[2], background[3]);
        if (detected !== this.fieldTheme) { this.fieldTheme = detected; this.draw(); }
        continue;
      }
      // OSC replies may be split across data events. Hold only the one response hcode asked for;
      // it is UI metadata, never text the owner typed into the message. A malformed answer is
      // discarded through its terminator as well: terminal metadata must never become draft text.
      if (this.pending.length >= 2 && BACKGROUND_PREFIX.startsWith(this.pending)) return;
      if (this.pending.startsWith(BACKGROUND_PREFIX)) {
        const bell = this.pending.indexOf("\x07", BACKGROUND_PREFIX.length);
        const stringTerminator = this.pending.indexOf("\x1b\\", BACKGROUND_PREFIX.length);
        const end = bell >= 0 && stringTerminator >= 0 ? Math.min(bell + 1, stringTerminator + 2)
          : bell >= 0 ? bell + 1 : stringTerminator >= 0 ? stringTerminator + 2 : -1;
        if (end < 0 && this.pending.length < 64) return;
        this.pending = end < 0 ? "" : this.pending.slice(end);
        continue;
      }
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) { this.applyInput({ type: "paste.append", value: this.pending }); this.pending = ""; return; }
        this.applyInput({ type: "paste.append", value: this.pending.slice(0, end) });
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.applyInput({ type: "paste.end" });
        // The reducer appends the paste to what it was given, which is the text before the cursor:
        // put the tail back behind it so a paste lands where the cursor is, not at the end.
        this.setBuffer(this.buffer + this.pasteTail, Array.from(this.buffer).length);
        this.pasteTail = "";
        this.selection = 0;
        this.draw();
        continue;
      }
      if (!this.pending) return;
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasteTail = this.chars().slice(this.cursor).join("");
        this.applyInput({ type: "buffer.set", value: this.chars().slice(0, this.cursor).join("") });
        this.applyInput({ type: "paste.start" });
        continue;
      }
      if (PASTE_START.startsWith(this.pending)) { this.armEscapeFlush(); return; }
      // Alt-<key> arrives as Esc + the key. Only the four hcode binds are read this way, so an
      // SS3 sequence (Esc O …) and every CSI can never be mistaken for a held-down Alt.
      const meta = /^\x1b([bfd\r]|\x7f)/.exec(this.pending);
      if (meta) {
        clearTimeout(this.escapeTimer); this.escapeTimer = null;
        this.pending = this.pending.slice(meta[0].length);
        this.handleMeta(meta[1]);
        continue;
      }
      // Application-cursor mode (Esc O A…D, Esc O H/F): the same keys, a different encoding.
      const ss3 = /^\x1bO([A-Z])/.exec(this.pending);
      if (ss3) {
        this.pending = this.pending.slice(3);
        this.handleSequence(`\x1b[${ss3[1]}`);
        continue;
      }
      if (this.pending === "\x1bO") return;
      const sequence = this.pending.match(CSI);
      if (sequence) {
        this.pending = this.pending.slice(sequence[0].length);
        this.handleSequence(sequence[0]);
        continue;
      }
      // A CSI still arriving byte by byte. 12 is room for the longest one hcode reads
      // (`\x1b[27;2;13~`, xterm's Shift-Enter) without wedging on a truncated one for ever.
      if (this.pending.startsWith("\x1b[") && this.pending.length < 12) return;
      const character = Array.from(this.pending)[0];
      this.pending = this.pending.slice(character.length);
      this.handleCharacter(character);
    }
  }

  // A lone Esc is also the first byte of every escape sequence, so feed() has to wait for
  // more input before it can tell. If nothing follows within a keystroke's worth of time,
  // it was the Esc key itself (menu: go back; input: close the command list, or stop the turn).
  armEscapeFlush() {
    clearTimeout(this.escapeTimer);
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = null;
      if (this.pending === "\x1b") { this.pending = ""; this.handleCharacter("\x1b"); }
    }, 40);
  }

  // Shift-Enter, in the two encodings terminals use for it — and since start() now asks for both
  // protocols, these are sequences a real terminal will actually produce rather than ones hcode
  // merely knows how to read. Where a terminal can send neither, Ctrl-J and a trailing backslash
  // still make a newline, so multiline never depends on the protocol being there.
  static NEWLINE_KEYS = new Set(["\x1b[13;2u", "\x1b[27;2;13~"]);
  // The other half of asking for a keyboard protocol: a terminal may now spell a key hcode
  // already binds as CSI u instead of as its control byte. The four ambiguous bytes (Esc / Ctrl-[,
  // Enter / Ctrl-M, Tab / Ctrl-I, Backspace) have fixed unmodified encodings; Ghostty also moves
  // Ctrl-letter chords. Both forms are handed straight back to handleCharacter below, so a key
  // means the same thing under every protocol instead of silently doing nothing under one of them.
  static LEGACY_KEYS = new Map([["\x1b[27u", "\x1b"], ["\x1b[13u", "\r"], ["\x1b[9u", "\t"], ["\x1b[127u", "\x7f"]]);

  handleSequence(sequence) {
    const legacy = TerminalComposer.LEGACY_KEYS.get(sequence);
    if (legacy) return this.handleCharacter(legacy);
    // Kitty's disambiguate protocol — enabled above for Shift-Enter — also encodes Ctrl-letter
    // chords as CSI <codepoint>;5u in Ghostty. Fold them back onto the same control bytes the
    // composer has always handled, so enabling multiline input cannot disable Ctrl-C (or peers).
    const control = /^\x1b\[(\d+);5u$/.exec(sequence);
    if (control) {
      const codepoint = Number(control[1]);
      if (codepoint >= 64 && codepoint <= 95) return this.handleCharacter(String.fromCodePoint(codepoint - 64));
      if (codepoint >= 97 && codepoint <= 122) return this.handleCharacter(String.fromCodePoint(codepoint - 96));
    }
    if (this.menu) return this.handleMenuKey(sequence);
    if (this.pager) return this.handlePagerKey(sequence);
    if (this.search) { if (sequence === "\x1b[A" || sequence === "\x1b[B") return; return this.handleSearchKey(sequence); }
    this.lastEscape = 0;
    if (TerminalComposer.NEWLINE_KEYS.has(sequence)) return this.insert("\n");
    const size = this.chars().length;
    if (sequence === "\x1b[A") this.move(-1);
    else if (sequence === "\x1b[B") this.move(1);
    else if (sequence === "\x1b[C") this.moveCursor(this.cursor + 1);
    else if (sequence === "\x1b[D") this.moveCursor(this.cursor - 1);
    else if (sequence === "\x1b[H" || sequence === "\x1b[1~") this.moveCursor(0);
    else if (sequence === "\x1b[F" || sequence === "\x1b[4~") this.moveCursor(size);
    else if (sequence === "\x1b[3~") this.replaceRange(this.cursor, this.cursor + 1);
  }

  handleMeta(key) {
    if (this.menu) return this.handleMenuKey(`\x1b${key}`);
    if (this.pager || this.search) return;
    this.lastEscape = 0;
    const characters = this.chars();
    if (key === "b") this.moveCursor(wordLeft(characters, this.cursor));
    else if (key === "f") this.moveCursor(wordRight(characters, this.cursor));
    else if (key === "d") this.replaceRange(this.cursor, wordRight(characters, this.cursor));
    else if (key === "\x7f") this.replaceRange(wordLeft(characters, this.cursor), this.cursor);
    else if (key === "\r") this.insert("\n");
  }

  moveCursor(to) {
    const size = this.chars().length;
    this.cursor = Math.max(0, Math.min(size, to));
    this.draw();
  }

  // The one edit primitive: drop [from, to) and put `text` in its place, cursor after it.
  replaceRange(from, to, text = "") {
    const characters = this.chars();
    const a = Math.max(0, Math.min(characters.length, Math.min(from, to)));
    const b = Math.max(0, Math.min(characters.length, Math.max(from, to)));
    if (a === b && !text) return;
    const head = characters.slice(0, a).join("");
    this.setBuffer(head + text + characters.slice(b).join(""), a + Array.from(text).length);
    this.selection = 0;
    this.historyIndex = -1;
    this.draw();
  }

  insert(text) { this.replaceRange(this.cursor, this.cursor, text); }

  move(delta) {
    const matches = this.suggestions();
    if (matches.length) {
      this.applyInput({ type: "slash.matches", names: matches.map(command => command.name) });
      this.applyInput({ type: "slash.move", delta });
    }
    else if (this.history.length) {
      if (this.historyIndex < 0) this.historyIndex = this.history.length;
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
      this.setBuffer(this.historyIndex === this.history.length ? "" : this.history[this.historyIndex]);
    }
    this.draw();
  }

  handleCharacter(character) {
    if (this.menu) return this.handleMenuKey(character);
    if (this.pager) return this.handlePagerKey(character);
    if (this.search) return this.handleSearchKey(character);
    if (character !== "\x1b") this.lastEscape = 0;
    if (character === "\x03") { this.applyInput({ type: "interrupt" }); this.emit("interrupt"); return; }
    if (character === "\x04") { if (!this.buffer && !this.attachments.length) this.emit("eof"); return; }
    if (character === "\x16") { if (!this.question) this.emit("paste-image"); return; }
    if (character === "\x0c") { this.redraw(); return; }
    if (character === "\x07") { if (!this.question) this.emit("editor", this.buffer); return; }
    if (character === "\x0f") { if (!this.question) this.openTranscript(); return; }
    // Ctrl-F is the one control byte hcode has never spoken for: not bound, not named in the
    // README's list of keys it deliberately leaves alone (Ctrl-B, Ctrl-P, Ctrl-N are), not a
    // flow-control byte the terminal eats (Ctrl-S/Ctrl-Q), and not a multiplexer's prefix — Ctrl-B
    // never reaches a program running under tmux, which rules out the key with the best mnemonic.
    // What is left reads as *follow*: the panel follows a helper's conversation while it works,
    // the way Ctrl-O follows the page.
    if (character === "\x06") { if (!this.question) this.openAgents(); return; }
    if (character === "\x12") { this.startSearch(); return; }
    if (character === "\x14") { if (!this.question) this.emit("command", "/tasks"); return; }
    // `?` on an empty line is the key table; with anything typed it is just a question mark.
    if (character === "?" && !this.buffer && !this.question) { this.openPager({ title: "Keys", lines: keyHelpRows(), searchable: true }); return; }
    const characters = this.chars();
    if (character === "\x7f" || character === "\b") return this.replaceRange(this.cursor - 1, this.cursor);
    if (character === "\x17") return this.replaceRange(wordLeft(characters, this.cursor), this.cursor);
    if (character === "\x15") return this.replaceRange(0, this.cursor);
    if (character === "\x0b") return this.replaceRange(this.cursor, characters.length);
    if (character === "\x01") return this.moveCursor(0);
    if (character === "\x05") return this.moveCursor(characters.length);
    if (character === "\t") { this.completeSuggestion(); return; }
    if (character === "\n") return this.insert("\n");            // Ctrl-J: a newline, never a send
    if (character === "\r") {
      // A trailing backslash is the other way to say "not yet": the backslash becomes the newline.
      if (this.buffer.endsWith("\\") && this.cursor === characters.length) return this.replaceRange(characters.length - 1, characters.length, "\n");
      this.submit(); return;
    }
    if (character === "\x1b") { this.escape(); return; }
    if (character >= " ") return this.insert(character);
    this.draw();
  }

  // Esc closes whatever is open first (an arrow-key menu is handled before this, then the
  // command list); with nothing open it stops the running turn. It never counts toward the
  // Ctrl-C double press — Esc never exits hcode — and it never clears the draft.
  // Two Escs in a row ask to rewind. There is no ambiguity to resolve and nothing to wait for:
  // the pair is only read when a single Esc had nothing to close and no turn to stop, which is
  // exactly the idle composer. Anything else typed in between puts the pair back to zero.
  escape() {
    if (this.suggestions().length || this.selection) { this.lastEscape = 0; this.selection = 0; this.draw(); return; }
    if (this.question) { this.lastEscape = 0; return; }
    if (this.busy) { this.lastEscape = 0; this.emit("cancel"); return; }
    const at = Date.now();
    if (this.lastEscape && at - this.lastEscape <= DOUBLE_ESCAPE_MS) { this.lastEscape = 0; this.emit("rewind"); return; }
    this.lastEscape = at;
  }

  completeSuggestion() {
    const command = this.suggestions()[this.selection];
    if (!command) return;
    const matches = this.suggestions(); this.applyInput({ type: "slash.matches", names: matches.map(item => item.name) });
    this.applyInput({ type: "slash.complete", takesArgs: command.takesArgs });
    this.cursor = this.chars().length;
    this.draw();
  }

  submit() {
    if (this.attachmentStatus) return;
    if (this.suggestions().length && !/\s/.test(this.buffer)) {
      const command = this.suggestions()[this.selection];
      if (command) this.setBuffer(`/${command.name}`);
    }
    const answer = this.buffer;
    if (!answer && !this.attachments.length && !this.question) return;
    if (this.question) {
      const { resolve } = this.question;
      this.question = null;
      this.setBuffer(this.savedDraft);
      this.savedDraft = "";
      this.draw();
      resolve(answer.trim());
      return;
    }
    this.setBuffer("");
    const attachments = this.attachments;
    this.attachments = [];
    this.attachmentStatus = "";
    this.selection = 0;
    this.historyIndex = -1;
    if (answer.trim()) {
      this.history.push(answer);
      if (this.history.length > 100) this.history.shift();
    }
    if (answer.trim() || attachments.length) this.emit("line", answer, attachments);
    this.draw();
  }

  erase() {
    if (!this.started || !this.drawnRows) { this.paintedRows = []; return; }
    if (this.pinned && this.scrollBottom) {
      this.writer.write("\x1b[?25l");
      const first = this.scrollBottom + 1;
      for (let row = 0; row < this.drawnRows; row++) this.writer.write(`\x1b[${first + row};1H\x1b[2K`);
      this.writer.write(`\x1b[${this.scrollBottom};1H`);
      this.drawnRows = 0;
      this.paintedRows = [];
      this.cursorTail = 0;
      return;
    }
    if (this.cursorTail) this.writer.write(`\x1b[${this.cursorTail}B`);
    for (let row = this.drawnRows - 1; row >= 0; row--) {
      this.writer.write("\r\x1b[2K");
      if (row) this.writer.write("\x1b[1A");
    }
    this.drawnRows = 0;
    this.paintedRows = [];
    this.cursorTail = 0;
  }

  resetScrollRegion() {
    if (!this.scrollBottom) return;
    this.writer.write("\x1b[r");
    this.scrollBottom = 0;
  }

  draw() {
    if (!this.started) return;
    if (this.menu) return this.paint(this.menuRows());
    if (this.pager) return this.paint(this.pagerRows());
    const max = Math.max(12, this.columns - 5);
    // While Ctrl-R is searching, the box shows the match that Enter would accept, not the draft.
    const view = this.search ? { field: fitFromEnd(visible(this.search.match), max), column: Math.min(max, displayWidth(visible(this.search.match))) } : this.inputView(max);
    const field = view.field;
    const matches = this.search ? [] : this.suggestions();
    // Everything above the input band is drawn on the owner's own terminal background: the
    // transcript, the activity row, the command list and the key hint are all things hcode says,
    // and they belong to the page. Only the three rows the owner types into are given a ground
    // of their own.
    const rows = [""];
    if (this.activity) {
      // Activity ("Thinking", "Running", …) lives above the input box with a blank row on
      // each side, so it never reads as part of the box or of the transcript.
      const beam = goldenSweep(this.activity.label, this.pulse, { reduced: has(this.env, "HCODE_REDUCE_MOTION"), plain: has(this.env, "NO_COLOR") });
      const activity = `\x1b[38;5;214m●\x1b[0m ${beam}${this.mainTurnMeter()}`;
      rows.push(`  ${fitAnsi(activity, Math.max(1, this.columns - 4))}`, "");
    }
    if (matches.length) {
      rows.push("\x1b[2mcommands\x1b[0m");
      matches.slice(0, 6).forEach((command, index) => rows.push(`${index === this.selection ? "\x1b[38;5;214m›" : " "}\x1b[0m /${command.name.padEnd(12)} \x1b[2m${command.description}\x1b[0m`));
    }
    if (this.search) rows.push(`\x1b[2m(reverse-i-search)\x1b[0m \x1b[38;5;214m${visible(this.search.query)}\x1b[0m\x1b[2m${this.search.match ? "" : this.search.query ? " — nothing sent before matches" : " — type to search what you sent before"}\x1b[0m`);
    if (this.question) rows.push(`\x1b[1;38;5;214m${this.question.label}\x1b[0m`);
    if (this.attachmentStatus) rows.push(`\x1b[38;5;214m◌\x1b[0m \x1b[2m${visible(this.attachmentStatus)}\x1b[0m`);
    for (const image of this.attachments) {
      const reference = `[${image.label}] path="${image.path}"`;
      rows.push(`\x1b[38;5;214m◇\x1b[0m ${displayWidth(reference) > max ? `…${fitFromEnd(reference, max - 1)}` : reference}`);
    }
    // The input band: three whole rows of one theme-matched ground — a row of air, the typed line, a row
    // of air — so the place the owner speaks has weight on the page instead of being a caret
    // adrift in the transcript, and so it breathes rather than being boxed. Still no rules: a
    // full-width rule only survives until the next zoom and leaves fragments in the scrollback
    // that outlive the box they were drawn for, while the band is repainted at the current width
    // every draw and lives only in the live frame. With no activity, its top row can be the page's
    // breathing row. While activity is visible, one terminal-background row stays between that
    // status and the band: a coloured blank is part of the input box, not separation from it.
    if (rows[rows.length - 1] === "" && !this.activity) rows.pop();
    else if (rows[rows.length - 1] !== "" && this.activity) rows.push("");
    rows.push(this.fieldRow(), this.fieldRow(`\x1b[1m›\x1b[22m ${this.search ? field : this.commandField(field)}`), this.fieldRow());
    // The cursor is the middle row of the band, and it has to be named here rather than counted
    // back from the end: the board below can be any height between zero and six rows, and a cursor
    // computed from the bottom would land on a helper the moment one appeared.
    const cursorRow = rows.length - 2;
    // Under the box, not over it: the owner's line stays the thing closest to where they are
    // looking, and the helpers sit between it and the status footer the way a footnote sits under
    // the text it belongs to.
    rows.push(...this.agentRows());
    // Full keys live behind `?`; token/cost lives in /cost or /status; permission lives in
    // /permissions. The footer says only what matters before the owner asks for those details.
    const action = this.search ? "Enter accepts" : this.busy ? "Esc interrupt" : "Enter send";
    rows.push(...this.statusRows(action));
    const prefix = INPUT_FRAME.cursorPrefixCells;
    this.paint({ rows, cursorRow, cursorColumn: prefix + Math.min(max, view.column) + 1 });
  }

  // Shared tail of draw(): fit the rows to the frame, pin them to the bottom (or draw inline).
  paint({ rows, cursorRow, cursorColumn }) {
    this.frameState = reduceFrame(this.frameState, { type: "live.replaced", rows, cursorRow, cursorColumn });
    const frame = layoutFrame(this.frameState); rows.splice(0, rows.length, ...frame.rows);
    const wasPinned = this.pinned; const previous = this.scrollBottom; const before = this.paintedRows;
    const nextPinned = frame.mode === "pinned";
    // Activity, elapsed clocks, input and presence normally keep the frame the same height. In that
    // common path repaint only rows whose bytes changed; clearing and repainting all footer rows at
    // 240ms was the visible flash. Structural changes still take the full, transcript-safe path.
    if (wasPinned && nextPinned && previous === frame.scrollBottom && before.length === rows.length && this.drawnRows === rows.length) {
      const first = previous + 1;
      this.writer.write("\x1b[?25l");
      rows.forEach((row, index) => { if (row !== before[index]) this.writer.write(`\x1b[${first + index};1H\x1b[2K${row}`); });
      const inputRow = first + frame.cursor.row;
      this.writer.write(`\x1b[${inputRow};${frame.cursor.column}H\x1b[?25h`);
      this.paintedRows = [...rows];
      this.cursorTail = 0;
      return;
    }
    this.erase();
    this.pinned = nextPinned; this.drawnRows = rows.length;
    if (this.pinned) {
      this.resetScrollRegion();
      this.scrollBottom = frame.scrollBottom;
      // A taller frame (command list, menu, activity row) reaches up into rows the transcript
      // is already using. Scroll the page up by that many lines first — the oldest lines go to
      // the scrollback the owner can still reach — instead of painting the frame over live text
      // and losing it. The scroll region is off at this point, so this moves the whole page.
      const covered = Math.max(0, Math.min(previous, this.transcriptRow - 1) - this.scrollBottom);
      if (covered) { this.writer.write(`\x1b[${covered}S`); this.transcriptRow -= covered; }
      // One past the region means "full": every row of the transcript is written on, so the
      // next print has to make room. Clamping to scrollBottom instead would silently overwrite
      // the last line the owner can still see.
      this.transcriptRow = Math.max(1, Math.min(this.transcriptRow, this.scrollBottom + 1));
      this.writer.write(`\x1b[1;${this.scrollBottom}r`);
      // The mirror of `covered`: rows the frame just gave back — a menu or the command list
      // closing, a taller terminal, a reflow that wiped the page — are the composer's again, so
      // the ring refills them instead of leaving a blank band where the transcript used to be.
      // Nothing left to put back means nothing is written, so an idle keystroke is still free.
      const tail = this.transcriptTail(this.scrollBottom);
      if (tail.rows > this.transcriptRow - 1) this.replayTranscript(tail);
      const first = this.scrollBottom + 1;
      rows.forEach((row, index) => this.writer.write(`\x1b[${first + index};1H\x1b[2K${row}`));
      const inputRow = first + frame.cursor.row;
      this.writer.write(`\x1b[${inputRow};${frame.cursor.column}H`);
      this.cursorTail = 0;
    } else {
      this.writer.write(rows.join("\n"));
      this.cursorTail = 1;
      this.writer.write("\x1b[1A\r");
      if (cursorColumn - 1 > 0) this.writer.write(`\x1b[${cursorColumn - 1}C`);
    }
    this.paintedRows = [...rows];
    this.writer.write("\x1b[?25h");
  }
}
