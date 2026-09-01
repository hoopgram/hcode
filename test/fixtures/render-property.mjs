// Runs inside a real tmux PTY. Replays one seeded, interleaved event sequence through the
// composer, then repaints the same state from scratch, so the driver can capture the pane
// before and after and prove the two frames are the same screen. Every wait is a real timer:
// SIGWINCH only reaches process.stdout when the event loop turns.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { TerminalComposer } from "../../src/composer.js";
import { layoutFrame, stripAnsi } from "../../src/frame.js";

const [seedArg, dir, tmuxBin, socket, target] = process.argv.slice(2);
if (!process.stdout.isTTY || !dir) process.exit(2);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const settle = () => sleep(45);

let seed = (Number(seedArg) >>> 0) || 1;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
const pick = list => list[Math.floor(random() * list.length)];

// A board the sequence can grow and shrink. Presence is not what is under test here — the frame
// arithmetic is: the rows under the input box are the one part of the live frame whose height
// changes on its own, without a keystroke, so a repaint that reserved the wrong number of rows
// would show up as a scroll region that moved and a page a line short of the golden draw.
let helpers = [];
const STATES = ["working", "done", "failed", "cancelled"];
const board = {
  list: () => helpers,
  transcript: () => [],
  subscribe: () => () => {},
  get mainTurn() { return { active: false, startedAt: 0, elapsedMs: 0, tokens: 0 }; },
};
const composer = new TerminalComposer({ env: { TERM: "xterm-256color", HCODE_REDUCE_MOTION: "1" }, presence: board });
// Every transcript write, so the golden repaint can put the same history back on a clean page.
// This is the oracle the composer's own transcript ring is checked against: only a banner-style
// page reset drops it, exactly as it drops the ring — a resize no longer does, because a reflow
// now repaints the history at the new width instead of abandoning it.
let transcript = [];
const say = value => { transcript.push(value); composer.print(value); };
composer.on("transcript-reset", () => { transcript = []; });

// Nothing the sequence prints is ever wider than the narrowest column count below, so any
// reflow the driver sees is the composer's own frame moving, not the terminal rewrapping text.
const TALK = ["● hcode 中文回答", "  第一行 🧑🏽‍💻 done", "  tool: read src/frame.js", "  ✓ 237 pass 0 skip", "  ● 家 家 家 家 家"];
const PASTES = ["第一行\nsecond 🧑🏽‍💻", "家家家家家家家家", "one\ntwo\nthree", "🧑🏽‍💻🧑🏽‍💻 mixed 中文"];
const OPTIONS = [
  { label: "Ask", description: "Confirm each write.", current: true },
  { label: "Auto", description: "Only unsafe actions ask." },
  { label: "Full", description: "No prompts at all." },
];

const events = [];
const resize = async columns => {
  events.push(`resize ${columns}`);
  spawnSync(tmuxBin, ["-L", socket, "resize-window", "-t", target, "-x", String(columns), "-y", "24"], { timeout: 5000 });
  for (let i = 0; i < 60 && composer.columns !== columns; i++) await sleep(25);
  if (composer.columns !== columns) throw new Error(`resize to ${columns} never reached the composer (still ${composer.columns})`);
  await settle();
};

