// The one-shot subcommands: each group answers from what is already on disk, returns an exit code,
// and never opens a session. A group returns null when the invocation was not one of its verbs, so
// the order these are consulted in IS the command surface — do not reorder them.
import fs from "node:fs";
import path from "node:path";
import { VERSION, HOME } from "./config.js";
import { getJson } from "./api.js";
import { openTunnel } from "./connect.js";
import { Session } from "./session.js";
import { scanCosts, formatCost } from "./cost.js";
import { doctor } from "./doctor.js";
import { runMemory } from "./memory.js";
import { loadPolicy } from "./policy.js";
import { TOOL_CONTRACT } from "./tools.js";
import { listRunners, removeRunner, addRunner, assertSafeExternalWorkspace } from "./runners.js";
import { brainChoices, needsBrainSetup, saveDefaultHoop, forgetDefaultHoop } from "./brain.js";
import { startTask, sendTask, stopTask, readTask, listTasks, taskTranscript, taskSummary, runTaskWorker } from "./tasks.js";
import { locateInstallRoot, rollbackNative, runNativeUpdate, runUpdate, runUpdateWorker } from "./update.js";
import { loginHoop, logoutHoop, describeHoopSession } from "./auth.js";
import * as sandbox from "./sandbox.js";
import { ui, color } from "./ui.js";
import { TerminalComposer } from "./composer.js";
import { commandsHelp } from "./commands.js";
import { formatTune, tuneReport } from "./tune.js";
import { listMcpConnectors, connectorsTable } from "./connectors.js";
import { benchmarkManifest, runBenchmark, formatBenchmark } from "./benchmark.js";
import { runPolyglot, formatPolyglot } from "./polyglot.js";
import { openWork, latestWorkId, runApprovedWork, formatWork } from "./work.js";
import { decideGate, formatGates, launchSupervisor, runSupervisorWorker, stopSupervisor, writeWorkStatus } from "./supervise.js";
import { brainVerdicts, guardOnce, guardStatus, loadRegistry, parseInterval, readAudit, registryFile } from "./guard.js";
import { reclaimSnapshots, formatReclaim } from "./rewind.js";
import { decideEscalation, loadAgencyCanon } from "./agency.js";
import { installNativeCandidate } from "./native-install.js";
import { isNativeRuntime } from "./runtime.js";
import { prompter, setupPrompter, chooseBrain } from "./cli-prompts.js";

