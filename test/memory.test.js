// hcode memory (V0.2.7 B): scan sees every agent's corner and opens no secret file; harvest
// is one-way (other agents' directories keep their mtimes), fences secrets twice, dedupes
// by hash; recall rewrites MEMORY-HUB.md with the fixed two-line header.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-memory-"));
const home = path.join(tmp, "home");
process.env.HCODE_HARVEST_HOME = home;
process.env.HCODE_HOME = path.join(home, ".hcode");
delete process.env.HCODE_SESSIONS;
const mem = await import("../src/memory.js");

const write = (rel, text) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
function seed() {
  const fakeApiKey = "sk-" + "A".repeat(32);
  const fakePrivateKeyHeader = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
  write(".claude/projects/-Users-me/memory/MEMORY.md", "# Index\n- [tea](tea.md)\n");
  write(".claude/projects/-Users-me/memory/tea.md", "# Tea\nThe owner drinks oolong every morning.\n");
  write(".claude/projects/-Users-me/memory/leak.md", `# Leak\napi key ${fakeApiKey}\n`);
  write(".claude/projects/-Users-me/memory/auth.json", JSON.stringify({ tokens: { access_token: "eyJ-fake" } }));      // red team: auth.json shape inside a harvest root
  write(".claude/projects/-Users-me/memory/id_ed25519", `${fakePrivateKeyHeader}\nfake\n`);                             // red team: a key file inside a harvest root
  write(".claude/settings.json", "{}");
  write(".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-fake" }));
  write(".codex/config.toml", "model = \"x\"\n");
  write(".codex/memories/MEMORY.md", "# Codex\nThe forge repo lives on gram.\n");
  write(".codex/memories/raw_memories.md", "The owner drinks oolong every morning.\n");
  write(".codex/memories/rollout_summaries/copy.md", "# Tea\nThe owner drinks oolong every morning.\n");   // byte-identical to Claude's tea.md → one hub entry
  write(".codex/memories/seed.md", "abandon ability able about above absent absorb abstract absurd abuse access accident\n");   // mnemonic shape
  write(".hcode/sessions/20260101-aaaa.jsonl", [JSON.stringify({ ts: 1, role: "user", content: "fix the build" }), JSON.stringify({ ts: 2, role: "assistant", content: "done" })].join("\n") + "\n");
  // a memory-shaped sqlite next to one that is not
  const sqlite = process.getBuiltinModule("node:sqlite");
  const db = new sqlite.DatabaseSync(path.join(home, ".codex", "memories_1.sqlite"));
  db.exec("create table stage1_outputs (thread_id text primary key, raw_memory text not null, rollout_summary text not null, memory_mode text)");
  db.prepare("insert into stage1_outputs values (?,?,?,?)").run("t1", "Codex remembers the canary password lives in a 0600 file.", "summary one", "on");
  db.prepare("insert into stage1_outputs values (?,?,?,?)").run("t2", "password: hunter2", "leaky", "on");
  db.close();
  const other = new sqlite.DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
  other.exec("create table threads (id text primary key, memory_mode text, status text)");
  other.prepare("insert into threads values (?,?,?)").run("a", "on", "ok");
  other.close();
}
const snapshot = () => {
  const out = [];
  const walk = dir => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, ent.name); if (ent.isDirectory()) walk(f); else out.push(`${f} ${fs.statSync(f).mtimeMs} ${fs.statSync(f).size}`); } };
  for (const agent of [".claude", ".codex"]) walk(path.join(home, agent));
  walk(path.join(home, ".hcode", "sessions"));
  return out.sort().join("\n");
};

test("scan lists every agent's corner, opens no secret, marks sqlite exportability", () => {
  seed();
  const rows = mem.scan(home);
  const byPath = Object.fromEntries(rows.map(r => [r.path, r]));
  assert.equal(byPath["~/.claude/projects/-Users-me/memory/auth.json"].skipped, "secret");
  assert.equal(byPath["~/.claude/projects/-Users-me/memory/id_ed25519"].skipped, "secret");
  assert.equal(byPath["~/.claude/settings.json"].skipped, "secret");
  assert.equal(byPath["~/.codex/auth.json"].skipped, "secret");
  assert.equal(byPath["~/.codex/config.toml"].skipped, "secret");
  assert.equal(byPath["~/.claude/projects/-Users-me/memory/tea.md"].exportable, true);
  assert.equal(byPath["~/.codex/memories_1.sqlite"].exportable, true);
  assert.deepEqual(byPath["~/.codex/memories_1.sqlite"].tables, [{ table: "stage1_outputs", columns: ["raw_memory", "rollout_summary"] }]);
  assert.equal(byPath["~/.codex/state_5.sqlite"].exportable, false);
  assert.equal(byPath["~/.hcode/sessions/20260101-aaaa.jsonl"].exportable, true);
  assert.ok(rows.every(r => r.path.startsWith("~/")));
  const summary = mem.scanSummary(rows);
  assert.equal(summary.claude.secrets, 3);
  assert.equal(summary.codex.secrets, 2);
  assert.deepEqual(Object.keys(summary).sort(), ["claude", "codex", "hcode"]);
  assert.match(mem.scanTable(rows), /skip:secret\s+~\/\.codex\/auth\.json/);
});

