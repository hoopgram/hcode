// `hcode doctor`: plain language. Where the config comes from, whether the brain answers (and if not, the two
// ways out), whether the sandbox is real, what the policy says, which runners exist. Never prints a key.
import fs from "node:fs";
import path from "node:path";
import { HOME, ON_HOOP, VERSION, keySource, DIRECT_RUNNER } from "./config.js";
import { projectContext } from "./agent.js";
import { loadPolicy } from "./policy.js";
import * as sandbox from "./sandbox.js";
import { loadSkills } from "./skills.js";
import { externalWrites, listRunners } from "./runners.js";
import { explainApiError, postJson } from "./api.js";
import { brainDownHint, hoopHost, openTunnel as realOpenTunnel, portListening, probeBrain } from "./connect.js";
import { color } from "./ui.js";
import { openWork } from "./work.js";
import { supervisorState } from "./supervise.js";
import { auditFile, loadRegistry, readAudit, registryFile } from "./guard.js";

export async function doctor(cfg, { cli = {}, json = false, probe = true, write = value => console.log(value), openTunnel = realOpenTunnel } = {}) {
  const rows = [];
  const ok = (name, good, detail, warn = false) => rows.push({ name, ok: Boolean(good), warn, detail });
  const major = Number(process.versions.node.split(".")[0]);
  ok("node", major >= 20, `${process.version}` + (major >= 20 ? "" : " — hcode needs Node 20 or newer"));
  ok("hcode", true, `${VERSION} · ${ON_HOOP ? "running on a Hoop" : "running on your computer"}`);
  // A remembered SSH-tunnel Hoop (`hcode connect <name>`, no HoopGram device session) isn't
  // dialed by `hcode doctor` itself, so cfg.baseUrl is still whatever untouched default it
  // loaded with — showing that instead of the tunnel URL a real run would use is misleading.
  const tunnelMode = cfg.runner === "hcode" && Boolean(cfg.defaultHoop) && cfg.authKind !== "hoopgram-device";
  const tunnelPort = Number(cli.port) || 18092;
  let tunnelHost = cfg.defaultHoop;
  if (tunnelMode) { try { tunnelHost = hoopHost(cfg.defaultHoop); } catch { /* keep raw name; shown as-is below */ } }
  const brainUrl = tunnelMode ? `http://127.0.0.1:${tunnelPort}` : cfg.baseUrl;
  ok("brain url", /^https?:\/\//.test(brainUrl), tunnelMode ? `${brainUrl} (tunnel to ${tunnelHost}:8092)` : brainUrl);
  const src = keySource(cli);
  // In tunnel mode the provider key lives on the Hoop, not here — `hcode connect <hoop>` (or
  // plain `hcode`'s remembered path) opens the tunnel per session and the brain behind it holds
  // the real key. Only flag a real problem: no key AND no Hoop to fall back on.
  // With an external runner doing the turns, hcode makes no model call of its own: no key is not a
  // fault here, and saying "the brain will refuse" would be false. `--runner direct` is what needs one.
  const externalRuns = cfg.runner !== DIRECT_RUNNER;
  const ownBrainUnused = externalRuns && !cfg.apiKey && !cfg.defaultHoop;
  ok("key", Boolean(cfg.apiKey) || Boolean(cfg.defaultHoop) || externalRuns,
    ownBrainUnused ? `none — and none needed while ${cfg.runner} runs the turns (\`--runner direct\` is what would use one)`
    : !cfg.apiKey && !cfg.defaultHoop ? "none set — the brain will refuse. Set ANTHROPIC_API_KEY / HCODE_API_KEY, or run `hcode connect <hoop>`"
    : !cfg.apiKey ? `held by the Hoop (${tunnelHost}) — nothing stored locally`
    : cfg.authKind === "hoopgram-device" ? "revocable HoopGram device session; the provider key stays on the Hoop"
    : cfg.apiKey === "gram-local" ? "your Hoop's keyproxy holds the real key; it never leaves the Hoop" : `set (from ${src || "config"}); never shown or logged`);
  ok("model", Boolean(cfg.model), cfg.model);
  const effort = cfg.effort || "high";
  ok("effort", ["low", "medium", "high"].includes(effort), `${effort} · portable tier shared with Codex and Claude Code`);
  const policy = loadPolicy(cfg.cwd);
  ok("mode", true, `${cfg.mode}` + (cfg.mode === "all" ? " — Full Agency; fixed secret, money, publication, deletion and owner-intent gates remain" : cfg.mode === "auto" ? " — writes and commands run without asking (Bash network still off unless allowed)" : cfg.mode === "read" ? " — nothing is written, no commands or public search" : " — every write/command and public query is confirmed by you"));
  ok("policy", !policy.problems.length, policy.fromFile ? `${path.relative(cfg.cwd, policy.file)} · network ${policy.network.default}${policy.network.allow.length ? " (allowed: " + policy.network.allow.join(", ") + ")" : ""} · ${policy.allow.length} allow rule(s)` + (policy.problems.length ? " · problems: " + policy.problems.join("; ") : "")
    : "none (.hcode/policy.json) — defaults: network off, sandbox auto");
  // The selected Codex path does not use hcode's host shell adapter at all: boundedArgs always
  // supplies Codex's own --sandbox, and never the dangerous bypass flag. Report the confinement
  // that will actually execute this session instead of failing doctor because an unused local
  // systemd-run/bwrap probe is degraded. Claude's permission mode is not an OS sandbox, so it does
  // not receive this equivalence and still reports the host adapter honestly.
  const codexSandbox = cfg.runner === "codex";
  const sb = codexSandbox ? { want: "codex", adapter: "codex", degraded: false, reason: "" } : sandbox.detect(policy.sandbox);
  const sbDetail = codexSandbox
    ? `codex --sandbox ${externalWrites(cfg.mode, cfg.agencyLevel) ? "workspace-write" : "read-only"} (dangerous bypass absent; network follows policy)`
    : sandbox.describe(sb);
  ok("sandbox", !sb.degraded, sbDetail, false);
  try { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.accessSync(HOME, fs.constants.W_OK); ok("home", true, HOME); } catch (e) { ok("home", false, `${HOME}: ${e.message}`); }
  try { fs.mkdirSync(cfg.sessionsDir, { recursive: true, mode: 0o700 }); fs.accessSync(cfg.sessionsDir, fs.constants.W_OK); ok("sessions", true, `${cfg.sessionsDir} (event stream v2; 0.1.0 sessions still open)`); } catch (e) { ok("sessions", false, `${cfg.sessionsDir}: ${e.message}`); }
  try { fs.accessSync(cfg.cwd, fs.constants.W_OK); ok("project", true, cfg.cwd + (fs.existsSync(path.join(cfg.cwd, ".git")) ? " (git)" : "")); } catch { ok("project", false, `${cfg.cwd} is not writable`); }
  const ctx = projectContext(cfg.cwd);
  ok("instructions", true, ctx ? `${ctx.length} chars from ${["HCODE.md", "AGENTS.md", "CLAUDE.md"].filter(f => fs.existsSync(path.join(cfg.cwd, f))).join(", ")}` : "none (HCODE.md / AGENTS.md / CLAUDE.md)");
  const skills = loadSkills(cfg.cwd);
  ok("skills", true, skills.length ? skills.map(s => s.name).join(", ") : "none (.hcode/skills/<name>/SKILL.md)");
  ok("budget", cfg.tokenBudget >= 4000, `${cfg.tokenBudget} tokens before automatic compaction`);
  const runners = listRunners();
  ok("runners", true, `${cfg.runner === DIRECT_RUNNER ? "direct" : cfg.runner} runs this session (${cfg.runnerExplicit ? "your choice" : "first one installed; --runner direct pins hcode's own call"}) · `
    + runners.map(r => (r.id === DIRECT_RUNNER ? "direct" : r.id) + (r.id === DIRECT_RUNNER ? "" : r.enabled ? (r.available ? " [available]" : " [not installed]") : " [removed]")).join(" / "));
  const work = openWork(cfg.cwd);
  const supervisor = work ? supervisorState(work) : { running: false };
  ok("supervisor", true, work ? `${supervisor.running ? `running (pid ${supervisor.pid})` : "not running"} · ${work.id} · ${work.state.status}` : "no coordinated work");
  try { const registry = loadRegistry(registryFile()); const last = readAudit(auditFile()).at(-1); ok("guard", true, `${registry.sessions.length} registered · ${last ? `last ${new Date(last.ts).toISOString()} ${last.session}/${last.action}` : "never run"}`); }
  catch { ok("guard", true, "not configured (guard/registry.json)"); }
  // reachability: a 1-token message is the only universal probe (keyproxy has no /v1/models).
  // Always aimed at the URL a real run would use — in tunnel mode that is the local tunnel end
  // (the Hoop's keyproxy holds the key), never cfg.baseUrl's untouched default.
  const pingBrain = async url => {
    const t0 = Date.now();
    try {
      const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      if (cfg.apiKey) { headers["x-api-key"] = cfg.apiKey; headers.authorization = `Bearer ${cfg.apiKey}`; }
      // the same transport the agent uses (node:http, one deadline) so doctor tells the truth about slow brains too
      const res = await postJson({ ...cfg, baseUrl: url }, "/v1/messages", { model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }, { headers, timeoutMs: 30000 });
      const body = await res.text();
      ok("brain", res.ok, res.ok ? `answers (${res.status} in ${Date.now() - t0} ms)${tunnelMode ? " through the tunnel" : ""}` : explainApiError(res.status, body));
    } catch (e) {
      ok("brain", false, e.code === "timeout" ? `${url} did not answer a one-token ping in 30 s — the brain is up but very slow or very busy (a small local model on a small Hoop can be); a real task will need HCODE_TIMEOUT_MS room`
        : `${e.code === "unreachable" ? e.message.replace(/ — run .*$/, "") : `cannot reach ${url} (${e.message})`}. ${tunnelMode ? `Is the brain (keyproxy) running on ${tunnelHost}?` : "Is the URL right? On a Hoop the keyproxy must be running; elsewhere check your network or use `hcode connect <hoop>`"}`);
    }
  };
  const notProbed = reason => ok("brain", false, `not probed — ${reason}`);
  if (tunnelMode) {
    if (!probe) {
      ok("tunnel", false, "skipped (--no-probe)");
    } else if (await portListening(tunnelPort)) {
      const alive = await probeBrain(brainUrl);
      ok("tunnel", alive, alive ? `127.0.0.1:${tunnelPort} is up and the brain behind it answers` : brainDownHint(tunnelHost, cli.user || "gram", 8092));
      if (alive) await pingBrain(brainUrl); else notProbed("the tunnel above is not answering");
    } else {
      // Nothing local yet — open the same on-demand tunnel plain `hcode` would (identical
      // openTunnel() path, stdio-bridge fallback included), so doctor answers the question a
      // user actually has ("would `hcode` work right now?") instead of a stale port check.
      // Never leave an ssh child behind: always close what we opened here.
      let opened = null;
      try {
        opened = await openTunnel({ name: cfg.defaultHoop, user: cli.user || "gram", localPort: tunnelPort, hoopLocalPort: cli.hoopPort, identity: cli.identity, autoPort: cli.port === undefined && cli.hoopPort === undefined });
        ok("tunnel", opened.brainAlive,
          opened.brainAlive ? `opened on demand to ${tunnelHost}:${opened.remotePort} and the brain answers${opened.viaBridge ? " (via ssh stdio bridge)" : ""}`
          : opened.hint || brainDownHint(tunnelHost, cli.user || "gram", 8092));
        // ping while the on-demand tunnel is still open, through the local end it actually chose
        if (opened.brainAlive) await pingBrain(opened.baseUrl || brainUrl); else notProbed("the tunnel above is not answering");
      } catch (e) {
        ok("tunnel", false, `could not open a tunnel to ${tunnelHost}: ${e.message}`);
        notProbed("no tunnel");
      } finally {
        if (opened) await opened.close();
      }
    }
  } else if (ownBrainUnused) ok("brain", true, `not probed and not needed — ${cfg.runner} runs the turns on this machine`);
  else if (probe) await pingBrain(cfg.baseUrl);
  if (json) { write(JSON.stringify({ ok: rows.every(r => r.ok), rows, sandboxDegraded: sb.degraded }, null, 2)); return rows.every(r => r.ok) ? 0 : 1; }
  for (const r of rows) write(`${r.ok ? color.green("[ok]") : color.red("[failed]")} ${r.name.padEnd(13)} ${r.ok ? r.detail : color.red(r.detail)}`);
  const bad = rows.filter(r => !r.ok);
  if (bad.length) write(color.dim(`\n${bad.length} thing(s) need attention (marked [failed] above).`));
  else write(color.dim("\neverything is in place."));
  return bad.length ? 1 : 0;
}