// A function, not a constant: the owner's own commands join the catalog while a session is running.
export const helpText = () => `○ Welcome to Hoop ${VERSION} — self-contained AI coding agent (zero third-party runtime packages)

usage: hcode [options] ["task"]
       hcode -p "task"                 non-interactive; prints the answer, exit code 0/1
       hcode --resume [session-id]     continue a session (hcode --resume list → recent sessions)
       hcode --agency <0-9> [task]     owner-selected agency; 8 is non-financial Full Agency
       hcode agency codex|claude       launch that CLI with full access + the same agency preamble
       hcode connect <hoop> [task]     connect once and remember this Hoop for future plain hcode
       hcode login <hoop>              sign in through hoopgram.ai; provider keys stay on the server
       hcode logout [hoop]             revoke this machine's HoopGram session
       hcode account [hoop]            HoopGram account, entitlement, session expiry, connection source (never a token)
       hcode quota                     spend pool + each provider's quota bucket; UNOBSERVED is printed as UNOBSERVED, never guessed
       hcode status [hoop]             workspace + brain + the same account facts as hcode account
       hcode setup                     connect the hcode coordinator through HoopGram, API, or your own Hoop
       hcode doctor [--json]           check config, brain, sandbox, policy, runners — in plain words
       hcode update                    update the current channel atomically (native release or source fast-forward)
       hcode rollback                  switch a native install to its previous verified version
       hcode demo                      render one scripted turn (no brain, no ssh) to look at the dialog shape
       hcode sessions [--reclaim]      list recent sessions (--reclaim frees snapshot blobs no thread names)
       hcode cost [--days N]           token use across every saved session: four classes, then the biggest sessions
       hcode tune [--days N]           what your own session history argues for: allow rules, commands, reads to trim
       hcode tools [--json]            the tool contract: schema, risk, idempotent
       hcode benchmark [--live]        fixed public quality, context, coordination and resource benchmark
       hcode mcp list [--json]         list Codex and Claude MCP connectors without reading their config
       hcode runner list|add|remove <id>   external runners (claude, codex) you installed yourself
       hcode task start claude|codex "task"  start a persistent background conversation (needs --agent-model or --kind)
       hcode task list|show|send|stop        inspect, continue, or stop background conversations
       hcode work status|supervise           inspect or supervise durable coordinated work
       hcode gate list|approve|reject        decide an append-only owner gate
       hcode guard [--once|--interval 15m]   patrol registered agents with bounded actions
       hcode memory scan|harvest|recall  one-way harvest of every agent's memory into your Hoop (hcode memory → details)

options:
  --agency <0-9>        owner-authorized agency for this process (never persisted)
  --full-agency         alias for --agency 8
  --agency-budget-usd <n> required to unlock level 9 financial authority
  --mode read|ask|auto|all  permission mode (default full agency; fixed hard gates remain)
  --runner codex|claude|direct  executor for this session (default: codex, else claude, else direct)
  --model <id>           model id (HCODE_MODEL / ANTHROPIC_MODEL)
  --agent-model <id>     brain for a subagent, never the coordinator (task start)
  --kind search|mechanical|implement   take that subagent tier instead of naming a model
  --allow-flagship       let a subagent run on a flagship brain (the owner asked for it by name)
  --fallback-models <ids> comma-separated, capability-verified fallback chain
  --agent-id <id>        cost/accountability identity sent to the trusted gateway
  --task-id <id>         owner-granted task budget identity sent to the trusted gateway
  --effort <level>       reasoning effort: low, medium, high, xhigh or max (default high)
  --base-url <url>       API base (HCODE_BASE_URL / ANTHROPIC_BASE_URL)
  --api-key <key>        API key (HCODE_API_KEY / ANTHROPIC_API_KEY) — prefer the env var
  --cwd <dir>            project root (default: current directory)
  --max-tokens <n>       per-turn output cap (default 8192)
  --max-turns <n>        maximum model/tool rounds for one request (default 40)
  --mission-steps <n>    total objective step budget across automatic continuations (default 400)
  --mission-tokens <n>   total objective token budget (default 1000000)
  --mission-wall-ms <n>  total objective wall-clock budget (default 21600000)
  --token-budget <n>     context budget before automatic compaction (default 120000)
  --context-rot-tokens <n> preventive compact+flush threshold (default 10000)
  --live                 add the real hcode, Codex and Claude comparison (benchmark only)
  --polyglot             run the Aider polyglot lane (Exercism js/py, pass@2) through hcode, Codex and Claude
  --exercises <dir>      clone of github.com/Aider-AI/polyglot-benchmark (polyglot only)
  --runners a,b          hcode, codex, claude, glm (glm = Claude Code against z.ai; needs ~/.config/zai/api_key)
  --models k=v,...       pin per-runner models, e.g. hcode=deepseek-v4-flash,claude=opus,glm=glm-5.3
  --langs javascript,python  --n <k>  --resume-rows <jsonl>  --keep   (polyglot knobs)
  --describe             print the fixed benchmark manifest without running it
  --budget-usd <n>       live benchmark owner ceiling; greater than 0, at most 1 (default 0.75)
  --days <n>             only sessions started in the last n days (cost only)
  --user <u> --port <p> --hoop-port <p> --identity <file>   connect options (default gram / 18092 / 18095)
  --version, --help

config file: ~/.hcode/config.json {baseUrl, apiKey, model, mode, tokenBudget}
policy file: .hcode/policy.json {"mode","network":{"default":"off","allow":[…]},"allow":["bash:git *"],"sandbox":"auto"}
rule book:   .hcode/settings.json and ~/.hcode/settings.json {"rules":[{"tool":"bash","command":"git push*","action":"ask"}]}
             deny beats ask beats allow in every mode; /permissions lists and edits them.
context: HCODE.md → AGENTS.md → CLAUDE.md and .hcode/skills/*/SKILL.md in the project root go into the system prompt.
interactive input: Ctrl-V pastes an image privately; Enter sends; Esc stops the running turn; Esc Esc rewinds; Ctrl-C twice exits.

${commandsHelp()}`;

export function sessionsTable(list) {
  if (!list.length) return "(no sessions yet)";
  return list.map(s => `${s.id}  ${s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ") : "                "}  ${String(s.turns).padStart(2)} turn${s.turns === 1 ? " " : "s"}  ${(s.runner && s.runner !== "hcode" ? s.runner + " " : "") + (s.v === 1 ? "v1 " : "")}${s.prompt || ""}`).join("\n");
}

