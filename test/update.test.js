// /update — hcode fast-forwards its own git checkout, never a package registry, never the project the
// owner happens to be sitting in. These tests build real fixture git repos (no network) and check the
// refusal table, the fast-forward path, and that every refused or failed step leaves HEAD untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-update-home-"));
process.env.HCODE_HOME = HOME_DIR;               // must be set before ../src/update.js computes STATE_FILE
const STATE_FILE = path.join(HOME_DIR, "update", "state.json");

const { compareVersions, isNixManagedNative, locateInstallRoot, readGitState, planUpdate, runNativeUpdate, runUpdate, readVersion, selectNativeRelease, updateSummaryLine, readUpdateState, startBackgroundUpdate } =
  await import("../src/update.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-update-"));
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);   // portable across git's default-branch config
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Test"]);
}
function commit(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", message]);
}
function cloneRepo(origin, dir) {
  git(path.dirname(dir), ["clone", "-q", origin, dir]);
  // A clone does not inherit the fixture repository's local author identity. Keep commits made by
  // the test independent of the developer machine and of a CI runner's global Git configuration.
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Test"]);
}
function resetBackgroundState() { fs.rmSync(path.dirname(STATE_FILE), { recursive: true, force: true }); }

// --- locateInstallRoot: source-position lookup, no execution ---

test("locateInstallRoot walks up from a nested module path to the git worktree root", () => {
  const root = tmp(); initRepo(root); commit(root, "a.txt", "a\n", "init");
  const nested = path.join(root, "nixos", "apps", "hcode", "src");
  fs.mkdirSync(nested, { recursive: true });
  const fakeModulePath = path.join(nested, "update.js");
  fs.writeFileSync(fakeModulePath, "// fixture\n");
  assert.equal(fs.realpathSync(locateInstallRoot(fakeModulePath)), fs.realpathSync(root));
});

test("locateInstallRoot refuses when hcode's own file is not inside any git checkout", () => {
  const dir = tmp(); const file = path.join(dir, "nested", "src", "update.js");
  fs.mkdirSync(path.join(dir, "nested", ".git"), { recursive: true }); // an inert marker is not a checkout
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "// fixture\n");
  assert.throws(() => locateInstallRoot(file), /not inside a git checkout/);
});

// --- planUpdate: the refusal table, pure ---

test("planUpdate refuses a dirty worktree", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "init");
  fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  assert.equal(readGitState(dir).dirty, true);
  const verdict = planUpdate(readGitState(dir));
  assert.deepEqual(verdict, { ok: false, reason: "dirty", message: verdict.message });
});

test("untracked collaboration notes do not make the source checkout dirty", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "init");
  const note = path.join(dir, "交接", "active", "local.md");
  fs.mkdirSync(path.dirname(note), { recursive: true }); fs.writeFileSync(note, "local only\n");
  assert.equal(readGitState(dir).dirty, false);
});

test("planUpdate reports no upstream for a local-only checkout, not an error", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "init");
  const state = readGitState(dir);
  assert.equal(state.upstream, "");
  assert.equal(planUpdate(state).reason, "no-upstream");
});

test("planUpdate allows a clean checkout with an upstream", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  const state = readGitState(local);
  assert.equal(state.dirty, false);
  assert.ok(state.upstream);
  assert.deepEqual(planUpdate(state), { ok: true });
});

// --- runUpdate: the safe end-to-end sequence ---

test("runUpdate reports already-current when there is nothing new upstream", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  const result = runUpdate({ root: local });
  assert.equal(result.ok, true);
  assert.equal(result.oldHead, result.newHead);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.oldVersion, result.newVersion);
});

test("runUpdate fast-forwards and reports the changed file count when upstream moved", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  commit(origin, "b.txt", "b\n", "add b");
  const result = runUpdate({ root: local });
  assert.equal(result.ok, true);
  assert.notEqual(result.oldHead, result.newHead);
  assert.equal(result.changedFiles, 1);
  assert.equal(git(local, ["rev-parse", "HEAD"]), result.newHead);
  assert.ok(fs.existsSync(path.join(local, "b.txt")));
});

test("runUpdate fast-forwards without touching an unrelated untracked handoff", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  const note = path.join(local, "交接", "active", "local.md");
  fs.mkdirSync(path.dirname(note), { recursive: true }); fs.writeFileSync(note, "keep me\n");
  commit(origin, "b.txt", "b\n", "add b");
  const result = runUpdate({ root: local });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(note, "utf8"), "keep me\n");
  assert.ok(fs.existsSync(path.join(local, "b.txt")));
});

