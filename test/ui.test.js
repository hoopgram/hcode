import { test } from "node:test";
import assert from "node:assert/strict";
import { TURN_METER_MS, createPalette, createUI, formatElapsed, formatSpend, formatTokens, inputStyle, inputTheme, renderMarkdown, themeFromRgb } from "../src/ui.js";
import { MUSINGS, WAITING_WORDS, musing, waitingWord } from "../src/musings.js";
import { Presence } from "../src/presence.js";
import { displayWidth } from "../src/frame.js";

const ESC_OR_CR = /[\x1b\r]/;
const UNSAFE_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const stripAnsi = value => String(value).replace(/\x1b\[[0-9;]*m/g, "");
const sink = ({ isTTY = false, columns = 80 } = {}) => ({
  isTTY, columns, chunks: [],
  write(value) { this.chunks.push(String(value)); return true; },
  get text() { return this.chunks.join(""); },
});

const sample = (terminal, width = 80) => {
  terminal.banner({ cwd: "/Users/owner/Projects/非常长的项目/with-a-very-long-name", model: "claude-sonnet-5", mode: "ask", runner: "hcode" }, "session-123", { runner: "hcode", network: "off", sandbox: "sandbox-exec", width });
  const prompt = terminal.permission("bash", { command: "rm -rf build/old-artifacts && printf done" }, { risk: ["write", "destructive"], reason: "removes generated files", why: "clean rebuild" });
  terminal.toolStart("$ npm test", ["write"]);
  terminal.toolEnd("$ npm test", "73 tests passed", { state: "done", durationMs: 1234 });
  return prompt;
};

test("terminal capabilities are per sink and honor NO_COLOR presence", () => {
  const out = sink({ isTTY: true }); const err = sink({ isTTY: false });
  const terminal = createUI({ out, err, env: { HOME: "/Users/owner", TERM: "xterm-256color" } });
  sample(terminal); terminal.error("failure stays readable");
  assert.match(out.text, /\x1b\[/, "interactive stdout may be decorated");
  assert.doesNotMatch(err.text, ESC_OR_CR, "non-TTY stderr is independently plain");
  assert.match(err.text, /  ✗ failure stays readable/);

  for (const [name, env, isTTY] of [
    ["empty NO_COLOR", { NO_COLOR: "", TERM: "xterm-256color" }, true],
    ["NO_COLOR=0", { NO_COLOR: "0", TERM: "xterm-256color" }, true],
    ["dumb terminal", { TERM: "dumb" }, true],
    ["pipe", { TERM: "xterm-256color" }, false],
  ]) {
    const plainOut = sink({ isTTY }); const plainErr = sink({ isTTY });
    const plain = createUI({ out: plainOut, err: plainErr, env: { HOME: "/Users/owner", ...env } });
    const prompt = sample(plain); plain.assistantText("\x1b[2Janswer\r"); plain.error(name);
    const transcript = plainOut.text + prompt + plainErr.text;
    assert.doesNotMatch(transcript, ESC_OR_CR, `${name} must be plain and append-only`);
    assert.match(transcript, /◆ Owner decision/);
    assert.match(transcript, /risk: write, destructive/);
  }
});

test("the home palette gives semantic roles distinct contrast", () => {
  const palette = createPalette(true);
  const roles = [palette.brand("brand"), palette.dim("ghost"), palette.cyan("link"), palette.green("done"), palette.red("failed"),
    palette.sand("waiting"), palette.lavender("working")];
  assert.equal(new Set(roles.map(value => value.match(/\x1b\[([^m]+)/)?.[1])).size, roles.length);
  assert.ok(roles.every(value => /\x1b\[[0-9;]+m/.test(value)));
  // The two roles 0.9.2 added, pinned to their exact ink: presence is warm, unfinished work is
  // the one cool ink nothing else uses, so a page of agents can be scanned for what is still open.
  assert.equal(palette.sand("x"), "\x1b[38;5;179mx\x1b[0m");
  assert.equal(palette.lavender("x"), "\x1b[38;5;140mx\x1b[0m");
  assert.equal(createPalette(false).sand("x"), "x", "a plain sink still receives no bytes it did not ask for");
});

test("input colour has explicit, hinted and honest-auto theme paths", () => {
  assert.equal(inputTheme({ HCODE_INPUT_THEME: "dark" }), "dark");
  assert.equal(inputTheme({ HCODE_INPUT_THEME: "light" }), "light");
  assert.equal(inputTheme({ COLORFGBG: "15;0" }), "dark");
  assert.equal(inputTheme({ COLORFGBG: "0;15" }), "light");
  assert.equal(inputTheme({ TERM: "xterm" }), "auto");
  assert.equal(themeFromRgb("0000", "0000", "0000"), "dark");
  assert.equal(themeFromRgb("ffff", "f000", "e800"), "light");
  assert.match(inputStyle("dark").row, /48;5;235m.*38;5;252m/);
  assert.match(inputStyle("light").row, /48;5;254m.*38;5;236m/);
  assert.equal(inputStyle("dark").command, "\x1b[1;38;2;255;214;10m", "dark fields use luminous yellow");
  assert.equal(inputStyle("light").command, "\x1b[1;38;2;169;120;0m", "light fields keep enough contrast to stay gold");
  assert.equal(inputStyle("auto").command, "\x1b[1;38;2;169;120;0m", "unknown backgrounds take the contrast-safe color");
  const luminance = rgb => rgb.map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const [gold, field] = [[169, 120, 0], [228, 228, 228]].map(luminance);
  assert.ok((field + 0.05) / (gold + 0.05) >= 3, "light gold clears Ghostty's 2.3 minimum instead of being replaced with black");

  for (const [theme, background] of [["dark", "235"], ["light", "254"]]) {
    const prompt = createUI({ out: sink({ isTTY: true }), err: sink(), env: { TERM: "xterm", HCODE_INPUT_THEME: theme } }).prompt();
    assert.match(prompt.prompt, new RegExp(`\\x1b\\[48;5;${background}m`));
    assert.equal(stripAnsi(prompt.prompt), "\n› ", `${theme} changes only projection, never the prompt text`);
  }
  const native = createUI({ out: sink({ isTTY: true }), err: sink(), env: { TERM: "xterm" } }).prompt();
  assert.doesNotMatch(native.prompt, /\x1b\[48;5;/, "an unanswered auto theme keeps the terminal's own background instead of guessing");
});

test("one meaning, one ink: the writers each paint their own semantic role", () => {
  const out = sink({ isTTY: true }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.assistantStart(); terminal.assistantText("done"); terminal.assistantEnd();
  assert.match(out.text, /\x1b\[1;38;5;208m●\x1b\[0m \x1b\[1mhcode/, "who is speaking stays the warm brand gold");

  out.chunks.length = 0;
  terminal.toolStart("grep /x/ .", ["read"], { name: "grep", input: { pattern: "x", path: "." } });
  assert.match(out.text, /\x1b\[38;5;75m●\x1b\[0m \x1b\[38;5;245mSearching x\x1b\[0m/, "a tool call is a soft cyan mark over dim body text");
  out.chunks.length = 0;
  terminal.toolEnd("grep /x/ .", "", { state: "done", name: "grep", input: { pattern: "x", path: "." } });
  assert.doesNotMatch(out.text, /Searched|\[done\]/, "successful reads and searches leave no repetitive completion rows");

  terminal.toolEnd("$ npm test", "", { state: "done", durationMs: 1200, name: "bash", input: { command: "npm test" } });
  assert.match(out.text, /\x1b\[38;5;71m•\x1b\[0m \x1b\[1mRan npm test\x1b\[0m · 1\.2s/, "a meaningful completed action keeps a compact green record");

  out.chunks.length = 0;
  terminal.turnStart(); terminal.turnEnd();
  assert.match(out.text, /\x1b\[38;5;179m● .+…\x1b\[0m/, "the waiting word is warm sand — presence, not progress");

  const banner = sink({ isTTY: true }); const opening = createUI({ out: banner, err: sink(), env: { TERM: "xterm", HOME: "/Users/owner" } });
  opening.banner({ cwd: "/Users/owner", mode: "ask", runner: "hcode" }, "s");
  assert.match(banner.text, /\x1b\[38;5;179m「.+」\x1b\[0m/, "and so is the musing, because it is the same state");
  assert.doesNotMatch(stripAnsi(banner.text), /在你到来之前，我在想/);
  const quote = /「(.+)」/.exec(stripAnsi(banner.text))?.[1];
  assert.ok(MUSINGS.includes(quote), "the welcome contains exactly one line from its curated Tao Te Ching selection");

  const ends = sink({ isTTY: true }); const outcomes = createUI({ out: ends, err: sink(), env: { TERM: "xterm" } });
  outcomes.toolEnd("$ x", "", { state: "failed" }); outcomes.toolEnd("$ y", "", { state: "cancelled" });
  assert.match(ends.text, /\x1b\[38;5;203m✗\x1b\[0m Failed/); assert.match(ends.text, /\x1b\[38;5;214m▲\x1b\[0m Cancelled/);
});

test("owner actions distinguish matched commands, progress and completed results", () => {
  const out = sink({ isTTY: true });
  const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });

  terminal.ownerLine("/permissions");
  assert.match(out.text, /\x1b\[1;38;2;169;120;0m\/permissions\x1b\[0m/, "a real slash command is the gold action token");
  out.chunks.length = 0;
  terminal.ownerLine("/not-a-command");
  assert.doesNotMatch(out.text, /\x1b\[1;38;2;169;120;0m\/not-a-command/, "an unknown slash token is not advertised as a command");

  out.chunks.length = 0;
  terminal.progress("Checking for updates...");
  terminal.done("Update installed");
  assert.match(out.text, /\x1b\[38;5;140m◌\x1b\[0m/, "unfinished work uses the working role");
  assert.match(out.text, /\x1b\[38;5;71m✓\x1b\[0m/, "a completed owner action uses the done role");
});

test("40, 80 and 120 columns preserve all critical facts", () => {
  for (const columns of [40, 80, 120]) {
    const out = sink({ columns }); const err = sink({ columns });
    const terminal = createUI({ out, err, columns, env: { HOME: "/Users/owner", NO_COLOR: "" } });
    const prompt = sample(terminal, columns);
    const text = out.text + prompt;
    assert.match(text, /\n {2}○ Welcome to Hoop\n {2}Your machine\. Your work\.\n {2}hoop: not linked yet\n/);
    assert.match(text, /~\/Projects\/非常长的项目\/with-a-very-long-name/);
    assert.match(text, /· Hoop Code · ask before changes/);
    assert.match(text, /\n {2}「.+」\n/, "the welcome keeps the Tao line and removes the explanatory prefix");
    assert.doesNotMatch(text.slice(0, text.indexOf("◆ Owner decision")), /─/, "the banner commits no full-width rule to the scrollback");
    assert.match(text, /rm -rf build\/old-artifacts && printf done/);
    assert.match(text, /allow\? \[y\]es once \/ \[n\]o \/ \[a\]lways this session/);
    assert.ok(!text.includes("..."), `critical facts are not truncated at ${columns} columns`);
  }
});

test("brain picker puts action before machine detail and marks only ready paths", () => {
  const out = sink(); const err = sink();
  const terminal = createUI({ out, err, env: { HOME: "/Users/owner", NO_COLOR: "" } });
  const prompt = terminal.brainPicker([
    { label: "HoopGram account", status: "coming in 0.2.9", detail: "subscription service required" },
    { label: "Codex", status: "installed", selectable: true, detail: "uses its existing account" },
    { label: "My self-hosted Hoop", status: "advanced", detail: "uses SSH" },
  ], { required: true });
  const text = out.text + prompt;
  assert.match(text, /Connect the Hoop Code coordinator/);
  assert.match(text, /1\. HoopGram account  \[coming in 0\.2\.9\]/);
  assert.match(text, /2\. Codex  \[installed\]/);
  assert.match(text, /3\. My self-hosted Hoop  \[advanced\]/);
  assert.match(text, /Codex and Claude remain optional subagents/);
  assert.doesNotMatch(text, /x-api-key|ANTHROPIC|baseUrl/);
});

test("subagent handoff shows the exact bounded task and only yes/no", () => {
  const out = sink(); const terminal = createUI({ out, err: sink(), env: { NO_COLOR: "" } });
  const prompt = terminal.permission("delegate_agent", { agent: "codex", task: "inspect only src/parser.js", kind: "search" }, { risk: ["external"], why: "bounded read-only review" });
  const text = out.text + prompt;
  assert.match(text, /ask codex on search tier to investigate read-only/, "the approval says which brain it will spend");
  terminal.permission("delegate_agent", { agent: "claude", task: "t", model: "haiku" }, { risk: ["external"] });
  assert.match(out.text, /ask claude on haiku to investigate/);
  terminal.permission("delegate_agent", { agent: "claude", task: "t" }, { risk: ["external"] });
  assert.match(out.text, /ask claude to investigate/, "a call that named nothing still renders");
  assert.match(text, /inspect only src\/parser\.js/);
  assert.match(text, /send task\? \[y\]es \/ \[n\]o/);
  assert.doesNotMatch(text, /always this session/);
});

test("private workspace is an owner yes/no gate with no implicit consent", () => {
  const out = sink(); const terminal = createUI({ out, err: sink(), env: { HOME: "/Users/owner", NO_COLOR: "" } });
  const prompt = terminal.workspacePermission("/Users/owner", "codex");
  const text = out.text + prompt;
  assert.match(text, /◆ Owner decision/);
  assert.match(text, /codex will work directly in ~/);
  assert.match(text, /Allow access for this hcode session only/);
  assert.match(text, /continue\? \[y\]es \/ \[n\]o/);
  assert.match(text, /Press Enter without a choice: do not allow/);
  assert.doesNotMatch(text, /\.ssh|\.env|PRIVATE=/);
});

test("approval is owner-first, complete, and has no implicit consent", () => {
  const out = sink(); const terminal = createUI({ out, err: sink(), env: { NO_COLOR: "" } });
  const prompt = terminal.permission("edit_file", { path: "src/owner gate.js", old_string: "allow = true", new_string: "allow = false" }, {
    risk: ["write"], reason: "changes the owner gate", why: "the current default is unsafe",
  });
  const transcript = out.text + prompt;
  assert.match(transcript, /^\n◆ Owner decision/m);
  assert.match(transcript, /hcode wants to edit src\/owner gate\.js/);
  assert.match(transcript, /risk: write \/ changes the owner gate \/ the current default is unsafe/);
  assert.match(transcript, /Press Enter without a choice: do not run\./);
  assert.match(transcript, /- allow = true\n\+ allow = false/);
  assert.ok(!transcript.includes("[Y]"), "no choice is preselected");
  assert.doesNotMatch(transcript, /countdown|default:\s*yes/i);

  const commandOut = sink(); const commandUI = createUI({ out: commandOut, err: sink(), env: { NO_COLOR: "" } });
  commandUI.permission("bash", { command: "printf safe\nrm -rf build" }, { risk: ["write", "destructive"] });
  assert.match(commandOut.text, /hcode wants to run printf safe\nrm -rf build/, "approval preserves command boundaries");
  assert.match(commandUI.toolLabel("bash", { command: "printf safe\nrm -rf build" }), /printf safe \\n rm -rf build/);
});

test("tool lifecycle is one replaceable activity line with quiet completion", () => {
  const out = sink({ isTTY: true }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  const meta = { name: "bash", input: { command: "npm test" } };
  terminal.toolStart("$ npm test", ["write"], meta);
  terminal.toolEnd("$ npm test", "all tests passed", { state: "done", durationMs: 1234, ...meta });
  const text = stripAnsi(out.text);
  assert.equal((text.match(/● Running npm test/g) || []).length, 1);
  assert.equal((text.match(/• Ran npm test/g) || []).length, 1);
  assert.doesNotMatch(text, /Ctrl-C|all tests passed|\[done\]/);
  assert.match(text, /• Ran npm test · 1\.2s/);
  assert.match(text, /\r/, "TTY activity is replaced in place");

  const editMeta = { name: "edit_file", input: { path: "src/ui.js", old_string: "old line", new_string: "new line" } };
  terminal.toolStart("edit_file src/ui.js", ["write"], editMeta);
  terminal.toolEnd("edit_file src/ui.js", "1 replacement", { state: "done", durationMs: 8, ...editMeta });
  const edited = stripAnsi(out.text);
  assert.match(edited, /• Edited src\/ui\.js · 8ms/); assert.match(edited, /- old line\n {2}\+ new line/, "an edit leaves a bounded human-readable preview");

  const quietRead = sink({ isTTY: true }); const reader = createUI({ out: quietRead, err: sink(), env: { TERM: "xterm" } });
  const readMeta = { name: "read_file", input: { path: "src/ui.js" } };
  reader.toolStart("read_file src/ui.js", ["read"], readMeta);
  reader.toolEnd("read_file src/ui.js", "contents", { state: "done", durationMs: 3, ...readMeta });
  assert.match(stripAnsi(quietRead.text), /● Reading src\/ui\.js/);
  assert.doesNotMatch(stripAnsi(quietRead.text), /Read src\/ui\.js|\[done\]/, "read completion is transient, not one row per file");

  const endings = sink(); const states = createUI({ out: endings, err: sink(), env: { NO_COLOR: "" } });
  states.toolEnd("$ false", "exit 1", { state: "failed", durationMs: 10 });
  states.toolEnd("$ sleep 5", "cancelled", { state: "cancelled", durationMs: 20 });
  states.toolDenied("$ rm file", "the human declined");
  assert.match(endings.text, /✗ Failed.*▲ Cancelled.*○ Not run/s);
  assert.doesNotMatch(endings.text, /\[(?:failed|cancelled|not run)\]/);
  assert.doesNotMatch(endings.text, ESC_OR_CR);
});

test("public search has a distinct sourced-work activity instead of looking like a local read", () => {
  const out = sink({ isTTY: true }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  const meta = { name: "web_search", input: { query: "youtube anope" } };
  terminal.toolStart("web_search youtube anope", ["read", "network"], meta);
  terminal.toolEnd("web_search youtube anope", "1. result", { state: "done", durationMs: 40, ...meta });
  const rendered = stripAnsi(out.text);
  assert.match(rendered, /Searching the web · youtube anope/); assert.match(rendered, /Searched the web · youtube anope · 40ms/);
});

test("notices wrap inside both gutters and plans expose goal, checkpoint and live state", () => {
  const err = sink({ isTTY: false, columns: 40 });
  const out = sink({ isTTY: true, columns: 40 });
  const terminal = createUI({ out, err, columns: 40, env: { TERM: "xterm" } });
  terminal.warn("Unknown command /permissions-extra. Type / to search or /help to list commands.");
  const warning = stripAnsi(err.text).split("\n").filter(Boolean);
  assert.ok(warning.length > 1, "a narrow notice wraps instead of running through the right edge");
  for (const line of warning) { assert.match(line, /^  /); assert.ok(displayWidth(line) <= 38, line); }
  assert.doesNotMatch(err.text, /\[attention\]/);

  terminal.plan({ goal: "Fix the live work UI", checkpoint: "Render and verify", steps: [
    { label: "Inspect", status: "completed" }, { label: "Implement", status: "in_progress" }, { label: "Verify", status: "pending" },
  ] });
  const plan = stripAnsi(out.text);
  assert.match(plan, /• Updated Plan/); assert.match(plan, /Goal  Fix the live work UI/); assert.match(plan, /Checkpoint  Render and verify/);
  assert.match(plan, /✓ Inspect/); assert.match(plan, /◌ Implement/); assert.match(plan, /□ Verify/); assert.doesNotMatch(plan, /\[plan\]/);
});

test("waiting names a posture, rotates, and never keeps the process alive", async t => {
  const out = sink({ isTTY: true }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.turnStart();
  const first = stripAnsi(out.text).replace(/\r|\x1b\[2K/g, "");
  assert.match(first, /^● (.+)…$/);
  assert.ok(WAITING_WORDS.includes(first.slice(2, -1)), `${first} is one of the waiting words`);
  assert.doesNotMatch(first, /Thinking/, "the wait is not one fixed claim about an inner state");
  terminal.turnEnd();
  await new Promise(resolve => setTimeout(resolve, 20));
  const settled = out.text;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(out.text, settled, "turnEnd stops the rotation timer");

  // the composer path is the same decision, spoken to the live frame instead of the line
  const labels = [];
  const composer = { print() {}, clearActivity() { labels.push(null); }, setActivity(label) { labels.push(label); } };
  const framed = createUI({ out: sink({ isTTY: true }), err: sink(), env: { TERM: "xterm" } });
  framed.attachComposer(composer); framed.turnStart(); framed.turnEnd();
  const spoken = labels.find(Boolean);
  assert.ok(WAITING_WORDS.includes(spoken), `${spoken} is one of the waiting words`);
  assert.equal(labels.at(-1), null, "the frame is cleared when the turn ends");

  // rotation itself is arithmetic, so it is checked without waiting on a clock
  const walk = Array.from({ length: WAITING_WORDS.length + 2 }, (_, i) => waitingWord(i));
  assert.deepEqual(walk.slice(0, WAITING_WORDS.length), [...WAITING_WORDS]);
  assert.equal(walk.at(-2), WAITING_WORDS[0], "the words wrap instead of running out");
  assert.ok(MUSINGS.length >= 8 && MUSINGS.length <= 16, "the welcome carries a small selection, not a book");
  assert.ok(MUSINGS.join("").length < 300, "the complete embedded selection stays smaller than one short paragraph");
  assert.equal(new Set(MUSINGS).size, MUSINGS.length, "each line earns its place once");
  MUSINGS.forEach((quote, index) => assert.equal(musing(() => (index + 0.5) / MUSINGS.length), quote, "every line is reachable by the same random draw"));
});

test("one tool-action table drives composer and readline while plain stays control-free", () => {
  const literal = value => new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const cases = [
    { label: "read_file src/ui.js", meta: { name: "read_file", input: { path: "src/ui.js" } }, active: "Reading src/ui.js", done: "Read src/ui.js", kind: "reading", quiet: true },
    { label: "grep /owner/ src", meta: { name: "grep", input: { pattern: "owner", path: "src" } }, active: "Searching owner", done: "Searched owner", kind: "searching", quiet: true },
    { label: "web_search hcode", meta: { name: "web_search", input: { query: "hcode" } }, active: "Searching the web · hcode", done: "Searched the web · hcode", kind: "searching" },
    { label: "edit_file README.md", meta: { name: "edit_file", input: { path: "README.md", old_string: "a", new_string: "b" } }, active: "Editing README.md", done: "Edited README.md", kind: "editing" },
    { label: "$ npm test", meta: { name: "bash", input: { command: "npm test" } }, active: "Running npm test", done: "Ran npm test", kind: "running" },
    { label: "codex subagent", meta: { name: "delegate_agent", input: { agent: "codex" } }, active: "Working with codex", done: "Heard back from codex", kind: "coordinating" },
    { label: "Checking connectors", meta: {}, active: "Checking", done: "Checked", kind: "checking" },
  ];

  for (const row of cases) {
    const readlineOut = sink({ isTTY: true });
    const readline = createUI({ out: readlineOut, err: sink(), env: { TERM: "xterm" } });
    readline.toolStart(row.label, [], row.meta);
    readline.toolEnd(row.label, "", { state: "done", ...row.meta });
    const visible = stripAnsi(readlineOut.text).replace(/\r|\x1b\[2K/g, "");
    assert.match(visible, literal(row.active), `${row.label}: readline active`);
    if (row.quiet) assert.doesNotMatch(visible, literal(row.done), `${row.label}: quiet completion stays quiet`);
    else assert.match(visible, literal(row.done), `${row.label}: readline completion`);

    const activities = []; const projected = [];
    const composer = {
      print(value) { projected.push(String(value)); },
      setActivity(label, kind) { activities.push([label, kind]); },
      clearActivity() { activities.push(null); },
    };
    const framed = createUI({ out: sink({ isTTY: true }), err: sink(), env: { TERM: "xterm" } });
    framed.attachComposer(composer);
    framed.toolStart(row.label, [], row.meta);
    framed.toolEnd(row.label, "", { state: "done", ...row.meta });
    assert.deepEqual(activities.find(Array.isArray), [row.active, row.kind], `${row.label}: composer receives the same semantic action`);
    assert.equal(activities.at(-1), null, `${row.label}: composer activity clears`);
    if (!row.quiet) assert.match(stripAnsi(projected.join("")), literal(row.done), `${row.label}: composer completion`);

    const plainOut = sink(); const plain = createUI({ out: plainOut, err: sink(), env: { NO_COLOR: "" } });
    plain.toolStart(row.label, [], row.meta);
    plain.toolEnd(row.label, "", { state: "done", ...row.meta });
    assert.doesNotMatch(plainOut.text, ESC_OR_CR, `${row.label}: plain sink has no terminal control`);
    if (row.quiet) assert.equal(plainOut.text, "", `${row.label}: quiet plain completion stays absent`);
    else assert.match(plainOut.text, literal(row.done), `${row.label}: plain completion keeps the semantic label`);
  }
});

test("Markdown answers render cleanly and the composer has a stable TTY boundary", () => {
  const plain = renderMarkdown("# Result\n\n**Ready** with `npm test`\n- one\n- two\n\n```js\nconst ok = true;\n```");
  assert.equal(plain, "Result\n\nReady with npm test\n• one\n• two\n\n│ const ok = true;");
  assert.doesNotMatch(plain, /\*\*|```|^#/m);
  const out = sink({ isTTY: true, columns: 50 }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  const prompt = terminal.prompt();
  assert.equal(typeof prompt, "object"); assert.match(stripAnsi(prompt.prompt), /^\n› $/); assert.match(stripAnsi(prompt.after), /^\n$/, "the field colour is reset and one breathing row follows the owner's line — no rule is committed to the scrollback");
  terminal.assistantStart(); terminal.assistantText("**Done**\n- verified"); terminal.assistantEnd();
  assert.doesNotMatch(stripAnsi(out.text), /\*\*/);
  // live dialog shape: speaker line, then the answer hanging two columns under it
  assert.match(stripAnsi(out.text), /  ● hcode\n  Done\n  • verified\n\n$/);
});

test("the live dialog names the speaker and hangs the answer; plain sinks stay verbatim", () => {
  const out = sink({ isTTY: true, columns: 50 }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.assistantStart("codex"); terminal.assistantText("one\n\ntwo"); terminal.assistantEnd();
  assert.equal(stripAnsi(out.text), "  ● codex\n  one\n\n  two\n\n", "speaker and text share the opening's two-cell margin; blank lines stay blank");
  const plain = sink(); const quiet = createUI({ out: plain, err: sink(), env: { NO_COLOR: "" } });
  quiet.assistantStart(); quiet.assistantText("one\n\ntwo"); quiet.assistantEnd();
  assert.equal(plain.text, "one\n\ntwo\n\n", "pipes and --print output carry no speaker line or hanging indent");
});

test("CJK answers keep both page gutters by terminal cell width", () => {
  const out = sink({ isTTY: true, columns: 40 }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.assistantStart(); terminal.assistantText("中文输出需要左右留白".repeat(6)); terminal.assistantEnd();
  const lines = stripAnsi(out.text).split("\n").filter(Boolean);
  assert.ok(lines.length > 2, "the CJK paragraph wraps instead of reaching the right wall");
  for (const line of lines) {
    assert.match(line, /^  /, "speaker and every answer line keep the left gutter");
    assert.ok(displayWidth(line) <= 38, `${line} leaves at least two cells on the right`);
  }
});

test("the owner's submitted line is committed to the transcript inside blank rows, never a rule", () => {
  const out = sink({ isTTY: true, columns: 40 }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.ownerLine("fix the bug\nand run tests");
  assert.equal(stripAnsi(out.text), "\n› fix the bug\n  and run tests\n\n");
  assert.doesNotMatch(out.text, /─/, "a rule in the scrollback breaks apart on the next zoom; whitespace reflows");
});

test("one speaker line per turn: tools and answer segments hang under it, the next prompt starts a new turn", () => {
  const out = sink({ isTTY: true, columns: 50 }); const terminal = createUI({ out, err: sink(), env: { TERM: "xterm" } });
  terminal.prompt();
  terminal.toolStart("grep /x/ .", ["read"], { name: "grep", input: { pattern: "x", path: "." } });
  terminal.toolEnd("grep /x/ .", "", { state: "done", name: "grep", input: { pattern: "x", path: "." } });
  terminal.assistantStart(); terminal.assistantText("found it"); terminal.assistantEnd();
  terminal.toolStart("$ npm test", ["write"], { name: "bash", input: { command: "npm test" } });
  terminal.toolEnd("$ npm test", "", { state: "done", name: "bash", input: { command: "npm test" } });
  terminal.assistantStart(); terminal.assistantText("all green"); terminal.assistantEnd();
  // the transient activity line is redrawn in place (\r + erase-line); drop those to read the final layout
  const turn = stripAnsi(out.text).replace(/\r|\x1b\[2K/g, "");
  assert.equal(turn.match(/● hcode/g).length, 1, "the speaker line is printed once, by whatever comes first");
  assert.equal(turn, "  ● hcode\n  ● Searching x  found it\n\n  ● Running npm test  • Ran npm test\n  all green\n\n");
  terminal.prompt();
  terminal.assistantStart(); terminal.assistantText("next turn"); terminal.assistantEnd();
  assert.equal(stripAnsi(out.text).match(/● hcode/g).length, 2, "a new prompt opens a new turn");
  terminal.ownerLine("and again");
  terminal.assistantStart(); terminal.assistantText("third"); terminal.assistantEnd();
  assert.equal(stripAnsi(out.text).match(/● hcode/g).length, 3, "the owner's line also opens a new turn (composer sessions never call prompt())");
});

test("the first answer can start immediately and later answers keep one breathing row", () => {
  const out = sink(); const terminal = createUI({ out, err: sink(), env: { NO_COLOR: "" } });
  terminal.assistantStart(); terminal.assistantText("First answer"); terminal.assistantEnd();
  terminal.assistantStart(); terminal.assistantText("Next answer"); terminal.assistantEnd();
  assert.equal(out.text, "First answer\n\nNext answer\n\n");
});

test("long paragraph deltas become visible before the turn ends", () => {
  const projected = [];
  const composer = { print(value) { projected.push(String(value)); }, clearActivity() {}, setActivity() {} };
  const terminal = createUI({ out: sink({ isTTY: true }), err: sink(), env: { TERM: "xterm" } });
  terminal.attachComposer(composer); terminal.assistantStart();
  terminal.assistantText("This answer is arriving progressively and should become visible while the model is still producing the rest of its response for the owner.");
  assert.ok(projected.some(value => /arriving progressively/.test(value)), "a bounded display line is projected before assistantEnd");
  terminal.assistantEnd();
});

test("control bytes are visible to the owner but cannot control the terminal", () => {
  const out = sink(); const terminal = createUI({ out, err: sink(), env: { NO_COLOR: "" } });
  const hostile = "printf approved\x1b]52;c;hidden\x07; \u009b31mACTUAL";
  terminal.permission("bash", { command: hostile }, { risk: ["write", "destructive"] });
  terminal.permission("write_file", { path: "payload.txt", content: hostile }, { risk: ["write"] });
  terminal.permission("edit_file", { path: "payload.txt", old_string: "plain", new_string: hostile }, { risk: ["write"] });
  terminal.assistantText(hostile);
  const escaped = "printf approved\\x1b]52;c;hidden\\x07; \\x9b31mACTUAL";
  assert.ok(out.text.split(escaped).length >= 5, "bash, write, edit and assistant surfaces show the same escaped bytes");
  assert.equal((out.text.match(/safety: non-printing input is escaped below/g) || []).length, 3, "only approvals containing actual non-printing input get an execution warning");
  assert.match(out.text, new RegExp(`write ${Buffer.byteLength(hostile)} bytes`), "byte count describes raw content, not its escaped preview");
  assert.match(terminal.toolLabel("bash", { command: hostile }), /\\x1b\]52;c;hidden\\x07; \\x9b31mACTUAL/);
  assert.doesNotMatch(out.text, UNSAFE_CONTROL);

  const literalOut = sink(); const literalUI = createUI({ out: literalOut, err: sink(), env: { NO_COLOR: "" } });
  literalUI.permission("bash", { command: String.raw`printf '\x1b'` }, { risk: ["write"] });
  assert.doesNotMatch(literalOut.text, /safety: non-printing input/, "literal escape text is not mislabeled as a hidden character");
});

test("print-mode usage can go to plain stderr without touching stdout", () => {
  const out = sink({ isTTY: true }); const err = sink({ isTTY: false });
  const terminal = createUI({ out, err, env: { TERM: "xterm" } });
  terminal.usage({ input: 10, output: 2, cacheWrite: 4, cacheRead: 30 }, 250, { stderr: true });
  assert.equal(out.text, "");
  assert.equal(err.text, ["used: 46 tokens / 250ms", "  input (uncached) 10", "  cache write      4", "  cache read       30", "  output           2", ""].join("\n"));
  assert.doesNotMatch(err.text, ESC_OR_CR);
});

test("usage from a brain without cache accounting still shows all four classes", () => {
  const out = sink({ isTTY: false });
  createUI({ out, err: sink(), env: { NO_COLOR: "" } }).usage({ input: 10, output: 2 }, 250);
  assert.match(out.text, /^used: 12 tokens \/ 250ms$/m);
  assert.match(out.text, /^ {2}cache write {6}0$/m);
  assert.match(out.text, /^ {2}cache read {7}0$/m);
});

// ---- the shared clock and meter ---------------------------------------------------------------
// One string, wherever presence is painted: the waiting word above the input box, the helper rows
// under it, the line a plain terminal rewrites with a carriage return. Two formatters would agree
// until the first of them learned about hours.
test("one formatter for every place presence is painted, and it rounds where a person stops counting", () => {
  // Under a minute the minutes are not written at all; a leading `0m ` is a column of zeroes to
  // look past to find the number that is actually moving.
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59_999), "59s", "the last moment before a minute is still seconds");
  assert.equal(formatElapsed(60_000), "1m 0s", "the first minute names the seconds it does not have");
  assert.equal(formatElapsed(274_000), "4m 34s");
  assert.equal(formatElapsed(-5), "0s", "time never runs backwards on this row");
  // Exact for as long as exact is readable.
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(109_700), "109.7k");
  // The whole string, and the one case where half of it is left off: `↓ 0 tokens` is a number
  // pretending to be news.
  assert.equal(formatSpend(274_000, 109_700), "4m 34s · ↓ 109.7k tokens");
  assert.equal(formatSpend(345_000, 83_900), "5m 45s · ↓ 83.9k tokens");
  assert.equal(formatSpend(4_000, 0), "4s", "no spend yet is no token half, not a zero");
  assert.equal(formatSpend(4_000, 999), "4s · ↓ 999 tokens");
});

// A board driven the way the owner's thread drives the real one: observe(), then the events a
// running turn actually emits.
const watchedTurn = (elapsedMs, usage) => {
  const now = 1_700_000_000_000;
  const listeners = [];
  const board = new Presence({ now: () => now, tickMs: 0 });
  board.observe({ id: "own", dir: "", events: [], onEvent: fn => { listeners.push(fn); return () => {}; } });
  for (const fn of listeners) fn({ type: "turn.start", ts: now - elapsedMs });
  for (const fn of listeners) fn({ type: "usage", live: true, ...usage });
  return board;
};

test("the waiting row carries the turn's own clock, on one timer, and only when a turn is observed", async () => {
  // Nobody is watching a turn: the wait is still honest, it just has no numbers to show.
  const bare = sink({ isTTY: true });
  const bareUI = createUI({ out: bare, err: sink(), env: { TERM: "xterm" }, presence: new Presence({ tickMs: 0 }) });
  bareUI.turnStart();
  assert.match(stripAnsi(bare.text).replace(/\r|\x1b\[2K/g, ""), /^● .+…$/, "an unobserved turn shows no clock counting up from nothing");
  bareUI.turnEnd();

  // A turn presence is watching: the same string the board under the input box uses, dim and in
  // brackets, on the row the waiting word already had.
  const board = watchedTurn(345_000, { in: 80_000, out: 3_900 });
  assert.equal(board.mainTurn.active, true);
  const watched = sink({ isTTY: true });
  const watchedUI = createUI({ out: watched, err: sink(), env: { TERM: "xterm" }, presence: board });
  watchedUI.turnStart();
  const row = stripAnsi(watched.text).replace(/\r|\x1b\[2K/g, "");
  assert.match(row, /^● .+… \(5m 45s · ↓ 83\.9k tokens\)$/, `the waiting row carries the meter: ${row}`);
  assert.match(watched.text, /\x1b\[38;5;245m\(5m 45s/, "the meter is dim: it is true, not news");
  watchedUI.turnEnd();

  // One timer, not two. The row repaints on the second so the clock moves, while the word keeps
  // its own slow cadence — and turnEnd() stops the single interval that does both jobs.
  const ticking = sink({ isTTY: true });
  const tickingUI = createUI({ out: ticking, err: sink(), env: { TERM: "xterm" }, presence: board });
  tickingUI.turnStart();
  const before = ticking.chunks.length;
  await new Promise(resolve => setTimeout(resolve, TURN_METER_MS + 150));
  assert.ok(ticking.chunks.length > before, "the row repaints on the second, not on the word's cadence");
  const words = new Set(stripAnsi(ticking.text).split(/\r/).map(line => (line.match(/● (.+?)…/) || [])[1]).filter(Boolean));
  assert.equal(words.size, 1, "one second is not long enough for the word to change under the reader");
  tickingUI.turnEnd();
  const settled = ticking.chunks.length;
  await new Promise(resolve => setTimeout(resolve, TURN_METER_MS + 80));
  assert.equal(ticking.chunks.length, settled, "turnEnd stops the one timer that does both jobs");
});