export function toolsTable() {
  return TOOL_CONTRACT.map(t => `${t.name.padEnd(11)} ${("[" + t.risk.join(",") + "]").padEnd(30)} ${t.idempotent ? "idempotent " : "           "} ${t.description}`).join("\n");
}

// doctor and demo: the two answers that read the machine and change nothing on it.
async function answerDiagnostic({ sub, args, cfg }) {
  if (sub === "doctor") return doctor(cfg, { cli: args, json: args.json });
  if (sub === "demo") {
    // A scripted turn through the real renderer, no brain, no ssh: the fastest way to look at
    // the dialog shape after a UI change. Nothing here touches sessions or config.
    ui.banner(cfg, "demo", { runner: "hcode" });
    ui.intro();
    ui.ownerLine("Fix the failing assertion in ui.test.js and run the suite.");
    ui.toolStart("grep /assistantEnd/ src"); ui.toolEnd("grep /assistantEnd/ src", "src/ui.js:340", { state: "done", durationMs: 42 });
    ui.toolStart("edit_file ui.test.js"); ui.toolEnd("edit_file ui.test.js", "", { state: "done", durationMs: 8 });
    ui.assistantStart("hcode"); ui.assistantText("The assertion expected the old separator. I updated it to the new **speaker line** shape.\n\nRunning the suite now.\n"); ui.assistantEnd();
    ui.toolStart("$ npm test"); ui.toolEnd("$ npm test", "# pass 210", { state: "done", durationMs: 8300 });
    ui.assistantStart("hcode"); ui.assistantText("- `npm test`: **210/210** pass\n- changed: `test/ui.test.js:162`\n\nAnything else?"); ui.assistantEnd();
    // The arrow-key menu, rendered once as a still frame: a composer that is never started
    // (no raw mode, no key handling) draws the same rows /brain and /permissions use live.
    const menuStill = new TerminalComposer({ columns: process.stdout.columns });
    menuStill.menu = {
      title: "Change the coordinator connection", index: 0,
      hint: "demo of the /brain menu — arrows or j/k move, digits jump, Enter confirms, Esc goes back",
      options: brainChoices(cfg).map(choice => ({ label: `${choice.label}  [${choice.status}]`, description: choice.detail })),
    };
    process.stdout.write(menuStill.menuRows().rows.join("\n") + "\n\n");
    const p = ui.prompt();
    if (typeof p === "object") process.stdout.write(`${p.prompt}(this is the input box — type here in a real session)\n${p.after}`);
    else process.stdout.write(`${p}\n`);
    ui.info("demo only — nothing was run, saved or sent. Launch `hcode` for the real thing.");
    return 0;
  }
  return null;
}

// The agency verbs: one decides an escalation from JSON, the other lends the canon to a foreign CLI.
async function answerAgencyLaunch({ sub, args, cfg }) {
  if (sub === "agency" && args._[1] === "decide") {
    try { const result = decideEscalation(JSON.parse(args._[2] || "{}")); console.log(JSON.stringify(result, null, 2)); return result.state === "UNOBSERVED" ? 2 : 0; }
    catch (error) { ui.error(`agency decision failed: ${error.message}`); return 64; }
  }
  if (sub === "agency" && ["codex", "claude"].includes(args._[1])) {
    const id = args._[1]; let canon;
    try { canon = loadAgencyCanon(); } catch (error) { ui.error(error.message); return 78; }
    const { spawnSync } = await import("node:child_process"); const extra = args._.slice(2);
    const command = id === "codex"
      ? ["--dangerously-bypass-approvals-and-sandbox", "-c", `developer_instructions=${JSON.stringify(canon)}`, ...extra]
      : ["--dangerously-skip-permissions", "--append-system-prompt", canon, ...extra];
    const result = spawnSync(id, command, { stdio: "inherit", cwd: cfg.cwd, env: process.env });
    if (result.error) { ui.error(`${id} could not start: ${result.error.message}`); return 127; }
    return result.status ?? 1;
  }
  return null;
}

