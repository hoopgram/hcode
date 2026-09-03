import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ACTIVITY_PULSE_MS, AGENT_ROWS_MAX, AGENT_VIEW_HINT, INPUT_FRAME, KEY_HELP, TerminalComposer, cleanPaste, displayWidth, goldenSweep, keyHelpRows, supportsComposer, wordLeft, wordRight } from "../src/composer.js";
import { INPUT_THEME_TOKENS } from "../src/ui.js";
import { commandMatches, commandsHelp, findCommand, matchedCommandToken } from "../src/commands.js";

class FakeInput extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.raw = false; }
  setRawMode(value) { this.raw = Boolean(value); }
  resume() {}
}

const output = () => ({
  isTTY: true, columns: 80, text: "",
  write(value) { this.text += String(value); return true; },
});

test("slash discovery filters one canonical command catalog", () => {
  assert.deepEqual(commandMatches("/he").map(command => command.name), ["help"]);
  assert.equal(findCommand("/quit").name, "exit");
  assert.equal(matchedCommandToken("/permissions"), "/permissions");
  assert.equal(matchedCommandToken("/permissions session"), "/permissions");
  assert.equal(matchedCommandToken("/permissio"), "", "only a complete canonical command is emphasized");
  const help = commandsHelp();
  for (const name of ["help", "config", "permissions", "context", "init", "review", "diff", "agents", "mcp", "brain", "doctor"]) assert.match(help, new RegExp(`/${name}\\b`));
  assert.match(help, /Ctrl-C twice/);
});

test("slash popup is keyboard-selectable and submits the chosen command once", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const lines = []; composer.on("line", line => lines.push(line));
  composer.feed("/");
  assert.equal(composer.suggestions()[0].name, "help");
  composer.feed("\x1b[B");
  composer.feed("\r");
  assert.deepEqual(lines, ["/config"]);
});

test("bracketed multiline paste stays one exact message", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const lines = []; composer.on("line", line => lines.push(line));
  composer.feed("\x1b[200~first line\r\n第二行\nthird");
  assert.deepEqual(lines, [], "paste is not submitted at an internal newline");
  composer.feed("\x1b[201~\r");
  assert.deepEqual(lines, ["first line\n第二行\nthird"]);
  assert.equal(cleanPaste("a\r\nb\0c"), "a\nbc");
});

test("CJK input uses terminal cell width instead of JavaScript length", () => {
  assert.equal(displayWidth("home 家"), 7);
  const out = output(); out.columns = 32;
  const composer = new TerminalComposer({ input: new FakeInput(), output: out, env: { HCODE_REDUCE_MOTION: "1" } });
  composer.start(); composer.feed("这是一个很长的中文输入字段，用来测试光标");
  assert.match(out.text, /…/);
  composer.close();
});

test("owner decision temporarily borrows the composer and restores the draft", async () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  composer.buffer = "next message draft";
  const answer = composer.ask("allow? [y]es / [n]o\n> ");
  assert.equal(composer.buffer, "");
  composer.feed("y\r");
  assert.equal(await answer, "y");
  assert.equal(composer.buffer, "next message draft");
});

test("Ctrl-C and Ctrl-D are signals, never hidden input", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  let interrupts = 0; let eof = 0;
  composer.on("interrupt", () => interrupts++); composer.on("eof", () => eof++);
  composer.feed("\x03\x03\x04");                         // legacy control bytes
  composer.feed("\x1b[99;5u\x1b[99;5u\x1b[100;5u");   // Ghostty/kitty Ctrl-C, Ctrl-C, Ctrl-D
  assert.equal(interrupts, 4); assert.equal(eof, 2); assert.equal(composer.buffer, "");
});

test("Esc cancels the running turn, closes what is open first, and never exits", async () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  let cancels = 0; let interrupts = 0; let eof = 0;
  composer.on("cancel", () => cancels++); composer.on("interrupt", () => interrupts++); composer.on("eof", () => eof++);
  // A lone Esc is the first byte of every escape sequence: feed() only knows it was the key
  // itself after the flush timer, so each press has to be given that keystroke of time.
  const escape = async () => { composer.feed("\x1b"); await new Promise(done => setTimeout(done, 60)); };

  composer.setBusy(true);
  const menu = composer.select({ title: "Brain", options: [{ label: "A" }, { label: "B" }] });
  await escape();
  assert.equal(await menu, null, "an open menu takes Esc first — it backs out of the menu");
  assert.equal(cancels, 0, "and does not cancel the turn");

  composer.feed("/co\x1b[B");
  assert.equal(composer.selection, 1);
  await escape();
  assert.equal(composer.selection, 0, "with the command list open Esc only resets the selection");
  assert.equal(cancels, 0);

  composer.feed("\x15");            // Ctrl-U clears the slash draft: a plain composer, turn still running
  await escape();
  assert.equal(cancels, 1, "while a turn runs a lone Esc cancels it");
  assert.equal(interrupts, 0); assert.equal(eof, 0, "Esc is never part of the Ctrl-C double press");

  composer.setBusy(false);
  composer.feed("draft");
  await escape();
  assert.equal(cancels, 1, "idle Esc cancels nothing");
  assert.equal(composer.buffer, "draft", "and never clears the draft");
});

test("Ctrl-V requests one image, preserves the draft and permits image-only submit", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const requested = []; const lines = []; let eof = 0;
  composer.on("paste-image", () => requested.push("paste"));
  composer.on("line", (line, images) => lines.push([line, images])); composer.on("eof", () => eof++);
  composer.feed("draft\x16"); assert.deepEqual(requested, ["paste"]); assert.equal(composer.buffer, "draft");
  composer.setAttachmentStatus("Reading image from clipboard…"); composer.feed("\r"); assert.deepEqual(lines, [], "Enter waits for the explicit paste to finish");
  composer.setAttachmentStatus("");
  const image = { id: "img-1", label: "Image #1", path: "/tmp/hcode-images-safe/img-1.png" };
  composer.addAttachment(image); composer.feed("\x04"); assert.equal(eof, 0, "an attached image prevents accidental Ctrl-D exit");
  composer.feed("\r"); assert.deepEqual(lines, [["draft", [image]]]);
  composer.addAttachment(image); composer.feed("\r"); assert.deepEqual(lines.at(-1), ["", [image]], "an image can be the whole message");
});

