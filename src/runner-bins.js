// The one primitive both config.js and runners.js need: is the executor the owner installed himself
// actually on this machine? It lives *below* both of them on purpose — config.js has to be able to
// pick a default runner without importing runners.js, which imports HOME from config.js (that cycle
// would break at load time, before any function runs).
//
// Nothing here executes anything. It answers one question about a fixed, hcode-owned name; an
// owner-supplied string is never turned into a binary to run.
import fs from "node:fs";
import path from "node:path";

// The external executors hcode knows how to bound. Fixed names, never taken from input.
export const EXTERNAL_BINS = { claude: "claude", codex: "codex" };
// The order hcode tries when the owner has not chosen: external executors first, codex before claude.
// hcode's own direct model call is the fallback, never an automatic pick while one of these exists.
export const AUTO_ORDER = ["codex", "claude"];

export function findBinary(bin, env = process.env) {
  for (const d of String(env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}
