#!/usr/bin/env node
// Four host-native builders produce four small manifests. This is the only door that may turn
// them into one installable release: every source fact must agree, every artifact must have run
// on its own target, and every byte is re-hashed before the output directory appears atomically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TARGETS } from "./build-native.mjs";

export const RELEASE_TARGETS = Object.freeze(Object.keys(TARGETS));
const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sourceKey = manifest => JSON.stringify({
  schema: manifest.schema, product: manifest.product, version: manifest.version, node: manifest.node,
  mainFormat: manifest.sea?.mainFormat, injector: manifest.sea?.injector, source: manifest.source,
});

function manifestsBelow(root) {
  const found = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === "native-manifest.json") found.push(file);
    }
  };
  walk(root);
  return found.sort();
}

function inspectRunnerManifest(file, expectedKey) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.schema !== 1 || manifest.product !== "hcode" || !/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) throw new Error(`${file}: invalid native manifest`);
  if (!/^[a-f0-9]{40}$/.test(String(manifest.source?.commit || "")) || !/^[a-f0-9]{40}$/.test(String(manifest.source?.hcodeTree || "")) || manifest.source?.dirty !== false) throw new Error(`${file}: release source is not clean and exact`);
  if (expectedKey && sourceKey(manifest) !== expectedKey) throw new Error(`${file}: source/version/runtime facts do not match the other runners`);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) throw new Error(`${file}: each runner must contribute exactly one artifact`);
  const artifact = manifest.artifacts[0];
  if (!RELEASE_TARGETS.includes(artifact.target) || manifest.sea?.builtOn !== artifact.target) throw new Error(`${file}: artifact was not built on its declared target`);
  if (artifact.verified !== true || !["version", "embedded-agency-charter", "help"].every(probe => artifact.probes?.includes(probe))) throw new Error(`${file}: ${artifact.target} lacks host-native probes`);
  if (path.basename(String(artifact.file || "")) !== artifact.file || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ""))) throw new Error(`${file}: unsafe artifact facts`);
  const binary = path.join(path.dirname(file), artifact.file);
  if (!fs.statSync(binary).isFile() || fs.statSync(binary).size !== Number(artifact.bytes) || sha256(binary) !== artifact.sha256) throw new Error(`${file}: ${artifact.target} bytes do not match its manifest`);
  return { manifest, artifact, binary };
}

export function assembleNativeRelease({ inputRoot, outDir, installer = path.join(here, "install-native.sh") }) {
  const input = path.resolve(inputRoot); const output = path.resolve(outDir);
  if (!fs.statSync(input).isDirectory()) throw new Error(`${input} is not a runner artifact directory`);
  if (fs.existsSync(output)) throw new Error(`${output} already exists; release assembly never overwrites`);
  const files = manifestsBelow(input);
  if (!files.length) throw new Error(`${input} contains no native manifests`);
  const first = JSON.parse(fs.readFileSync(files[0], "utf8")); const expectedKey = sourceKey(first);
  const rows = files.map(file => inspectRunnerManifest(file, expectedKey));
  const byTarget = new Map();
  for (const row of rows) {
    if (byTarget.has(row.artifact.target)) throw new Error(`duplicate ${row.artifact.target} runner artifact`);
    byTarget.set(row.artifact.target, row);
  }
  const missing = RELEASE_TARGETS.filter(target => !byTarget.has(target));
  if (missing.length) throw new Error(`missing host-native artifact(s): ${missing.join(", ")}`);
  if (byTarget.size !== RELEASE_TARGETS.length) throw new Error("release has an unexpected native target");
  if (!fs.statSync(installer).isFile()) throw new Error(`missing installer ${installer}`);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(output), ".hcode-release-"));
  try {
    const artifacts = [];
    for (const target of RELEASE_TARGETS) {
      const row = byTarget.get(target); const name = `hcode-${target}`; const destination = path.join(stage, name);
      fs.copyFileSync(row.binary, destination); fs.chmodSync(destination, 0o755);
      fs.writeFileSync(path.join(stage, `${name}.sha256`), `${row.artifact.sha256}  ${name}\n`);
      artifacts.push({ ...row.artifact, file: name });
    }
    const generatedAt = rows.map(row => row.manifest.generatedAt).filter(Boolean).sort().at(-1) || new Date(0).toISOString();
    const manifest = { ...first, generatedAt, sea: { ...first.sea, builtOn: "host-native-matrix" }, artifacts };
    fs.writeFileSync(path.join(stage, "native-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.copyFileSync(installer, path.join(stage, "install.sh")); fs.chmodSync(path.join(stage, "install.sh"), 0o755);
    const releaseFiles = [...RELEASE_TARGETS.map(target => `hcode-${target}`), "native-manifest.json", "install.sh"];
    fs.writeFileSync(path.join(stage, "SHA256SUMS"), releaseFiles.map(name => `${sha256(path.join(stage, name))}  ${name}`).join("\n") + "\n");
    fs.renameSync(stage, output);
    return manifest;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const inputRoot = process.argv[2] || "dist/runners"; const outDir = process.argv[3] || "dist/release";
  try {
    const manifest = assembleNativeRelease({ inputRoot, outDir });
    console.log(`hcode ${manifest.version} release assembled · ${manifest.artifacts.length} host-native artifacts`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