test("gather: secrets fenced and counted, hash dedupe, nothing touched", () => {
  const before = snapshot();
  const got = mem.gather(home);
  assert.equal(snapshot(), before);
  const texts = got.entries.map(e => e.text).join("\n");
  assert.ok(!/sk-ABCDEF|hunter2|BEGIN OPENSSH|eyJ-fake|abandon ability/.test(texts));
  assert.equal(got.secretsSkipped, 3);          // leak.md, seed.md (mnemonic), sqlite row "password:"
  assert.equal(got.duplicates, 1);              // rollout_summaries/copy.md is byte-identical to tea.md
  assert.deepEqual(got.sources, { claude: 2, codex: 3, hcode: 1 });
  assert.ok(got.entries.every(e => e.originPath.startsWith("~/") && /^sha256:[0-9a-f]{64}$/.test(e.hash) && ["claude", "codex", "hcode"].includes(e.source)));
  const sqliteEntry = got.entries.find(e => e.originPath.includes("#stage1_outputs/"));
  assert.ok(sqliteEntry && sqliteEntry.text.includes("canary password lives in a 0600 file"));
  assert.equal(got.entries.find(e => e.source === "hcode").text, "- fix the build");
  assert.deepEqual(mem.gather(home, "hcode").sources, { hcode: 1 });
  assert.ok(!fs.readdirSync(os.tmpdir()).some(name => name.startsWith("hcode-sqlite-")));
});

test("harvest twice over a hub = zero duplicates; dry run sends nothing; recall writes MEMORY-HUB.md", async (t) => {
  const store = new Map(); const calls = [];
  const hub = http.createServer((req, res) => {
    let body = ""; req.on("data", c => { body += c; }); req.on("end", () => {
      const u = new URL(req.url, "http://x"); calls.push(`${req.method} ${u.pathname}`);
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "POST" && u.pathname === "/memory/hub/put") {
        const b = JSON.parse(body); let added = 0, duplicates = 0, secretsSkipped = 0;
        for (const e of b.entries) { if (/sk-/.test(e.text)) { secretsSkipped++; continue; } const id = mem.sha(e.text); if (store.has(id)) duplicates++; else { store.set(id, { ...e, id: "h-" + id.slice(7, 19), harvestId: b.harvestId }); added++; } }
        return json(200, { ok: true, added, duplicates, rejected: secretsSkipped, secretsSkipped });
      }
      if (req.method === "GET" && u.pathname === "/memory/hub") {
        const q = (u.searchParams.get("q") || "").toLowerCase();
        const entries = [...store.values()].filter(e => !q || `${e.title}\n${e.text}`.toLowerCase().includes(q));
        return json(200, { q, total: entries.length, entries: entries.slice(0, Number(u.searchParams.get("limit")) || 20) });
      }
      json(404, { error: "nope" });
    });
  });
  await new Promise(resolve => hub.listen(0, "127.0.0.1", resolve));
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.address().port}`;
  const before = snapshot();

  const dry = await mem.harvest({ home, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.candidates, 6); assert.equal(calls.length, 0);

  const first = await mem.harvest({ home, base });
  assert.equal(first.added, 6); assert.equal(first.duplicates, 0); assert.match(first.harvestId, /^hv-/);
  const second = await mem.harvest({ home, base });
  assert.equal(second.added, 0); assert.equal(second.duplicates, 6);
  assert.equal(store.size, 6);
  assert.equal(snapshot(), before, "other agents' directories must keep their mtimes");
  await assert.rejects(mem.harvest({ home }), /no Hoop/);

  const r = await mem.recall({ q: "oolong", base, domain: "test.hoopgram.ai" });
  assert.equal(r.total, 2);   // tea.md and raw_memories.md both mention oolong
  const file = fs.readFileSync(mem.HUB_FILE, "utf8").split("\n");
  assert.equal(file[0], "<!-- 由 Hoop 生成（hcode memory recall）· 勿手改 -->");
  assert.match(file[1], /^# Memory Hub · test\.hoopgram\.ai · \d{4}-\d\d-\d\dT/);
  assert.ok(file.some(line => line.includes("oolong")));
  assert.equal(fs.statSync(mem.HUB_FILE).mode & 0o777, 0o644);
  assert.equal(snapshot(), before);
});

test("cleanup", () => { fs.rmSync(tmp, { recursive: true, force: true }); });
