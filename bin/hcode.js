#!/usr/bin/env node
import { main } from "../src/cli.js";
main(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; }, err => {
  // One machine-readable line before the stack: the supervisor's circuit breaker classifies
  // THIS line first (regex classification of the stack text stays only as a fallback), so
  // "provider key missing (403)" is never mistaken for "rate limited, keep waiting".
  const cls = err && err.failureClass ? err.failureClass : "unknown";
  console.error(`hcode-failure: class=${cls}${err && err.status ? ` status=${err.status}` : ""}${err && err.model ? ` model=${err.model}` : ""}`);
  console.error(String(err && err.stack || err)); process.exitCode = 1;
});
