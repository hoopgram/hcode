#!/usr/bin/env node
// Reproducible Node SEA builder. The runtime archives and the only build dependency are pinned;
// neither enters the npm/runtime dependency graph. Cross-platform files may be produced anywhere,
// but a manifest calls an artifact verified only after it has executed on that target OS/arch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const NODE_VERSION = "24.20.0";
export const TARGETS = Object.freeze({
  "darwin-arm64": "b7bf7707070b950ba1ec5f1af3bb6de0f2b1962c5033973d94068ab021ef3014",
  "darwin-x64": "26fc30891004603d094eed11de5efcd03bbd2efbc35c177fc72648d5d7a7701b",
  "linux-arm64": "5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7",
  "linux-x64": "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2",
});

export function hostTarget(platform = process.platform, arch = process.arch) {
  const value = `${platform}-${arch}`;
  if (!TARGETS[value]) throw new Error(`unsupported native target ${value}`);
  return value;
}
export function artifactName(version, target) { return `hcode-v${version}-${target}`; }
export function selectedTargets(raw = "current") {
  if (raw === "all") return Object.keys(TARGETS);
  if (raw === "current") return [hostTarget()];
  const rows = raw.split(",").map(x => x.trim()).filter(Boolean);
  if (!rows.length || rows.some(x => !TARGETS[x])) throw new Error(`--target must be current, all, or a comma list of: ${Object.keys(TARGETS).join(", ")}`);
  return [...new Set(rows)];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (command, args, options = {}) => {
  const output = execFileSync(command, args, { encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", ...options });
  return typeof output === "string" ? output.trim() : "";
};

async function download(url, target) {
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  const body = new Uint8Array(await response.arrayBuffer());
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, target);
}

async function nodeExecutable(target, cache, tempRoot) {
  const file = `node-v${NODE_VERSION}-${target}.tar.xz`;
  const archive = path.join(cache, file);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`, archive);
  const actual = sha256(archive);
  if (actual !== TARGETS[target]) throw new Error(`${file} sha256 ${actual} != pinned ${TARGETS[target]}`);
  const unpack = path.join(tempRoot, target);
  fs.mkdirSync(unpack, { recursive: true });
  run("tar", ["-xJf", archive, "-C", unpack]);
  return path.join(unpack, `node-v${NODE_VERSION}-${target}`, "bin", "node");
}

function sourceFacts() {
  const repo = run("git", ["rev-parse", "--show-toplevel"], { cwd: root, capture: true });
  const rel = path.relative(repo, root).replaceAll(path.sep, "/");
  let tree = "uncommitted";
  try { tree = run("git", ["rev-parse", `HEAD:${rel}`], { cwd: repo, capture: true }); } catch {}
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no", "--", rel], { cwd: repo, capture: true }).length > 0;
  return { commit: run("git", ["rev-parse", "HEAD"], { cwd: repo, capture: true }), hcodeTree: tree, dirty };
}

export async function buildNative({ targets = [hostTarget()], outDir = path.join(root, "dist", "native"), cache = path.join(os.homedir(), ".cache", "hcode-native") } = {}) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty; move the previous candidate before rebuilding`);
  fs.mkdirSync(outDir, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-native-build-"));
  try {
    const bundle = path.join(tempRoot, "hcode.bundle.cjs");
    await build({ entryPoints: [path.join(root, "src", "native-entry.js")], outfile: bundle, bundle: true, platform: "node", format: "cjs", target: "node24", sourcemap: false, legalComments: "none",
      define: { "import.meta.url": JSON.stringify("file:///hcode-native/hcode.bundle.cjs") } });
    fs.copyFileSync(path.join(root, "FULL-AGENCY.md"), path.join(tempRoot, "FULL-AGENCY.md"));
    const hostNode = await nodeExecutable(hostTarget(), cache, tempRoot);
    const config = path.join(tempRoot, "sea.json"); const blob = path.join(tempRoot, "hcode.blob");
    fs.writeFileSync(config, JSON.stringify({ main: "hcode.bundle.cjs", output: "hcode.blob",
      disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false,
      assets: { "FULL-AGENCY.md": "FULL-AGENCY.md" } }, null, 2) + "\n");
    run(hostNode, ["--experimental-sea-config", "sea.json"], { cwd: tempRoot });
    const artifacts = [];
    for (const target of targets) {
      const executable = await nodeExecutable(target, cache, tempRoot);
      const name = artifactName(packageJson.version, target); const output = path.join(outDir, name);
      fs.copyFileSync(executable, output);
      if (target.startsWith("darwin-")) { try { run("codesign", ["--remove-signature", output]); } catch {} }
      const postject = path.join(root, "node_modules", ".bin", "postject");
      const inject = [output, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
      if (target.startsWith("darwin-")) inject.push("--macho-segment-name", "NODE_SEA");
      run(postject, inject);
      fs.chmodSync(output, 0o755);
      if (target.startsWith("darwin-")) run("codesign", ["--force", "--sign", "-", output]);
      let verified = false; const probes = [];
      if (target === hostTarget()) {
        const version = run(output, ["--version"], { capture: true });
        if (version !== packageJson.version) throw new Error(`${target} probe reported ${version}, expected ${packageJson.version}`);
        run(output, ["agency", "decide", JSON.stringify({ kind: "technical_uncertainty", summary: "native asset probe", proposed_action: "continue", recommendation: "continue" })], { capture: true });
        run(output, ["--help"], { capture: true });
        verified = true; probes.push("version", "embedded-agency-charter", "help");
      }
      artifacts.push({ target, file: name, bytes: fs.statSync(output).size, sha256: sha256(output),
        signature: target.startsWith("darwin-") ? "ad-hoc (Developer ID/notarization pending owner gate)" : "unsigned",
        verified, ...(probes.length ? { probes } : {}) });
    }
    const manifest = { schema: 1, product: "hcode", version: packageJson.version, node: NODE_VERSION,
      sea: { mainFormat: "commonjs", injector: "postject@1.0.0-alpha.6", builtOn: hostTarget() },
      source: sourceFacts(), generatedAt: new Date().toISOString(), artifacts };
    fs.writeFileSync(path.join(outDir, "native-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const index = process.argv.indexOf("--target");
  const targets = selectedTargets(index >= 0 ? process.argv[index + 1] : "current");
  buildNative({ targets }).then(manifest => console.log(JSON.stringify(manifest, null, 2)), error => { console.error(error.message); process.exitCode = 1; });
}
