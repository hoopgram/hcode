// hcode updates itself by fast-forwarding its own source checkout — never by talking to a package
// registry, never with sudo, never by touching the project the owner happens to be sitting in. The
// install and the workspace are two different git repositories even when their paths overlap in a
// terminal's history, so this module resolves its own root from its own file, not from cwd.
//
// A checkout that owns the binary that is about to update it has to be stricter with itself than an
// ordinary agent write: a dirty tree is refused rather than stashed, a merge is refused rather than
// forced, and every step that can fail leaves the tree exactly where it found it. `git fetch` never
// touches the working tree; `git merge --ff-only` either lands cleanly or aborts without moving
// anything — there is no step in between where a checkout can be left half-updated.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { HOME, VERSION } from "./config.js";
import { isNativeRuntime, isNixRuntime, selfCommand } from "./runtime.js";
import { DEFAULT_BIN_DIR, DEFAULT_INSTALL_ROOT, installNativeCandidate, nativeTarget, rollbackNativeInstall, validateNativeManifest } from "./native-install.js";

const STATE_DIR = path.join(HOME, "update");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export const isNixManagedNative = (native = isNativeRuntime(), nixPath = isNixRuntime()) => Boolean(native && nixPath);

// One git call in, one trimmed stdout string out (or a thrown error carrying stderr). Every function
// below takes this as `git` so a test can hand it a stub instead of shelling out.
export function defaultGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Walk up from hcode's own installed file (its realpath, so a global symlink resolves to the actual
// worktree) to the nearest ancestor that is a git checkout, then let git normalize that into the
// worktree's own root — the main repo's root for an ordinary clone, the worktree's own directory for
// `git worktree`, never the parent repo a worktree happens to hang off of.
export function locateInstallRoot(startPath = fileURLToPath(import.meta.url), { git = defaultGit } = {}) {
  let dir = path.dirname(fs.realpathSync(startPath));
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (fs.existsSync(path.join(dir, ".git"))) {
      try { return git(dir, ["rev-parse", "--show-toplevel"]); }
      catch { /* malformed or unrelated marker; keep looking for a real checkout */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("hcode's own source is not inside a git checkout; nothing to update");
}

// VERSION if the checkout carries one; otherwise the one line of git log that is always available and
// always changes when the checkout does, so "old vs new" means something even without a version bump.
export function readVersion(root, { git = defaultGit } = {}) {
  try { return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(); } catch { /* no VERSION file here */ }
  try { return git(root, ["log", "--oneline", "-1"]); } catch { return "unknown"; }
}

// Everything an update decision or an update report needs, read fresh — called once before and once
// after, so a rejected update and a finished one both explain themselves from the same fields.
export function readGitState(root, { git = defaultGit } = {}) {
  // Collaboration ledgers and editor furniture may intentionally be untracked beside the source.
  // They do not make a tracked checkout unsafe to fast-forward; if an incoming path would overwrite
  // one, git merge itself refuses before moving HEAD. Tracked or staged changes still stop here.
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
  let upstream = "";
  try { upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); } catch { /* no upstream configured — a local dev checkout */ }
  return { root, dirty, upstream, head: git(root, ["rev-parse", "HEAD"]), version: readVersion(root, { git }) };
}

// The refusal table, kept pure and apart from anything that touches disk so a test can hand it a
// fabricated state and check the verdict without spawning a single git process.
export function planUpdate(state) {
  if (state.dirty) return { ok: false, reason: "dirty", message: "worktree has uncommitted changes; commit, stash or discard them before updating" };
  if (!state.upstream) return { ok: false, reason: "no-upstream", message: "local development source, no upstream to update from" };
  return { ok: true };
}

// The whole safe-update sequence: decide, fetch, fast-forward-only merge, re-read. Any refusal or
// failure returns before the tree is touched a second time, so oldVersion === newVersion is itself
// proof nothing moved.
export function runUpdate({ root, git = defaultGit } = {}) {
  const before = readGitState(root, { git });
  const verdict = planUpdate(before);
  const refused = (reason, message) => ({ ok: false, root, oldVersion: before.version, newVersion: before.version, changedFiles: 0, reason, message });
  if (!verdict.ok) return refused(verdict.reason, verdict.message);
  try { git(root, ["fetch", "--quiet"]); }
  catch (error) { return refused("fetch-failed", firstLine(error)); }
  try { git(root, ["merge", "--ff-only", "--quiet", "@{u}"]); }
  catch { return refused("not-fast-forward", "local and upstream have diverged; refusing to merge or rebase on your behalf"); }
  const after = readGitState(root, { git });
  let changedFiles = 0;
  if (after.head !== before.head) {
    try { changedFiles = git(root, ["diff", "--name-only", before.head, after.head]).split("\n").filter(Boolean).length; } catch { /* report the move even if the diff listing failed */ }
  }
  return { ok: true, root, oldVersion: before.version, newVersion: after.version, oldHead: before.head, newHead: after.head, changedFiles };
}

// GitHub's /releases/latest shortcut deliberately omits prereleases. Native hcode remains a
// prerelease until the macOS artifacts have Developer ID notarization, so using that shortcut made
// a perfectly healthy installation blind to every current native build. Discover the newest
// published release through the public list API instead, then download only assets named by that
// release and verified by its source-bound manifest. An explicit base URL remains available for
// owner-controlled mirrors, exact-version recovery and offline tests.
const DEFAULT_NATIVE_RELEASES_API = "https://api.github.com/repos/hoopgram/hcode/releases?per_page=10";
const versionCore = value => String(value).split(/[+-]/, 1)[0].split(".").map(Number);
export function compareVersions(a, b) {
  const left = versionCore(a), right = versionCore(b);
  for (let i = 0; i < 3; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
  return 0;
}
const releaseVersion = tag => {
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(String(tag || ""));
  return match?.[1] || null;
};
const releaseAssets = release => new Map((release?.assets || [])
  .filter(asset => typeof asset?.name === "string" && typeof asset?.browser_download_url === "string")
  .map(asset => [asset.name, asset.browser_download_url]));

export function selectNativeRelease(releases, { target = nativeTarget() } = {}) {
  const candidates = (Array.isArray(releases) ? releases : []).flatMap(release => {
    if (!release || release.draft === true) return [];
    const version = releaseVersion(release.tag_name); const assets = releaseAssets(release);
    if (!version || !assets.has("native-manifest.json") || !assets.has(`hcode-${target}`)) return [];
    return [{ version, tag: release.tag_name, prerelease: release.prerelease === true, assets }];
  });
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length) throw new Error(`no published native release supports ${target}`);
  return candidates[0];
}

async function boundedFetch(url, { fetchImpl = fetch, maxBytes = 200 * 1024 * 1024 } = {}) {
  const response = await fetchImpl(url, { redirect: "follow", headers: { accept: "application/vnd.github+json", "user-agent": "hcode-native-updater" } });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (length > maxBytes) throw new Error("download exceeds the native update size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("download exceeds the native update size limit");
  return bytes;
}

async function resolveNativeRelease({ baseUrl, releasesUrl, fetchImpl, target }) {
  if (baseUrl) {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return { base, version: null, assets: null };
  }
  const api = new URL(releasesUrl || DEFAULT_NATIVE_RELEASES_API);
  if (api.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(api.hostname)) throw new Error("native updates require HTTPS");
  const bytes = await boundedFetch(api, { fetchImpl, maxBytes: 2 * 1024 * 1024 });
  return { ...selectNativeRelease(JSON.parse(Buffer.from(bytes).toString("utf8")), { target }), base: null };
}

export async function runNativeUpdate({ baseUrl = process.env.HCODE_UPDATE_BASE_URL, releasesUrl = process.env.HCODE_UPDATE_RELEASES_URL,
  fetchImpl = fetch, root = DEFAULT_INSTALL_ROOT, binDir = DEFAULT_BIN_DIR, target = nativeTarget(), spawnImpl,
  runtimeIsNix = isNixManagedNative() } = {}) {
  // A Node supplied by Nix is not itself a Nix-managed hcode. Source tests and source/npm hcode may
  // quite correctly run under /nix/store/.../bin/node; only an hcode SEA executable in the store is
  // immutable and must defer to its flake/profile. Keeping both halves of the classification here
  // makes the same source suite truthful on god and on a non-Nix developer host.
  if (runtimeIsNix) return { ok: false, reason: "nix-managed", message: "this hcode is Nix-managed; update it through the owning flake/profile" };
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-native-update-"));
  try {
    const release = await resolveNativeRelease({ baseUrl, releasesUrl, fetchImpl, target });
    const urls = [release.base, ...(release.assets?.values?.() || [])].filter(Boolean).map(value => new URL(value));
    if (urls.some(url => url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname))) throw new Error("native updates require HTTPS");
    const manifestUrl = release.base ? new URL("native-manifest.json", release.base) : release.assets.get("native-manifest.json");
    const manifestBytes = await boundedFetch(manifestUrl, { fetchImpl, maxBytes: 1024 * 1024 });
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    const { version, artifact } = validateNativeManifest(manifest, { target });
    if (release.version && version !== release.version) throw new Error(`release ${release.tag} carries native manifest ${version}`);
    if (version === VERSION) return { ok: true, oldVersion: VERSION, newVersion: VERSION, changedFiles: 0 };
    if (compareVersions(version, VERSION) < 0) throw new Error(`latest native manifest ${version} is older than the running ${VERSION}`);
    const candidate = path.join(stage, artifact.file);
    const artifactUrl = release.base ? new URL(artifact.file, release.base) : release.assets.get(artifact.file);
    if (!artifactUrl) throw new Error(`release ${release.tag} is missing ${artifact.file}`);
    fs.writeFileSync(candidate, await boundedFetch(artifactUrl, { fetchImpl }), { mode: 0o700 });
    const installed = installNativeCandidate(candidate, manifest, { root, binDir, target, spawnImpl });
    return { ok: true, oldVersion: VERSION, newVersion: installed.current, changedFiles: 1, sha256: installed.sha256 };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function rollbackNative(options = {}) {
  if (!isNativeRuntime() && !options.allowSourceTest) return { ok: false, reason: "source", message: "source/npm hcode uses Git/npm rollback; native rollback is unavailable" };
  try { const state = rollbackNativeInstall(options); return { ok: true, oldVersion: state.previous, newVersion: state.current, changedFiles: 1 }; }
  catch (error) { return { ok: false, reason: "rollback-failed", message: firstLine(error) }; }
}

function firstLine(error) { return String(error?.message || error).split("\n")[0]; }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
}

export function readUpdateState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}

// One quiet line in the same voice as a finished background subagent's — an owner who never checks
// still reads the truth the next time they type /update, and one who is watching reads it and moves on.
export function updateSummaryLine(state) {
  if (!state) return "update: nothing has run yet";
  if (state.status === "queued" || state.status === "running") return `update ${state.status} — started ${Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))}s ago`;
  const result = state.result;
  if (result?.ok) return result.changedFiles === 0 || (result.oldHead && result.oldHead === result.newHead) ? `update: already current (${result.newVersion})` : `update: ${result.oldVersion} → ${result.newVersion} (${result.changedFiles} file${result.changedFiles === 1 ? "" : "s"} changed)`;
  return `update: ${result?.message || state.error || "did not complete"}`;
}

// Detached exactly the way a background subagent conversation is (tasks.js's own launch()): hcode
// re-invokes its own binary with a private subcommand and gets out of the owner's way. A fetch is
// usually fast, but the terminal the owner is typing in should never have to wait on the network for it.
export function startBackgroundUpdate({ env = process.env, spawnImpl = spawn } = {}) {
  const previous = readUpdateState();
  if (previous && ["queued", "running"].includes(previous.status)) return previous;
  const state = { v: 1, status: "queued", startedAt: Date.now(), updatedAt: Date.now() };
  atomicWrite(STATE_FILE, state);
  const self = selfCommand(["_update-worker"]);
  const child = spawnImpl(self.command, self.args, { detached: true, stdio: "ignore", cwd: "/", env });
  child.unref();
  return state;
}

// The detached worker's entire body: locate, update, record. Reached only through `hcode _update-worker`.
export async function runUpdateWorker({ git = defaultGit } = {}) {
  const state = readUpdateState() || { v: 1, status: "queued", startedAt: Date.now() };
  atomicWrite(STATE_FILE, { ...state, status: "running", updatedAt: Date.now() });
  let result;
  try { result = isNativeRuntime() ? await runNativeUpdate() : runUpdate({ root: locateInstallRoot(undefined, { git }), git }); }
  catch (error) { result = { ok: false, reason: "error", message: firstLine(error) }; }
  atomicWrite(STATE_FILE, { ...state, status: "done", result, updatedAt: Date.now(), finishedAt: Date.now() });
  return result;
}
