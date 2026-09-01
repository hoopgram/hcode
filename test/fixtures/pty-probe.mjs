import fs from "node:fs";
import { createInputState, reduceInput } from "../../src/input-state.js";
import { createFrameState, layoutFrame, reduceFrame, stripAnsi } from "../../src/frame.js";
const output = process.argv[2]; let input = createInputState(), pending = "";
if (!process.stdin.isTTY || !process.stdout.isTTY || !output) process.exit(2);
process.stdin.setRawMode(true); process.stdout.write("\x1b[?2004h");
process.stdin.on("data", chunk => {
  pending += chunk.toString("utf8"); const start = pending.indexOf("\x1b[200~"), end = pending.indexOf("\x1b[201~");
  if (start < 0 || end < start) return;
  input = reduceInput(input, { type: "paste.start" }); input = reduceInput(input, { type: "paste.append", value: pending.slice(start + 6, end) }); input = reduceInput(input, { type: "paste.end" });
  let frame = createFrameState({ columns: process.stdout.columns, rows: process.stdout.rows }); frame = reduceFrame(frame, { type: "live.replaced", rows: ["● PTY 中文 🧑🏽‍💻", `› ${input.buffer}`], cursorRow: 1, cursorColumn: 3 });
  const laid = layoutFrame(frame); const raw = `\x1b[38;5;214m${laid.rows.join("\n")}\x1b[0m`; const normalized = stripAnsi(raw);
  process.stdout.write(raw); fs.writeFileSync(output, JSON.stringify({ tty: true, columns: process.stdout.columns, rows: process.stdout.rows, paste: input.buffer, raw, normalized, frame: laid.rows }) + "\n");
  process.stdout.write("\x1b[?2004l"); process.exit(0);
});
