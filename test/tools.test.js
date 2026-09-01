import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createTools, resolveInside, isSecretPath, allowed, toolDefs } from "../src/tools.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-t-"));
// Tool mechanics are tested without an OS wrapper here; SandboxWriteGate has
// its own degraded/adapter coverage in policy.test.js.
const tools = createTools({ root, bashTimeoutMs: 5000, sandboxWant: "none" });

test("update_plan projects a bounded structured plan without touching the workspace", async () => {
  const seen = [];
  const planning = createTools({ root, sandboxWant: "none", updatePlan: value => seen.push(value) });
  const plan = { goal: "Fix live UI", checkpoint: "Implement", steps: [{ label: "Inspect", status: "completed" }, { label: "Verify", status: "in_progress" }] };
  assert.equal(await planning.update_plan(plan), "plan updated");
  assert.deepEqual(seen, [plan]);
});

test("edit_file: exact single replacement, refuses ambiguous and missing", async () => {
  fs.writeFileSync(path.join(root, "a.txt"), "one two one\n");
  await assert.rejects(tools.edit_file({ path: "a.txt", old_string: "one", new_string: "1" }), /occurs 2 times/);
  await assert.rejects(tools.edit_file({ path: "a.txt", old_string: "zzz", new_string: "1" }), /not found/);
  assert.match(await tools.edit_file({ path: "a.txt", old_string: "two", new_string: "2" }), /1 replacement/);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "one 2 one\n");
  assert.match(await tools.edit_file({ path: "a.txt", old_string: "one", new_string: "1", replace_all: true }), /2 replacements/);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "1 2 1\n");
  // special replacement patterns ($&, $1) must be literal
  fs.writeFileSync(path.join(root, "b.txt"), "x\n");
  await tools.edit_file({ path: "b.txt", old_string: "x", new_string: "$& $1 $$" });
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "$& $1 $$\n");
});

test("path safety: writes never leave the root; secrets are refused everywhere", async () => {
  await assert.rejects(tools.write_file({ path: "../escape.txt", content: "x" }), /outside the project root/);
  await assert.rejects(tools.write_file({ path: "/etc/passwd", content: "x" }), /outside the project root/);
  await assert.rejects(tools.edit_file({ path: path.join("..", "x"), old_string: "a", new_string: "b" }), /outside/);
  await assert.rejects(tools.read_file({ path: "~/.ssh/id_ed25519" }), /secret/);
  await assert.rejects(tools.read_file({ path: path.join(root, ".env") }), /secret/);
  await assert.rejects(tools.write_file({ path: ".env.local", content: "k=v" }), /secret/);
  await assert.rejects(tools.read_file({ path: "a\0.txt" }), /bad path/);
  assert.ok(isSecretPath("/home/u/.hoopgram/keys/x/key.txt"));
  assert.ok(isSecretPath("/Users/u/.npmrc"));
  assert.ok(!isSecretPath("/home/u/project/src/env.js"));
  assert.equal(resolveInside(root, "sub/../a.txt"), path.join(root, "a.txt"));
  // reads outside root require an exact owner policy grant; writes remain forbidden
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-o-")); fs.writeFileSync(path.join(outside, "r.txt"), "hi\n");
  await assert.rejects(tools.read_file({ path: path.join(outside, "r.txt") }), /allowedRoots/);
  const granted = createTools({ root, allowedRoots: [outside], sandboxWant: "none" });
  assert.match(await granted.read_file({ path: path.join(outside, "r.txt") }), /hi/);
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-o-")); fs.writeFileSync(path.join(sibling, "no.txt"), "no\n");
  await assert.rejects(granted.read_file({ path: path.join(sibling, "no.txt") }), /allowedRoots/);
  fs.symlinkSync(sibling, path.join(outside, "escape"));
  await assert.rejects(granted.read_file({ path: path.join(outside, "escape", "no.txt") }), /allowedRoots/);
});

test("glob + grep skip secrets and ignored dirs", async () => {
  fs.mkdirSync(path.join(root, "src", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "m.js"), "const needle = 1;\n");
  fs.writeFileSync(path.join(root, "src", "node_modules", "n.js"), "needle\n");
  fs.writeFileSync(path.join(root, "src", "id_rsa"), "needle\n");
  assert.equal(await tools.glob({ pattern: "src/**/*.js" }), "src/m.js");
  assert.equal(await tools.glob({ pattern: "*.js", path: "src" }), "src/m.js");
  assert.equal(await tools.grep({ pattern: "needle" }), "src/m.js:1:const needle = 1;");
});

