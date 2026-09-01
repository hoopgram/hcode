// Session modes (0.8 C): one owner switch that changes how the session spends, recorded on the thread
// as a `mode` event so a handoff can carry it and /continue can put it back.
//
// A mode is deliberately not a config file entry: it belongs to a conversation, not to a machine. It
// rides in the append-only log next to everything else that happened, which means `hcode --resume`,
// a rewind fork and a handoff ledger all restore it for free.
export const MODES = ["default", "savetoken"];

// The last `mode` event wins; a thread that never set one is "default".
export function currentMode(session) {
  let mode = "default";
  for (const event of session?.events || []) if (event.type === "mode" && MODES.includes(event.mode)) mode = event.mode;
  return mode;
}

export function setMode(session, mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${String(mode).slice(0, 40)}" (${MODES.join("|")})`);
  return session.emit("mode", { mode });
}

// cfg is what the kernel and the slash commands read; the mode only ever sets these two fields, so a
// mode can never quietly widen permission, change the brain or touch the sandbox.
export function applyMode(cfg, mode) {
  cfg.saveToken = mode === "savetoken";
  cfg.subagentDefaultKind = cfg.saveToken ? "search" : "";
  return cfg;
}

export function modeNotice(mode) {
  return mode === "savetoken"
    ? "Token-saving mode is on for this session: delegation is the default, answers stay short, and a delegation that names no brain takes the smallest tier. /usedefault cancels it."
    : "Token-saving mode is off. This session works in the main context again; a delegation that reads as searching still takes the smallest tier by itself, and anything else must name its brain or its kind.";
}

// Injected into the system prompt (agent.js). It is guidance, not a permission change: nothing here
// can let the model do something the broker would otherwise refuse.
export function modePrompt(cfg) {
  if (!cfg?.saveToken) return "";
  return [
    "",
    "# Token-saving mode (the owner switched it on with /savetoken)",
    "Delegation is the default and this context is the exception. Searching, scanning, log reading and any check across more than three files go to delegate_agent with kind:\"search\"; a known file is read with a bounded range, never a whole directory.",
    "Judgment, design, security reasoning, the final answer and every state-changing step stay with you — correctness outranks the token rule, so read directly when the reasoning needs it, still ranged and targeted.",
    "A delegation that names neither a model nor a kind takes the smallest tier instead of being refused. Batch independent questions into one delegation rather than several.",
    "Answer conclusion first, under ten lines, with file:line pointers instead of pasted file contents, and never restate what is already settled.",
  ].join("\n");
}
