// The rendering quality gate. Whatever the owner does — resize, CJK paste, streamed output,
// menus, approvals — the terminal has to end up showing exactly the screen a fresh draw()
// of the same composer state would paint, with nothing left over above the scroll region.
// "The same state" now includes the composer's transcript ring, so the comparison covers the
// whole page and not just the frame: a line that scrolled out has to come back on a reflow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const harness = new URL("./fixtures/render-property.mjs", import.meta.url).pathname;
const source = new URL("../src", import.meta.url).pathname;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ROWS = 24;
// Fixed seeds, so a failure reproduces exactly; HCODE_RENDER_SEEDS widens the sweep by hand.
const SEEDS = Array.from({ length: Math.max(1, Number(process.env.HCODE_RENDER_SEEDS) || 12) }, (_, index) => (0x5eed + index * 0x9e3779b1) >>> 0);
// Composer frame furniture: none of it may survive above the scroll region.
const FURNITURE = [/─{6,}/, /(?:Enter send|Enter accepts|Esc interrupt)(?: ·|$)/, /^›\s/, /Press enter to confirm/];

const waitFor = (file, tries = 400) => { for (let i = 0; i < tries && !fs.existsSync(file); i++) pause(25); return fs.existsSync(file); };

test("real PTYs keep the idle and busy footer to one complete row at 40, 80 and 120 columns", t => {
  const tmux = spawnSync("sh", ["-lc", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  if (!tmux) { t.skip("blocked-by-environment: tmux unavailable"); return; }
  const socket = `hcode-footer-${process.pid}`; const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-footer-pty-"));
  const call = args => spawnSync(tmux, ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
  const probe = path.join(dir, "footer-probe.mjs");
  fs.writeFileSync(probe, `
import fs from "node:fs";
import { TerminalComposer } from ${JSON.stringify(path.join(source, "composer.js"))};
const [ready, go, busy] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const composer = new TerminalComposer({ env: { TERM: "xterm-256color", HCODE_REDUCE_MOTION: "1" } });
composer.start();
composer.setMeter({ text: "↓ 3.8K tokens · Context 97% left · 3.4K/120K · 4.6K cu", identity: { model: "deepseek-v4-pro", effort: "medium", sessionMode: "default", permission: "all" }, band: "calm" });
fs.writeFileSync(ready, "idle");
while (!fs.existsSync(go)) await sleep(20);
composer.setBusy(true); await sleep(50); fs.writeFileSync(busy, "busy");
await new Promise(() => {});
`);
  const footer = (session, columns, action) => {
    const shot = call(["capture-pane", "-p", "-t", session]);
    assert.equal(shot.status, 0, shot.stderr);
    const lines = shot.stdout.replace(/\n$/, "").split("\n").map(row => row.replace(/\s+$/, ""));
    const expected = columns === 40 ? `  ${action} · deepseek-v4-pro` : `  ${action} · deepseek-v4-pro · Context 97% left`;
    assert.equal(lines.at(-1), expected, `${columns}: exact footer projection`);
    assert.equal(lines.filter(row => row.includes(action)).length, 1, `${columns}: action occupies one physical row`);
    assert.doesNotMatch(lines.join("\n"), /Shift\+Enter|Ctrl-C twice|\? keys|3\.8K tokens|3\.4K\/120K|4\.6K cu|medium|default|all/);
  };

  try {
    for (const columns of [40, 80, 120]) {
      const session = `footer-${columns}`; const ready = path.join(dir, `${columns}-ready`);
      const go = path.join(dir, `${columns}-go`); const busy = path.join(dir, `${columns}-busy`);
      const started = call(["new-session", "-d", "-x", String(columns), "-y", String(ROWS), "-s", session, process.execPath, probe, ready, go, busy]);
      assert.equal(started.status, 0, started.stderr); assert.ok(waitFor(ready), `${columns}: idle footer probe did not start`);
      footer(session, columns, "Enter send");
      fs.writeFileSync(go, ""); assert.ok(waitFor(busy), `${columns}: busy footer probe did not repaint`);
      footer(session, columns, "Esc interrupt");
      call(["kill-session", "-t", session]);
    }
  } finally {
    spawnSync(tmux, ["-L", socket, "kill-server"], { encoding: "utf8", timeout: 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("random PTY sequences repaint to the golden frame with no residue outside the scroll region", t => {
  const tmux = spawnSync("sh", ["-lc", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  if (!tmux) { t.skip("blocked-by-environment: tmux unavailable"); return; }
  const socket = `hcode-render-${process.pid}`;
  const call = args => spawnSync(tmux, ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
  const capture = target => {
    const shot = call(["capture-pane", "-p", "-t", target]);
    assert.equal(shot.status, 0, shot.stderr);
    const lines = shot.stdout.replace(/\n$/, "").split("\n").map(row => row.replace(/\s+$/, ""));
    while (lines.length < ROWS) lines.push("");
    return lines.slice(0, ROWS);
  };

  try {
    for (const seed of SEEDS) {
      const why = extra => `seed 0x${seed.toString(16)}${extra ? ` — ${extra}` : ""}`;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hcode-render-${seed.toString(16)}-`));
      const session = `render-${seed.toString(16)}`;
      try {
        const started = call(["new-session", "-d", "-x", "80", "-y", String(ROWS), "-s", session,
          process.execPath, harness, String(seed), dir, tmux, socket, session]);
        assert.equal(started.status, 0, started.stderr);
        assert.ok(waitFor(path.join(dir, "phase1.json")), why(`harness never finished${fs.existsSync(path.join(dir, "error.txt")) ? `: ${fs.readFileSync(path.join(dir, "error.txt"), "utf8")}` : ""}`));

        const one = JSON.parse(fs.readFileSync(path.join(dir, "phase1.json"), "utf8"));
        const trace = why(one.events.join(" › "));
        const before = capture(session);
        fs.writeFileSync(path.join(dir, "go"), "");
        assert.ok(waitFor(path.join(dir, "phase2.json")), `${trace} — golden repaint never finished`);
        const two = JSON.parse(fs.readFileSync(path.join(dir, "phase2.json"), "utf8"));
        const after = capture(session);

        // (a) the whole screen is what a fresh draw of the same state paints — transcript rows
        // included. Before the transcript ring the composer modelled no line that had scrolled
        // out of the region, so this only held while nothing had scrolled and the page silently
        // ran a line short of the golden repaint; now the page is a function of (ring, frame).
        assert.ok(one.pinned && one.scrollBottom > 0, `${trace} — the composer stayed pinned`);
        assert.equal(two.scrollBottom, one.scrollBottom, `${trace} — the repaint reserved a different frame`);
        assert.deepEqual(before, after, `${trace} — screen differs from a fresh repaint of the same state`);
        const expected = one.frameRows.map(row => row.replace(/\s+$/, ""));
        while (expected.length < ROWS - one.scrollBottom) expected.push("");
        assert.deepEqual(before.slice(one.scrollBottom), expected, `${trace} — the live frame is not the frame a fresh draw paints`);
        assert.deepEqual(after.slice(one.scrollBottom), expected, `${trace} — the repainted live frame drifted`);

        // (b) nothing of the composer's frame is left above the scroll region, the transcript
        // stops exactly where the composer thinks it stops, and what is on the page is the
        // *newest* unbroken run of what was printed — no gap, no overwrite, no doubled line and
        // no line stranded in the scrollback while a blank row sits where it belongs. Once the
        // ring has dropped lines it can only put back the tail it kept, so the run is checked
        // against what is still replayable.
        const history = before.slice(0, one.scrollBottom);
        for (const row of history) for (const shape of FURNITURE) assert.doesNotMatch(row, shape, `${trace} — composer furniture left above the scroll region`);
        const last = history.reduce((end, row, index) => row ? index + 1 : end, 0);
        assert.ok(last <= one.transcriptRow, `${trace} — row ${last} is written on but the composer thinks the transcript ends at ${one.transcriptRow}`);
        const visible = history.slice(0, last);
        assert.equal(one.dropped, 0, `${trace} — the ring dropped ${one.dropped} lines, so the sequence outgrew it`);
        assert.deepEqual(visible, one.printed.slice(one.printed.length - visible.length), `${trace} — the visible transcript is not the newest unbroken run of what was printed`);
      } finally {
        call(["kill-session", "-t", session]);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally { spawnSync(tmux, ["-L", socket, "kill-server"], { encoding: "utf8", timeout: 5000 }); }
});

// A fourth render path that writes cursor or scroll-region control to the terminal on its own
// would be invisible to the gate above, so keep the sink closed by construction.
test("only the composer paints cursor and scroll-region control; no fourth render path", () => {
  // src/ui.js owns the readline path (a carriage return plus erase-line for its one-line
  // activity, and the banner's page clear); everything else must go through the composer.
  const allowed = new Map([["ui.js", ["\\x1b[2J\\x1b[3J\\x1b[H"]]]);
  // Cursor movement and absolute positioning (also when the row is interpolated), cursor
  // visibility, erase-in-display, scroll region, scroll up/down. Erase-in-line and colour
  // are not screen geometry, so they stay legal everywhere.
  const control = /\\x1b\[(?:\?25[lh]|(?:[0-9;]|\$\{[^}]*\})*(?:[ABCDEFGHJSTdf]|r(?![a-zA-Z0-9])))/;
  const offenders = [];
  for (const name of fs.readdirSync(source).filter(file => file.endsWith(".js"))) {
    if (name === "composer.js") continue;
    const lines = fs.readFileSync(path.join(source, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      let rest = line;
      for (const literal of allowed.get(name) || []) rest = rest.split(literal).join("");
      if (control.test(rest)) offenders.push(`${name}:${index + 1} ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], "cursor/scroll control outside composer.paint()/erase() and the readline whitelist");
});
