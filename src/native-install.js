// Versioned native installation. A candidate is fully verified before the one atomic current-link
// switch; an interrupted download or failed probe can therefore never replace the working hcode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const DEFAULT_INSTALL_ROOT = path.join(os.homedir(), ".local", "share", "hcode");
export const DEFAULT_BIN_DIR = path.join(os.homedir(), ".local", "bin");
export const nativeTarget = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const safeVersion = value => {
  const text = String(value || "");
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(text)) throw new Error("native manifest has an invalid version");
  return text;
};

export function validateNativeManifest(manifest, { target = nativeTarget(), requireClean = true } = {}) {
  if (!manifest || manifest.schema !== 1 || manifest.product !== "hcode") throw new Error("invalid native manifest");
  const version = safeVersion(manifest.version);
  if (requireClean && manifest.source?.dirty !== false) throw new Error("native manifest is not bound to a clean source tree");
  if (!/^[a-f0-9]{40}$/.test(String(manifest.source?.commit || "")) || !/^[a-f0-9]{40}$/.test(String(manifest.source?.hcodeTree || ""))) throw new Error("native manifest is missing its source commit/tree");
  const artifact = manifest.artifacts?.find(item => item.target === target);
  if (!artifact || !/^[A-Za-z0-9._-]+$/.test(String(artifact.file || "")) || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))) throw new Error(`native manifest has no valid ${target} artifact`);
  if (artifact.verified !== true) throw new Error(`${target} artifact was not executed on its build platform`);
  return { version, artifact };
}

export function inspectNativeCandidate(file, manifest, options = {}) {
  const { version, artifact } = validateNativeManifest(manifest, options);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== Number(artifact.bytes)) throw new Error("native candidate size does not match its manifest");
  const digest = sha256(file);
  if (digest !== artifact.sha256) throw new Error(`native candidate sha256 ${digest} != manifest ${artifact.sha256}`);
  fs.chmodSync(file, 0o755);
  const run = (options.spawnImpl || spawnSync)(file, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (run.status !== 0 || String(run.stdout).trim() !== version) throw new Error(`native candidate did not report version ${version}`);
  return { version, artifact, digest };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(temp, file);
}
function atomicSymlink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o755 });
  if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) throw new Error(`refusing to replace non-symlink ${link}`);
  const temp = `${link}.${process.pid}.tmp`;
  try { fs.symlinkSync(target, temp); fs.renameSync(temp, link); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}
export function readInstallState(root = DEFAULT_INSTALL_ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "install.json"), "utf8")); } catch { return null; }
}

export function installNativeCandidate(file, manifest, { root = DEFAULT_INSTALL_ROOT, binDir = DEFAULT_BIN_DIR, target = nativeTarget(), requireClean = true, spawnImpl = spawnSync } = {}) {
  const checked = inspectNativeCandidate(file, manifest, { target, requireClean, spawnImpl });
  const versions = path.join(root, "versions"); const versionDir = path.join(versions, checked.version);
  const installed = path.join(versionDir, "hcode");
  fs.mkdirSync(versionDir, { recursive: true, mode: 0o755 });
  if (fs.existsSync(installed)) {
    if (sha256(installed) !== checked.digest) throw new Error(`version ${checked.version} already exists with different bytes`);
  } else {
    const temp = path.join(versionDir, `.hcode.${process.pid}.tmp`);
    fs.copyFileSync(file, temp); fs.chmodSync(temp, 0o755); fs.renameSync(temp, installed);
  }
  const before = readInstallState(root);
  const previous = before?.current && before.current !== checked.version ? before.current : before?.previous || null;
  atomicSymlink(installed, path.join(root, "current"));
  atomicSymlink(path.join(root, "current"), path.join(binDir, "hcode"));
  atomicSymlink(path.join(root, "current"), path.join(binDir, "hcode-supervise"));
  const state = { schema: 1, current: checked.version, previous, target, source: manifest.source, sha256: checked.digest, installedAt: new Date().toISOString() };
  atomicJson(path.join(root, "install.json"), state);
  return state;
}

export function rollbackNativeInstall({ root = DEFAULT_INSTALL_ROOT, binDir = DEFAULT_BIN_DIR, spawnImpl = spawnSync } = {}) {
  const state = readInstallState(root);
  if (!state?.previous) throw new Error("no previous native hcode version is available");
  const previous = path.join(root, "versions", safeVersion(state.previous), "hcode");
  if (!fs.existsSync(previous)) throw new Error(`previous hcode ${state.previous} is missing`);
  const run = spawnImpl(previous, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (run.status !== 0 || String(run.stdout).trim() !== state.previous) throw new Error(`previous hcode ${state.previous} failed its version probe`);
  atomicSymlink(previous, path.join(root, "current"));
  atomicSymlink(path.join(root, "current"), path.join(binDir, "hcode"));
  atomicSymlink(path.join(root, "current"), path.join(binDir, "hcode-supervise"));
  const next = { ...state, current: state.previous, previous: state.current, rolledBackAt: new Date().toISOString() };
  atomicJson(path.join(root, "install.json"), next);
  return next;
}
