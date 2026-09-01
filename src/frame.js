// Pure terminal-frame model. Durable transcript events never enter `live.rows`;
// resize replays this bounded state and FrameWriter is the sole byte sink.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = value => segmenter ? [...segmenter.segment(String(value))].map(row => row.segment) : Array.from(String(value));
const codeWidth = code => {
  if (code === 0x200d || (code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
};
const graphemeWidth = value => Math.max(0, ...Array.from(value, character => codeWidth(character.codePointAt(0))));
export const stripAnsi = value => String(value || "").replace(ANSI, "");
export const displayWidth = value => graphemes(stripAnsi(value)).reduce((sum, item) => sum + graphemeWidth(item), 0);

// Greedy terminal-cell wrapping shared by the live frame and streamed answers. JavaScript length
// is not a layout unit: CJK and emoji occupy two cells, while combining marks occupy none. A word
// wider than the available row is split by grapheme so no projected line crosses its right gutter.
export function wrapText(text, columns) {
  const width = Math.max(1, Number(columns) || 1);
  const out = [];
  for (const paragraph of String(text || "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (displayWidth(line + word) <= width) { line += word; continue; }
      if (line.trim()) out.push(line.trimEnd());
      let chunk = word.trimStart();
      while (displayWidth(chunk) > width) {
        const parts = graphemes(chunk); let part = ""; let index = 0;
        while (index < parts.length && displayWidth(part + parts[index]) <= width) part += parts[index++];
        out.push(part); chunk = parts.slice(index).join("");
      }
      line = chunk;
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}

export function fitAnsi(value, columns) {
  const width = Math.max(1, Number(columns) || 1); const text = String(value || "");
  if (displayWidth(text) <= width) return text;
  const tokens = text.split(/(\x1b\[[0-?]*[ -/]*[@-~])/g).filter(Boolean); let used = 0, out = "", styled = false;
  for (const token of tokens) {
    if (/^\x1b\[/.test(token)) { out += token; styled = true; continue; }
    for (const item of graphemes(token)) {
      const cells = graphemeWidth(item); if (used + cells > width - 1) return out + "…" + (styled ? "\x1b[0m" : "");
      out += item; used += cells;
    }
  }
  return out;
}

export function createFrameState({ columns = 80, rows = 0 } = {}) {
  return Object.freeze({ v: 1, columns: Math.max(20, Number(columns) || 80), rows: Math.max(0, Number(rows) || 0), revision: 0, transcriptCount: 0,
    live: Object.freeze({ rows: Object.freeze([]), cursorRow: 0, cursorColumn: 1 }) });
}

export function reduceFrame(state, event) {
  if (!state || state.v !== 1) throw new Error("invalid frame state");
  if (!event || typeof event !== "object") throw new Error("invalid frame event");
  if (event.type === "resize") return Object.freeze({ ...state, columns: Math.max(20, Number(event.columns) || 80), rows: Math.max(0, Number(event.rows) || 0), revision: state.revision + 1 });
  if (event.type === "transcript.committed") return Object.freeze({ ...state, transcriptCount: state.transcriptCount + Math.max(1, Number(event.count) || 1), revision: state.revision + 1 });
  if (event.type === "live.replaced") {
    const limit = Math.max(1, Math.min(64, Number(event.limit) || 64)); const rows = (Array.isArray(event.rows) ? event.rows : []).slice(-limit).map(String);
    return Object.freeze({ ...state, revision: state.revision + 1, live: Object.freeze({ rows: Object.freeze(rows), cursorRow: Math.max(0, Math.min(rows.length - 1, Number(event.cursorRow) || 0)), cursorColumn: Math.max(1, Number(event.cursorColumn) || 1) }) });
  }
  throw new Error(`unknown frame event: ${event.type}`);
}

export function layoutFrame(state) {
  const rows = state.live.rows.map(row => fitAnsi(row, state.columns));
  const pinned = state.rows >= 8 && rows.length < state.rows;
  const scrollBottom = pinned ? state.rows - rows.length : 0;
  return Object.freeze({ v: 1, revision: state.revision, columns: state.columns, terminalRows: state.rows, mode: pinned ? "pinned" : "inline",
    scrollBottom, rows: Object.freeze(rows), cursor: Object.freeze({ row: Math.max(0, Math.min(rows.length - 1, state.live.cursorRow)), column: Math.min(state.columns, state.live.cursorColumn) }), transcriptCount: state.transcriptCount });
}

export class FrameWriter {
  constructor(output) { if (!output || typeof output.write !== "function") throw new Error("frame writer needs an output"); this.output = output; this.writes = 0; }
  write(value) { this.writes++; return this.output.write(String(value)); }
}
