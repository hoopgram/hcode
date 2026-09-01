// One self-runtime contract for both the source tree and the Node SEA executable. Modules that
// relaunch hcode must never reconstruct `node bin/hcode.js` themselves: inside a SEA, execPath is
// already hcode and adding the source entry would turn it into an ordinary user argument.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as sea from "node:sea";

const SOURCE_ENTRY = fileURLToPath(new URL("../bin/hcode.js", import.meta.url));

export function isNativeRuntime() {
  return typeof sea.isSea === "function" && sea.isSea();
}

export function isNixRuntime(execPath = process.execPath) {
  return /(?:^|\/)nix\/store\//.test(String(execPath));
}

export function selfCommand(args = [], { native = isNativeRuntime(), execPath = process.execPath, sourceEntry = SOURCE_ENTRY } = {}) {
  return native
    ? { command: execPath, args: [...args], kind: isNixRuntime(execPath) ? "nix" : "native" }
    : { command: execPath, args: [sourceEntry, ...args], kind: "source" };
}

export function selfArgv(args = [], options = {}) {
  const launch = selfCommand(args, options);
  return [launch.command, ...launch.args];
}

export function runtimeAsset(name, sourceFile) {
  if (isNativeRuntime()) return sea.getAsset(name, "utf8");
  return fs.readFileSync(sourceFile, "utf8");
}

export function runtimeLabel() {
  if (!isNativeRuntime()) return `source · node ${process.version}`;
  return `${isNixRuntime() ? "nix" : "native"} · node ${process.version}`;
}

export const SOURCE_BIN = SOURCE_ENTRY;
