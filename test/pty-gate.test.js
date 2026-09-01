import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const probe = new URL("./fixtures/pty-probe.mjs", import.meta.url).pathname;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("direct PTY and independent tmux socket preserve size, CJK and bracketed paste", t => {
  const script = spawnSync("sh", ["-lc", "command -v script"], { encoding: "utf8" }).stdout.trim();
  const tmux = spawnSync("sh", ["-lc", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
  if (!script || !tmux) { t.skip("blocked-by-environment: script/tmux unavailable"); return; }
  // BSD/macOS script(1) has no equivalent of GNU util-linux's `-qfec`, and feeding a
  // non-interactive stdin source to `script <file> <cmd>` on macOS makes the pty
  // driver deliver a premature EOF (a literal ^D) to the child before the real
  // payload arrives, no matter how the input is supplied (regular file, pipe, or
  // fifo all reproduce it). So the direct (non-tmux) half only runs where GNU
  // script is available; the independent-tmux-socket half below is unaffected and
  // still exercises real PTY behaviour on macOS.
  const directPty = process.platform !== "darwin";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-pty-gate-")); const payload = "第一行\nsecond 🧑🏽‍💻"; const socket = `hcode-pty-${process.pid}`;
  try {
    const call = args => spawnSync(tmux, ["-L", socket, ...args], { encoding: "utf8", timeout: 5000 });
    for (const columns of [40, 60, 80, 120]) {
      if (directPty) {
        const direct = path.join(dir, `direct-${columns}.json`); const run = spawnSync(script, ["-qfec", `stty -echo cols ${columns} rows 24; ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)} ${JSON.stringify(direct)}`, "/dev/null"], { input: `\x1b[200~${payload}\x1b[201~`, encoding: "utf8", timeout: 5000 });
        assert.equal(run.status, 0, run.stderr); const one = JSON.parse(fs.readFileSync(direct)); assert.equal(one.columns, columns); assert.equal(one.paste, payload); assert.match(one.raw, /\x1b\[/); assert.equal(one.normalized, one.frame.join("\n"));
      }
      const session = `gate-${columns}`, result = path.join(dir, `tmux-${columns}.json`), buffer = path.join(dir, `paste-${columns}.txt`); fs.writeFileSync(buffer, payload);
      assert.equal(call(["new-session", "-d", "-x", String(columns), "-y", "24", "-s", session, process.execPath, probe, result]).status, 0); pause(100);
      assert.equal(call(["load-buffer", "-b", session, buffer]).status, 0); assert.equal(call(["paste-buffer", "-p", "-b", session, "-t", session]).status, 0);
      for (let i = 0; i < 50 && !fs.existsSync(result); i++) pause(20);
      assert.ok(fs.existsSync(result), `tmux PTY ${columns} completed`); const two = JSON.parse(fs.readFileSync(result)); assert.equal(two.columns, columns); assert.equal(two.paste, payload); assert.equal(two.normalized, two.frame.join("\n")); assert.match(two.frame.join("\n"), /中文.*🧑🏽‍💻/);
    }
  } finally { spawnSync(tmux, ["-L", socket, "kill-server"], { encoding: "utf8", timeout: 5000 }); fs.rmSync(dir, { recursive: true, force: true }); }
});
