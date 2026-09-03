#!/usr/bin/env node
// Pull one integrated candidate through a named Git remote, prove the requested risk profile, then
// delegate host-native build/verification/atomic install to the same exact executor used by local:ui.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main as installCurrentExact } from "./local-ui.mjs";

export const PROFILES = Object.freeze(["fast", "balanced", "full"]);

export function parsePullOptions(argv) {
  const options = { remote: "", branch: "", exact: "", profile: "balanced" };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--remote") options.remote = String(argv[++index] || "").trim();
    else if (value === "--branch") options.branch = String(argv[++index] || "").trim();
    else if (value === "--exact") options.exact = String(argv[++index] || "").trim();
    else if (value === "--profile") options.profile = String(argv[++index] || "").trim();
    else throw new Error(`unknown local:pull option ${value}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.remote)) throw new Error("local:pull requires a named --remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.branch) || options.branch.includes("..")) throw new Error("local:pull requires a safe --branch");
  if (options.exact && !/^[a-f0-9]{40}$/.test(options.exact)) throw new Error("--exact must be 40 lowercase hex");
  if (!PROFILES.includes(options.profile)) throw new Error(`--profile must be ${PROFILES.join(", ")}`);
  return options;
}

export function verificationCommands(profile) {
  const rows = [["npm", ["run", "check"]]];
  if (profile !== "fast") rows.push(["npm", ["test"]]);
  if (profile === "full") {
    rows.push(["npm", ["test"]]);
    rows.push(["npm", ["pack", "--dry-run", "--json"]]);
  }
  return rows;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = (command, args, { cwd = root, quiet = true, allow = [] } = {}) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allow.includes(result.status)) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${detail ? `\n${detail}` : ""}`);
  }
  return result;
};
const git = (args, options) => exec("git", args, options).stdout.trim();
const timed = (timings, name, action) => {
  const start = performance.now(); const value = action(); timings[name] = performance.now() - start; return value;
};

function installState() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".local/share/hcode/install.json"), "utf8")); }
  catch { return null; }
}

export function main(argv = process.argv.slice(2)) {
  const options = parsePullOptions(argv); const timings = {}; const total = performance.now();
  const repo = git(["rev-parse", "--show-toplevel"]); const subtree = path.relative(repo, root).split(path.sep).join("/");
  const trackedDirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: repo });
  const hcodeUntracked = git(["ls-files", "--others", "--exclude-standard", "--", subtree], { cwd: repo });
  const staged = git(["diff", "--cached", "--name-only"], { cwd: repo });
  if (trackedDirty || hcodeUntracked || staged) throw new Error("local:pull requires a clean tracked tree, no staged files and no untracked hcode files");

  const before = git(["rev-parse", "HEAD"], { cwd: repo });
  timed(timings, "fetch", () => exec("git", ["fetch", "--no-tags", options.remote, options.branch], { cwd: repo, quiet: false }));
  const target = git(["rev-parse", "FETCH_HEAD"], { cwd: repo });
  if (options.exact && target !== options.exact) throw new Error(`fetched ${target}, expected ${options.exact}`);
  const ff = exec("git", ["merge-base", "--is-ancestor", before, target], { cwd: repo, allow: [1] });
  if (ff.status !== 0) throw new Error(`candidate ${target} is not a fast-forward of ${before}`);
  timed(timings, "fast-forward", () => exec("git", ["merge", "--ff-only", target], { cwd: repo, quiet: false }));

  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const installed = installState();
  if (installed?.current === version && installed?.source?.commit && installed.source.commit !== target) {
    throw new Error(`candidate reused installed version ${version} for a different commit; bump once before delivery`);
  }
  if (installed?.current === version && installed?.source?.commit === target) {
    console.log(`local:pull already exact — ${version} · ${target.slice(0, 12)}`);
    return { version, commit: target, changed: false, timings };
  }

  timed(timings, "dependencies", () => exec("npm", ["ci", "--ignore-scripts"], { quiet: false }));
  timed(timings, "verify", () => {
    for (const [command, args] of verificationCommands(options.profile)) exec(command, args, { quiet: false });
    exec("git", ["diff", "--check", `${before}..${target}`], { cwd: repo });
  });
  const delivered = timed(timings, "native", () => installCurrentExact(["--resume"]));
  if (delivered.commit !== target) throw new Error(`installed ${delivered.commit}, expected ${target}`);
  timings.total = performance.now() - total;
  console.log(`local:pull complete · ${options.profile} · ${before.slice(0, 12)} → ${target.slice(0, 12)}\n${Object.entries(timings).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(2)}s`).join(" · ")}`);
  return { version, commit: target, changed: before !== target, timings };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`local:pull: ${error.message}`); process.exitCode = 1; }
}
