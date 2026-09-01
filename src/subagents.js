// Subagents (0.7 B): which brain a helper may run on, and how the owner looks inside one.
//
// Three rules live here, in one place, so the model-facing tool and the owner's slash commands cannot
// drift apart:
//   1. a subagent never inherits the foreign CLI's own default brain. Every spawn names its model and
//      records it in the child ledger, so a thread can always be asked what a helper was run on;
//   2. that name comes from the caller (model) or from the tier the caller declared for the work
//      (search → smallest, mechanical → middle, implement → largest). Nothing is guessed;
//   3. a flagship brain — the class the coordinator itself runs on — is refused as a helper unless the
//      call names it on purpose. A helper that costs what the coordinator costs is not a delegation.
// Every refusal carries the exact way to write the call instead; a rule the caller cannot obey is a bug.
// It deliberately imports no runner: the executor is handed in, so the tool contract can name these
// tiers without dragging the spawn machinery into every module that reads a schema.
import path from "node:path";
import { Session, headTail } from "./session.js";

export const SUBAGENT_KINDS = ["search", "mechanical", "implement"];
// Model aliases the owner-installed CLIs accept themselves. Any cell can be replaced from
// .hcode/settings.json or ~/.hcode/config.json — {"subagentModels":{"codex":{"search":"o4-mini"}}} —
// because the installed CLI, and the names it knows, belong to the owner and not to hcode.
// The codex column is the model set the installed CLI actually ships with, checked against
// codex-cli 0.151.0: `gpt-5.6-luna` ("high-throughput, lower-latency work"), `gpt-5.6-terra`
// ("balanced quality, latency, and cost") and `gpt-5.6-sol` ("quality-first flagship, reasoning, and
// difficult coding work"). The 0.7 table named gpt-5.1-codex/-mini/-max, which that CLI now carries
// only as a migration key: a tier that resolves to a model the CLI has retired is worse than no
// default, because the refusal arrives from the foreign process instead of from hcode.
export const SUBAGENT_TIERS = {
  claude: { search: "haiku", mechanical: "sonnet", implement: "opus" },
  codex: { search: "gpt-5.6-luna", mechanical: "gpt-5.6-terra", implement: "gpt-5.6-sol" },
};
// The coordinator class. `fable` is here by name; the brain this very session runs on is added at
// call time, which is what "same class as the coordinator" means when the owner changed brains.
export const FLAGSHIP_MODELS = ["fable", "claude-fable-5"];
export const MODEL_ID = /^[A-Za-z0-9._:/-]{1,120}$/;
export const SUBAGENT_DIR = "subagents";

// Work that is looking rather than building. When a call names neither a brain nor a tier, hcode reads
// the task: if it is searching, scanning, locating or reading output, the smallest tier is taken and said
// out loud. Saving money is the default that needs no argument; spending it stays explicit, so anything
// that does not read as search still refuses and asks the caller to declare what the work is.
const SEARCH_HINTS = /\b(?:search|searching|find|finds|finding|locate|locating|grep|scan|scanning|list|listing|enumerate|survey|inspect|identify|trace|count)\b|\blook\s+(?:for|up|through|at)\b|\bwhere\s+(?:is|are|does)\b|\bwhich\s+(?:file|files|module|function)\b|\b(?:read|check|inspect)\b[\s\S]{0,30}?\b(?:log|logs|output)\b|[搜找扫查阅列举]|定位/i;
export const inferKind = task => (SEARCH_HINTS.test(String(task || "")) ? "search" : "");

