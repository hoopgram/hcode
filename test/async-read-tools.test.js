// The four read tools wait on the filesystem asynchronously, so a batch of them (agent.js) really does overlap
// instead of only looking like it. Two things are proved here and they are equally load-bearing:
//   1. nothing an owner can observe changed — every output, every refusal and every error code is pinned below,
//      including the path boundary, which is still decided synchronously before the first await;
//   2. the overlap is real — the evidence is an in-flight counter on the filesystem itself, plus the same four
//      reads measured serially in the same test, not a wall clock guess about one number.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/tools.js";
import { runAgent } from "../src/agent.js";
import { Session } from "../src/session.js";
import { startFakeModel, text, tool } from "./fake-model.js";

const DELAY = 60;

// A filesystem that is slow and honest: it counts how many of this workspace's waits are in flight at once.
// Only paths under the test workspace are slowed, so nothing else in the process is disturbed, and the counter
// therefore counts the tools' own reads and nothing else. tools.js and this test share one node:fs/promises.
function slowFs(root, delayMs = DELAY) {
  const state = { inFlight: 0, peak: 0, calls: 0 };
  const originals = {};
  for (const name of ["stat", "readFile", "readdir"]) {
    originals[name] = fsp[name];
    fsp[name] = async (target, ...rest) => {
      if (!String(target).startsWith(root)) return originals[name](target, ...rest);
      state.inFlight++; state.calls++; state.peak = Math.max(state.peak, state.inFlight);
      try {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return await originals[name](target, ...rest);
      } finally { state.inFlight--; }
    };
  }
  state.restore = () => { for (const [name, fn] of Object.entries(originals)) fsp[name] = fn; };
  return state;
}

