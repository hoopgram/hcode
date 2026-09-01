// Pure, replayable owner-input state. Terminal bytes are decoded by composer.js;
// this reducer owns paste, queue, interrupts and slash selection without doing I/O.
export const BREATHING_CADENCE_MS = Object.freeze({ stream: 120, active: 240, calm: 480 });

export function createInputState() {
  return Object.freeze({ v: 1, buffer: "", paste: "", pasting: false, queueCount: 0, interruptCount: 0, slash: Object.freeze({ names: Object.freeze([]), selection: 0 }), revision: 0 });
}

const freeze = state => Object.freeze({ ...state, slash: Object.freeze({ ...state.slash, names: Object.freeze([...state.slash.names]) }) });
export function reduceInput(state, event) {
  if (!state || state.v !== 1 || !event || typeof event !== "object") throw new Error("invalid input reducer event");
  const next = { ...state, revision: state.revision + 1, slash: { ...state.slash, names: [...state.slash.names] } };
  if (event.type === "buffer.set") next.buffer = String(event.value || "");
  else if (event.type === "queue.set") next.queueCount = Math.max(0, Math.min(999, Number(event.count) || 0));
  else if (event.type === "interrupt") next.interruptCount++;
  else if (event.type === "paste.start") { next.pasting = true; next.paste = ""; }
  else if (event.type === "paste.append") { if (!next.pasting) throw new Error("paste append without start"); next.paste += String(event.value || ""); }
  else if (event.type === "paste.end") { if (!next.pasting) throw new Error("paste end without start"); next.buffer += String(next.paste).replace(/\r\n?/g, "\n").replace(/\x00/g, ""); next.paste = ""; next.pasting = false; }
  else if (event.type === "slash.matches") { next.slash.names = (Array.isArray(event.names) ? event.names : []).map(String).slice(0, 64); next.slash.selection = Math.max(0, Math.min(next.slash.names.length - 1, next.slash.selection)); }
  else if (event.type === "slash.move") { const size = next.slash.names.length; next.slash.selection = size ? (next.slash.selection + Number(event.delta || 0) + size) % size : 0; }
  else if (event.type === "slash.complete") { const name = next.slash.names[next.slash.selection]; if (name) next.buffer = `/${name}${event.takesArgs ? " " : ""}`; next.slash.selection = 0; }
  else throw new Error(`unknown input event: ${event.type}`);
  return freeze(next);
}

export function breathingFrame({ elapsedMs = 0, cadence = "calm", reduced = false, plain = false } = {}) {
  const interval = BREATHING_CADENCE_MS[cadence]; if (!interval) throw new Error("invalid breathing cadence");
  if (reduced || plain) return Object.freeze({ glyph: "●", phase: 0, intervalMs: null, animated: false });
  const glyphs = ["◌", "◍", "●", "◍"]; const phase = Math.floor(Math.max(0, Number(elapsedMs) || 0) / interval) % glyphs.length;
  return Object.freeze({ glyph: glyphs[phase], phase, intervalMs: interval, animated: true });
}
