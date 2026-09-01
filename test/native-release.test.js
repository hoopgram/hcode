import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { assembleNativeRelease, RELEASE_TARGETS } from "../scripts/assemble-native-release.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-native-release-test-"));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function runner(root, target, { commit = "a".repeat(40), verified = true } = {}) {
  const directory = path.join(root, target); fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, `hcode-v0.10.1-${target}`); fs.writeFileSync(binary, `native ${target}\n`);
  const manifest = {
    schema: 1, product: "hcode", version: "0.10.1", node: "24.20.0",
    sea: { mainFormat: "commonjs", injector: "postject@1.0.0-alpha.6", builtOn: target },
    source: { commit, hcodeTree: "b".repeat(40), dirty: false }, generatedAt: `2026-09-01T00:00:0${RELEASE_TARGETS.indexOf(target)}.000Z`,
    artifacts: [{ target, file: path.basename(binary), bytes: fs.statSync(binary).size, sha256: digest(binary), signature: "test", verified, probes: ["version", "embedded-agency-charter", "help"] }],
  };
  fs.writeFileSync(path.join(directory, "native-manifest.json"), JSON.stringify(manifest));
}
function matrix(root, options = {}) { for (const target of RELEASE_TARGETS) runner(root, target, options[target]); }

test("four exact host manifests become one atomic installer release", () => {
  const root = tmp(), input = path.join(root, "runners"), output = path.join(root, "release"); matrix(input);
  const manifest = assembleNativeRelease({ inputRoot: input, outDir: output });
  assert.deepEqual(manifest.artifacts.map(row => row.target), RELEASE_TARGETS);
  assert.equal(manifest.sea.builtOn, "host-native-matrix");
  for (const target of RELEASE_TARGETS) {
    const name = `hcode-${target}`; assert.equal(fs.statSync(path.join(output, name)).mode & 0o111, 0o111);
    assert.equal(fs.readFileSync(path.join(output, `${name}.sha256`), "utf8"), `${digest(path.join(output, name))}  ${name}\n`);
  }
  assert.match(fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8"), /native-manifest\.json[\s\S]*install\.sh/);
  assert.equal(fs.statSync(path.join(output, "install.sh")).mode & 0o111, 0o111);
});

test("a missing, mismatched or unverified runner leaves no partial release", () => {
  for (const disease of ["missing", "source", "unverified"]) {
    const root = tmp(), input = path.join(root, "runners"), output = path.join(root, "release");
    if (disease === "missing") for (const target of RELEASE_TARGETS.slice(1)) runner(input, target);
    else matrix(input, disease === "source" ? { [RELEASE_TARGETS[1]]: { commit: "c".repeat(40) } } : { [RELEASE_TARGETS[2]]: { verified: false } });
    assert.throws(() => assembleNativeRelease({ inputRoot: input, outDir: output }), disease === "missing" ? /missing host-native/ : disease === "source" ? /do not match/ : /lacks host-native/);
    assert.equal(fs.existsSync(output), false, `${disease} never exposes a partial release`);
  }
});
