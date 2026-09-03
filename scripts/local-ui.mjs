#!/usr/bin/env node
// One bounded local UI delivery: scope gate -> one patch version -> targeted proof -> exact commit
// -> host-native build -> verified atomic install. It never pushes, tags, publishes or touches Nix.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UI_FAST_PATHS = Object.freeze(new Set([
  "ARCHITECTURE.md", "CHANGELOG.md", "DEVELOPING.md", "README.md", "UI-MAP.md",
  "package.json", "package-lock.json", "src/config.js", "src/ui.js", "src/composer.js",
  "src/brand.js", "src/frame.js", "src/input-state.js", "src/musings.js", "src/presence.js",
  "test/ui.test.js", "test/composer.test.js", "test/brand.test.js", "test/frame.test.js",
  "test/input-state.test.js", "test/musings.test.js", "test/render-property.test.js",
  "test/docs.test.js", "test/local-ui.test.js", "scripts/local-ui.mjs",
]));

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ""));
  if (!match) throw new Error(`local:ui requires an x.y.z version, got ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function isUiFastPath(file) { return UI_FAST_PATHS.has(String(file || "").replaceAll(path.sep, "/")); }

const anchors = Object.freeze([
  ["Opening date", "src/ui.js", "formatWelcomeDate", "test/ui.test.js", "token"],
  ["Welcome projection", "src/ui.js", "banner(cfg, sessionId", "test/ui.test.js", "semantic"],
  ["Input theme tokens", "src/ui.js", "INPUT_THEME_TOKENS", "test/ui.test.js", "token"],
  ["Input theme detection", "src/ui.js", "inputTheme", "test/ui.test.js", "semantic"],
  ["Input frame geometry", "src/composer.js", "INPUT_FRAME", "test/composer.test.js", "geometry"],
  ["Input row projection", "src/composer.js", "fieldRow(content", "test/composer.test.js", "geometry"],
  ["Composer frame assembly", "src/composer.js", "draw()", "test/render-property.test.js", "geometry"],
  ["Three render-path semantics", "src/ui.js", "createUI({", "test/ui.test.js", "semantic"],
  ["Footer priority projection", "src/composer.js", "statusRows(action)", "test/composer.test.js", "geometry"],
  ["Footer real PTY fixture", "test/render-property.test.js", "real PTYs keep the idle and busy footer", "test/render-property.test.js", "geometry"],
  ["Working gold sweep", "src/composer.js", "goldenSweep", "test/composer.test.js", "token"],
  ["Hoop robot and charge", "src/brand.js", "robotHoopRows", "test/brand.test.js", "geometry"],
  ["Native build", "scripts/build-native.mjs", "buildNative", "test/native-build.test.js", "native"],
  ["Atomic native install", "src/native-install.js", "installNativeCandidate", "test/native-install.test.js", "native"],
]);

const lineOf = (root, file, anchor) => {
  const rows = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  const index = rows.findIndex(row => row.includes(anchor));
  if (index < 0) throw new Error(`UI-MAP anchor drifted: ${file}:${anchor}`);
  return index + 1;
};

export function renderUiMap(root) {
  const rows = anchors.map(([surface, file, anchor, proof, risk]) =>
    `| ${surface} | \`${file}:${lineOf(root, file, anchor)}\` · \`${anchor}\` | \`${proof}\` | ${risk} |`);
  return `# hcode UI pointer map\n\nThis is a generated pointer index, not a second architecture document. Stable symbols are authoritative;\n\`npm run local:ui\` refreshes line numbers before proof and commit. System rules remain in \`ARCHITECTURE.md\`.\n\n| Owner-visible surface | Implementation anchor | Nearest proof | Lane |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Fast lane\n\n- token: copy, colour or semantic token; default targeted proof.\n- semantic: all affected composer/readline/plain projections.\n- geometry: add \`--geometry\` so the real tmux render-property gate runs.\n- native: leave this UI fast lane and use the native/release contract.\n`;
}

export function parseOptions(argv) {
  const options = { note: "", agent: process.env.HCODE_AGENT || "Codex", geometry: false, resume: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--note") options.note = String(argv[++index] || "").trim();
    else if (value === "--agent") options.agent = String(argv[++index] || "").trim();
    else if (value === "--geometry") options.geometry = true;
    else if (value === "--resume") options.resume = true;
    else throw new Error(`unknown local:ui option ${value}`);
  }
  if (!options.resume && !options.note) throw new Error("local:ui requires --note \"owner-visible change\"");
  if (!options.agent || /[\r\n]/.test(options.agent) || /[\r\n]/.test(options.note)) throw new Error("local:ui agent/note must be one line");
  return options;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slash = value => String(value || "").split(path.sep).join("/");
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
  const start = performance.now(); const result = action();
  timings[name] = performance.now() - start; return result;
};
const atomicWrite = (file, content) => {
  const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, content); fs.renameSync(temp, file);
};
const saveFiles = files => new Map(files.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]));
const restoreFiles = originals => { for (const [file, content] of originals) content === null ? fs.existsSync(file) && fs.unlinkSync(file) : atomicWrite(file, content); };

function changedPaths(repo, subtree) {
  const tracked = git(["diff", "--name-only", "HEAD", "--", subtree], { cwd: repo }).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", subtree], { cwd: repo }).split("\n").filter(Boolean);
  const prefix = subtree ? `${slash(subtree).replace(/\/$/, "")}/` : "";
  return [...new Set([...tracked, ...untracked].map(file => slash(file).slice(prefix.length)))].sort();
}