// The patrol, the self-update, and the `_`-prefixed workers hcode re-invokes itself as. None of
// these belong to an owner sitting at a prompt; each one is a whole process's job.
async function answerWorker({ sub, args, cfg }) {
  if (sub === "guard") {
    try {
      const file = args.registry || registryFile(); const registry = loadRegistry(file);
      if (args._[1] === "status") { console.log(guardStatus(registry, readAudit())); return 0; }
      const brief = args.brief ? fs.readFileSync(path.resolve(args.brief), "utf8").slice(0, 20_000) : undefined;
      const patrol = () => guardOnce({ registry, socket: args.tmuxSocket || null, decide: input => brainVerdicts(cfg, { ...input, brief }) });
      if (args.once || !args.interval) { const result = await patrol(); console.log(JSON.stringify(result, null, args.json ? 2 : 0)); return 0; }
      const interval = parseInterval(args.interval); for (;;) { await patrol(); await new Promise(resolve => setTimeout(resolve, interval)); }
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "_task-worker") {
    const id = args._[1]; if (!id) return 64;
    try { return await runTaskWorker(id); } catch (error) { ui.error(error.message); return 1; }
  }
  // hcode updates itself — its own git checkout, never the project cwd happens to sit in. Foreground
  // here (an owner who typed `hcode update` is already waiting); /update backgrounds the same logic.
  if (sub === "update") {
    try {
      const result = isNativeRuntime() ? await runNativeUpdate() : runUpdate({ root: locateInstallRoot() });
      if (result.ok) { console.log(result.changedFiles === 0 ? `already current (${result.newVersion})` : `updated ${result.oldVersion} → ${result.newVersion} (${result.changedFiles} file${result.changedFiles === 1 ? "" : "s"} changed)`); return 0; }
      ui.error(`update refused: ${result.message}`); return 1;
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "rollback") {
    const result = rollbackNative();
    if (result.ok) { console.log(`rolled back ${result.oldVersion} → ${result.newVersion}`); return 0; }
    ui.error(`rollback refused: ${result.message}`); return 1;
  }
  if (sub === "_install-native") {
    try {
      const candidate = args._[1], manifestFile = args._[2];
      if (!candidate || !manifestFile) throw new Error("usage: hcode _install-native BINARY MANIFEST");
      const state = installNativeCandidate(path.resolve(candidate), JSON.parse(fs.readFileSync(path.resolve(manifestFile), "utf8")));
      console.log(`installed hcode ${state.current}; restart the shell if ~/.local/bin is new to PATH`); return 0;
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "_update-worker") {
    try { const result = await runUpdateWorker(); return result.ok ? 0 : 1; } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "_work-supervisor") {
    const id = args._[1]; const cwd = args._[2]; if (!id || !cwd) return 64;
    try {
      const store = openWork(cwd, id); if (!store) throw new Error(`work ${id} not found`);
      store.onChange = writeWorkStatus;
      if (["approved", "running"].includes(store.state.status)) await runApprovedWork(store, { cfg: { ...cfg, cwd }, policy: loadPolicy(cwd), runners: listRunners, sandbox: sandbox.detect(loadPolicy(cwd).sandbox) });
      else await runSupervisorWorker(store);
      writeWorkStatus(store); return 0;
    } catch (error) { ui.error(error.message); return 1; }
  }
  return null;
}

// Who this machine is connected as, and what that connection is entitled to. Every one of these
// prints facts it observed; a number nobody answered is printed as UNOBSERVED, never guessed.
async function answerAccount({ sub, args, cfg, policy }) {
  if (sub === "setup") {
    const { ask, select, close } = setupPrompter();
    try { return await chooseBrain(cfg, ask, { required: needsBrainSetup(cfg), select }) ? 0 : 1; }
    finally { close(); }
  }
  if (sub === "login") {
    const name = args._[1]; if (!name) { ui.error("usage: hcode login <hoop-name>"); return 64; }
    try {
      ui.info("Opening hoopgram.ai account approval. Your Hoop desktop login is separate; if hoopgram.ai is not signed in, its email link is expected.");
      const session = await loginHoop(name, { onCode: ({ userCode, verificationUri }) => ui.info(`Browser sign-in: ${verificationUri}\nconfirmation code: ${userCode}`) });
      saveDefaultHoop(session.hoop); console.log(`Connected ${session.hoop}.hoopgram.ai. Provider API keys remain on HoopGram.`); return 0;
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "logout") {
    const name = args._[1] || cfg.defaultHoop; if (!name) { ui.info("No HoopGram account is connected on this machine."); return 0; }
    await logoutHoop(name); forgetDefaultHoop(); ui.info(`Logged out ${name}.hoopgram.ai on this machine.`); return 0;
  }
  if (sub === "account") {
    const name = args._[1] || cfg.defaultHoop;
    ui.account(name ? describeHoopSession(name) : { connected: false });
    return 0;
  }
  if (sub === "quota") {
    // The bucket answer, straight from the box that holds the keys. Never a guessed number:
    // a provider that does not expose a remaining-quota header prints UNOBSERVED with why.
    try {
      const authHeaders = cfg.apiKey ? { "x-api-key": cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` } : {};
      const r = await getJson(cfg, "/v1/quota", { headers: authHeaders, timeoutMs: 10000 });
      if (!r.ok) { ui.error(`quota not answerable (HTTP ${r.status})${r.status === 404 ? " — this Hoop's keyproxy predates /v1/quota" : ""}`); return 1; }
      const q = await r.json();
      const pct = q.pool.capUsd > 0 ? ` (${(100 * q.pool.usd / q.pool.capUsd).toFixed(1)}%)` : "";
      console.log(`spend pool  $${q.pool.usd.toFixed(2)} of $${q.pool.capUsd.toFixed(2)}/month${pct}${q.pool.usd >= q.pool.capUsd ? "  ← DRAINED: pool-backed models are refused (429) until the month rolls over" : ""}`);
      console.log(`byo keys    $${Number(q.byo?.usd || 0).toFixed(2)} across ${q.byo?.turns || 0} turns (own keys; not pool-capped)`);
      for (const [id, p] of Object.entries(q.providers || {})) {
        const kind = p.kind === "pool" ? "pool-backed" : p.kind === "byo" ? "own key (BYO)" : p.kind === "free" ? "free/local" : "NO KEY — physically impossible";
        const obs = p.quota?.state === "OBSERVED" ? `remaining ${p.quota.remaining}` : `UNOBSERVED (${p.quota?.reason || "no observation"})`;
        console.log(`  ${id.padEnd(10)} ${kind.padEnd(28)} ${obs}`);
      }
      return 0;
    } catch (error) { ui.error(`quota not answerable: ${error.message}`); return 1; }
  }
  if (sub === "status") {
    const name = args._[1] || cfg.defaultHoop;
    const localSb = sandbox.detect(policy.sandbox);
    ui.status(cfg, null, { runner: cfg.runner, network: policy.network.default, sandbox: localSb.adapter, account: name ? describeHoopSession(name) : { connected: false } });
    return 0;
  }
  return null;
}

// What the saved threads add up to. `--resume list` is answered here too: it names a thread to read,
// not one to reopen, so it must never fall through into the interactive launch below.
async function answerHistory({ sub, args, cfg }) {
  if (sub === "memory") { try { return await runMemory(args, { openTunnel, ui }); } catch (e) { ui.error(e.message); return 1; } }
  if (sub === "sessions") {
    // The explicit sweep, for after a thread has been deleted or archived: blobs no saved thread names.
    if (args.reclaim) { console.log(formatReclaim(reclaimSnapshots({ dir: cfg.sessionsDir }))); return 0; }
    console.log(sessionsTable(Session.list(cfg.sessionsDir, 20))); return 0;
  }
  if (sub === "cost") { console.log(formatCost(scanCosts(cfg.sessionsDir, { days: Number(args.days) > 0 ? Number(args.days) : 0 }))); return 0; }
  if (sub === "tune") { console.log(formatTune(tuneReport(cfg.sessionsDir, { days: Number(args.days) > 0 ? Number(args.days) : 0 }))); return 0; }
  if (args.resume === "list") { console.log(sessionsTable(Session.list(cfg.sessionsDir, 10))); return 0; }
  return null;
}

// The fixed contracts: what hcode may do, how well it does it, and which other CLIs are installed.
async function answerCatalog({ sub, args, cfg }) {
  if (sub === "tools") { console.log(args.json ? JSON.stringify(TOOL_CONTRACT, null, 2) : toolsTable()); return 0; }
  if (sub === "benchmark" && (args.describe || (!args.live && !args.polyglot))) {
    try {
      if (args.describe) { console.log(JSON.stringify(benchmarkManifest(), null, 2)); return 0; }
      const report = await runBenchmark(cfg, { budgetUsd: args.budgetUsd ?? 0.75 });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatBenchmark(report)); return report.pass ? 0 : 1;
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "mcp") {
    const verb = args._[1] || "list";
    if (verb !== "list") { ui.error("usage: hcode mcp list [--json]"); return 64; }
    const rows = await listMcpConnectors({ cwd: cfg.cwd });
    console.log(args.json ? JSON.stringify(rows, null, 2) : connectorsTable(rows)); return rows.some(row => row.available && !row.ok) ? 1 : 0;
  }
  if (sub === "runner") {
    const verb = args._[1] || "list"; const id = args._[2];
    try {
      if (verb === "list") { const rs = listRunners(); console.log(args.json ? JSON.stringify(rs, null, 2) : rs.map(r => `${r.id.padEnd(7)} ${r.enabled ? (r.available ? color.green("[available]") : color.dim("[not installed]")) : color.red("[removed]")}  ${r.label}${r.path ? color.dim("  " + r.path) : ""}`).join("\n")); return 0; }
      if (verb === "remove" && id) { console.log(removeRunner(id)); return 0; }
      if (verb === "add" && id) { console.log(addRunner(id)); return 0; }
      ui.error("usage: hcode runner list | add <claude|codex> | remove <claude|codex>"); return 64;
    } catch (e) { ui.error(e.message); return 1; }
  }
  return null;
}

// Background conversations and durable coordinated work: started, inspected, gated and stopped from
// the shell. Both owner gates here (an unsafe workspace, a flagship's price) are asked
// interactively or refused — a pipe is never treated as a human saying yes.
async function answerCoordination({ sub, args, cfg, policy }) {
  if (sub === "task") {
    const verb = args._[1] || "list"; const id = args._[2];
    try {
      if (verb === "list") { const rows = listTasks(); console.log(rows.length ? rows.map(taskSummary).join("\n") : "(no background tasks)"); return 0; }
      if ((verb === "show" || verb === "attach") && id) { const state = readTask(id); console.log(taskSummary(state)); const transcript = taskTranscript(id); if (transcript) console.log("\n" + transcript.trimEnd()); return 0; }
      if (verb === "send" && id) { const prompt = args._.slice(3).join(" ").trim(); const state = sendTask(id, prompt, process.env, { agencyLevel: cfg.agencyLevel, agencyBudgetUsd: cfg.agencyBudgetUsd ?? null, unattended: cfg.unattended }); console.log(`${state.id} queued; use \`hcode task show ${state.id}\``); return 0; }
      if (verb === "stop" && id) { console.log(taskSummary(stopTask(id))); return 0; }
      if (verb === "start" && ["claude", "codex"].includes(id)) {
        const prompt = args._.slice(3).join(" ").trim();
        let allowUnsafeWorkspace = false;
        try { assertSafeExternalWorkspace(cfg.cwd); }
        catch {
          if (!process.stdin.isTTY) throw Object.assign(new Error("this workspace needs owner approval; run this command interactively"), {
            code: "approval_required",
            details: { cwd: cfg.cwd, mode: cfg.mode, runner: id, policy: "workspace", sandbox: sandbox.detect(policy.sandbox), allowedRoots: policy.allowedRoots },
          });
          const { ask, close } = prompter();
          try { allowUnsafeWorkspace = /^y(es)?$/i.test(await ask(ui.workspacePermission(cfg.cwd, id))); }
          finally { close(); }
          if (!allowUnsafeWorkspace) throw new Error("owner declined workspace access");
        }
        const start = spendApproved => startTask({ runner: id, prompt, cwd: cfg.cwd, mode: cfg.mode, effort: cfg.effort, policy, allowUnsafeWorkspace, agencyLevel: cfg.agencyLevel ?? null, agencyBudgetUsd: cfg.agencyBudgetUsd ?? null, unattended: cfg.unattended,
          model: args.agentModel || "", kind: args.kind || "", allowFlagship: Boolean(args.allowFlagship), spendApproved, coordinatorModel: cfg.model });
        let state;
        // The spend gate, asked the same way the workspace question is: interactively, or refused.
        try { state = start(false); }
        catch (error) {
          if (error.code !== "spend_gate") throw error;
          if (!process.stdin.isTTY) throw Object.assign(new Error(`${error.message}; run this command interactively to approve it`), { code: "approval_required", details: error.details });
          const { ask, close } = prompter();
          let yes; try { yes = /^y(es)?$/i.test(String(await ask(`${error.details.why}. Start it anyway? [y/N]\n> `) || "").trim()); } finally { close(); }
          if (!yes) throw new Error("owner declined the spend");
          state = start(true);
        }
        console.log(`${state.id} started in the background; use \`hcode task show ${state.id}\` or \`hcode task send ${state.id} "continue"\``); return 0;
      }
      ui.error("usage: hcode task start <claude|codex> <prompt> | list | show <id> | send <id> <prompt> | stop <id>   (hcode launch <claude|codex> <prompt> is the same command)"); return 64;
    } catch (error) {
      if (args.json && error?.code) process.stderr.write(JSON.stringify({ ok: false, code: error.code, error: error.message, ...error.details }) + "\n");
      else ui.error(error.message);
      return 1;
    }
  }
  if (sub === "gate") {
    const verb = args._[1] || "list"; const workId = args._[2] || latestWorkId(cfg.cwd); const gateId = args._[3];
    try {
      const store = openWork(cfg.cwd, workId); if (!store) throw new Error("no coordinated work found");
      if (verb === "list") { console.log(formatGates(store)); return 0; }
      if (["approve", "reject"].includes(verb) && gateId) { const gate = decideGate(store, gateId, verb, { by: "owner", note: args.note || args._.slice(4).join(" ") }); writeWorkStatus(store); console.log(`${gate.id} ${gate.status}`); return 0; }
      ui.error("usage: hcode gate list [workId] | approve|reject <workId> <gateId> [--note <text>]"); return 64;
    } catch (error) { ui.error(error.message); return 1; }
  }
  if (sub === "work") {
    const verb = args._[1] || "status"; const workId = args._[2] || latestWorkId(cfg.cwd);
    try {
      const store = openWork(cfg.cwd, workId); if (!store) throw new Error("no coordinated work found");
      if (verb === "status") { writeWorkStatus(store); console.log(formatWork(store) + "\n" + formatGates(store)); return 0; }
      if (verb === "supervise") {
        if (args.stop) { const state = stopSupervisor(store); console.log(state.running ? "supervisor stopping" : "supervisor stopped"); return 0; }
        const state = launchSupervisor(store, { tmux: args.tmux }); console.log(`supervising ${store.id} with pid ${state.pid}${args.tmux ? " (tmux observation enabled)" : ""}`); return 0;
      }
      ui.error("usage: hcode work status [workId] | supervise [workId] [--tmux|--stop]"); return 64;
    } catch (error) { ui.error(error.message); return 1; }
  }
  return null;
}

// The order below is the command surface: `hcode tools --resume list` prints sessions because
// answerHistory is consulted before answerCatalog, exactly as the single if-chain used to.
const ONE_SHOT_GROUPS = [answerDiagnostic, answerAgencyLaunch, answerWorker, answerAccount, answerHistory, answerCatalog, answerCoordination];

export async function answerOneShot(launch) {
  for (const answer of ONE_SHOT_GROUPS) {
    const code = await answer(launch);
    if (code !== null) return code;
  }
  return null;
}

// The two benchmark lanes that need a brain, so they are answered after the tunnel is up and are
// the only one-shot answers that own the tunnel's close.
export async function answerLiveBenchmark({ sub, args, cfg, tunnel }) {
  if (sub === "benchmark" && args.polyglot) {
    try {
      const report = await runPolyglot(cfg, { exercises: args.exercises || path.join(HOME, "polyglot-benchmark"), langs: args.langs, n: args.n || 0, runners: args.runners, budgetUsd: args.budgetUsd ?? 2, models: args.models, resume: args.resumeRows, keep: args.keep,
        onRow: row => { if (!args.json) console.error(`[${row.pass2 ? row.pass1 ? "pass@1" : "pass@2" : row.skipped ? "skip" : "FAIL"}] ${row.runner} ${row.id} ${Math.round(row.wallMs / 1000)}s`); } });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatPolyglot(report)); return 0;
    } catch (error) { ui.error(error.message); return 1; }
    finally { tunnel?.close(); }
  }
  if (sub === "benchmark" && args.live) {
    try {
      const report = await runBenchmark(cfg, { live: true, budgetUsd: args.budgetUsd ?? 0.75 });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatBenchmark(report)); return report.pass ? 0 : 1;
    } catch (error) { ui.error(error.message); return 1; }
    finally { tunnel?.close(); }
  }
  return null;
}
