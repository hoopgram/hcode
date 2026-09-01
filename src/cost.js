// `/cost`: what every saved session spent, read back from the append-only logs in ~/.hcode/sessions.
// Two questions only: which of the four classes the money went into, and which session is the whale.
//
// De-duplication is the whole trick. A crash-recovered thread rewrites its tail, so the same
// `turn.end` can appear twice on disk; adding up every line came out ~50% high on a real
// sessions directory. `seq` is what session replay de-duplicates on (session.js load()), and it
// is what this counts on too — first line with a given seq wins, the rest are replay noise.
//
// No dollars: hcode talks to gateways with no published price list, so a $ figure here would be
// invented. The weights below are the shape list prices come in (cache write 1.25× uncached
// input, cache read 0.1×, output 5×) and are printed as *relative* cost units, never as money.
import fs from "node:fs";
import path from "node:path";

export const COST_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
export const costUnits = t => Math.round(t.input * COST_WEIGHTS.input + t.cacheWrite * COST_WEIGHTS.cacheWrite + t.cacheRead * COST_WEIGHTS.cacheRead + t.output * COST_WEIGHTS.output);

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const CHUNK = 1 << 16;

// ---- the live session meter -------------------------------------------------------------------
// What a session is costing should not require the owner to write a statusline script, so the
// composer carries it on the row it already has. Two numbers: how full the context is (the same
// figure the compactor decides on) and what this session has spent so far. Three bands, and the
// top one only *says* /handoff — nothing here ever clears or hands off a conversation by itself.
export const COST_CLASSES = Object.keys(COST_WEIGHTS);
export const METER_BANDS = Object.freeze({ warn: 0.6, danger: 0.8 });
export const meterBand = fraction => fraction >= METER_BANDS.danger ? "danger" : fraction >= METER_BANDS.warn ? "warn" : "calm";
const compact = value => value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(Math.round(value));

// A resumed thread keeps what it already spent. Session events use the compatibility names in/out;
// the live meter uses input/output. One bounded pass over the in-memory event list joins the two.
export function sessionSpend(events = []) {
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const event of events || []) {
    if (event?.type !== "turn.end") continue;
    totals.input += num(event.usage?.input ?? event.usage?.in);
    totals.output += num(event.usage?.output ?? event.usage?.out);
    totals.cacheWrite += num(event.usage?.cacheWrite);
    totals.cacheRead += num(event.usage?.cacheRead);
  }
  return totals;
}

// Dollars only when the owner supplied a price list (config `prices` / HCODE_PRICES, USD per
// million tokens per class); otherwise null and the meter prints relative cost units instead.
export function spendDollars(totals, prices) {
  if (!prices || !totals) return null;
  return COST_CLASSES.reduce((sum, key) => sum + num(totals[key]) * (num(prices[key]) / 1e6), 0);
}

export function formatSpend(totals, prices) {
  const money = spendDollars(totals, prices);
  if (money === null) return `${compact(costUnits(totals))} cu`;
  return money >= 0.01 || money === 0 ? `$${money.toFixed(2)}` : `$${money.toFixed(4)}`;
}

// { text, band, fraction } — the composer only decides which colour a band gets and where the text
// sits; every number and every word is decided here, where it can be tested without a terminal.
export function contextMeter({ tokens = 0, window = 0, spend = null, prices = null, model = "", effort = "", sessionMode = "", permission = "" } = {}) {
  const carried = Math.max(0, num(tokens));
  const budget = Math.max(0, num(window));
  const fraction = budget > 0 ? carried / budget : 0;
  const band = budget > 0 ? meterBand(fraction) : "calm";
  const spentTokens = spend ? COST_CLASSES.reduce((sum, key) => sum + num(spend[key]), 0) : 0;
  const left = Math.max(0, 100 - Math.round(fraction * 100));
  const parts = [`↓ ${compact(spentTokens)} tokens`, budget > 0 ? `Context ${left}% left · ${compact(carried)}/${compact(budget)}` : `Context ${compact(carried)}`];
  if (spend) parts.push(formatSpend(spend, prices));
  if (band === "danger") parts.push("/handoff");
  const identity = { model: String(model || ""), effort: String(effort || ""), sessionMode: String(sessionMode || ""), permission: String(permission || "") };
  return { text: parts.join(" · "), identity, band, fraction };
}

// One pass, one 64K buffer, one line at a time: a session file carries whole tool outputs, and
// nothing here needs them. Only lines that can be a header or a turn.end are ever JSON.parsed.
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
  if (rest) onLine(rest);          // a killed writer left half a line: still offered, still tolerated
}