function bumpVersion(target, note) {
  const packageFile = path.join(root, "package.json"); const lockFile = path.join(root, "package-lock.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")); pkg.version = target;
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")); lock.version = target; lock.packages[""].version = target;
  atomicWrite(packageFile, JSON.stringify(pkg, null, 2) + "\n"); atomicWrite(lockFile, JSON.stringify(lock, null, 2) + "\n");
  const configFile = path.join(root, "src/config.js"); const config = fs.readFileSync(configFile, "utf8");
  atomicWrite(configFile, config.replace(/export const VERSION = "\d+\.\d+\.\d+"/, `export const VERSION = "${target}"`));
  const now = new Date(); const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const changelogFile = path.join(root, "CHANGELOG.md"); const changelog = fs.readFileSync(changelogFile, "utf8");
  if (!changelog.includes("## Unreleased\n")) throw new Error("CHANGELOG.md has no Unreleased heading");
  atomicWrite(changelogFile, changelog.replace("## Unreleased\n", `## Unreleased\n\n## ${target} — ${day} — UI 快车道\n\n- ${note}\n`));
}

export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv); const timings = {}; const total = performance.now();
  const repo = git(["rev-parse", "--show-toplevel"]); const subtree = slash(path.relative(repo, root));
  const packageFile = path.join(root, "package.json"); const current = JSON.parse(fs.readFileSync(packageFile, "utf8")).version;
  let target = current; let committed = false; let originals;
  if (git(["diff", "--cached", "--name-only"], { cwd: repo })) throw new Error("local:ui refuses pre-staged changes; keep its commit exact");
  if (!options.resume) {
    const generated = ["package.json", "package-lock.json", "src/config.js", "CHANGELOG.md", "UI-MAP.md"].map(file => path.join(root, file));
    originals = saveFiles(generated);
    try {
      target = nextPatch(current);
      timed(timings, "prepare", () => {
        atomicWrite(path.join(root, "UI-MAP.md"), renderUiMap(root));
        bumpVersion(target, options.note);
      });
      let changed = changedPaths(repo, subtree);
      const outside = changed.filter(file => !isUiFastPath(file));
      if (outside.length) throw new Error(`local:ui scope gate refused: ${outside.join(", ")}`);
      const geometryOnly = changed.filter(file => ["src/frame.js", "src/input-state.js", "test/render-property.test.js"].includes(file));
      if (geometryOnly.length && !options.geometry) throw new Error(`local:ui requires --geometry for ${geometryOnly.join(", ")}`);
      const substance = changed.filter(file => !["CHANGELOG.md", "package.json", "package-lock.json", "src/config.js", "UI-MAP.md"].includes(file));
      if (!substance.length) throw new Error("local:ui found no UI implementation/test/document change");
      timed(timings, "check", () => exec("npm", ["run", "check"]));
      const tests = ["test/local-ui.test.js", "test/ui.test.js", "test/composer.test.js", "test/docs.test.js"];
      if (changed.includes("src/brand.js") || changed.includes("test/brand.test.js")) tests.push("test/brand.test.js");
      if (options.geometry) tests.push("test/render-property.test.js");
      timed(timings, "tests", () => exec(process.execPath, ["--test", ...tests]));
      timed(timings, "diff", () => git(["diff", "--check", "--", subtree], { cwd: repo }));
      changed = changedPaths(repo, subtree);
      timed(timings, "commit", () => {
        git(["add", "--", ...changed.map(file => slash(path.join(subtree, file)))], { cwd: repo });
        try { git(["commit", "-m", `Ship hcode ${target} local UI`, "-m", options.note, "-m", `Agent: ${options.agent}`], { cwd: repo }); }
        catch (error) { git(["restore", "--staged", "--", ...changed.map(file => slash(path.join(subtree, file)))], { cwd: repo, allow: [1] }); throw error; }
      });
      committed = true;
    } catch (error) {
      if (!committed && originals) restoreFiles(originals);
      throw error;
    }
  } else {
    if (changedPaths(repo, subtree).length) throw new Error("local:ui --resume requires a clean committed hcode tree");
  }

  const outDir = path.join(root, "dist/native");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    const previous = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-local-ui-previous-"));
    fs.renameSync(outDir, path.join(previous, "native"));
  }
  try {
    timed(timings, "build", () => exec("npm", ["run", "build:native"]));
    const manifestFile = path.join(outDir, "native-manifest.json"); const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const commit = git(["rev-parse", "HEAD"], { cwd: repo });
    if (manifest.version !== target || manifest.source?.commit !== commit || manifest.source?.dirty !== false) throw new Error("native manifest is not bound to the clean fast-path commit");
    const artifact = manifest.artifacts.find(item => item.target === `${process.platform}-${process.arch}`);
    const candidate = path.join(outDir, artifact.file);
    timed(timings, "verify", () => exec(process.execPath, ["scripts/verify-native-manifest.mjs", manifestFile]));
    timed(timings, "install", () => exec(candidate, ["_install-native", candidate, manifestFile]));
    const installed = fs.realpathSync(path.join(os.homedir(), ".local/share/hcode/current"));
    const probe = exec(installed, ["--version"]).stdout.trim();
    if (probe !== target || sha256(installed) !== artifact.sha256) throw new Error("installed hcode differs from the verified candidate");
    timings.total = performance.now() - total;
    const row = Object.entries(timings).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(2)}s`).join(" · ");
    console.log(`local:ui installed hcode ${target}\ncommit ${commit.slice(0, 12)} · ${artifact.target} · sha256:${artifact.sha256}\n${row}`);
    return { version: target, commit, artifact, timings };
  } catch (error) {
    if (committed) error.message += "\nThe exact commit is safe; rerun `npm run local:ui -- --resume`.";
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`local:ui: ${error.message}`); process.exitCode = 1; }
}
