// Locks the behavior of two dedupe merges: canonical() (formerly duplicated verbatim in session.js
// and coordinator.js, now shared from canonical.js) and readJson() (formerly duplicated verbatim in
// policy.js and rules.js, now imported from config.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical } from "../src/canonical.js";
import { canonical as sessionCanonical } from "../src/session.js";
import { canonical as coordinatorCanonical } from "../src/coordinator.js";
import { readJson } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hcode-dedupe-"));

test("canonical: session.js and coordinator.js re-export the same shared function", () => {
  assert.equal(sessionCanonical, canonical);
  assert.equal(coordinatorCanonical, canonical);
});

test("canonical: sorts object keys regardless of insertion order, recurses through arrays", () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(canonical([{ b: 1, a: 2 }, "x"]), '[{"a":2,"b":1},"x"]');
  assert.equal(canonical(null), "null");
  assert.equal(canonical("s"), '"s"');
});

test("readJson: missing file returns the fallback (null by default)", () => {
  const dir = tmp();
  assert.equal(readJson(path.join(dir, "nope.json")), null);
  assert.deepEqual(readJson(path.join(dir, "nope.json"), {}), {});
});

test("readJson: corrupt JSON returns the fallback, never throws", () => {
  const dir = tmp();
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{not json");
  assert.equal(readJson(file), null);
  assert.deepEqual(readJson(file, { fallback: true }), { fallback: true });
});

test("readJson: valid JSON parses and round-trips", () => {
  const dir = tmp();
  const file = path.join(dir, "good.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, allow: ["git *"] }));
  assert.deepEqual(readJson(file), { v: 1, allow: ["git *"] });
});
