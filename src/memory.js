// `hcode memory scan | harvest | recall` — V0.2.7 B2–B4 (CONTRACTS-V027 §4.3).
// Every agent on this machine leaves memories in its own corner (Claude's project memory,
// Codex's memories dir + sqlite, hcode's own sessions). This module READS them, one way,
// and pushes a normalised copy into the owner's Hoop — the hub layer of the Memory organ.
// It never writes, changes or deletes anything in another agent's directory (sqlite files
// are copied to a private tmpdir before they are opened read-only, so not even a -shm is
// touched). Secrets are fenced twice: a path blacklist decides what is never opened, a
// content filter throws away any entry that looks like a key / token / private key /
// mnemonic / password — counted, never sent.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HOME, ON_HOOP, VERSION } from "./config.js";

export const MAX_TEXT = 64 * 1024;
export const BATCH = 200;
const MAX_ROWS_PER_TABLE = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ── fence 1: paths that are never opened (§2 blacklist + what those dirs mix in) ─────
const SECRET_NAMES = [/^auth\.json$/i, /^settings(\.local)?\.json$/i, /^config\.toml(\..*)?$/i, /^credentials(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|token)$/i, /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, /^\.env(\..*)?$/i, /^\.netrc$/i,
  /^(api[_-]?key|secret|token)s?(\..*)?$/i, /^\.npmrc$/i, /^\.pypirc$/i];
const CONFIG_NAMES = [/^\.?config(\.json|\.toml|\.yaml|\.yml)?$/i, /^installation_id$/i, /^models_cache\.json$/i, /^\.sandbox_migration$/i, /\.bak(-.*)?$/i];
const SECRET_DIRS = new Set([".secrets", "keys", ".ssh", ".git", ".tmp", "cache", "node_modules"]);
// hcode's rewind snapshots (rewind.js) sit beside the sessions and are verbatim copies of project
// files, not memory. The harvest never walks into them: only a rewind reads them back.
const WORKSPACE_DIRS = new Set(["snapshots"]);
export function skipReason(name, isDir) {
  if (isDir) return SECRET_DIRS.has(name) ? "secret" : WORKSPACE_DIRS.has(name) ? "workspace" : null;
  if (SECRET_NAMES.some(rx => rx.test(name))) return "secret";
  if (CONFIG_NAMES.some(rx => rx.test(name))) return "config";
  return null;
}

// ── fence 2: content shapes that are never sent (§4.1) ───────────────────────────
const SECRET_PATTERNS = [
  /-----BEGIN/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bxox[bpsa]-/, /\bAKIA[0-9A-Z]{16}\b/, /\bghp_[A-Za-z0-9]{20,}/,
  /\bgh[ours]_[A-Za-z0-9]{20,}/, /\bpassword\s*[:=]/i, /\bpasswd\s*[:=]/i,
  /^(?:[a-z]{3,8} ){11}[a-z]{3,8}$/m, /^(?:[a-z]{3,8} ){23}[a-z]{3,8}$/m,
];
export const looksSecret = text => SECRET_PATTERNS.some(rx => rx.test(String(text || "")));

export const sha = text => "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
const homeDir = () => process.env.HCODE_HARVEST_HOME || os.homedir();
export const tilde = file => { const h = homeDir(); return file === h ? "~" : file.startsWith(h + path.sep) ? "~/" + path.relative(h, file).split(path.sep).join("/") : file; };
const kindOf = name => /\.md$/i.test(name) ? "md" : /\.jsonl$/i.test(name) ? "jsonl" : /\.(sqlite|sqlite3|db)$/i.test(name) ? "sqlite" : /\.json$/i.test(name) ? "json" : "other";

// Where each agent keeps its memory (the harvest roots). `home` is overridable for tests.
export function roots(home = homeDir()) {
  const out = [];
  const claude = path.join(home, ".claude");
  try {
    for (const project of fs.readdirSync(path.join(claude, "projects"))) {
      const dir = path.join(claude, "projects", project, "memory");
      if (fs.existsSync(dir)) out.push({ agent: "claude", dir, tags: ["claude", project] });
    }
  } catch { }
  for (const name of ["settings.json", "settings.local.json"]) if (fs.existsSync(path.join(claude, name))) out.push({ agent: "claude", file: path.join(claude, name) });
  const codex = path.join(home, ".codex");
  if (fs.existsSync(path.join(codex, "memories"))) out.push({ agent: "codex", dir: path.join(codex, "memories"), tags: ["codex"] });
  try {
    for (const name of fs.readdirSync(codex)) if (/\.(sqlite|sqlite3|db)$/i.test(name) || skipReason(name, false)) out.push({ agent: "codex", file: path.join(codex, name), tags: ["codex", "sqlite"] });
  } catch { }
  const sessions = process.env.HCODE_SESSIONS || path.join(home, ".hcode", "sessions");
  if (fs.existsSync(sessions)) out.push({ agent: "hcode", dir: sessions, tags: ["hcode", "session"] });
  return out;
}