test("live composer capability is explicit and restores terminal modes", () => {
  const input = new FakeInput(); const out = output();
  assert.equal(supportsComposer(input, out, { TERM: "xterm-256color" }), true);
  assert.equal(supportsComposer(input, out, { TERM: "xterm-256color", NO_COLOR: "" }), false);
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm-256color", HCODE_REDUCE_MOTION: "1" } });
  composer.start(); assert.equal(input.raw, true); assert.match(out.text, /\x1b\[\?2004h/);
  assert.match(out.text, /\x1b\[\?2004h\x1b\[\?25l\x1b\[>4;1m\x1b\[>1u/, "raw mode also asks for the two keyboard protocols that can spell Shift-Enter");
  assert.match(out.text, /\x1b\]11;\?\x07/, "auto theme asks the terminal for its background without blocking startup");
  composer.setBusy(true); composer.setActivity("Reading", "reading"); composer.close();
  assert.equal(input.raw, false); assert.match(out.text, /\x1b\[\?2004l\x1b\[\?25h/);
  assert.match(out.text, /\x1b\[<u\x1b\[>4;0m\x1b\[\?2004l\x1b\[\?25h/, "and gives all of them back on the way out");
});

test("every way out of raw mode gives back exactly the modes raw mode took", () => {
  const input = new FakeInput(); const out = new EventEmitter();
  out.isTTY = true; out.columns = 80; out.rows = 24; out.text = "";
  out.write = value => { out.text += String(value); return true; };
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" } });
  const count = pattern => (out.text.match(pattern) || []).length;
  composer.start(); composer.suspend(); composer.resume(); composer.close();
  const on = count(/\x1b\[\?2004h\x1b\[\?25l\x1b\[>4;1m\x1b\[>1u/g);
  assert.equal(on, 2, "start() and resume() are the only places the modes go on");
  assert.equal(count(/\x1b\[<u\x1b\[>4;0m\x1b\[\?2004l\x1b\[\?25h/g), on, "suspend() and close() each give back the whole set");
  // A half-pair is the failure that matters: a keyboard protocol left on outlives hcode and the
  // shell that inherits it can no longer read its own keys.
  assert.equal(count(/\x1b\[>1u/g), count(/\x1b\[<u/g), "every kitty push is popped");
  assert.equal(count(/\x1b\[>4;1m/g), count(/\x1b\[>4;0m/g), "every modifyOtherKeys level is reset");
});

test("live composer follows terminal resize and removes its listener on close", () => {
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {};
  const output = new EventEmitter(); output.isTTY = true; output.columns = 40; output.chunks = []; output.write = value => { output.chunks.push(String(value)); return true; };
  const composer = new TerminalComposer({ input, output, env: { TERM: "xterm" } });
  composer.start(); assert.equal(output.listenerCount("resize"), 1); assert.equal(composer.columns, 40);
  output.columns = 100; output.emit("resize"); assert.equal(composer.columns, 100);
  composer.close(); assert.equal(output.listenerCount("resize"), 0);
});

test("TTY composer reserves the physical bottom and restores the scroll region", () => {
  const input = new FakeInput(); const out = new EventEmitter();
  out.isTTY = true; out.columns = 80; out.rows = 24; out.text = "";
  out.write = value => { out.text += String(value); return true; };
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" } });
  composer.start();
  assert.match(out.text, /\x1b\[1;20r/, "a breathing row above the typed line, one below it, and the key hint reserve the bottom frame — no rules");
  composer.print("answer line\n");
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kanswer line/, "the transcript fills the page from the top, not from the row above the box");
  composer.print("second\n");
  assert.match(out.text, /\x1b\[2;1H\x1b\[2Ksecond/, "each print continues on the next transcript row");
  assert.equal(composer.transcriptRow, 3);
  composer.resetTranscript(); composer.print("\x1b[2J\x1b[3J\x1b[H○ banner\n");
  assert.equal(composer.transcriptRow, 2, "after resetTranscript() the banner lands on row 1 and the transcript continues at row 2");
  composer.print("x".repeat(170) + "\n");
  assert.equal(composer.transcriptRow, 5, "a wrapped line counts the rows it occupies (170 cols on an 80-col page = 3 rows)");
  assert.match(out.text, new RegExp(`\\x1b\\[22;${INPUT_FRAME.cursorPrefixCells + 1}H`), "the input cursor returns after the semantic frame prefix");
  out.rows = 30; out.emit("resize");
  assert.match(out.text, /\x1b\[1;26r/, "resize recomputes the transcript region");
  composer.close();
  assert.match(out.text, /\x1b\[r/); assert.match(out.text, /\x1b\[\?25h/);
  assert.ok(ACTIVITY_PULSE_MS >= 400, "activity never forces high-frequency full-frame redraws");
});

const pinned = (options = {}) => {
  const input = new FakeInput(); const out = new EventEmitter();
  out.isTTY = true; out.columns = 80; out.rows = 24; out.text = "";
  out.write = value => { out.text += String(value); return true; };
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" }, ...options });
  composer.start();
  return { composer, out };
};

test("the transcript ring puts back the lines a taller frame pushed out of the region", () => {
  const { composer, out } = pinned();
  assert.equal(composer.scrollBottom, 20);
  for (let index = 1; index <= 25; index++) composer.print(`line ${index}\n`);
  assert.equal(composer.transcriptRow, 21, "20 rows written on: the region is full and the next line has to scroll");
  assert.equal(composer.transcript.length, 25, "every printed line is still in the ring");
  composer.feed("/co");
  assert.ok(composer.scrollBottom < 20, "the command list makes the frame taller");
  out.text = "";
  composer.feed("\x15");
  assert.equal(composer.scrollBottom, 20, "closing the list gives the rows back");
  assert.equal(composer.transcriptRow, 21, "and the transcript fills them again");
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kline 6/, "the oldest line the region can hold comes back from the ring");
  assert.match(out.text, /\x1b\[20;1H\x1b\[2Kline 25/, "down to the newest, with no blank band where the transcript was");
  composer.close();
});

test("the input band follows light and dark terminal backgrounds without entering the draft", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output(), env: { TERM: "xterm" } });
  composer.feed("\x1b]11;rgb:0000/0000/0000");
  assert.equal(composer.pending, "\x1b]11;rgb:0000/0000/0000", "a split OSC background reply waits for its terminator");
  composer.feed("\x07");
  assert.equal(composer.pending, ""); assert.equal(composer.buffer, ""); assert.equal(composer.fieldTheme, "dark");
  assert.ok(composer.fieldRow("› ").startsWith(`${INPUT_FRAME.edgeInk}${INPUT_FRAME.edge}\x1b[0m${INPUT_THEME_TOKENS.dark.row}`));
  composer.feed("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  assert.equal(composer.fieldTheme, "light");
  assert.ok(composer.fieldRow("› ").startsWith(`${INPUT_FRAME.edgeInk}${INPUT_FRAME.edge}\x1b[0m${INPUT_THEME_TOKENS.light.row}`));
  composer.feed("\x1b]11;not-a-colour\x07owner");
  assert.equal(composer.buffer, "owner", "malformed terminal metadata is discarded, not inserted into the owner's draft");
});

test("a width change repaints the transcript from the ring instead of abandoning the page", () => {
  const { composer, out } = pinned();
  let resets = 0;
  composer.on("transcript-reset", () => { resets++; });
  for (const line of ["one", "two", "three"]) composer.print(`${line}\n`);
  out.text = "";
  out.columns = 60; out.emit("resize");
  assert.equal(resets, 0, "a reflow no longer throws the transcript away");
  assert.equal(composer.transcript.length, 3);
  assert.equal(composer.transcriptRow, 4, "all three lines are back on the page at the new width");
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kone/);
  assert.doesNotMatch(out.text, /\x1b\[24S/, "nothing has to go to the scrollback: the ring puts the same page back");
  composer.close();
});

test("a shorter terminal keeps the newest lines on the page, not the oldest", () => {
  const { composer, out } = pinned();
  for (let index = 1; index <= 19; index++) composer.print(`line ${index}\n`);
  assert.equal(composer.transcriptRow, 20);
  out.text = "";
  out.rows = 14; out.emit("resize");
  assert.equal(composer.scrollBottom, 10, "the frame keeps its four rows at the new bottom");
  assert.equal(composer.transcriptRow, 11, "ten rows of transcript again");
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kline 10/, "and they are the newest ten, not the ten the page happened to start with");
  assert.match(out.text, /\x1b\[10;1H\x1b\[2Kline 19/);
  assert.doesNotMatch(out.text, /\x1b\[14S/, "nothing has to go to the scrollback: the ring holds all of it");
  composer.close();
});

test("the transcript ring is bounded, drops the oldest line and degrades to what it kept", () => {
  const { composer, out } = pinned({ transcriptLines: 4 });
  for (let index = 1; index <= 10; index++) composer.print(`line ${index}\n`);
  assert.equal(composer.transcript.length, 4, "the ring never grows past its capacity");
  assert.equal(composer.transcriptDropped, 6);
  assert.deepEqual(composer.transcriptTail(19).lines, ["line 7", "line 8", "line 9", "line 10"], "oldest first, newest kept");
  out.text = "";
  out.columns = 100; out.emit("resize");
  assert.match(out.text, /\x1b\[24S/, "what the ring cannot restore goes to the scrollback before the page is wiped");
  assert.equal(composer.transcriptRow, 5, "four lines come back and the rest is simply gone — no residue, no crash");
  composer.close();
});

test("only colour survives into the ring, so a replayed line can never repaint the screen", () => {
  const { composer } = pinned();
  composer.print("\x1b[2J\x1b[3J\x1b[H\x1b[1m○ banner\x1b[0m\r\n");
  assert.deepEqual(composer.transcript, ["\x1b[1m○ banner\x1b[0m"]);
  composer.close();
});

test("the input band is three whole rows of one ground, painted edge to edge", () => {
  const input = new FakeInput(); const out = output(); out.rows = 20;
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1", HCODE_INPUT_THEME: "light" } });
  composer.start();
  composer.feed("hello");
  const band = composer.frameState.live.rows.filter(row => row.includes(INPUT_THEME_TOKENS.light.row));
  const [above, typed, below] = band;
  assert.equal(plain(typed).slice(1, -1).trimEnd(), "› hello", "the caret and the words sit between the side edges");
  assert.equal(band.length, INPUT_FRAME.rows, "the field owns exactly its semantic row budget");
  for (const [name, row] of [["the row above", above], ["the typed row", typed], ["the row below", below]]) {
    assert.equal(displayWidth(row), 80, `${name} is painted to the right edge — a background that stops at the text leaves a transparent notch`);
  }
  assert.ok(band.every(row => plain(row).startsWith(INPUT_FRAME.edge) && plain(row).endsWith(INPUT_FRAME.edge)), "each live row has quiet gold side edges");
  assert.doesNotMatch(out.text, /─/, "the band has no horizontal rule, so a zoom cannot leave fragments in scrollback");
  assert.equal(composer.scrollBottom, 16, "and it takes no row the transcript was using: the blank rows it replaced were already there");
  composer.close();
});

test("the live frame repaints only a changed row and the work word carries a moving gold beam", () => {
  assert.equal(plain(goldenSweep("Working", 0)), "Working");
  assert.notEqual(goldenSweep("Working", 0), goldenSweep("Working", 1), "the highlight moves while the word stays the same");
  assert.equal(goldenSweep("Working", 0, { reduced: true }), goldenSweep("Working", 5, { reduced: true }), "reduced motion keeps a steady gold word");

  const { composer, out } = pinned({ env: { TERM: "xterm" } });
  composer.setBusy(true); composer.setActivity("Working", "work");
  const activity = composer.frameState.live.rows.find(row => plain(row).includes("Working"));
  assert.equal(plain(activity).trim(), "● Working", "the activity row names only the work instead of repeating the footer action");
  assert.equal(plain(composer.frameState.live.rows.at(-1)), "  Esc interrupt", "the one footer row owns the busy action");
  out.text = "";
  composer.pulse++; composer.draw();
  assert.equal((out.text.match(/\x1b\[\d+;1H\x1b\[2K/g) || []).length, 1, "one pulse rewrites only the activity row, not the whole footer");
  assert.doesNotMatch(out.text, /\x1b\[r|\x1b\[1;\d+r/, "a same-height pulse never resets the scroll region or flashes the frame");
  composer.close();
});

test("the band belongs to the live frame alone — a menu and a panel keep the owner's background", () => {
  const { composer, out } = pinned();
  out.text = "";
  composer.select({ title: "Brain", options: [{ label: "A" }, { label: "B" }] });
  assert.ok(!out.text.includes(INPUT_THEME_TOKENS.light.row), "a decision is not a place to type, so it gets no field");
  composer.feed("\r");
  out.text = "";
  composer.openPager({ title: "Keys", lines: ["a"] });
  assert.ok(!out.text.includes(INPUT_THEME_TOKENS.light.row), "and neither is a read-only panel");
  composer.closePager();
  composer.close();
});

// ---- keys ---------------------------------------------------------------------------------------

test("the input line has a cursor: arrows, Ctrl-A/E, Alt-B/F/D and the kill keys all act on it", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  composer.feed("hello brave world");
  assert.equal(composer.cursor, 17);
  composer.feed("\x01"); assert.equal(composer.cursor, 0, "Ctrl-A goes to the start");
  composer.feed("\x1b[C\x1b[C"); assert.equal(composer.cursor, 2, "→ moves one character");
  composer.feed("\x05"); assert.equal(composer.cursor, 17, "Ctrl-E goes to the end");
  composer.feed("\x1bb"); assert.equal(composer.cursor, 12, "Alt-B goes back one word");
  composer.feed("\x1bb"); assert.equal(composer.cursor, 6);
  composer.feed("\x1bf"); assert.equal(composer.cursor, 11, "Alt-F goes forward one word");
  composer.feed("\x1b[D"); assert.equal(composer.cursor, 10, "← moves back one character");
  composer.feed("\x1b[C"); assert.equal(composer.cursor, 11);
  composer.feed("X"); assert.equal(composer.buffer, "hello braveX world", "typing inserts where the cursor is");
  composer.feed("\x7f"); assert.equal(composer.buffer, "hello brave world", "backspace deletes before the cursor");
  composer.feed("\x1bd"); assert.equal(composer.buffer, "hello brave", "Alt-D deletes the word after the cursor");
  composer.feed("\x17"); assert.equal(composer.buffer, "hello ", "Ctrl-W deletes the word before it");
  composer.feed("world\x01"); assert.equal(composer.buffer, "hello world");
  composer.feed("\x0b"); assert.equal(composer.buffer, "", "Ctrl-K kills to the end of the line");
  composer.feed("keep this\x1bb\x15");
  assert.equal(composer.buffer, "this", "Ctrl-U kills to the start, not the whole line");
  assert.deepEqual([wordLeft(Array.from("家 world"), 7), wordRight(Array.from("家 world"), 0)], [2, 1], "words are counted in graphemes");
});

test("Enter sends, Ctrl-J and a trailing backslash and Shift-Enter make a newline instead", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const lines = []; composer.on("line", line => lines.push(line));
  composer.feed("first\x0asecond");
  assert.equal(composer.buffer, "first\nsecond");
  assert.deepEqual(lines, [], "Ctrl-J never sends");
  composer.feed("\\\r");
  assert.equal(composer.buffer, "first\nsecond\n", "a trailing backslash turns Enter into a newline");
  composer.feed("\x1b[13;2u");
  assert.equal(composer.buffer, "first\nsecond\n\n", "Shift-Enter (kitty) is a newline");
  composer.feed("\x1b[27;2;13~third");
  assert.equal(composer.buffer, "first\nsecond\n\n\nthird", "Shift-Enter (xterm) is the same key");
  composer.feed("\r");
  assert.deepEqual(lines, ["first\nsecond\n\n\nthird"], "one Enter sends the whole multiline message");
});

test("the input field emphasizes only a complete slash command", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  composer.setBuffer("/permissions");
  assert.equal(composer.commandField("/permissions"), "\x1b[1;38;2;169;120;0m/permissions\x1b[22m\x1b[39m");
  composer.setBuffer("/permissions session");
  assert.match(composer.commandField("/permissions session"), /^\x1b\[1;38;2;169;120;0m\/permissions\x1b\[22m\x1b\[39m session$/);
  assert.equal(composer.commandField("…session /permissions"), "…session /permissions", "a scrolled-away command never colors matching text in its arguments");
  composer.setBuffer("/permissionish");
  assert.equal(composer.commandField("/permissionish"), "/permissionish");
});

test("a key means the same thing under either keyboard protocol hcode asks for", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const lines = []; let cancels = 0;
  composer.on("line", line => lines.push(line)); composer.on("cancel", () => cancels++);
  // Under kitty's disambiguate flag the four historically ambiguous bytes may arrive as CSI u.
  composer.feed("draft\x1b[9u");
  assert.equal(composer.buffer, "draft", "Tab is still the completion key, never a typed character");
  composer.feed("\x1b[127u");
  assert.equal(composer.buffer, "draf", "Backspace still deletes");
  composer.setBusy(true);
  composer.feed("\x1b[27u");
  assert.equal(cancels, 1, "Esc still cancels the turn, and without waiting on the flush timer");
  composer.setBusy(false);
  composer.feed("\x1b[13u");
  assert.deepEqual(lines, ["draf"], "Enter still sends");
  composer.feed("again\x1b[13;2u");
  assert.equal(composer.buffer, "again\n", "and the modified form is still a newline, not a send");
});

test("a paste lands where the cursor is, not at the end of the draft", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  composer.feed("head tail\x1bb");
  composer.feed("\x1b[200~中文 pasted \x1b[201~");
  assert.equal(composer.buffer, "head 中文 pasted tail");
  assert.equal(composer.cursor, 15, "and the cursor is left after what was pasted");
});

test("? opens the key panel on an empty line and is an ordinary question mark otherwise", async () => {
  const { composer, out } = pinned();
  const plain = () => out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "");
  composer.feed("?");
  assert.ok(composer.pager, "an empty input line makes ? the panel");
  assert.match(plain(), /Ctrl-A \/ Ctrl-E\s+go to the start/);
  assert.match(plain(), /Alt-D\s+delete the word after/);
  assert.equal(composer.buffer, "", "the panel does not type into the draft");
  composer.feed("\x1b"); await new Promise(done => setTimeout(done, 60));
  assert.equal(composer.pager, null, "Esc closes it");
  composer.feed("why?");
  assert.equal(composer.pager, null, "with something typed ? is just a character");
  assert.equal(composer.buffer, "why?");
  assert.equal(keyHelpRows().filter(row => row.trim()).length, KEY_HELP.flatMap(([, keys]) => keys).length + KEY_HELP.length);
  composer.close();
});

test("the panel pages, searches with / and never touches the draft or the ring", () => {
  const { composer, out } = pinned();
  composer.print("banner\n");
  composer.feed("draft");
  const lines = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`);
  composer.openPager({ title: "Long", lines, searchable: true });
  const height = composer.pagerHeight();
  assert.equal(height, 16, "the panel is bounded so the frame stays shorter than the terminal");
  assert.equal(composer.pager.top, 0);
  composer.feed("\x1b[B\x1b[B"); assert.equal(composer.pager.top, 2, "↓ scrolls one line");
  composer.feed("\x1b[6~"); assert.equal(composer.pager.top, 2 + height, "PgDn scrolls a page");
  composer.feed("G"); assert.equal(composer.pager.top, 60 - height, "G goes to the end");
  composer.feed("g"); assert.equal(composer.pager.top, 0);
  out.text = "";
  composer.feed("/row 42\r");
  assert.deepEqual(composer.pager.matches, [41], "/ searches the wrapped page");
  assert.ok(composer.pager.top <= 41 && composer.pager.top + height > 41, "and puts the match on the page");
  assert.match(out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, ""), /match 1\/1/);
  composer.closePager();
  assert.equal(composer.buffer, "draft", "the draft survived the panel");
  assert.deepEqual(composer.transcript, ["banner"], "and so did the transcript ring");
  composer.close();
});

test("Ctrl-O reads the transcript back from the ring, pages it, searches it and follows new output", () => {
  const { composer, out } = pinned();
  const plain = () => out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "");
  for (let index = 1; index <= 40; index++) composer.print(`answer line ${index}\n`);
  composer.feed("a draft");
  out.text = "";
  composer.feed("\x0f");
  const height = composer.pagerHeight();
  assert.ok(composer.pager?.live, "Ctrl-O opens the transcript view");
  assert.equal(composer.pager.top, 40 - height, "it opens at the newest line, not the oldest");
  assert.match(plain(), /answer line 40/);
  assert.doesNotMatch(plain(), /answer line 1\b/, "line 1 is above the window");

  out.text = "";
  composer.feed("\x1b[5~");
  assert.equal(composer.pager.top, 40 - 2 * height, "PgUp goes back a page");
  assert.equal(composer.pager.follow, false, "and stops following new output");
  composer.print("streamed while reading\n");
  assert.equal(composer.pager.top, 40 - 2 * height, "a reader who scrolled up is not yanked to the bottom");
  assert.equal(composer.pager.lines.length, 41, "but the new line is in the view");

  composer.feed("G");
  assert.equal(composer.pager.follow, true);
  composer.print("and another\n");
  assert.equal(composer.pager.top, 42 - height, "at the end the view follows the newest output");

  out.text = "";
  composer.feed("/line 7\r");
  assert.deepEqual(composer.pager.matches, [6], "/ searches every line the ring kept, not just the page");
  assert.match(out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, ""), /match 1\/1/);
  composer.feed("\x0f");
  assert.equal(composer.pager, null, "Ctrl-O closes it again");
  assert.equal(composer.buffer, "a draft", "and the draft is still there");
  assert.equal(composer.transcript.length, 42, "the ring was never disturbed by reading it");
  composer.close();
});

test("the transcript view says what the ring could not keep, and starts empty honestly", () => {
  const { composer, out } = pinned({ transcriptLines: 5 });
  for (let index = 1; index <= 12; index++) composer.print(`row ${index}\n`);
  out.text = "";
  composer.feed("\x0f");
  const plain = out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "");
  assert.match(plain, /7 older lines have left the ring/);
  assert.match(plain, /row 12/);
  assert.deepEqual(composer.pager.lines, ["row 8", "row 9", "row 10", "row 11", "row 12"]);
  composer.closePager();
  composer.resetTranscript();
  out.text = "";
  composer.feed("\x0f");
  assert.match(out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, ""), /nothing has been printed on this page yet/);
  composer.close();
});

test("Ctrl-R searches backwards through what was sent, and Esc keeps the draft", () => {
  const composer = new TerminalComposer({ input: new FakeInput(), output: output() });
  const lines = []; composer.on("line", line => lines.push(line));
  for (const line of ["fix the parser", "run the tests", "fix the render gate"]) composer.feed(`${line}\r`);
  composer.feed("half a draft");
  composer.feed("\x12");
  assert.ok(composer.search, "Ctrl-R opens the search");
  composer.feed("fix");
  assert.equal(composer.search.match, "fix the render gate", "the newest match first");
  composer.feed("\x12");
  assert.equal(composer.search.match, "fix the parser", "Ctrl-R again steps further back");
  composer.feed("\r");
  assert.equal(composer.search, null);
  assert.equal(composer.buffer, "fix the parser", "Enter puts it in the box");
  assert.deepEqual(lines.length, 3, "and never sends it");
  composer.setBuffer("half a draft");
  composer.feed("\x12run\x1b");
  assert.equal(composer.buffer, "half a draft", "Esc gives the draft back untouched");
});

test("Ctrl-L repaints the page from the ring; Ctrl-G and Ctrl-T are handed to the session", () => {
  const { composer, out } = pinned();
  for (let index = 1; index <= 3; index++) composer.print(`line ${index}\n`);
  const drafts = []; const commands = [];
  composer.on("editor", draft => drafts.push(draft)); composer.on("command", line => commands.push(line));
  composer.feed("a draft");
  out.text = "";
  composer.feed("\x0c");
  assert.match(out.text, /\x1b\[H\x1b\[J/, "Ctrl-L wipes the page");
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kline 1/, "and the ring paints it back from the top");
  assert.equal(composer.transcriptRow, 4);
  composer.feed("\x07"); assert.deepEqual(drafts, ["a draft"]);
  composer.feed("\x14"); assert.deepEqual(commands, ["/tasks"]);
  composer.close();
});

test("suspend() hands the terminal to an editor and resume() takes it back", () => {
  const input = new FakeInput(); const out = new EventEmitter();
  out.isTTY = true; out.columns = 80; out.rows = 24; out.text = "";
  out.write = value => { out.text += String(value); return true; };
  const composer = new TerminalComposer({ input, output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" } });
  composer.start();
  composer.print("kept\n");
  out.text = "";
  composer.suspend();
  assert.equal(input.raw, false, "raw mode is off while the editor owns the terminal");
  assert.equal(input.listenerCount("data"), 0);
  assert.match(out.text, /\x1b\[r/); assert.match(out.text, /\x1b\[\?2004l\x1b\[\?25h/);
  out.text = "";
  composer.feed("ignored");
  composer.resume();
  assert.equal(input.raw, true); assert.equal(input.listenerCount("data"), 1);
  assert.match(out.text, /\x1b\[1;1H\x1b\[2Kkept/, "and the page comes back from the ring");
  composer.setBuffer("edited elsewhere");
  assert.equal(composer.buffer, "edited elsewhere"); assert.equal(composer.cursor, 16);
  composer.close();
});

test("the footer is exactly one semantic-priority row at 40, 80 and 120 columns", () => {
  const { composer, out } = pinned();
  const before = composer.scrollBottom;

  out.text = "";
  composer.setMeter({ text: "↓ 21.6K tokens · Context 67% left · 40K/120K · 4.5K cu", identity: { model: "deepseek-v4-pro", effort: "high", sessionMode: "savetoken", permission: "ask" }, band: "calm" });
  assert.equal(composer.scrollBottom, before, "meter facts never make the footer taller");
  for (const columns of [80, 120]) {
    composer.columns = columns;
    const rows = composer.statusRows("Enter send");
    assert.equal(rows.length, 1, `${columns}: one physical row`);
    assert.equal(plain(rows[0]), "  Enter send · deepseek-v4-pro · Context 67% left");
    assert.ok(displayWidth(rows[0]) <= columns, `${columns}: no terminal wrap`);
    assert.doesNotMatch(rows[0], /[\r\n]/);
  }

  composer.columns = 40;
  let rows = composer.statusRows("Enter send");
  assert.equal(rows.length, 1);
  assert.equal(plain(rows[0]), "  Enter send · deepseek-v4-pro", "the lowest-priority context field hides whole at 40 columns");
  assert.ok(displayWidth(rows[0]) <= 40);
  assert.doesNotMatch(plain(rows[0]), /Context|tokens|cu|high|savetoken|ask|keys|Ctrl|Shift/);

  rows = composer.statusRows("Esc interrupt");
  assert.equal(plain(rows[0]), "  Esc interrupt · deepseek-v4-pro", "busy keeps the interrupt key ahead of identity");
  assert.ok(displayWidth(rows[0]) <= 40);

  composer.setMeter({ text: "↓ 12K tokens · Context 14% left · 103K/120K · $1.20 · /handoff", band: "danger" });
  composer.columns = 80;
  rows = composer.statusRows("Enter send");
  assert.equal(rows.length, 1);
  assert.equal(plain(rows[0]), "  Enter send · Context 14% left", "danger remains understandable without its colour or token/cost detail");
  assert.match(rows[0], /\x1b\[1;38;5;1mContext 14% left\x1b\[0m/);
  assert.doesNotMatch(plain(rows[0]), /12K|103K|\$1\.20|handoff/);

  composer.setMeter(null);
  assert.equal(plain(composer.statusRows("Enter send")[0]), "  Enter send", "the action row exists even before a meter does");

  composer.columns = 40;
  composer.setMeter({ text: "↓ 0 tokens · Context 97% left · 3.4K/120K · 0 cu", identity: { model: "a-model-name-that-cannot-fit-as-a-complete-field-at-this-width" }, band: "calm" });
  rows = composer.statusRows("Enter send");
  assert.equal(plain(rows[0]), "  Enter send", "an overlong higher-priority field and everything below it hide whole");
  composer.close();
});

test("select(): arrow-key menu with title, descriptions, Enter confirms, Esc backs out, digits jump", async () => {
  const out = output(); out.isTTY = true; out.columns = 80; out.rows = 30; out.text = "";
  const composer = new TerminalComposer({ input: new FakeInput(), output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" } });
  composer.start();
  composer.buffer = "draft";
  const options = [
    { label: "Ask for approval", description: "Every write and command is confirmed by you first.", current: true },
    { label: "Approve for me", description: "Only ask for actions detected as potentially unsafe." },
    { label: "Full access", description: "Edit files outside this workspace and access the internet without asking. Exercise caution when using." },
  ];
  const picked = composer.select({ title: "Update Model Permissions", options, initial: 0 });
  assert.equal(composer.buffer, "", "the draft is parked while the menu is open");
  const plain = () => out.text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.match(plain(), /Update Model Permissions/);
  assert.match(plain(), /› 1\. Ask for approval \(current\)\s+Every write/);
  assert.match(plain(), /  3\. Full access\s+Edit files outside/);
  assert.match(plain(), /Press enter to confirm or esc to go back/);
  composer.feed("\x1b[B"); composer.feed("\x1b[B");
  assert.match(plain(), /› 3\. Full access/);
  composer.feed("\x1b[A");
  composer.feed("\r");
  assert.equal(await picked, 1);
  assert.equal(composer.buffer, "draft", "the draft comes back after the decision");
  const backedOut = composer.select({ title: "t", options });
  composer.feed("3"); composer.feed("\x1b");
  assert.equal(await backedOut, null);
  const byDigit = composer.select({ title: "t", options });
  composer.feed("3"); composer.feed("\r");
  assert.equal(await byDigit, 2);
  composer.close();
});

// ---- the board under the input box -------------------------------------------------------------
// A board the composer can read without presence being wired to anything. What is under test is the
// rendering, the frame arithmetic and the lifecycle, never presence's own reducers.
const helper = (over = {}) => ({
  id: "child-1", kind: "claude", model: "", title: "look at the frame", state: "working",
  startedAt: 0, elapsedMs: 274_000, tokens: 109_700, activity: "Reading frame.js…",
  summary: "", outcome: "", thread: "t-1", ...over,
});
const board = (rows = [], { turn = { active: false, startedAt: 0, elapsedMs: 0, tokens: 0 }, scripts = {} } = {}) => ({
  rows, listeners: [], scripts,
  list() { return this.rows; },
  transcript(id) { return this.scripts[id] || []; },
  get mainTurn() { return turn; },
  subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(item => item !== fn); }; },
  change() { for (const fn of this.listeners) fn(); },
});
const boarded = (rows, options, columns = 80) => {
  const out = output(); out.isTTY = true; out.columns = columns; out.rows = 30;
  const presence = board(rows, options);
  const composer = new TerminalComposer({ input: new FakeInput(), output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" }, presence });
  composer.start();
  return { composer, presence, out, live: () => composer.frameState.live.rows };
};
const plain = value => String(value).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("an idle session says nothing: no helpers, no board, no reserved band", () => {
  const empty = boarded([]);
  const quiet = empty.live();
  assert.equal(quiet.filter(row => plain(row).includes("○ ")).length, 0);
  assert.equal(quiet.some(row => plain(row).includes(AGENT_VIEW_HINT)), false, "a hint under an empty board is furniture advertising itself");
  empty.composer.close();

  // The same frame, one helper later, is exactly two rows taller: the row and the way in.
  const one = boarded([helper()]);
  assert.equal(one.live().length, quiet.length + 2);
  one.composer.close();
});

test("a helper row is a state, a kind, what it is doing, and what it has cost", () => {
  const { composer, live } = boarded([helper()]);
  const row = live().find(line => plain(line).startsWith("○ "));
  assert.equal(plain(row), "○ claude  Reading frame.js…  4m 34s · ↓ 109.7k tokens");
  assert.match(row, /^\x1b\[38;5;140m○/, "still working is lavender — the one ink that belongs to nothing else");
  assert.match(row, /\x1b\[2mReading frame\.js…\x1b\[0m/, "what it is doing is dim");
  assert.match(row, /\x1b\[2m4m 34s · ↓ 109\.7k tokens\x1b\[0m/, "so is what it has cost");
  composer.close();
});

test("the mark carries the state, so the state costs no words", () => {
  const states = [["working", "38;5;140"], ["done", "38;5;71"], ["failed", "38;5;203"], ["cancelled", "38;5;214"]];
  const { composer, live } = boarded(states.map(([state], i) => helper({ id: `c${i}`, state, activity: "", title: state })));
  const rows = live().filter(line => plain(line).startsWith("○ "));
  states.forEach(([state, ink], index) => {
    assert.ok(rows[index].startsWith(`\x1b[${ink}m○`), `${state} is painted ${ink}`);
    assert.doesNotMatch(plain(rows[index]), new RegExp(`\\[${state}\\]`), "the state is the colour, not a second word");
  });
  // A finished helper has no activity left, so the row falls back to what it was asked to do.
  assert.match(plain(rows[1]), /^○ claude {2}done {2}/);
  composer.close();
});

test("running helpers come first, and the rest keep the order they were started in", () => {
  const rows = [helper({ id: "a", state: "done", title: "a", activity: "" }), helper({ id: "b", state: "working", title: "b", activity: "" }),
    helper({ id: "c", state: "failed", title: "c", activity: "" }), helper({ id: "d", state: "working", title: "d", activity: "" })];
  const { composer, live } = boarded(rows);
  const titles = live().filter(line => plain(line).startsWith("○ ")).map(line => plain(line).split(/\s{2}/)[1]);
  assert.deepEqual(titles, ["b", "d", "a", "c"], "what is still running is what the owner is looking for");
  composer.close();
});

test("what gives way in a narrow column is the activity, never the clock", () => {
  const { composer, live } = boarded([helper({ activity: "Reading a file with a very long name indeed.js…" })], undefined, 46);
  const row = plain(live().find(line => plain(line).startsWith("○ ")));
  assert.ok(row.endsWith("4m 34s · ↓ 109.7k tokens"), `the clock survives whole: ${row}`);
  assert.match(row, /…\s{2}4m 34s/, "the activity is cut with an ellipsis that says so");
  assert.ok(displayWidth(row) <= 46, `${displayWidth(row)} cells fits the column`);
  composer.close();
});

test("past four helpers the board says how many rather than growing", () => {
  const many = Array.from({ length: 7 }, (_, i) => helper({ id: `c${i}`, title: `t${i}` }));
  const { composer, live } = boarded(many);
  const rows = live().filter(line => plain(line).startsWith("○ "));
  assert.equal(rows.length, AGENT_ROWS_MAX, "four rows is the whole budget; the fifth would be a row of the page");
  assert.ok(live().some(line => plain(line) === "… +3"), "the rest are told about in a word");
  assert.ok(live().some(line => plain(line) === AGENT_VIEW_HINT));
  composer.close();
});

test("the board grows under the box without moving the line the owner types on", () => {
  const { composer, presence, live } = boarded([]);
  const before = composer.frameState.live.cursorRow;
  const bandBefore = plain(live()[before]);
  presence.rows = Array.from({ length: 6 }, (_, i) => helper({ id: `c${i}` }));
  presence.change();
  assert.equal(plain(live()[composer.frameState.live.cursorRow]).trimEnd(), bandBefore.trimEnd(), "the cursor still lands on the input band");
  assert.ok(live().length > before + 1, "and the board really is under it");
  composer.close();
});

test("the activity row carries the main turn's own meter, and nothing when no turn is watched", () => {
  const idle = boarded([], { turn: { active: false, startedAt: 0, elapsedMs: 0, tokens: 0 } });
  idle.composer.setActivity("Listening", "thinking");
  assert.doesNotMatch(plain(idle.live().join("\n")), /Listening \(/, "an unobserved turn shows no clock");
  idle.composer.close();

  const fresh = boarded([], { turn: { active: true, startedAt: 1, elapsedMs: 1_000, tokens: 0 } });
  fresh.composer.setActivity("Listening", "thinking");
  const freshRow = fresh.live().find(line => plain(line).includes("Listening"));
  assert.match(plain(freshRow), /Listening \(1s\)$/);
  assert.doesNotMatch(plain(freshRow), /tokens/, "before the provider reports usage, time is shown and token spend is not invented");
  fresh.composer.close();

  const busy = boarded([], { turn: { active: true, startedAt: 1, elapsedMs: 345_000, tokens: 83_900 } });
  busy.composer.setActivity("Listening", "thinking");
  const row = busy.live().find(line => plain(line).includes("Listening"));
  assert.match(plain(row), /^  /, "activity shares the input cursor and assistant output gutter");
  assert.ok(displayWidth(row) <= busy.composer.columns - 2, "activity leaves the matching right gutter");
  assert.match(plain(row), /Listening \(5m 45s · ↓ 83\.9k tokens\)$/);
  assert.match(row, /\x1b\[2m\(5m 45s/, "the meter is dim beside the word it belongs to");
  const liveRows = busy.composer.frameState.live.rows;
  const activityAt = liveRows.findIndex(line => plain(line).includes("Listening"));
  assert.equal(liveRows[activityAt + 1], "", "one terminal-background row separates activity from the input band");
  assert.match(liveRows[activityAt + 2], /\x1b\[(?:48;5;\d+|49)m/, "the input band begins only after that full row");
  busy.composer.close();
});

test("Ctrl-F opens one helper's whole conversation, in the panel Ctrl-O already is", async () => {
  const script = [{ role: "owner", text: "look at the frame" }, { role: "agent", text: "reading it now" },
    { role: "tool", text: "read_file {\"path\":\"src/frame.js\"}" }, { role: "meta", text: "turn ended (done) · 1200 tokens" }];
  const { composer, out } = boarded([helper()], { scripts: { "child-1": script } });
  out.text = "";
  composer.feed("\x06");
  assert.equal(composer.pager.agent, "child-1", "the panel knows whose conversation it is showing");
  const page = out.text;
  assert.match(plain(page), /claude · look at the frame/, "the title names the helper and its task");
  assert.match(plain(page), /still working/, "and says it has not finished");
  assert.match(page, /\x1b\[1mlook at the frame\x1b\[0m/, "the owner is bold — a reader scans for the questions");
  assert.match(page, /\x1b\[38;5;75mread_file/, "a tool is the soft cyan hcode gives its own machinery");
  assert.match(page, /\x1b\[2mturn ended \(done\)/, "the machinery's own remarks are dim");
  assert.ok(page.includes("reading it now") && !page.includes("\x1b[1mreading it now"), "the helper's words are plain body text");
  // Reading changes nothing, and the way out is the way in.
  composer.feed("\x06");
  assert.equal(composer.pager, null);
  composer.feed("\x06"); composer.feed("\x1b");
  await sleep(80);      // a lone Esc is only known to be the Esc key once nothing follows it
  assert.equal(composer.pager, null, "Esc leaves it too");
  composer.close();
});

test("a panel on a working helper follows what it writes, and stops the moment the reader scrolls up", () => {
  const script = Array.from({ length: 40 }, (_, i) => ({ role: "agent", text: `line ${i}` }));
  const { composer, presence } = boarded([helper()], { scripts: { "child-1": script } });
  composer.feed("\x06");
  assert.equal(composer.pager.follow, true);
  const end = composer.pager.top;
  presence.scripts["child-1"] = [...script, { role: "agent", text: "line 40" }];
  presence.change();
  composer.draw();
  assert.ok(composer.pager.top > end, "a reader parked at the end keeps seeing the newest output");
  composer.feed("\x1b[A");
  assert.equal(composer.pager.follow, false, "scrolling up is a deliberate place to be");
  const parked = composer.pager.top;
  presence.scripts["child-1"] = [...presence.scripts["child-1"], { role: "agent", text: "line 41" }];
  presence.change();
  composer.draw();
  assert.equal(composer.pager.top, parked, "and the reader stays exactly where they put themselves");
  composer.close();
});

test("with several helpers the composer's own chooser asks first, and Esc keeps the draft", async () => {
  const rows = [helper({ id: "a", kind: "claude", title: "read the frame" }), helper({ id: "b", kind: "codex", state: "done", title: "run the tests" })];
  const { composer, out } = boarded(rows, { scripts: { a: [{ role: "agent", text: "from a" }], b: [{ role: "agent", text: "from b" }] } });
  composer.setBuffer("half a thought");
  composer.feed("\x06");
  assert.equal(composer.buffer, "", "the draft is parked while the question is open");
  assert.match(plain(out.text), /Subagents/);
  out.text = "";
  composer.feed("\x1b");
  await sleep(80);
  assert.equal(composer.pager, null, "backing out of the chooser opens nothing");
  assert.equal(composer.buffer, "half a thought", "and the draft comes back untouched");
  composer.feed("\x06"); composer.feed("\x1b[B"); composer.feed("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(composer.pager.agent, "b");
  assert.match(plain(out.text), /from b/);
  composer.close();
});

test("the composer watches the board for exactly as long as it owns the terminal", () => {
  const { composer, presence } = boarded([helper()]);
  assert.equal(presence.listeners.length, 1, "start() subscribes once");
  // A change is a repaint, and an elapsed second is a change nobody else emits an event for.
  const writes = composer.writer.writes;
  presence.change();
  assert.ok(composer.writer.writes > writes, "a board that moved repaints the frame");
  // While $EDITOR has the terminal there is no door at all.
  composer.suspend();
  const suspended = composer.writer.writes;
  presence.change();
  assert.equal(composer.writer.writes, suspended, "nothing is painted onto a terminal hcode has handed away");
  composer.resume();
  composer.close();
  assert.equal(presence.listeners.length, 0, "and the subscription goes when the terminal does");
});

test("a board that throws is never the reason the input box cannot be drawn", () => {
  const out = output(); out.isTTY = true; out.columns = 80; out.rows = 30;
  const angry = { list() { throw new Error("no"); }, transcript() { throw new Error("no"); },
    get mainTurn() { throw new Error("no"); }, subscribe() { return () => {}; } };
  const composer = new TerminalComposer({ input: new FakeInput(), output: out, env: { TERM: "xterm", HCODE_REDUCE_MOTION: "1" }, presence: angry });
  composer.start();
  composer.setActivity("Listening", "thinking");
  assert.ok(composer.frameState.live.rows.length > 0);
  assert.equal(composer.agentRows().length, 0);
  assert.equal(composer.openAgents(), false);
  composer.close();
});

test("a helper's own output can never move the cursor: the panel escapes what it shows", () => {
  const { composer, out } = boarded([helper()], { scripts: { "child-1": [{ role: "agent", text: "before\x1b[2J\x1b[3;1Hafter" }] } });
  out.text = "";
  composer.feed("\x06");
  const body = out.text.split("\n").filter(line => line.includes("after")).join("\n");
  assert.match(body, /\\x1b\[2J/, "an escape a subagent printed is shown as bytes, not obeyed");
  assert.doesNotMatch(plain(body), /\x1b/);
  composer.close();
});

test("the key table, /help and the README name the same key for the board", () => {
  const page = KEY_HELP.find(([group]) => group === "The page")[1];
  const entry = page.find(([label]) => label === "Ctrl-F");
  assert.ok(entry, "Ctrl-F is in the one key table the panel, /help and the README all render");
  assert.match(keyHelpRows().join("\n"), /Ctrl-F/);
  assert.match(commandsHelp(), /Ctrl-F/);
  assert.match(AGENT_VIEW_HINT, /ctrl\+f/, "and the hint under the board names the same key");
  // Keys the README says hcode deliberately leaves alone stay unbound.
  for (const key of ["\x02", "\x10", "\x0e"]) {
    const { composer } = boarded([helper()]);
    composer.feed(key);
    assert.equal(composer.pager, null, `${JSON.stringify(key)} is still nobody's key`);
    composer.close();
  }
});