function workspace() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hcode-async-")));
  fs.mkdirSync(path.join(cwd, ".hcode"));
  fs.writeFileSync(path.join(cwd, ".hcode", "policy.json"), JSON.stringify({ v: 1, sandbox: "none" }));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "src", "deep"));
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.mkdirSync(path.join(cwd, "empty"));
  for (const name of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name} one\n${name} two\n`);
  fs.writeFileSync(path.join(cwd, "empty.txt"), "");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(cwd, "src", "one.js"), "const one = 1;\nexport default one;\n");
  fs.writeFileSync(path.join(cwd, "src", "deep", "three.js"), "const three = 3;\n");
  fs.writeFileSync(path.join(cwd, "node_modules", "hidden.js"), "const one = 1;\n");
  return cwd;
}
const toolsIn = cwd => createTools({ root: cwd, allowedRoots: [], allowedTempRoots: [] });
const FILES = ["a.txt", "b.txt", "c.txt", "d.txt"];
// A directory's entries come back in the filesystem's own order, which differs between APFS and ext4, so the
// tests below pin what the tools found and check the order separately, as a property that holds anywhere.
const lines = value => value.split("\n").sort();

// ---- 1. nothing observable changed ------------------------------------------------------------------
// These are the exact strings the synchronous implementation produced; they are the contract, and the
// refusals among them are the security boundary, so a future rewrite has to keep saying these words.

test("the read tools return exactly what they always returned", async () => {
  const cwd = workspace();
  const tools = toolsIn(cwd);
  try {
    assert.equal(await tools.read_file({ path: "a.txt" }), "    1\ta one\n    2\ta two\n    3\t");
    assert.equal(await tools.read_file({ path: "a.txt", offset: 2, limit: 1 }), "    2\ta two");
    assert.equal(await tools.read_file({ path: "a.txt", offset: 99 }), "(empty file)");
    assert.equal(await tools.read_file({ path: "empty.txt" }), "    1\t");   // one empty line, not the "(empty file)" word
    assert.equal(await tools.list_dir({}), "a.txt\nb.txt\nc.txt\nd.txt\nempty/\nempty.txt\nnode_modules/\nsrc/");
    assert.equal(await tools.list_dir({ path: "empty" }), "(empty)");
    assert.equal(await tools.list_dir({ path: "src" }), "deep/\none.js");
    assert.deepEqual(lines(await tools.glob({ pattern: "**/*.js" })), ["src/deep/three.js", "src/one.js"]);
    assert.equal(await tools.glob({ pattern: "*.js", path: "src" }), "src/one.js");   // `*` does not cross a slash
    assert.equal(await tools.glob({ pattern: "**/*.rs" }), "(no matches)");
    assert.deepEqual(lines(await tools.grep({ pattern: "const" })), ["src/deep/three.js:1:const three = 3;", "src/one.js:1:const one = 1;"]);
    // hits inside one file stay in line order, whatever order the files themselves were visited in
    assert.equal(await tools.grep({ pattern: "ONE", ignore_case: true, glob: "**/one.js" }), "src/one.js:1:const one = 1;\nsrc/one.js:2:export default one;");
    assert.equal(await tools.grep({ pattern: "zzzz" }), "(no matches)");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a directory walked asynchronously is still walked depth-first, in one order, ignoring the same directories", async () => {
  const cwd = workspace();
  try {
    const tools = toolsIn(cwd);
    const once = await tools.glob({ pattern: "**/*" });
    const twice = await tools.glob({ pattern: "**/*" });
    assert.equal(once, twice, "the same tree walked twice gives the same order");
    assert.doesNotMatch(once, /node_modules|\.hcode/, "ignored directories stay ignored");
    assert.deepEqual(lines(once).filter(line => line.startsWith("src/")), ["src/deep/three.js", "src/one.js"]);
    // glob and grep share one walk, so they visit files in the same order — that is the property an
    // asynchronous traversal could have lost, and it is checked without pinning any one filesystem's order.
    const globbed = (await tools.glob({ pattern: "**/*.js" })).split("\n");
    const grepped = [...new Set((await tools.grep({ pattern: "const" })).split("\n").map(hit => hit.split(":")[0]))];
    assert.deepEqual(grepped, globbed, "one traversal, one order, for both search tools");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("the path boundary still refuses in the same words, and still refuses before any byte is read", async () => {
  const cwd = workspace();
  const tools = toolsIn(cwd);
  const secretRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hcode-async-secret-")));
  const secretDir = path.join(secretRoot, ".ssh");
  const secretFile = path.join(secretDir, "id_rsa");
  fs.mkdirSync(secretDir);
  fs.writeFileSync(secretFile, "test-only\n");
  const fails = async (call, message, code = undefined) => {
    await assert.rejects(call, error => {
      assert.equal(error.message, message);
      if (code !== undefined) assert.equal(error.code, code);
      return true;
    });
  };
  try {
    await fails(tools.read_file({ path: "" }), "path required");
    await fails(tools.read_file({ path: "a\0b" }), "bad path");
    await fails(tools.read_file({ path: "src" }), "src is a directory (use list_dir)");
    await fails(tools.read_file({ path: "nope.txt" }), `ENOENT: no such file or directory, stat '${path.join(cwd, "nope.txt")}'`, "ENOENT");
    await fails(tools.read_file({ path: "../etc/hosts" }), "refused: ../etc/hosts is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.read_file({ path: "/etc/hosts" }), "refused: /etc/hosts is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.read_file({ path: ".env" }), "refused: .env looks like a secret; hcode never reads or writes those");
    await fails(tools.read_file({ path: "~/.ssh/id_rsa" }), "refused: ~/.ssh/id_rsa looks like a secret; hcode never reads or writes those");
    await fails(tools.list_dir({ path: "/etc" }), "refused: /etc is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.list_dir({ path: "nope" }), `ENOENT: no such file or directory, scandir '${path.join(cwd, "nope")}'`, "ENOENT");
    await fails(tools.list_dir({ path: "a.txt" }), `ENOTDIR: not a directory, scandir '${path.join(cwd, "a.txt")}'`, "ENOTDIR");
    await fails(tools.glob({ pattern: "*", path: "/etc" }), "refused: /etc is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.grep({ pattern: "x", path: "/etc" }), "refused: /etc is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.grep({ pattern: "([" }), "bad regex: Invalid regular expression: /([/: Unterminated character class");
    // a symlink out of the root, and one into a secret directory, are judged by where they really land
    fs.symlinkSync("/etc", path.join(cwd, "outside"));
    fs.symlinkSync(secretDir, path.join(cwd, "keys"));
    await fails(tools.read_file({ path: "outside/hosts" }), "refused: outside/hosts is outside the project root and is not in policy.json allowedRoots");
    await fails(tools.read_file({ path: "keys/id_rsa" }), `refused: keys/id_rsa → ${secretFile} looks like a secret; hcode never reads or writes those`);
    // and the refusal happens with the filesystem untouched: a slowed fs is never even asked
    const slow = slowFs(cwd);
    try {
      await fails(tools.read_file({ path: ".env" }), "refused: .env looks like a secret; hcode never reads or writes those");
      assert.equal(slow.calls, 0, "a refused path never reaches the filesystem");
    } finally { slow.restore(); }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(secretRoot, { recursive: true, force: true });
  }
});

// ---- 2. the overlap is real -------------------------------------------------------------------------

test("four reads issued together wait together; the same four awaited in turn do not", async () => {
  const cwd = workspace();
  const tools = toolsIn(cwd);
  const slow = slowFs(cwd);
  try {
    const startedTogether = Date.now();
    const together = await Promise.all(FILES.map(file => tools.read_file({ path: file })));
    const elapsedTogether = Date.now() - startedTogether;
    const peakTogether = slow.peak;

    slow.peak = 0; slow.calls = 0;
    const startedInTurn = Date.now();
    const inTurn = [];
    for (const file of FILES) inTurn.push(await tools.read_file({ path: file }));
    const elapsedInTurn = Date.now() - startedInTurn;

    // the same answers either way, and each file's own content
    assert.deepEqual(together, inTurn);
    assert.equal(together[0], "    1\ta one\n    2\ta two\n    3\t");
    // a synchronous read_file could not have done this: four stats, then four reads, all waiting at once
    assert.equal(peakTogether, 4, `four reads were in flight together, saw ${peakTogether}`);
    assert.equal(slow.peak, 1, `awaited in turn, one read waits at a time, saw ${slow.peak}`);
    // read_file waits twice (stat, then read), so four together cost about two delays and four in turn cost eight
    assert.ok(elapsedTogether < DELAY * 4, `four together finish in about two delays, took ${elapsedTogether}ms`);
    assert.ok(elapsedInTurn > elapsedTogether * 2, `in turn is far slower: ${elapsedInTurn}ms against ${elapsedTogether}ms`);
  } finally { slow.restore(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a grep and a glob running beside reads overlap too, and still answer exactly", async () => {
  const cwd = workspace();
  const tools = toolsIn(cwd);
  const slow = slowFs(cwd);
  try {
    const [grep, glob, list, read] = await Promise.all([
      tools.grep({ pattern: "const" }), tools.glob({ pattern: "**/*.js" }),
      tools.list_dir({ path: "src" }), tools.read_file({ path: "a.txt" }),
    ]);
    assert.deepEqual(lines(grep), ["src/deep/three.js:1:const three = 3;", "src/one.js:1:const one = 1;"]);
    assert.deepEqual(lines(glob), ["src/deep/three.js", "src/one.js"]);
    assert.equal(list, "deep/\none.js");
    assert.equal(read, "    1\ta one\n    2\ta two\n    3\t");
    assert.ok(slow.peak >= 4, `all four search/read tools waited together, saw ${slow.peak}`);
  } finally { slow.restore(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("one step proposing four local reads overlaps end to end and still answers in the model's order", async () => {
  const cwd = workspace();
  const model = await startFakeModel((_messages, _request, turn) => turn === 1
    ? { blocks: FILES.map(file => tool("read_file", { path: file })), stop: "tool_use" }
    : text("read four"));
  const slow = slowFs(cwd);
  const started = Date.now();
  try {
    const run = await runAgent({
      cfg: { baseUrl: model.base, apiKey: "k", model: "m", maxTokens: 100, maxTurns: 4, bashTimeoutMs: 2000, cwd, mode: "auto" },
      settings: {}, session: new Session(path.join(cwd, "s")), prompt: "read them", quiet: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(run.text, "read four");
    assert.equal(slow.peak, 4, `the batch really overlapped, saw ${slow.peak}`);
    assert.ok(elapsed < DELAY * 8, `the batch cost about two delays, not eight; took ${elapsed}ms`);
    const answers = model.lastTools().map(block => block.content);
    assert.equal(answers.length, 4);
    assert.deepEqual(answers.map(body => body.split("\t")[1].split("\n")[0]), ["a one", "b one", "c one", "d one"]);
  } finally { slow.restore(); model.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