test("runUpdate refuses a dirty tree and leaves HEAD and the working tree untouched", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  commit(origin, "b.txt", "b\n", "add b");            // upstream is ahead
  fs.writeFileSync(path.join(local, "a.txt"), "dirty\n");
  const before = git(local, ["rev-parse", "HEAD"]);
  const result = runUpdate({ root: local });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dirty");
  assert.equal(git(local, ["rev-parse", "HEAD"]), before);
  assert.equal(fs.existsSync(path.join(local, "b.txt")), false);   // never even fetched-and-merged
});

test("runUpdate refuses a no-upstream checkout without touching it", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "init");
  const before = git(dir, ["rev-parse", "HEAD"]);
  const result = runUpdate({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-upstream");
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
});

test("runUpdate refuses a diverged history and leaves the checkout exactly where it was", () => {
  const origin = tmp(); initRepo(origin); commit(origin, "a.txt", "a\n", "init");
  const local = path.join(tmp(), "local"); cloneRepo(origin, local);
  commit(origin, "b.txt", "b\n", "origin moves on");
  commit(local, "c.txt", "c\n", "local moves on too");   // no common fast-forward path either way
  const before = git(local, ["rev-parse", "HEAD"]);
  const result = runUpdate({ root: local });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-fast-forward");
  assert.equal(git(local, ["rev-parse", "HEAD"]), before);
  assert.equal(fs.existsSync(path.join(local, "c.txt")), true);    // local's own commit: untouched
  assert.equal(fs.existsSync(path.join(local, "b.txt")), false);   // origin's commit: never merged in
});

// --- readVersion ---

test("readVersion prefers a VERSION file when the checkout has one", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "init");
  fs.writeFileSync(path.join(dir, "VERSION"), "9.9.9\n");
  assert.equal(readVersion(dir), "9.9.9");
});

test("readVersion falls back to the last commit line without a VERSION file", () => {
  const dir = tmp(); initRepo(dir); commit(dir, "a.txt", "a\n", "distinctive commit subject");
  assert.match(readVersion(dir), /distinctive commit subject/);
});

// --- updateSummaryLine: the quiet one-line report, pure ---

test("updateSummaryLine describes every state without touching disk", () => {
  assert.match(updateSummaryLine(null), /nothing has run yet/);
  assert.match(updateSummaryLine({ status: "running", startedAt: Date.now() }), /running/);
  assert.match(updateSummaryLine({ status: "done", result: { ok: true, oldHead: "a", newHead: "a", newVersion: "v1" } }), /already current/);
  assert.match(updateSummaryLine({ status: "done", result: { ok: true, oldHead: "a", newHead: "b", oldVersion: "v1", newVersion: "v2", changedFiles: 3 } }), /v1 → v2 \(3 files changed\)/);
  assert.match(updateSummaryLine({ status: "done", result: { ok: false, message: "worktree has uncommitted changes" } }), /uncommitted/);
});

// --- background orchestration: state file + detached spawn, spawn stubbed so no process is launched ---

test("startBackgroundUpdate writes a queued state and spawns the private worker subcommand", () => {
  resetBackgroundState();
  const spawned = [];
  const state = startBackgroundUpdate({ spawnImpl: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; } });
  assert.equal(state.status, "queued");
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes("_update-worker"));
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(readUpdateState().status, "queued");
});

test("startBackgroundUpdate does not spawn a second worker while one is already queued", () => {
  resetBackgroundState();
  let spawns = 0;
  const spawnImpl = () => { spawns += 1; return { unref() {} }; };
  const first = startBackgroundUpdate({ spawnImpl });
  const second = startBackgroundUpdate({ spawnImpl });
  assert.equal(spawns, 1);
  assert.equal(second.startedAt, first.startedAt);
});

test("native update downloads verified bytes, switches once, and rejects a bad digest without moving current", async () => {
  assert.equal(compareVersions("0.10.0", "0.9.4"), 1); assert.equal(compareVersions("0.9.4", "0.9.4"), 0);
  const dir = tmp(), root = path.join(dir, "share"), binDir = path.join(dir, "bin"), target = `${process.platform}-${process.arch}`;
  const candidate = Buffer.from("#!/bin/sh\nprintf '9.9.9\\n'\n");
  const digest = (await import("node:crypto")).createHash("sha256").update(candidate).digest("hex");
  const manifest = { schema: 1, product: "hcode", version: "9.9.9", source: { dirty: false, commit: "a".repeat(40), hcodeTree: "b".repeat(40) },
    artifacts: [{ target, file: `hcode-v9.9.9-${target}`, bytes: candidate.length, sha256: digest, verified: true }] };
  const fetchImpl = async url => new Response(String(url).endsWith("native-manifest.json") ? JSON.stringify(manifest) : candidate);
  const result = await runNativeUpdate({ baseUrl: "https://release.test/", fetchImpl, root, binDir, target, runtimeIsNix: false });
  assert.equal(result.ok, true); assert.equal(result.newVersion, "9.9.9"); assert.equal(fs.realpathSync(path.join(binDir, "hcode")), fs.realpathSync(path.join(root, "versions", "9.9.9", "hcode")));
  const before = fs.realpathSync(path.join(root, "current"));
  const broken = { ...manifest, version: "9.9.10", artifacts: [{ ...manifest.artifacts[0], file: `hcode-v9.9.10-${target}`, sha256: "0".repeat(64) }] };
  const badFetch = async url => new Response(String(url).endsWith("native-manifest.json") ? JSON.stringify(broken) : candidate);
  await assert.rejects(() => runNativeUpdate({ baseUrl: "https://release.test/", fetchImpl: badFetch, root, binDir, target, runtimeIsNix: false }), /sha256/);
  assert.equal(fs.realpathSync(path.join(root, "current")), before);
});

