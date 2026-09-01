// `/tune`: what your own history says hcode should be told, with the count and a pointer for every
// claim. It reads the saved session logs and proposes three kinds of change, and it changes nothing.
//
// The rule this module exists to keep is that a suggestion without evidence is a guess. So every row
// carries how many times it happened and one `session:seq` you can open, nothing is inferred from a
// single occurrence, and when the logs cannot support a class the report says the data is thin rather
// than filling the section with something plausible. It writes no file and edits no policy: a change
// to what hcode may do without asking is the owner's to make, and a tool that proposed and applied its
// own permissions would be the wrong shape however good the evidence.
//
// Streaming and de-duplication follow cost.js: one pass, one buffer, first line with a given `seq`
// wins, because a crash-recovered thread rewrites its tail and counting both copies inflates
// everything by roughly half.
import fs from "node:fs";
import path from "node:path";

export const MIN_APPROVALS = 2;      // twice is a pattern worth a rule; once is a Tuesday
export const MIN_REPEATS = 3;
export const MIN_WHOLE_READS = 2;
export const BIG_FILE_BYTES = 20_000;
const CHUNK = 1 << 16;

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const firstLine = value => String(value ?? "").split("\n").map(line => line.trim()).find(Boolean) || "";

function eachLine(file, onLine) {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(CHUNK); const decoder = new TextDecoder("utf8");
  let rest = "";
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (!read) break;
      const parts = (rest + decoder.decode(buffer.subarray(0, read), { stream: true })).split("\n");
      rest = parts.pop();
      for (const line of parts) onLine(line);
    }
  } finally { fs.closeSync(fd); }
  if (rest) onLine(rest);
}