const normalize = value => String(value || "").trim().toLowerCase().replace(/^[a-z0-9]+\//, "");
const segments = value => normalize(value).split(/[-._:/]+/).filter(Boolean);
const firstLine = value => String(value ?? "").split("\n").map(line => line.trim()).find(Boolean) || "";

// Merge owner overrides over the built-in table without letting a stray key invent a runner or a tier.
export function subagentTiers(overrides = null) {
  const tiers = Object.fromEntries(Object.entries(SUBAGENT_TIERS).map(([runner, table]) => [runner, { ...table }]));
  for (const [runner, table] of Object.entries(overrides || {})) {
    if (!tiers[runner] || !table || typeof table !== "object") continue;
    for (const kind of SUBAGENT_KINDS) {
      const wanted = String(table[kind] || "").trim();
      if (wanted && MODEL_ID.test(wanted)) tiers[runner][kind] = wanted;
    }
  }
  return tiers;
}

export function isFlagship(model, { coordinator = "", extra = [] } = {}) {
  const want = normalize(model);
  if (!want) return false;
  const banned = [...FLAGSHIP_MODELS, ...extra, ...(coordinator ? [coordinator] : [])].map(normalize).filter(Boolean);
  const parts = segments(want);
  return banned.some(entry => want === entry || parts.includes(entry));
}

// "tool" is what the model writes inside delegate_agent; "command" is what the owner types.
const forms = syntax => syntax === "command"
  ? { model: id => `--model ${id}`, kind: kind => `--kind ${kind}`, flagship: "--allow-flagship" }
  : { model: id => `model:"${id}"`, kind: kind => `kind:"${kind}"`, flagship: "allow_flagship:true" };
const tierHelp = (table, form) => [
  `${form.kind("search")} → ${table.search} (searching, scanning, reading logs)`,
  `${form.kind("mechanical")} → ${table.mechanical} (repetitive edits across known files)`,
  `${form.kind("implement")} → ${table.implement} (designing and writing code)`,
].join(", ");

// Returns {model, kind, source, note}; throws with the exact call to write instead. `source` is "named"
// when the caller chose the brain, "tier" when hcode filled it in from the declared kind of work, "mode"
// when the session had already declared what an unqualified delegation means, and "inferred" when the
// call declared nothing, no mode was set, and the task itself read as search/scan — in which case hcode
// takes the smallest tier and says so, because the cheap answer is the one that should need no argument.
// `defaultKind` is the one way a call may arrive with neither a brain nor a tier and still be a decision
// rather than a guess: a session mode (/savetoken → search) that has already answered the question. It is
// checked **before** the task is read, so the two never argue and the owner is told once, not twice — the
// rule is that nothing inherits the foreign CLI's default, not that the owner must retype the tier once
// they have set it for the session.
export function resolveSubagentModel({ runner, model = "", kind = "", task = "", coordinatorModel = "", allowFlagship = false, tiers = SUBAGENT_TIERS, syntax = "tool", defaultKind = "" }) {
  const table = tiers[runner];
  if (!table) throw new Error(`unknown subagent runner "${runner}" (${Object.keys(tiers).join("|")})`);
  const form = forms(syntax);
  const named = String(model || "").trim();
  let wanted = String(kind || "").trim().toLowerCase();
  let fromMode = false;
  if (!named && !wanted && SUBAGENT_KINDS.includes(String(defaultKind).toLowerCase())) { wanted = String(defaultKind).toLowerCase(); fromMode = true; }
  if (!named && !wanted) {
    // Looking is cheap by default. Building still has to be asked for: an undeclared implementation task
    // must not quietly take the biggest brain, and it must not quietly take the smallest one either.
    const inferred = inferKind(task);
    if (inferred) return { model: table[inferred], kind: inferred, source: "inferred",
      note: `this reads as ${inferred} work, so hcode took the smallest tier (${table[inferred]}); a bigger brain is explicit — ${form.kind("implement")} or ${form.model(table.implement)}` };
    throw new Error(`refused: a ${runner} subagent needs its brain named in the call. Either name it — ${form.model(table.mechanical)}, or any model id the ${runner} CLI accepts — or declare the work and take that tier: ${tierHelp(table, form)}. hcode never lets a subagent inherit the CLI's own default.`);
  }
  if (!named && !SUBAGENT_KINDS.includes(wanted)) {
    throw new Error(`refused: kind must be one of ${SUBAGENT_KINDS.join("|")} for a ${runner} subagent — ${tierHelp(table, form)}.`);
  }
  if (named && !MODEL_ID.test(named)) throw new Error(`refused: "${named.slice(0, 60)}" is not a model id (letters, digits, dot, underscore, colon, slash, dash; 120 characters).`);
  const resolved = named || table[wanted];
  if (!allowFlagship && isFlagship(resolved, { coordinator: coordinatorModel })) {
    const same = normalize(resolved) === normalize(coordinatorModel);
    throw new Error(`refused: "${resolved}" is a flagship brain${same ? " — the very class this coordinator runs on" : ""}, and hcode does not spend one on a subagent. Take a tier instead: ${tierHelp(table, form)}. If the owner asked for that brain by name, repeat the call with ${form.flagship}.`);
  }
  return { model: resolved, kind: SUBAGENT_KINDS.includes(wanted) ? wanted : "", source: named ? "named" : fromMode ? "mode" : "tier" };
}

// Leading flags on an owner-typed delegation line: `/claude --kind search find the parser`.
// Parsing stops at the first word that is not a flag, so a prompt may contain dashes freely.
export function parseDelegateFlags(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const out = { model: "", kind: "", agent: "", allowFlagship: false, prompt: "" };
  let i = 0;
  for (; i < words.length; i++) {
    const word = words[i];
    const value = () => { const next = words[i + 1]; if (!next || next.startsWith("-")) throw new Error(`${word} needs a value`); i++; return next; };
    if (word === "--model" || word === "-m") out.model = value();
    else if (word === "--kind" || word === "-k") out.kind = value();
    else if (word === "--agent" || word === "-a") out.agent = value();
    else if (word === "--allow-flagship") out.allowFlagship = true;
    else break;
  }
  out.prompt = words.slice(i).join(" ");
  return out;
}

// ---- the child ledger -------------------------------------------------------------------------------
// child.spawn / child.report / child.merge are already the append-only record of every helper this
// thread started (session.js). This folds them into one row per child for /attach.
export function childLedger(session) {
  const rows = new Map();
  for (const event of session.events || []) {
    if (event.type === "child.spawn") {
      rows.set(event.childId, { childId: event.childId, runner: event.runner, model: event.model || "", task: event.task || "",
        cwd: event.cwd || "", session: event.session || "", status: "running", summary: "", usage: { in: 0, out: 0 },
        startedAt: event.ts, endedAt: 0, outcome: "", files: [] });
    } else if (event.type === "child.report") {
      const row = rows.get(event.childId); if (!row) continue;
      row.status = event.status; row.summary = event.summary || ""; row.usage = event.usage || row.usage; row.endedAt = event.ts;
    } else if (event.type === "child.merge") {
      const row = rows.get(event.childId); if (!row) continue;
      row.outcome = event.outcome; row.files = event.files || [];
    }
  }
  return [...rows.values()];
}

const age = (ts, now) => `${Math.max(0, Math.round((now - ts) / 1000))}s ago`;

export function childSummary(row, { now = Date.now() } = {}) {
  return `${row.childId}  ${String(row.runner).padEnd(6)}  ${String(row.model || "?").padEnd(20)}  ${String(row.status).padEnd(8)}  ${age(row.endedAt || row.startedAt, now)}  ${firstLine(row.task).slice(0, 60)}`;
}

// The /attach index: this thread's own helpers first, then the detached background conversations.
export function formatSubagents({ children = [], tasks = [], now = Date.now() } = {}) {
  const rows = [];
  if (children.length) rows.push("Subagents of this session", ...children.map(child => "  " + childSummary(child, { now })));
  if (tasks.length) rows.push(...(rows.length ? [""] : []), "Background conversations", ...tasks.map(line => "  " + line));
  if (!rows.length) return "No subagents yet. /claude and /codex start a background conversation, /btw asks one aside question.";
  rows.push("", "/attach <id> opens one; /task <task-id> <message> continues a background conversation.");
  return rows.join("\n");
}

// A subagent thread is an ordinary v2 thread, so its transcript is read back the same way the owner's is.
export function childTranscript(session, { max = 12000 } = {}) {
  const lines = [];
  for (const event of session.events || []) {
    if (event.type === "turn.start") lines.push(`> ${firstLine(event.prompt).slice(0, 400)}`);
    else if (event.type === "error") lines.push(`! ${event.code}: ${firstLine(event.message).slice(0, 200)}`);
    else if (event.type !== "item") continue;
    else if (event.item.kind === "message" && event.item.role === "assistant") {
      const text = (Array.isArray(event.item.content) ? event.item.content.filter(block => block.type === "text").map(block => block.text).join("") : String(event.item.content)).trim();
      if (text) lines.push(text);
    } else if (event.item.kind === "tool_call" && event.item.state === "running") {
      lines.push(`· ${event.item.tool} ${firstLine(JSON.stringify(event.item.input || {})).slice(0, 120)}`);
    }
  }
  return lines.length ? headTail(lines.join("\n"), max, "transcript characters").text : "(this subagent wrote nothing to its thread)";
}

// /attach <c-…>: the ledger row plus, when the spawn recorded one, the subagent's own thread.
export function openChild(row, { dir, open = (base, id) => new Session(base, id) } = {}) {
  const head = [
    `${row.childId} · ${row.runner}${row.model ? " " + row.model : ""} · ${row.status}${row.usage?.in || row.usage?.out ? ` · ${row.usage.in} in / ${row.usage.out} out` : ""}`,
    `task: ${firstLine(row.task).slice(0, 300)}`,
  ];
  if (!row.session) return [...head, "", "(no thread was recorded for this subagent; it ran before hcode kept subagent transcripts)"].join("\n");
  let transcript;
  try { transcript = childTranscript(open(dir, row.session)); }
  catch (error) { return [...head, "", `(its thread ${row.session} could not be read: ${error.message})`].join("\n"); }
  return [...head, `thread: ${row.session}`, "", transcript, "", "Read-only. A one-off subagent does not take further messages; /claude or /codex start one that does."].join("\n");
}

// ---- /btw: one aside question ------------------------------------------------------------------------
// The answer is shown to the owner and recorded in the child ledger, and it never enters the coordinator's
// message list — that is the whole point: a side question must not buy itself a seat in every later prompt.
export const ASIDE_SYSTEM = "You are a one-off aside for Hoop Code's owner. Answer the single question asked, from this workspace, read-only. Do not modify files, use the network, seek secrets, or continue the owner's main conversation. Be brief and concrete; say plainly when you do not know.";

export async function askAside({ cfg, policy, session, runner, question, model = "", kind = "search", allowFlagship = false, tiers = SUBAGENT_TIERS, signal = null, onText = null, run, env = process.env }) {
  const asked = String(question || "").trim();
  if (!asked) throw new Error("/btw needs a question");
  if (typeof run !== "function") throw new Error("askAside needs a runner to execute with");
  const chosen = resolveSubagentModel({ runner, model, kind, coordinatorModel: cfg.model, allowFlagship, tiers, syntax: "command" });
  const dir = path.join(cfg.sessionsDir, SUBAGENT_DIR);
  const thread = new Session(dir, null, { cwd: cfg.cwd, runner, model: chosen.model, effort: cfg.effort });
  const spawned = session.childSpawn({ runner, task: asked, cwd: cfg.cwd, model: chosen.model, session: thread.id, policy: { mode: "read", sandbox: policy?.sandbox || "auto" } });
  try {
    const result = await run({
      id: runner,
      cfg: { ...cfg, runner, mode: "read", runnerModel: chosen.model, runnerPromptViaStdin: true },
      policy: { ...policy, mode: "read", network: { default: "off", allow: [] } },
      session: thread, prompt: asked, system: ASIDE_SYSTEM, signal, onText, env, allowUnsafeWorkspace: true,
    });
    // An abort resolves rather than throws (runners.js settles the cancelled run), so the aside has
    // to read it off the result: a cancelled child must never be filed as a completed one.
    const cancelled = Boolean(result.cancelled || signal?.aborted);
    session.childReport({ childId: spawned.childId, status: cancelled ? "cancelled" : "done", summary: String(result.text || "").slice(0, 4000), usage: { in: result.usage.input, out: result.usage.output } });
    return { text: result.text, cancelled, model: chosen.model, childId: spawned.childId, session: thread.id, usage: result.usage };
  } catch (error) {
    session.childReport({ childId: spawned.childId, status: signal?.aborted ? "cancelled" : "failed", summary: String(error.message).slice(0, 4000) });
    throw error;
  }
}