const steps = {
  resize: () => resize(pick([40, 52, 64, 80, 100, 120, 160])),
  talk: () => { events.push("talk"); say(pick(TALK) + "\n"); },
  burst: () => { events.push("burst"); for (let i = 0; i < 8; i++) say(`  ${i} ${pick(TALK)}\n`); },
  paste: () => { events.push("paste"); composer.feed(`\x1b[200~${pick(PASTES)}\x1b[201~`); },
  submit: () => { events.push("submit"); composer.feed("\r"); },
  clear: () => { events.push("clear"); composer.feed("\x15"); },
  slash: () => { events.push("slash"); composer.feed("\x15/co"); composer.feed("\x1b[B"); },
  activity: () => { events.push("activity"); composer.setActivity(pick(["Thinking", "Running", "Reading"]), "work"); },
  idle: () => { events.push("idle"); composer.clearActivity(); },
  tick: () => { events.push("tick"); composer.pulse++; composer.draw(); },
  busy: () => { events.push("busy"); composer.setBusy(!composer.busy); composer.setQueueCount(Math.floor(random() * 3)); },
  attach: () => { events.push("attach"); composer.addAttachment({ id: "img-1", label: "Image #1", path: "/tmp/hcode-images-safe/img-1.png" }); },
  agents: () => {
    const count = Math.floor(random() * 6);
    events.push(`agents ${count}`);
    helpers = Array.from({ length: count }, (_, i) => ({
      id: `child-${i}`, kind: i % 2 ? "codex" : "claude", model: "", state: STATES[i % STATES.length],
      title: `helper ${i} 家家家家`, activity: i % 3 ? `Reading 家frame.js…` : "", summary: "", outcome: "", thread: "",
      startedAt: 0, elapsedMs: i * 61_000 + 4000, tokens: i * 1234,
    }));
    composer.draw();
  },
  menu: async () => {
    events.push("menu");
    const done = composer.select({ title: "Permissions", options: OPTIONS, initial: 0 });
    await settle();
    composer.feed("\x1b[B");
    await settle();
    composer.feed(random() < 0.5 ? "\r" : "\x1b");
    // A lone Esc is only known to be the Esc key once the flush timer says nothing followed.
    if (composer.menu) await sleep(80);
    if (composer.menu) composer.feed("\r");
    return done;
  },
  approval: async () => {
    events.push("approval");
    const answer = composer.ask("allow write to src/frame.js? [y]es / [n]o\n> ");
    await settle();
    composer.feed("y\r");
    return answer;
  },
};
const KINDS = ["resize", "talk", "talk", "burst", "paste", "submit", "clear", "slash", "activity", "idle", "tick", "busy", "attach", "agents", "agents", "menu", "approval"];

const snapshot = () => {
  const frame = layoutFrame(composer.frameState);
  const printed = transcript.length ? transcript.join("").replace(/\n$/, "").split("\n").map(row => row.replace(/\s+$/, "")) : [];
  return {
    seed: Number(seedArg), events, columns: composer.columns, rows: composer.rows,
    scrollBottom: composer.scrollBottom, transcriptRow: composer.transcriptRow, pinned: composer.pinned, printed,
    frameRows: frame.rows.map(row => stripAnsi(row).replace(/\s+$/, "")),
    // How much of the history the ring can still put back: once it has dropped lines the page
    // is only the tail it kept, and the driver stops asking for more than that.
    dropped: composer.transcriptDropped,
  };
};

const run = async () => {
  composer.start();
  await settle();
  // Each event carries the frame geometry it left behind, so a failing trace says where the
  // region moved and how many lines had been printed by then.
  for (let i = 0; i < 24; i++) {
    await steps[pick(KINDS)]();
    events[events.length - 1] += `[sB=${composer.scrollBottom} tr=${composer.transcriptRow} n=${transcript.length}]`;
  }
  await sleep(150);
  fs.writeFileSync(`${dir}/phase1.json`, JSON.stringify(snapshot()));

  for (let i = 0; i < 400 && !fs.existsSync(`${dir}/go`); i++) await sleep(25);
  // The golden frame: the same composer state, drawn onto a page that has been scrolled away.
  const history = [...transcript];
  composer.resetScrollRegion();
  composer.writer.write(`\x1b[${composer.rows}S\x1b[H\x1b[J`);
  composer.drawnRows = 0;
  composer.cursorTail = 0;
  composer.resetTranscript();
  composer.draw();
  for (const value of history) composer.print(value);
  await sleep(150);
  fs.writeFileSync(`${dir}/phase2.json`, JSON.stringify(snapshot()));
  await sleep(400);
  process.exit(0);
};

run().catch(error => { fs.writeFileSync(`${dir}/error.txt`, String(error && error.stack || error)); process.exit(3); });