// ── B2 scan: see everything, open nothing secret ────────────────────────────────
function walk(root, rows, depth = 0) {
  let names = [];
  try { names = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { return; }
  for (const ent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root.dir, ent.name);
    if (ent.isDirectory()) {
      const skipped = skipReason(ent.name, true);
      if (skipped) rows.push({ agent: root.agent, path: tilde(file) + "/", kind: "dir", bytes: 0, mtime: 0, exportable: false, skipped });
      else if (depth < 4) walk({ ...root, dir: file }, rows, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    if (/\.(sqlite|db)-(wal|shm|journal)$/i.test(ent.name)) continue;   // belongs to its database row
    rows.push(fileRow(root, file));
  }
}
function fileRow(root, file) {
  const name = path.basename(file);
  let stat; try { stat = fs.statSync(file); } catch { return { agent: root.agent, path: tilde(file), kind: kindOf(name), bytes: 0, mtime: 0, exportable: false, skipped: "config" }; }
  const row = { agent: root.agent, path: tilde(file), kind: kindOf(name), bytes: stat.size, mtime: Math.round(stat.mtimeMs) };
  const skipped = skipReason(name, false);
  if (skipped) return { ...row, exportable: false, skipped };
  if (row.kind === "sqlite") { const probe = probeSqlite(file); return { ...row, exportable: probe.ok, tables: probe.tables, note: probe.note }; }
  return { ...row, exportable: ["md", "jsonl"].includes(row.kind) && stat.size <= MAX_FILE_BYTES };
}
export function scan(home = homeDir()) {
  const rows = [];
  for (const root of roots(home)) { if (root.file) rows.push(fileRow(root, root.file)); else walk(root, rows); }
  return rows;
}
export function scanSummary(rows) {
  const by = {};
  for (const row of rows) {
    const b = by[row.agent] || (by[row.agent] = { files: 0, bytes: 0, exportable: 0, skipped: 0, secrets: 0 });
    b.files++; b.bytes += row.bytes || 0; if (row.exportable) b.exportable++; if (row.skipped) b.skipped++; if (row.skipped === "secret") b.secrets++;
  }
  return by;
}

// ── sqlite, read-only, on a private copy (the original file is never opened for write) ─
let sqliteMod = null;
function loadSqlite() {
  if (sqliteMod !== null) return sqliteMod;
  try { sqliteMod = process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : null; } catch { sqliteMod = false; }
  return sqliteMod || false;
}
// §4.3: a table is memory-shaped when its name OR a text column's name says memory/note/
// fact/summary. A matching table gives up all its text columns; otherwise only the
// matching columns (Codex keeps `raw_memory`/`rollout_summary` in `stage1_outputs`).
const MEMORY_RX = /memor|note|fact|summar/i;
const TEXTY = /memor|note|fact|summar|content|text|body|title|message/i;
const NOT_TEXT = /(^|_)(mode|id|key|token|hash|status|kind|type|path|url)$/i;   // flags and handles, never prose
const ident = name => '"' + String(name).replace(/"/g, '""') + '"';              // quoted SQL identifier
function withCopy(file, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hcode-sqlite-"));
  try {
    const copy = path.join(tmp, "db.sqlite");
    fs.copyFileSync(file, copy);
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    return fn(copy);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export function probeSqlite(file) {
  const mod = loadSqlite();
  if (!mod) return { ok: false, tables: [], note: "node:sqlite unavailable" };
  try {
    return withCopy(file, copy => {
      const db = new mod.DatabaseSync(copy, { readOnly: true });
      try {
        const tables = db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(row => row.name);
        const found = [];
        for (const table of tables) {
          if (table.startsWith("_")) continue;
          const info = db.prepare(`pragma table_info(${ident(table)})`).all();
          const textual = col => /text|char|clob/i.test(col.type || "") && !NOT_TEXT.test(col.name);
          const cols = (MEMORY_RX.test(table) ? info.filter(col => textual(col) || TEXTY.test(col.name)) : info.filter(col => textual(col) && MEMORY_RX.test(col.name))).map(col => col.name);
          if (cols.length) found.push({ table, columns: cols });
        }
        return { ok: found.length > 0, tables: found, note: found.length ? "" : tables.length ? "no memory-shaped table (exists, unreadable as memory)" : "empty" };
      } finally { db.close(); }
    });
  } catch (e) { return { ok: false, tables: [], note: `unreadable: ${String(e.message || e).slice(0, 80)}` }; }
}
function sqliteEntries(file, tags, stat) {
  const mod = loadSqlite(); if (!mod) return [];
  const probe = probeSqlite(file); if (!probe.ok) return [];
  return withCopy(file, copy => {
    const db = new mod.DatabaseSync(copy, { readOnly: true });
    const out = [];
    try {
      for (const { table, columns } of probe.tables) {
        const q = `select rowid as _rid, ${columns.map(ident).join(", ")} from ${ident(table)} limit ${MAX_ROWS_PER_TABLE}`;
        let rows = []; try { rows = db.prepare(q).all(); } catch { continue; }
        for (const row of rows) {
          const parts = columns.map(c => row[c]).filter(v => typeof v === "string" && v.trim());
          if (!parts.length) continue;
          const text = parts.join("\n").slice(0, MAX_TEXT);
          out.push({ source: "codex", originPath: tilde(file) + `#${table}/${row._rid}`, originMtime: Math.round(stat.mtimeMs), title: `${path.basename(file)} · ${table} #${row._rid}`, text, tags: [...tags, table] });
        }
      }
    } finally { db.close(); }
    return out;
  });
}

// ── normalise one file into hub entries ──────────────────────────────────────────
const firstHeading = text => { const m = /^#+\s+(.+)$/m.exec(text); return m ? m[1].trim().slice(0, 200) : ""; };
function fileEntries(root, file) {
  const name = path.basename(file);
  if (skipReason(name, false)) return [];
  let stat; try { stat = fs.statSync(file); } catch { return []; }
  if (stat.size > MAX_FILE_BYTES) return [];
  const kind = kindOf(name), mtime = Math.round(stat.mtimeMs), source = root.agent;
  if (kind === "md") {
    const text = fs.readFileSync(file, "utf8").slice(0, MAX_TEXT);
    if (!text.trim()) return [];
    return [{ source, originPath: tilde(file), originMtime: mtime, title: firstHeading(text) || name.replace(/\.md$/i, ""), text, tags: root.tags }];
  }
  if (kind === "jsonl" && source === "hcode") {
    // a session → one entry: what the owner asked (never tool output, never keys)
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const asks = [];
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const role = row.role || row.item?.role, content = row.content ?? row.item?.content ?? row.prompt;
      if (!["user", "owner"].includes(role) && row.type !== "turn.start") continue;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => c?.text || "").join(" ") : "";
      if (text.trim()) asks.push(text.trim());
    }
    if (!asks.length) return [];
    const text = asks.map(a => "- " + a).join("\n").slice(0, MAX_TEXT);
    return [{ source, originPath: tilde(file), originMtime: mtime, title: asks[0].slice(0, 120), text, tags: root.tags }];
  }
  if (kind === "sqlite") return sqliteEntries(file, root.tags, stat);
  return [];
}
function collectFiles(root, out, depth = 0) {
  let names = []; try { names = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { return; }
  for (const ent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root.dir, ent.name);
    if (ent.isDirectory()) { if (!skipReason(ent.name, true) && depth < 4) collectFiles({ ...root, dir: file }, out, depth + 1); }
    else if (ent.isFile()) out.push([root, file]);
  }
}

// ── B3 harvest: gather, fence, dedupe locally, push in batches of 200 ───────────
export function gather(home = homeDir(), agent = "") {
  const files = [];
  for (const root of roots(home)) {
    if (agent && root.agent !== agent) continue;
    if (root.file) files.push([root, root.file]); else collectFiles(root, files);
  }
  const out = { entries: [], secretsSkipped: 0, duplicates: 0, sources: {}, files: 0 };
  const seen = new Set();
  for (const [root, file] of files) {
    let entries = []; try { entries = fileEntries(root, file); } catch { continue; }
    if (entries.length) out.files++;
    for (const entry of entries) {
      if (looksSecret(entry.text) || looksSecret(entry.title)) { out.secretsSkipped++; continue; }
      const hash = sha(entry.text);
      if (seen.has(hash)) { out.duplicates++; continue; }
      seen.add(hash);
      out.entries.push({ ...entry, hash });
      out.sources[entry.source] = (out.sources[entry.source] || 0) + 1;
    }
  }
  return out;
}

// ── the Hoop side: mind over the hcode tunnel (or localhost on a Hoop) ───────────
export function hubBase(opts = {}) {
  if (opts.hubUrl) return String(opts.hubUrl).replace(/\/+$/, "");
  if (process.env.HCODE_HUB_URL) return process.env.HCODE_HUB_URL.replace(/\/+$/, "");
  if (ON_HOOP) return "http://127.0.0.1:8095";
  return "";
}
function call(base, method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base + "/");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, res => {
      const chunks = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { let out = {}; try { out = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { }
        if ((res.statusCode || 500) >= 300) reject(new Error(out.error || `hub ${res.statusCode}`)); else resolve(out); });
    });
    req.setTimeout(60000, () => req.destroy(new Error("hub timeout")));
    req.on("error", reject); if (data) req.end(data); else req.end();
  });
}

