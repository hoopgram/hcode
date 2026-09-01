#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const file = path.resolve(process.argv[2] || "dist/native/native-manifest.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const expected = process.env.EXPECTED_TARGET || `${process.platform}-${process.arch}`;
if (manifest.sea?.builtOn !== expected) throw new Error(`manifest builtOn ${manifest.sea?.builtOn} != runner ${expected}`);
if (manifest.source?.dirty) throw new Error("release candidate was built from a dirty hcode tree");
const artifact = manifest.artifacts?.find(item => item.target === expected);
if (!artifact?.verified || !artifact.probes?.includes("embedded-agency-charter")) throw new Error(`${expected} was not fully executed on its own runner`);
const binary = path.join(path.dirname(file), artifact.file);
const digest = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
if (digest !== artifact.sha256 || fs.statSync(binary).size !== artifact.bytes) throw new Error(`${expected} bytes do not match manifest`);
console.log(`${expected} verified · ${artifact.bytes} bytes · sha256:${digest}`);