test("a Nix-provided source Node is not mistaken for a Nix-managed hcode executable", async () => {
  // This file intentionally runs under the host's real Node. On god that executable is in
  // /nix/store, while hcode is still ordinary source (sea.isSea() is false). Reaching release
  // validation proves runNativeUpdate did not return the old false `nix-managed` result.
  assert.equal(isNixManagedNative(false, true), false, "Nix Node + source hcode is source, not a Nix install");
  assert.equal(isNixManagedNative(true, true), true, "an hcode SEA in the store remains Nix-managed");
  let fetched = false;
  await assert.rejects(() => runNativeUpdate({ baseUrl: "http://release.test/", fetchImpl: async () => { fetched = true; } }), /require HTTPS/);
  assert.equal(fetched, false);
});

test("native release discovery includes prereleases, ignores drafts, and takes the highest supported version", () => {
  const target = `${process.platform}-${process.arch}`;
  const assets = version => [
    { name: "native-manifest.json", browser_download_url: `https://release.test/${version}/native-manifest.json` },
    { name: `hcode-${target}`, browser_download_url: `https://release.test/${version}/hcode-${target}` }
  ];
  const selected = selectNativeRelease([
    { tag_name: "v99.0.0", draft: true, assets: assets("99.0.0") },
    { tag_name: "v0.9.4", draft: false, prerelease: false, assets: assets("0.9.4") },
    { tag_name: "v0.10.2", draft: false, prerelease: true, assets: assets("0.10.2") },
    { tag_name: "v0.11.0", draft: false, prerelease: true, assets: [{ name: "native-manifest.json", browser_download_url: "https://release.test/missing-target" }] }
  ], { target });
  assert.equal(selected.version, "0.10.2");
  assert.equal(selected.prerelease, true);
});

test("native update discovers the newest published prerelease instead of GitHub releases/latest", async () => {
  const dir = tmp(), root = path.join(dir, "share"), binDir = path.join(dir, "bin"), target = `${process.platform}-${process.arch}`;
  const candidate = Buffer.from("#!/bin/sh\nprintf '9.9.9\\n'\n");
  const digest = (await import("node:crypto")).createHash("sha256").update(candidate).digest("hex");
  const manifest = { schema: 1, product: "hcode", version: "9.9.9", source: { dirty: false, commit: "a".repeat(40), hcodeTree: "b".repeat(40) },
    artifacts: [{ target, file: `hcode-${target}`, bytes: candidate.length, sha256: digest, verified: true }] };
  const seen = [];
  const fetchImpl = async url => {
    const value = String(url); seen.push(value);
    if (value.includes("api.github.test")) return new Response(JSON.stringify([{ tag_name: "v9.9.9", draft: false, prerelease: true, assets: [
      { name: "native-manifest.json", browser_download_url: "https://release.test/v9.9.9/native-manifest.json" },
      { name: `hcode-${target}`, browser_download_url: `https://release.test/v9.9.9/hcode-${target}` }
    ] }]));
    return new Response(value.endsWith("native-manifest.json") ? JSON.stringify(manifest) : candidate);
  };
  const result = await runNativeUpdate({ releasesUrl: "https://api.github.test/releases", fetchImpl, root, binDir, target, runtimeIsNix: false });
  assert.equal(result.newVersion, "9.9.9");
  assert.match(seen[0], /api\.github\.test/);
  assert.equal(seen.some(url => url.includes("releases/latest")), false);
});

test("native release discovery refuses an insecure API before sending a request", async () => {
  let fetched = false;
  await assert.rejects(() => runNativeUpdate({ releasesUrl: "http://release.test/releases", fetchImpl: async () => { fetched = true; }, runtimeIsNix: false }), /require HTTPS/);
  assert.equal(fetched, false);
});
