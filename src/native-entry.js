// Bundled as the single Node SEA main. Source entrypoints stay tiny and unchanged for npm/source
// users; the native executable also dispatches the hcode-supervise alias from process.argv0.
import path from "node:path";
import { main } from "./cli.js";
import { mainRetryCircuit } from "./retry-circuit-cli.js";

const name = path.basename(process.argv0 || process.argv[0]);
const run = name.startsWith("hcode-supervise") ? mainRetryCircuit : main;

run(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; }, error => {
  const cls = error && error.failureClass ? error.failureClass : "unknown";
  console.error(`hcode-failure: class=${cls}${error && error.status ? ` status=${error.status}` : ""}${error && error.model ? ` model=${error.model}` : ""}`);
  console.error(String(error && error.stack || error)); process.exitCode = 1;
});
