#!/usr/bin/env node
import { mainRetryCircuit } from "../src/retry-circuit-cli.js";
mainRetryCircuit(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; }, error => {
  console.error(String(error && error.stack || error)); process.exitCode = 1;
});