test("bash: runs in root with timeout", async () => {
  assert.match(await tools.bash({ command: "pwd" }), new RegExp(fs.realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(await tools.bash({ command: "sleep 5", timeout_ms: 200 }), /killed: timeout/);
  assert.match(await tools.bash({ command: "exit 3" }), /\[exit 3\]/);
});

test("allow list", () => {
  const s = { allow: ["bash:git *", "write_file:docs/**", "glob"] };
  assert.ok(allowed(s, "bash", { command: "git status" }));
  assert.ok(!allowed(s, "bash", { command: "rm -rf /" }));
  assert.ok(allowed(s, "write_file", { path: "docs/a/b.md" }));
  assert.ok(!allowed(s, "write_file", { path: "src/x.js" }));
  assert.ok(!allowed({}, "bash", { command: "ls" }));
});

test("bash timeout kills the whole process tree and returns at once (A8 HC-14: a grandchild used to hang hcode forever)", async () => {
  // a grandchild keeps ticking into a file and holds the stdout pipe; the shell itself exits at once
  const beat = path.join(root, "heartbeat.txt");
  const t0 = Date.now();
  const out = await tools.bash({ command: `(while :; do echo tick >> ${JSON.stringify(beat)}; sleep 0.1; done) & echo started; wait`, timeout_ms: 700 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `returned in ${ms} ms`);
  assert.match(out, /killed: timeout/); assert.match(out, /process tree is gone/);
  await new Promise(r => setTimeout(r, 400));
  const a = fs.statSync(beat).size; assert.ok(a > 0, "the grandchild really was running");
  await new Promise(r => setTimeout(r, 700));
  assert.equal(fs.statSync(beat).size, a, "the grandchild kept running after the timeout");
});

test("bash cancel via signal returns immediately and kills the tree", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const out = await tools.bash({ command: "sleep 20", timeout_ms: 60000 }, { signal: ac.signal });
  assert.ok(Date.now() - t0 < 4000);
  assert.match(out, /killed: cancelled/);
});

test("large output keeps head AND tail with the omitted byte count in the middle (A8 HC-10)", async () => {
  const out = await tools.bash({ command: "echo BEGIN-MARKER; head -c 3000000 /dev/zero | tr '\\0' 'a'; echo; echo END-MARKER", timeout_ms: 30000 });
  assert.match(out, /BEGIN-MARKER/, "head survives");
  assert.match(out, /END-MARKER/, "tail survives");
  assert.match(out, /bytes of output omitted from the middle/);
  assert.ok(out.length < 130_000, `kept ${out.length} chars`);
});

test("connected Hoop tools are opt-in, read-only, source-labelled, and separate from local files", async () => {
  assert.ok(!toolDefs().some(t => t.name.startsWith("hoop_")));
  assert.deepEqual(toolDefs({ hoop: true }).filter(t => t.name.startsWith("hoop_")).map(t => t.name),
    ["hoop_status", "hoop_finance", "hoop_chats", "hoop_files", "hoop_calendar", "hoop_memory"]);
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, actor: req.headers["x-pa-actor"] });
    if (req.url.startsWith("/files/get")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("remote text"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/finance/") ? { todayPnl: 12.34 } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const remote = createTools({ root, hoopUrl: `http://127.0.0.1:${server.address().port}`, hoopName: "my-hoop" });
    assert.match(await remote.hoop_finance({ account: "real" }), /^\[source: Hoop my-hoop · Finance\]/);
    assert.match(await remote.hoop_finance({ account: "real" }), /"todayPnl": 12\.34/);
    assert.match(await remote.hoop_files({ operation: "read", path: "Inbox/a.txt" }), /Hoop my-hoop · Files\]\nremote text/);
    assert.match(await remote.hoop_chats({ operation: "list" }), /^\[source: Hoop my-hoop · Chats\]/);
    assert.ok(seen.every(row => row.actor === "owner"));
    assert.ok(seen.some(row => row.url === "/finance/summary?account=real"));
  } finally { server.close(); }
  await assert.rejects(createTools({ root }).hoop_status(), /no Hoop data channel/);
});

test("allowedTempRoots: writable scratch for self-verification — bounded on both sides (2026-08-28 order)", async () => {
  const scratch = path.join(root, ".hcode", "tmp"); fs.mkdirSync(scratch, { recursive: true });
  const t = createTools({ root, allowedTempRoots: [scratch], sandboxWant: "none" });
  // write_file into the declared scratch passes; edit_file round-trips (hide → restore)
  assert.match(await t.write_file({ path: path.join(scratch, "CLAIMS.json"), content: "{}" }), /created/);
  assert.match(await t.edit_file({ path: path.join(scratch, "CLAIMS.json"), old_string: "{}", new_string: '{"hidden":true}' }), /edited/);
  // the grant is exact: any other outside path still refuses
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-o-"));
  await assert.rejects(t.write_file({ path: path.join(other, "x.txt"), content: "x" }), /allowedTempRoots/);
  await assert.rejects(t.write_file({ path: "../escape.txt", content: "x" }), /allowedTempRoots/);
  // a read grant does not become writable because a scratch grant exists elsewhere
  const readGrant = createTools({ root, allowedRoots: [other], allowedTempRoots: [scratch], sandboxWant: "none" });
  await assert.rejects(readGrant.write_file({ path: path.join(other, "x.txt"), content: "x" }), /allowedTempRoots/);
  // a symlink out of the scratch dir is an escape, not a scratch file
  fs.symlinkSync(other, path.join(scratch, "escape"));
  await assert.rejects(t.write_file({ path: path.join(scratch, "escape", "x.txt"), content: "x" }), /declared \.hcode\/tmp scratch/);
  // glob/grep honor read grants exactly like read_file — one rule for the whole tool belt
  const handover = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-h-")); fs.writeFileSync(path.join(handover, "READ-FIRST.md"), "work order\n");
  const g = createTools({ root, allowedRoots: [handover], sandboxWant: "none" });
  assert.match(await g.glob({ pattern: "*.md", path: handover }), /READ-FIRST/);
  assert.match(await g.grep({ pattern: "work order", path: handover }), /READ-FIRST/);
});

test("web_search is injectable, bounded and forwards cancellation without opening a result URL", async () => {
  const calls = []; const controller = new AbortController();
  const t = createTools({ root, webSearch: async (query, options) => { calls.push({ query, options }); return "1. result\n   https://example.com"; } });
  assert.match(await t.web_search({ query: "anope youtube", max_results: 3 }, { signal: controller.signal }), /https:\/\/example\.com/);
  assert.equal(calls[0].query, "anope youtube"); assert.equal(calls[0].options.maxResults, 3); assert.equal(calls[0].options.signal, controller.signal);
});