export async function harvest({ home = homeDir(), agent = "", dryRun = false, base = "" } = {}) {
  const got = gather(home, agent);
  const harvestId = `hv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const result = { ok: true, harvestId, dryRun, files: got.files, candidates: got.entries.length, localDuplicates: got.duplicates,
    secretsSkipped: got.secretsSkipped, sources: got.sources, added: 0, duplicates: 0, rejected: 0 };
  if (dryRun) return result;
  if (!base) throw new Error("no Hoop: use --hoop <name> (tunnel) or HCODE_HUB_URL");
  for (let i = 0; i < got.entries.length; i += BATCH) {
    const entries = got.entries.slice(i, i + BATCH).map(({ hash, ...entry }) => entry);
    const r = await call(base, "POST", "/memory/hub/put", { entries, harvestId });
    result.added += r.added || 0; result.duplicates += r.duplicates || 0; result.rejected += r.rejected || 0; result.secretsSkipped += r.secretsSkipped || 0;
  }
  if (!got.entries.length) await call(base, "POST", "/memory/hub/audit", { action: "harvest", added: 0, duplicates: 0, secretsSkipped: got.secretsSkipped, sources: {} });
  return result;
}

// ── B4 recall + the read-only file every agent can open ─────────────────────────
export const HUB_FILE = path.join(HOME, "MEMORY-HUB.md");
export function renderHubFile(domain, entries, q = "") {
  const lines = ["<!-- 由 Hoop 生成（hcode memory recall）· 勿手改 -->", `# Memory Hub · ${domain || "hoop"} · ${new Date().toISOString()}`, ""];
  lines.push(q ? `Recall for: ${q} — ${entries.length} hit(s). The hub is a one-way COPY; every agent's own memory keeps growing in its own directory.` :
    `${entries.length} newest hub entries. The hub is a one-way COPY; every agent's own memory keeps growing in its own directory.`);
  lines.push("", "Refresh: `hcode memory recall <query>` or `hcode memory harvest`.", "");
  for (const e of entries) {
    lines.push(`## ${e.title || e.id} · ${e.source} · ${e.originPath || ""}`);
    lines.push(String(e.text || "").trim().split("\n").slice(0, 40).join("\n"), "");
  }
  return lines.join("\n") + "\n";
}
export async function recall({ q, limit = 20, base = "", domain = "" }) {
  if (!base) throw new Error("no Hoop: use --hoop <name> (tunnel) or HCODE_HUB_URL");
  const r = await call(base, "GET", `/memory/hub?q=${encodeURIComponent(q || "")}&limit=${Math.min(Math.max(1, Number(limit) || 20), 200)}`);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${HUB_FILE}.tmp`; fs.writeFileSync(tmp, renderHubFile(domain, r.entries || [], q), { mode: 0o644 }); fs.renameSync(tmp, HUB_FILE);
  return r;
}

// ── CLI surface ───────────────────────────────────────────────────────────────────
const fmtBytes = n => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + "M" : n >= 1024 ? Math.round(n / 1024) + "K" : String(n);
const fmtTime = ms => ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-";
export function scanTable(rows) {
  const lines = ["agent   kind    size    modified          export  path"];
  for (const r of rows) lines.push(`${r.agent.padEnd(7)} ${r.kind.padEnd(7)} ${fmtBytes(r.bytes).padStart(6)}  ${fmtTime(r.mtime).padEnd(17)} ${(r.skipped ? "skip:" + r.skipped : r.exportable ? "yes" : "no").padEnd(11)} ${r.path}${r.note ? "  (" + r.note + ")" : ""}`);
  return lines.join("\n");
}

export const MEMORY_HELP = `hcode memory — one-way harvest of every agent's memory into YOUR Hoop (the hub layer)
  hcode memory scan [--json]                      what each agent left here, where, how big, skipped secrets
  hcode memory harvest [--agent claude|codex|hcode] [--dry-run] [--hoop <name>]
  hcode memory recall <query> [--limit 20] [--hoop <name>]   search the hub; rewrites ~/.hcode/MEMORY-HUB.md
  On a Hoop the hub is local. Elsewhere --hoop <name> opens an SSH tunnel with your own key (nothing stored).
  Daily harvest (off by default): see launchd/ai.hoopgram.hcode-memory-harvest.plist in the hcode package.`;

export async function runMemory(args, { openTunnel, ui } = {}) {
  const sub = args._[1];
  const say = s => console.log(s);
  if (!sub || !["scan", "harvest", "recall"].includes(sub)) { say(MEMORY_HELP); return sub ? 64 : 0; }
  let tunnel = null, base = hubBase(args);
  const domain = args.hoop ? (args.hoop.includes(".") ? args.hoop : `${args.hoop}.hoopgram.ai`) : (ON_HOOP ? os.hostname() : "");
  if (args.hoop && !base) {
    if (!openTunnel) throw new Error("tunnel unavailable");
    tunnel = await openTunnel({ name: args.hoop, user: args.user, localPort: args.port || 18095, remotePort: 8095, identity: args.identity, autoPort: args.port === undefined });
    base = tunnel.baseUrl;
  }
  try {
    if (sub === "scan") {
      const rows = scan();
      if (args.json) say(JSON.stringify({ v: 1, hcode: VERSION, scannedAt: Date.now(), rows, summary: scanSummary(rows) }, null, 2));
      else { say(scanTable(rows)); say(""); for (const [agent, s] of Object.entries(scanSummary(rows))) say(`${agent}: ${s.files} files, ${fmtBytes(s.bytes)}, ${s.exportable} exportable, ${s.skipped} skipped (${s.secrets} secret)`); }
      if (base) { try {
        const s = scanSummary(rows);
        const inventory = Object.fromEntries(Object.entries(s).map(([agent, value]) => [agent, {
          ...value, unreadable: rows.filter(row => row.agent === agent && !row.exportable && !row.skipped).length,
        }]));
        await call(base, "POST", "/memory/hub/audit", {
          action: "scan", target: os.hostname().slice(0, 60),
          sources: Object.fromEntries(Object.entries(s).map(([agent, value]) => [agent, value.files])), inventory,
        });
      } catch (e) { ui?.error?.(`audit not written: ${e.message}`); } }
      else if (!args.json) say("(no Hoop connected: audit line not written — add --hoop <name>)");
      return 0;
    }
    if (sub === "harvest") {
      const r = await harvest({ agent: args.agent || "", dryRun: Boolean(args.dryRun), base });
      if (args.json) say(JSON.stringify(r, null, 2));
      else say(`${r.dryRun ? "dry run: " : ""}${r.files} files → ${r.candidates} entries (${r.localDuplicates} local dup, ${r.secretsSkipped} secrets skipped)` + (r.dryRun ? "" : `; hub: +${r.added}, ${r.duplicates} duplicate, ${r.rejected} rejected · ${r.harvestId}`));
      if (!r.dryRun) { try { await recall({ q: "", limit: 50, base, domain }); } catch { } }
      return 0;
    }
    const q = args._.slice(2).join(" ").trim();
    if (!q) { ui?.error?.("usage: hcode memory recall <query>"); return 64; }
    const r = await recall({ q, limit: args.limit || 20, base, domain });
    if (args.json) say(JSON.stringify(r, null, 2));
    else { say(`${r.total} hit(s) for "${q}" (showing ${r.entries.length}) → ${HUB_FILE}`); for (const e of r.entries) say(`- [${e.source}] ${e.title || e.id} — ${e.originPath || ""}\n  ${String(e.text).trim().split("\n")[0].slice(0, 160)}`); }
    return 0;
  } finally { tunnel?.close(); }
}
