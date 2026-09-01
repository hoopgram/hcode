import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { installNativeCandidate, nativeTarget, readInstallState, rollbackNativeInstall, validateNativeManifest } from "../src/native-install.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-native-install-test-"));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function candidate(dir, version) {
  const file = path.join(dir, `hcode-v${version}-${nativeTarget()}`);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o755 });
  const manifest = { schema: 1, product: "hcode", version, source: { dirty: false, commit: "a".repeat(40), hcodeTree: "b".repeat(40) },
    artifacts: [{ target: nativeTarget(), file: path.basename(file), bytes: fs.statSync(file).size, sha256: digest(file), verified: true }] };
  return { file, manifest };
}

test("native install switches one symlink atomically and rollback swaps verified versions", () => {
  const dir = tmp(), root = path.join(dir, "share"), binDir = path.join(dir, "bin");
  const first = candidate(dir, "1.0.0"), second = candidate(dir, "1.1.0");
  assert.equal(installNativeCandidate(first.file, first.manifest, { root, binDir }).current, "1.0.0");
  assert.equal(installNativeCandidate(second.file, second.manifest, { root, binDir }).previous, "1.0.0");
  const installed = fs.realpathSync(path.join(root, "versions", "1.1.0", "hcode"));
  assert.equal(fs.realpathSync(path.join(binDir, "hcode")), installed);
  assert.equal(fs.realpathSync(path.join(binDir, "hcode-supervise")), installed);
  const rolled = rollbackNativeInstall({ root, binDir });
  assert.equal(rolled.current, "1.0.0"); assert.equal(rolled.previous, "1.1.0");
  assert.equal(readInstallState(root).current, "1.0.0");
});

test("wrong hash, unverified platform and dirty source fail before the current link moves", () => {
  const dir = tmp(), root = path.join(dir, "share"), binDir = path.join(dir, "bin"), good = candidate(dir, "1.0.0");
  installNativeCandidate(good.file, good.manifest, { root, binDir }); const before = fs.realpathSync(path.join(root, "current"));
  const bad = candidate(dir, "1.1.0"); bad.manifest.artifacts[0].sha256 = "0".repeat(64);
  assert.throws(() => installNativeCandidate(bad.file, bad.manifest, { root, binDir }), /sha256/);
  assert.equal(fs.realpathSync(path.join(root, "current")), before);
  assert.throws(() => validateNativeManifest({ ...good.manifest, source: { ...good.manifest.source, dirty: true } }), /clean source/);
  assert.throws(() => validateNativeManifest({ ...good.manifest, artifacts: [{ ...good.manifest.artifacts[0], verified: false }] }), /not executed/);
});