// ---- how a fact becomes a proposal -----------------------------------------------------------------
// A bash rule is the command plus its subcommand, never the whole line: `bash:git commit *` is a rule
// the owner can read and judge, `bash:git commit -m "fix the thing"` is a rule that will never match again.
export function allowRule(tool, input) {
  if (tool === "bash") {
    const words = String(input?.command || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    const head = words[0].split("/").pop();
    const sub = words[1] && /^[a-z][a-z0-9:_-]*$/i.test(words[1]) ? ` ${words[1]}` : "";
    return `bash:${head}${sub} *`;
  }
  if (tool === "write_file" || tool === "edit_file") {
    const dir = path.dirname(String(input?.path || "").replace(/^\.\//, ""));
    return `${tool}:${dir && dir !== "." ? dir.split("/")[0] + "/**" : "*"}`;
  }
  return `${tool}`;
}

// The shape of a request, not its words: a path or a number is what changes between two askings of the
// same thing, so replacing them is what turns "run the tests for src/a.js" and "…for src/b.js" into one
// row — and the row is exactly the command whose body would carry $ARGUMENTS.
export function requestShape(prompt) {
  return firstLine(prompt).toLowerCase()
    .replace(/[`"']/g, "")
    .replace(/\b[\w./-]*\/[\w./-]+\b/g, "<path>")
    .replace(/\b[\w-]+\.[a-z]{1,5}\b/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .replace(/[.!?;,]+$/, "")
    .trim()
    .slice(0, 120);
}

const bump = (map, key, sample) => {
  if (!key) return;
  const row = map.get(key) || { key, count: 0, sample: "", bytes: 0, examples: [] };
  row.count++;
  if (!row.sample) row.sample = sample?.at || "";
  if (sample?.text && row.examples.length < 3 && !row.examples.includes(sample.text)) row.examples.push(sample.text);
  if (sample?.bytes) row.bytes += sample.bytes;
  map.set(key, row);
};

export function readSessionEvidence(file, { approvals = new Map(), requests = new Map(), reads = new Map() } = {}) {
  const id = path.basename(file).replace(/\.jsonl$/, "");
  const calls = new Map();      // itemId → the merged tool_call (state updates are partial items)
  const pendingReads = new Map();
  const seen = new Set();
  let turns = 0; let startedAt = 0;
  eachLine(file, line => {
    if (!line.trim()) return;
    let row; try { row = JSON.parse(line); } catch { return; }
    if (row.type === "header") { startedAt = num(row.startedAt); return; }
    if (typeof row.seq !== "number" || seen.has(row.seq)) return;      // replay noise, exactly as cost.js drops it
    seen.add(row.seq);
    const at = `${id}:${row.seq}`;
    if (row.type === "turn.start") { turns++; bump(requests, requestShape(row.prompt), { at, text: firstLine(row.prompt).slice(0, 100) }); return; }
    if (row.type === "approval") {
      // Only what the OWNER was stopped for. A policy allow cost nobody a keystroke and proposing a
      // rule for it would be proposing a rule that already exists.
      if (row.by !== "owner" || !["allow", "always"].includes(row.decision)) return;
      const call = calls.get(row.itemId);
      if (call) bump(approvals, allowRule(call.tool, call.input), { at, text: `${call.tool} ${firstLine(JSON.stringify(call.input || {})).slice(0, 70)}` });
      return;
    }
    if (row.type !== "item") return;
    const item = row.item;
    if (item.kind === "tool_call") {
      calls.set(item.id, { ...calls.get(item.id), ...item });
      const merged = calls.get(item.id);
      // A whole-file read is one with no offset and no limit: the model asked for everything there was.
      if (merged.tool === "read_file" && merged.input && !merged.input.offset && !merged.input.limit) pendingReads.set(item.id, { path: String(merged.input.path || ""), at });
    } else if (item.kind === "tool_result") {
      const wanted = pendingReads.get(item.callId);
      if (!wanted || !item.ok) return;
      pendingReads.delete(item.callId);
      bump(reads, wanted.path, { at: wanted.at, bytes: num(item.bytes) });
    }
  });
  return { id, turns, startedAt, approvals, requests, reads };
}

export function tuneReport(dir, { days = 0, now = Date.now(), limit = 5 } = {}) {
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort(); } catch { files = []; }
  const since = days > 0 ? now - days * 86_400_000 : 0;
  const approvals = new Map(); const requests = new Map(); const reads = new Map();
  let sessions = 0; let turns = 0; let skipped = 0;
  // Counted per session first, then merged: a session outside the window must not leave its rows
  // behind in the totals it is being excluded from.
  const merge = (into, from) => {
    for (const [key, row] of from) {
      const target = into.get(key);
      if (!target) { into.set(key, row); continue; }
      target.count += row.count; target.bytes += row.bytes;
      if (!target.sample) target.sample = row.sample;
      for (const example of row.examples) if (target.examples.length < 3 && !target.examples.includes(example)) target.examples.push(example);
    }
  };
  for (const name of files) {
    let evidence;
    try { evidence = readSessionEvidence(path.join(dir, name)); }
    catch { continue; }                                            // an unreadable log is never fatal
    if (since && evidence.startedAt && evidence.startedAt < since) { skipped++; continue; }
    sessions++; turns += evidence.turns;
    merge(approvals, evidence.approvals); merge(requests, evidence.requests); merge(reads, evidence.reads);
  }
  const rank = (map, min) => [...map.values()].filter(row => row.count >= min).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, limit);
  const bigReads = [...reads.values()].filter(row => row.count >= MIN_WHOLE_READS && row.bytes / row.count >= BIG_FILE_BYTES);
  return {
    dir, days, sessions, turns, skipped,
    approvals: rank(approvals, MIN_APPROVALS),
    requests: rank(requests, MIN_REPEATS),
    reads: bigReads.sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key)).slice(0, limit),
    thin: { approvals: approvals.size, requests: requests.size, reads: reads.size },
  };
}

// The name is a guess and is meant to be edited, but a guess made of "run-the" is not worth typing:
// the filler words are what two different requests have in common, so they are exactly what to drop.
const FILLER = new Set(["the", "and", "for", "with", "into", "from", "then", "that", "this", "all", "any", "our", "its", "out", "please", "just", "also", "again"]);
const suggestName = shape => (shape.split(" ").filter(word => /^[a-z][a-z-]{2,}$/.test(word) && !FILLER.has(word)).slice(0, 2).join("-") || "routine").slice(0, 24);
const kb = bytes => `${Math.round(bytes / 1000)}KB`;

export function formatTune(report) {
  const scope = report.days ? `started in the last ${report.days} day${report.days === 1 ? "" : "s"}` : "all saved sessions";
  const lines = [`tune — ${report.sessions} session${report.sessions === 1 ? "" : "s"} · ${report.turns} turn${report.turns === 1 ? "" : "s"} · ${scope}`,
    "Proposals only. hcode changed nothing; every row says how often it happened and where to look.", ""];
  if (!report.sessions || report.turns < 3) {
    lines.push(`Not enough history to propose anything yet (${report.sessions} session(s), ${report.turns} turn(s) in ${report.dir}).`,
      "Come back after a few real sessions — a suggestion from one afternoon would be a guess with a number next to it.");
    return lines.join("\n");
  }

  lines.push("1. Approvals you keep granting → .hcode/policy.json allow rules");
  if (report.approvals.length) {
    for (const row of report.approvals) lines.push(`   ${String(row.count).padStart(3)}×  "${row.key}"`, `        e.g. ${row.examples[0] || ""}  (${row.sample})`);
    lines.push(`   add to .hcode/policy.json: {"allow": [${report.approvals.map(row => JSON.stringify(row.key)).join(", ")}]}`);
  } else lines.push(`   nothing was approved ${MIN_APPROVALS}+ times the same way (${report.thin.approvals} distinct owner approval shape(s) seen) — no rule is warranted yet.`);
  lines.push("");

  lines.push("2. Requests you keep retyping → /command new");
  if (report.requests.length) {
    for (const row of report.requests) {
      lines.push(`   ${String(row.count).padStart(3)}×  ${row.key}`, `        e.g. "${row.examples[0] || ""}"  (${row.sample})`,
        `        /command new ${suggestName(row.key)} <the prompt, with $ARGUMENTS where the ${row.key.includes("<path>") ? "path" : "detail"} goes>`);
    }
  } else lines.push(`   nothing was asked ${MIN_REPEATS}+ times in the same shape (${report.thin.requests} distinct request shape(s) seen) — no command is warranted yet.`);
  lines.push("");

  lines.push("3. Big files read whole → read a range, or delegate the search");
  if (report.reads.length) {
    for (const row of report.reads) lines.push(`   ${String(row.count).padStart(3)}×  ${row.key}  ${kb(row.bytes / row.count)} average, ${kb(row.bytes)} total  (${row.sample})`);
    lines.push("   these went into the context whole: ask for an offset/limit range, or send the search to a subagent (/savetoken makes that the default).");
  } else lines.push(`   no file over ${kb(BIG_FILE_BYTES)} was read whole ${MIN_WHOLE_READS}+ times (${report.thin.reads} distinct whole-file read(s) seen) — nothing to trim here.`);

  if (report.skipped) lines.push("", `${report.skipped} older session${report.skipped === 1 ? "" : "s"} outside the window were not read.`);
  return lines.join("\n");
}