export function readSessionCost(file) {
  const s = { id: path.basename(file).replace(/\.jsonl$/, ""), startedAt: 0, endedAt: 0, turns: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, peak: 0, corrupt: 0 };
  const seen = new Set();
  eachLine(file, line => {
    if (!line || (!line.includes("turn.end") && !line.includes("header"))) return;   // the rest cannot carry usage
    let row; try { row = JSON.parse(line); } catch { s.corrupt++; return; }
    if (row.type === "header" && row.v === 2) { s.startedAt = num(row.startedAt) || s.startedAt; return; }
    if (row.header) { s.startedAt = Date.parse(row.startedAt) || s.startedAt; return; }   // 0.1.0 file
    if (row.type !== "turn.end" || typeof row.seq !== "number" || seen.has(row.seq)) return;
    seen.add(row.seq);
    const u = row.usage || {};
    const input = num(u.in), output = num(u.out), cacheWrite = num(u.cacheWrite), cacheRead = num(u.cacheRead);   // pre-0.5 turns carry {in,out} only
    s.turns++; s.input += input; s.output += output; s.cacheWrite += cacheWrite; s.cacheRead += cacheRead;
    s.peak = Math.max(s.peak, input + cacheWrite + cacheRead);                    // what the brain actually billed as prompt that turn
    const ts = num(row.ts);
    if (ts) { s.endedAt = Math.max(s.endedAt, ts); if (!s.startedAt) s.startedAt = ts; }
  });
  s.units = costUnits(s);
  return s;
}

// days > 0 keeps sessions that started within that window (a session with no readable start time stays).
export function scanCosts(dir, { days = 0, now = Date.now() } = {}) {
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort(); } catch { files = []; }
  const since = days > 0 ? now - days * 86_400_000 : 0;
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const sessions = []; let turns = 0, corrupt = 0, skipped = 0;
  for (const name of files) {
    let s; try { s = readSessionCost(path.join(dir, name)); } catch { corrupt++; continue; }   // unreadable file: never fatal
    if (since && s.startedAt && s.startedAt < since) { skipped++; continue; }
    corrupt += s.corrupt; turns += s.turns;
    for (const key of Object.keys(totals)) totals[key] += s[key];
    sessions.push(s);
  }
  sessions.sort((a, b) => b.units - a.units || a.id.localeCompare(b.id));
  return { dir, days, sessions, totals: { ...totals, units: costUnits(totals) }, turns, corrupt, skipped };
}

const group = value => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// 20260830123456-1a2b → 20260830-1a2b: the day and the tail are what the owner recognises.
export const shortSessionId = id => {
  const m = /^(\d{8})\d{6}(-[0-9a-f]+)$/.exec(id);
  return m ? m[1] + m[2] : (id.length > 18 ? id.slice(0, 17) + "…" : id);
};

export function formatCost(report, { top = 10 } = {}) {
  const scope = report.days ? `started in the last ${report.days} day${report.days === 1 ? "" : "s"}` : "all saved sessions";
  const head = `cost — ${report.sessions.length} session${report.sessions.length === 1 ? "" : "s"} · ${report.turns} turn${report.turns === 1 ? "" : "s"} · ${scope}`;
  if (!report.sessions.length) return `${head}\n(nothing recorded in ${report.dir})`;
  const t = report.totals;
  const lines = [head];
  for (const [label, value] of [["input (uncached)", t.input], ["cache write", t.cacheWrite], ["cache read", t.cacheRead], ["output", t.output]]) lines.push(`  ${label.padEnd(17)}${group(value).padStart(13)}`);
  lines.push(`  ${"cost units".padEnd(17)}${group(t.units).padStart(13)}   relative weights, not dollars: uncached 1 · cache write ${COST_WEIGHTS.cacheWrite} · cache read ${COST_WEIGHTS.cacheRead} · output ${COST_WEIGHTS.output}`);
  const whales = report.sessions.slice(0, top);
  lines.push("", `whales — ${whales.length === report.sessions.length ? "every session" : `the ${whales.length} biggest sessions`} by cost units (peak ctx = the largest prompt one turn carried)`);
  lines.push(`  ${"session".padEnd(16)}${"turns".padStart(6)}${"peak ctx".padStart(12)}${"cache read".padStart(14)}${"cost units".padStart(14)}`);
  for (const s of whales) lines.push(`  ${shortSessionId(s.id).padEnd(16)}${String(s.turns).padStart(6)}${group(s.peak).padStart(12)}${group(s.cacheRead).padStart(14)}${group(s.units).padStart(14)}`);
  const notes = [];
  if (report.skipped) notes.push(`${report.skipped} older session${report.skipped === 1 ? "" : "s"} outside the window`);
  if (report.corrupt) notes.push(`${report.corrupt} unreadable line${report.corrupt === 1 ? "" : "s"} skipped`);
  if (notes.length) lines.push("", notes.join(" · "));
  return lines.join("\n");
}
