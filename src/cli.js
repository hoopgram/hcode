// Command surface:
//   hcode                      interactive
//   hcode "task"               one task, then exit
//   hcode -p "task"            non-interactive print mode (scripts, routines): no confirmations, stdout only
//   hcode --resume [id|list]   reopen the latest (or given) session; `list` shows recent ones
//   hcode --runner claude|codex  legacy one-shot compatibility path (never saved as the coordinator)
//   hcode connect <name> [...] use your Hoop as the brain through an SSH tunnel
//   hcode doctor · sessions · tools [--json] · runner list|add|remove <id> · --version · --help
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, loadProjectSettings, ensureHome, VERSION, HOME } from "./config.js";
import { getJson } from "./api.js";
import { Session } from "./session.js";
import { scanCosts, formatCost, contextMeter, sessionSpend } from "./cost.js";
import { runAgent, compactNow, estimateTokens, effectiveBudget, projectContext, MAX_CONTINUATIONS } from "./agent.js";
import { doctor } from "./doctor.js";
import { openTunnel, brainDownHint, hoopHost } from "./connect.js";
import { runMemory } from "./memory.js";
import { loadPolicy } from "./policy.js";
import { GATE_CLASSES } from "./gates.js";
import { TOOL_CONTRACT } from "./tools.js";
import { listRunners, removeRunner, addRunner, findBinary, runExternal, lastForeignSession, assertSafeExternalWorkspace } from "./runners.js";
import { brainChoices, needsBrainSetup, resolveBrainChoice, saveRunner, saveDefaultHoop, forgetDefaultHoop } from "./brain.js";
import { startTask, sendTask, stopTask, readTask, listTasks, taskTranscript, taskSummary, runTaskWorker, spendGateFor } from "./tasks.js";
import { locateInstallRoot, runUpdate, runUpdateWorker, startBackgroundUpdate, readUpdateState, updateSummaryLine } from "./update.js";
import { loginHoop, logoutHoop, loadHoopSession, applyHoopSession, describeHoopSession } from "./auth.js";
import * as sandbox from "./sandbox.js";
import { ui, color, renderDiff } from "./ui.js";
import { TerminalComposer, supportsComposer } from "./composer.js";
import { BUILTIN_NAMES, commandsHelp, setCustomCommands } from "./commands.js";
import { customCommandsHelp, expandCustomCommand, findCustomCommand, loadCustomCommands, parseCommandNew, saveCustomCommand } from "./custom-commands.js";
import { formatTune, tuneReport } from "./tune.js";
import { chooseStartupPermission, confirmPermissionMode, openPermissions } from "./permissions.js";
import { selectOption } from "./select.js";
import { listMcpConnectors, connectorsTable } from "./connectors.js";
import { initializeProject, projectDiff, contextSummary } from "./project-commands.js";
import { activeDir, collectFacts, continueFrom, formatContinue, formatLedgers, ledgerRoot, listLedgers, retiredThreads, suggestStatus, threadEvidence, writeLedger } from "./handoff.js";
import { applyMode, currentMode, modeNotice, setMode } from "./modes.js";
import { SUBAGENT_DIR, askAside, childLedger, formatSubagents, openChild, parseDelegateFlags, resolveSubagentModel, subagentTiers } from "./subagents.js";
import { AttachmentStore, MAX_IMAGES_PER_MESSAGE, formatAttachment } from "./attachments.js";
import { benchmarkManifest, runBenchmark, formatBenchmark } from "./benchmark.js";
import { runPolyglot, formatPolyglot } from "./polyglot.js";
import { CoordinatorStore } from "./coordinator.js";
import { formatPlan, formatWork, latestWorkId, openWork, proposeWork, runApprovedWork } from "./work.js";
import { decideGate, formatGates, launchSupervisor, runSupervisorWorker, stopSupervisor, writeWorkStatus } from "./supervise.js";
import { brainVerdicts, guardOnce, guardStatus, loadRegistry, parseInterval, readAudit, registryFile } from "./guard.js";
import { SnapshotStore, openRewind, reclaimOnClose, reclaimSnapshots, formatReclaim } from "./rewind.js";
import { runMission } from "./mission.js";
import { loadAgencyCanon, decideEscalation, applyAgencyGrant } from "./agency.js";
import { presence } from "./presence.js";

// A function, not a constant: the owner's own commands join the catalog while a session is running.
const helpText = () => `○ Welcome to Hoop ${VERSION} — HoopGram's AI coding agent (zero dependencies)

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
       hcode update                    fast-forward hcode's own source checkout (local git only, no npm, no sudo)
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
  --runner hcode|claude|codex   legacy one-shot override; normal sessions keep hcode as coordinator
  --model <id>           model id (HCODE_MODEL / ANTHROPIC_MODEL)
  --agent-model <id>     brain for a subagent, never the coordinator (task start)
  --kind search|mechanical|implement   take that subagent tier instead of naming a model
  --allow-flagship       let a subagent run on a flagship brain (the owner asked for it by name)
  --fallback-models <ids> comma-separated, capability-verified fallback chain
  --agent-id <id>        cost/accountability identity sent to the trusted gateway
  --task-id <id>         owner-granted task budget identity sent to the trusted gateway
  --effort <level>       reasoning effort: low, medium or high (default high)
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

const safeHoopHost = name => { try { return hoopHost(name); } catch { return name; } };
const bridgeSuffix = tunnel => tunnel.viaBridge ? " (via ssh stdio bridge; sshd forbids port forwarding)" : "";
const busyPorts = tunnel => tunnel.reassigned ? ` (default ports busy; using localhost ${tunnel.localPort}/${tunnel.hoopLocalPort})` : "";
// What a plain `hcode` in this environment would give a session. A handoff's restart line repeats only
// the flags this session actually moved away from that, so the line stays one paste long.
const baselineConfig = () => { try { return loadConfig({}); } catch { return {}; } };

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case "-p": case "--print": o.print = true; break;
      case "--full-agency": o.fullAgency = true; break;
      case "--agency": o.agencyLevel = Number(next()); break;
      case "--unattended": o.unattended = true; break;
      case "--agency-budget-usd": o.agencyBudgetUsd = Number(next()); break;
      case "--json": o.json = true; break;
      case "--resume": o.resume = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true; break;
      case "--mode": o.mode = next(); break;
      case "--runner": o.runner = next(); break;
      case "--model": o.model = next(); break;
      case "--agent-model": o.agentModel = next(); break;
      case "--kind": o.kind = next(); break;
      case "--allow-flagship": o.allowFlagship = true; break;
      case "--fallback-models": o.fallbackModels = next(); break;
      case "--agent-id": o.agentId = next(); break;
      case "--task-id": o.taskId = next(); break;
      case "--effort": o.effort = next(); break;
      case "--base-url": o.baseUrl = next(); break;
      case "--api-key": o.apiKey = next(); break;
      case "--cwd": o.cwd = next(); break;
      case "--max-tokens": o.maxTokens = next(); break;
      case "--max-turns": o.maxTurns = next(); break;
      case "--mission-steps": o.missionStepBudget = next(); break;
      case "--mission-tokens": o.missionTokenBudget = next(); break;
      case "--mission-wall-ms": o.missionWallMs = next(); break;
      case "--token-budget": o.tokenBudget = next(); break;
      case "--context-rot-tokens": o.contextRotTokens = next(); break;
      case "--live": o.live = true; break;
      case "--polyglot": o.polyglot = true; break;
      case "--exercises": o.exercises = next(); break;
      case "--runners": o.runners = next().split(",").map(v => v.trim()).filter(Boolean); break;
      case "--models": o.models = Object.fromEntries(next().split(",").map(kv => kv.split("=").map(s => s.trim())).filter(p => p[0] && p[1])); break;
      case "--langs": o.langs = next().split(",").map(v => v.trim()).filter(Boolean); break;
      case "--n": o.n = Number(next()); break;
      case "--resume-rows": o.resumeRows = next(); break;
      case "--keep": o.keep = true; break;
      case "--reclaim": o.reclaim = true; break;
      case "--describe": o.describe = true; break;
      case "--budget-usd": o.budgetUsd = Number(next()); break;
      case "--tmux": o.tmux = true; break;
      case "--stop": o.stop = true; break;
      case "--note": o.note = next(); break;
      case "--once": o.once = true; break;
      case "--interval": o.interval = next(); break;
      case "--registry": o.registry = next(); break;
      case "--brief": o.brief = next(); break;
      case "--tmux-socket": o.tmuxSocket = next(); break;
      case "--user": o.user = next(); break;
      case "--port": o.port = Number(next()); break;
      case "--hoop-port": o.hoopPort = Number(next()); break;
      case "--identity": case "-i": o.identity = next(); break;
      // hcode memory (V0.2.7 B): --hoop opens the tunnel to mind; the rest are harvest/recall knobs
      case "--hoop": o.hoop = next(); break;
      case "--agent": o.agent = next(); break;
      case "--dry-run": o.dryRun = true; break;
      case "--limit": o.limit = Number(next()); break;
      case "--days": o.days = Number(next()); break;
      case "--version": case "-v": o.version = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (a.startsWith("-") && a.length > 1) throw new Error(`unknown option ${a} (see --help)`);
        o._.push(a);
    }
  }
  return o;
}

function prompter() {
  // Lines are queued, so piped stdin ("y\ny\n") answers confirmations in order instead of
  // being swallowed by readline before the next question is asked.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const queue = []; const waiting = []; let closed = false;
  rl.on("line", line => {
    const w = waiting.shift();
    if (w) { if (w.after) process.stdout.write(w.after); w.resolve(line.trim()); }
    else queue.push(line.trim());
  });
  rl.on("close", () => { closed = true; while (waiting.length) waiting.shift().resolve(""); });
  const ask = question => new Promise(res => {
    const q = typeof question === "object" ? question : { prompt: String(question), after: "" };
    if (queue.length) { process.stdout.write(q.prompt); const a = queue.shift(); process.stdout.write(a + "\n" + q.after); return res(a); }
    if (closed) return res("");
    process.stdout.write(q.prompt); waiting.push({ resolve: res, after: q.after });
  });
  return { ask, close: () => rl.close(), rl };
}

// Setup runs before any session exists; give it the same arrow-key menu as the in-session
// /brain picker when the terminal can hold a composer, and the numbered readline picker
// otherwise (pipes, dumb terminals, NO_COLOR).
function setupPrompter() {
  if (!supportsComposer(process.stdin, process.stdout, process.env)) {
    const input = prompter();
    return { ask: input.ask, close: input.close };
  }
  const composer = new TerminalComposer();
  ui.attachComposer(composer);
  composer.start();
  return {
    ask: question => composer.ask(question),
    select: spec => composer.select(spec),
    close: () => { composer.close(); ui.attachComposer(null); },
  };
}

// The owner-decision prompt accepts exactly y / n / a (Enter = do not run, as printed). Anything
// else — a whole message typed to help a stuck agent, a stray keypress, piped garbage — is NOT a
// human decision and must never be recorded as one (2026-08-28, 阿加莎's reproduction + 张良's
// order: "rescuing an agent stuck at the gate must not itself deny an action in the agent's name").
// On a real terminal an unrecognized answer re-asks (the rescue message produces NO record); on
// piped stdin there is no human behind the input, so it auto-denies as a machine decision.
function makeConfirm(ask, { interactive = process.stdin.isTTY } = {}) {
  return async (name, input, meta = {}) => {
    for (;;) {
      const a = String(await ask(ui.permission(name, input, meta)) || "").trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (a === "y" || a === "yes") return "allow";
      if (a === "n" || a === "no") return "deny";
      // Blank input also remains fail-closed, but it is not evidence that a human
      // declined.  In unattended/TUI automation it commonly means EOF, a swallowed
      // key, or a transport probe.  Never forge those into an owner decision.
      if (a === "") return "unobserved";
      // Any other text is not a decision either.  On a real terminal it re-asks and
      // records NOTHING (a rescue message must never become a refusal); on piped
      // stdin there is no human behind it — the gate auto-denies as a machine
      // decision, worded invalid-choice, never "human".
      if (!interactive) return "invalid-choice";
      ui.warn(`"${a.slice(0, 40)}" is not one of y / n / a — this is a decision prompt, not a chat input; nothing was recorded`);
    }
  };
}

export async function chooseBrain(cfg, ask, { required = false, terminal = ui, runners = listRunners(), select } = {}) {
  const choices = brainChoices(cfg, runners);
  for (;;) {
    let answer;
    if (select) {
      // arrow-key menu in composer sessions; the numbered picker stays for readline/pipes
      const index = await selectOption({
        title: required ? "Connect the Hoop Code coordinator" : "Change the coordinator connection",
        options: choices.map(choice => ({ label: `${choice.label}  [${choice.status}]`, description: choice.detail })),
        select,
      });
      if (index === null) return false;
      answer = String(index + 1);
    } else answer = await ask(terminal.brainPicker(choices, { required }));
    if (!answer || /^(q|quit|exit)$/i.test(answer)) return false;
    const choice = resolveBrainChoice(answer, choices);
    if (!choice) { terminal.warn("Choose one of the numbers shown above."); continue; }
    if (choice.runner && choice.selectable) {
      cfg.runner = choice.runner;
      saveRunner(choice.runner);
      terminal.info(`${choice.label} now connects the Hoop Code coordinator on this machine.`);
      return true;
    }
    if (choice.id === "hoopgram") {
      const name = await ask("Hoop name (the part before .hoopgram.ai)\n> ");
      if (!name) continue;
      try {
        terminal.info("Opening hoopgram.ai account approval. Your Hoop desktop login is separate; if hoopgram.ai is not signed in, its email link is expected.");
        const session = await loginHoop(name, { onCode: ({ userCode, verificationUri }) => terminal.info(`Browser sign-in: ${verificationUri}\nconfirmation code: ${userCode}`) });
        applyHoopSession(cfg, session); saveDefaultHoop(session.hoop); saveRunner("hcode");
        terminal.info(`Connected ${session.hoop}.hoopgram.ai. This Mac holds a revocable session only; model API keys remain on HoopGram.`);
        return true;
      } catch (error) { terminal.warn(`HoopGram sign-in did not finish: ${error.message}`); continue; }
    }
    if (choice.id === "byok") {
      terminal.info("Advanced setup: configure HCODE_API_KEY (and optionally HCODE_BASE_URL / HCODE_MODEL) outside this prompt, then run `hcode setup` again. Hoop Code never asks you to paste a secret into chat.");
      continue;
    }
    if (choice.id === "connect") {
      terminal.info("Advanced setup: run `hcode connect <your-hoop-name>`. This uses your existing SSH identity and stores no model key on this Mac.");
      continue;
    }
    terminal.warn(`${choice.label} is not ready. ${choice.detail}.`);
  }
}

export { makeConfirm };
export function sessionsTable(list) {
  if (!list.length) return "(no sessions yet)";
  return list.map(s => `${s.id}  ${s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ") : "                "}  ${String(s.turns).padStart(2)} turn${s.turns === 1 ? " " : "s"}  ${(s.runner && s.runner !== "hcode" ? s.runner + " " : "") + (s.v === 1 ? "v1 " : "")}${s.prompt || ""}`).join("\n");
}

export function toolsTable() {
  return TOOL_CONTRACT.map(t => `${t.name.padEnd(11)} ${("[" + t.risk.join(",") + "]").padEnd(30)} ${t.idempotent ? "idempotent " : "           "} ${t.description}`).join("\n");
}

// One switch for the one permission concept the owner sees. `all` is Full Agency level 8; changing
// away from it removes that continuation grant as well as its broker mode, so the UI and runtime can
// never disagree about whether hcode is autonomous.
function applyPermissionChoice(cfg, mode) {
  cfg.mode = mode;
  if (mode === "all") {
    const canon = (cfg.agencyCanon || loadAgencyCanon()).replace(/\n\n# Active grant[\s\S]*$/, "");
    cfg.agencyCanon = canon + "\n\n# Active grant\nAgency level: 8/9. Financial authority is locked.";
    applyAgencyGrant(cfg, { agencyLevel: 8, agencyBudgetUsd: null, unattended: cfg.unattended });
  } else {
    cfg.fullAgency = false;
    delete cfg.agencyLevel;
    delete cfg.agencyBudgetUsd;
  }
  return cfg;
}

export async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { ui.error(e.message); return 64; }
  if (args.help) { console.log(helpText()); return 0; }
  if (args.version) { console.log(VERSION); return 0; }
  const sub = args._[0];
  let cfg;
  try { cfg = loadConfig(args); } catch (e) { ui.error(e.message); return 64; }
  ensureHome();
  const policy = loadPolicy(cfg.cwd);
  const offerStartupPermission = !cfg.modeExplicit && !policy.mode && !args.fullAgency && args.agencyLevel === undefined;
  if (policy.mode && !cfg.modeExplicit) {
    cfg.mode = policy.mode;     // policy.json sets the project default; --mode / HCODE_MODE win
  }
  cfg.policy = policy;
  if (args.fullAgency || args.agencyLevel !== undefined) {
    let requested = args.fullAgency ? 8 : args.agencyLevel;
    if (!Number.isInteger(requested) || requested < 0 || requested > 9) { ui.error("--agency must be an integer from 0 to 9"); return 64; }
    if (requested === 9 && !(args.agencyBudgetUsd > 0)) { ui.warn("agency 9 needs a positive --agency-budget-usd; using agency 8"); requested = 8; }
    try { cfg.agencyCanon = loadAgencyCanon(); } catch (error) { ui.error(error.message); return 78; }
    cfg.agencyLevel = requested;
    cfg.agencyCanon += `\n\n# Active grant\nAgency level: ${requested}/9. ${requested === 9 ? `Owner-set financial ceiling: USD ${args.agencyBudgetUsd}.` : "Financial authority is locked."}`;
    applyAgencyGrant(cfg, { agencyLevel: requested, agencyBudgetUsd: requested === 9 ? args.agencyBudgetUsd : null, unattended: args.unattended });
  } else if (cfg.mode === "all") {
    try { applyPermissionChoice(cfg, "all"); } catch (error) { ui.error(error.message); return 78; }
  }
  if (args.unattended) cfg.unattended = true;
  if (cfg.runner === "hcode" && needsBrainSetup(cfg) && cfg.defaultHoop) {
    const account = loadHoopSession(cfg.defaultHoop);
    if (account) applyHoopSession(cfg, account);
  }

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
      const result = runUpdate({ root: locateInstallRoot() });
      if (result.ok) { console.log(result.oldHead === result.newHead ? `already current (${result.newVersion})` : `updated ${result.oldVersion} → ${result.newVersion} (${result.changedFiles} file${result.changedFiles === 1 ? "" : "s"} changed)`); return 0; }
      ui.error(`update refused: ${result.message}`); return 1;
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
  if (sub === "memory") { try { return await runMemory(args, { openTunnel, ui }); } catch (e) { ui.error(e.message); return 1; } }
  if (sub === "sessions") {
    // The explicit sweep, for after a thread has been deleted or archived: blobs no saved thread names.
    if (args.reclaim) { console.log(formatReclaim(reclaimSnapshots({ dir: cfg.sessionsDir }))); return 0; }
    console.log(sessionsTable(Session.list(cfg.sessionsDir, 20))); return 0;
  }
  if (sub === "cost") { console.log(formatCost(scanCosts(cfg.sessionsDir, { days: Number(args.days) > 0 ? Number(args.days) : 0 }))); return 0; }
  if (sub === "tune") { console.log(formatTune(tuneReport(cfg.sessionsDir, { days: Number(args.days) > 0 ? Number(args.days) : 0 }))); return 0; }
  if (args.resume === "list") { console.log(sessionsTable(Session.list(cfg.sessionsDir, 10))); return 0; }
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
      ui.error("usage: hcode task start <claude|codex> <prompt> | list | show <id> | send <id> <prompt> | stop <id>"); return 64;
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

  let tunnel = null;
  if (sub === "connect") {
    const name = args._[1]; if (!name) { ui.error("usage: hcode connect <hoop-name> [task]"); return 64; }
    try { tunnel = await openTunnel({ name, user: args.user, localPort: args.port, hoopLocalPort: args.hoopPort, identity: args.identity, autoPort: args.port === undefined && args.hoopPort === undefined }); }
    catch (e) { ui.error(e.message); return 1; }
    if (!tunnel.brainAlive) {
      ui.error(tunnel.hint || brainDownHint(tunnel.host, tunnel.user, tunnel.remotePort));
      tunnel.close(); tunnel = null;
      return 1;
    }
    cfg.baseUrl = tunnel.baseUrl; cfg.apiKey = args.apiKey || process.env.HCODE_API_KEY || "gram-local";
    cfg.hoopUrl = tunnel.hoopUrl || ""; cfg.hoopName = name;
    if (!args.model && !process.env.HCODE_MODEL) cfg.model = "deepseek-v4-pro";
    saveDefaultHoop(name, undefined, { bridge: tunnel.viaBridge });
    ui.info(`connected: ${tunnel.host} is the brain and read-only Hoop data source${busyPorts(tunnel)} (keys stay on the Hoop; local files and subagents stay on this machine)${bridgeSuffix(tunnel)}`);
    args._.splice(0, 2);
  } else if (cfg.runner === "hcode" && needsBrainSetup(cfg) && cfg.defaultHoop) {
    const account = loadHoopSession(cfg.defaultHoop);
    if (account) {
      applyHoopSession(cfg, account);
      ui.info(`connected: ${account.hoop}.hoopgram.ai through your HoopGram session (provider keys stay on the server)`);
    } else {
      // openTunnel() owns the single retry for transient ssh drops; here we only judge the result.
      try {
        tunnel = await openTunnel({ name: cfg.defaultHoop, user: args.user, localPort: args.port, hoopLocalPort: args.hoopPort, identity: args.identity, autoPort: args.port === undefined && args.hoopPort === undefined, bridge: cfg.hoopBridge });
        if (!tunnel.brainAlive) {
          const failMsg = tunnel.hint || brainDownHint(tunnel.host, tunnel.user, tunnel.remotePort);
          tunnel.close(); tunnel = null;
          throw new Error(failMsg);
        }
        cfg.baseUrl = tunnel.baseUrl; cfg.apiKey = args.apiKey || process.env.HCODE_API_KEY || "gram-local";
        cfg.hoopUrl = tunnel.hoopUrl || ""; cfg.hoopName = cfg.defaultHoop;
        if (!args.model && !process.env.HCODE_MODEL) cfg.model = "deepseek-v4-pro";
        if (tunnel.viaBridge && !cfg.hoopBridge) saveDefaultHoop(cfg.defaultHoop, undefined, { bridge: true });
        ui.info(`connected: ${tunnel.host} is the brain and read-only Hoop data source${busyPorts(tunnel)} (remembered SSH device; keys stay on the Hoop)${bridgeSuffix(tunnel)}`);
      } catch (e) {
        // A remembered Hoop that is unreachable right now is a connection problem, not a
        // first run: never fall through to the setup wizard (which would offer a browser
        // sign-in the owner never asked for). Say what failed and how to get back.
        ui.warn(`could not reconnect ${cfg.defaultHoop}: ${e.message}`);
        ui.info(`Your Hoop is still remembered. Try again with \`hcode\`, diagnose with \`hcode doctor\`, or \`ssh ${args.user || "gram"}@${safeHoopHost(cfg.defaultHoop)} true\` to check ssh itself. \`hcode connect <other>\` or \`/logout\` changes the Hoop.`);
        return 1;
      }
    }
  }

  let task = args._.join(" ").trim();
  // `hcode "/continue parser"` is a slash command, not a prompt: it runs on the fresh session and then
  // hands the terminal over, which is what makes a handoff's restart line one paste instead of two.
  // The name is matched first and only then decided on: an argument naming no command is sent whole
  // as an ordinary prompt (see handleLine's `startup`), because nothing at the shell could complete it.
  let startupCommand = "";
  if (!args.print && task.startsWith("/")) { startupCommand = task; task = ""; }
  if (cfg.runner === "hcode" && needsBrainSetup(cfg)) {
    if (process.stdin.isTTY && !args.print && !args.resume) {
      const { ask, select, close } = setupPrompter();
      try {
        if (!(await chooseBrain(cfg, ask, { required: true, select }))) return 1;
      } finally { close(); }
    } else {
      ui.brainUnavailable(brainChoices(cfg));
      return 78;
    }
  }

  if (cfg.runner !== "hcode") {
    const r = listRunners().find(x => x.id === cfg.runner);
    if (!r || !r.enabled) { ui.error(`${cfg.runner} was removed from hcode — \`hcode runner add ${cfg.runner}\` to enable it again, or use --runner hcode`); tunnel?.close(); return 64; }
    if (!r.available) { ui.error(`${r.label} is not installed (no \`${cfg.runner}\` on PATH). hcode never installs it for you; install it, or use --runner hcode`); tunnel?.close(); return 64; }
  }

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

  const settings = loadProjectSettings(cfg.cwd);
  // The owner's own commands join the slash catalog before the composer is built, and again whenever
  // one is saved, so a command written mid-session is in the popup on the next keystroke.
  let customCommands = [];
  const refreshCustomCommands = () => { customCommands = loadCustomCommands(cfg.cwd, { builtins: BUILTIN_NAMES }); setCustomCommands(customCommands); return customCommands; };
  refreshCustomCommands();
  let attachmentStore = null;
  const cleanup = () => { attachmentStore?.cleanup(); attachmentStore = null; tunnel?.close(); };
  process.once("exit", cleanup);
  let current = null;          // AbortController of the running turn (Ctrl-C cancels it; a second Ctrl-C exits)
  let lastInterrupt = 0;
  let requestInteractiveExit = null;
  const handleInterrupt = () => {
    const now = Date.now();
    if (now - lastInterrupt <= 1500) {
      requestInteractiveExit?.(130);
      if (!requestInteractiveExit) { cleanup(); process.exit(130); }
      return;
    }
    lastInterrupt = now;
    if (current && !current.signal.aborted) {
      current.abort();
      ui.warn("Cancelling this turn… Press Ctrl-C again to exit.");
    } else ui.warn("Press Ctrl-C again to exit Hoop Code.");
  };
  // Esc stops the turn and nothing else: it never arms the 1.5s double press, so it can never
  // exit hcode. Everything after the abort (the cancelled marks, the notice) is Ctrl-C's path.
  const handleCancel = () => {
    if (current && !current.signal.aborted) { current.abort(); ui.warn("Cancelling this turn…"); }
  };
  const onSigint = () => handleInterrupt();
  process.on("SIGINT", onSigint);
  const sb = sandbox.detect(policy.sandbox);
  const workspaceApprovals = new Set();
  try {
    let session;
    if (args.resume) {
      if (args.resume === "list") { console.log(sessionsTable(Session.list(cfg.sessionsDir, 10))); return 0; }
      const id = args.resume === true ? Session.latest(cfg.sessionsDir) : String(args.resume);
      if (!id) { ui.error("no session to resume (hcode sessions)"); return 1; }
      try { session = new Session(cfg.sessionsDir, id); } catch (e) { ui.error(`cannot open session ${id}: ${e.message}`); return 1; }
      // the session's own agency grant wins over the ask default on resume — a supervisor's
      // `hcode --resume <id> -p …` must not silently drop the --agency the mission started with
      const grant = session.agencyGrant();
      if (grant && args.agencyLevel === undefined && !args.fullAgency) {
        applyAgencyGrant(cfg, grant);
        ui.info(`resuming with this session's agency grant: level ${grant.agencyLevel}/9 (mode ${cfg.mode}${cfg.unattended ? ", unattended" : ""})`);
      }
      if (args.resume === true && !args.print) { const recent = Session.list(cfg.sessionsDir, 5); if (recent.length > 1) ui.info("recent sessions (resuming the first; `hcode --resume <id>` picks another):\n" + sessionsTable(recent)); }
    } else session = new Session(cfg.sessionsDir, null, { cwd: cfg.cwd, runner: cfg.runner, model: cfg.model, effort: cfg.effort, tokenBudget: cfg.tokenBudget });
    // A mode is a property of the conversation, so a resumed thread comes back in the mode it was in.
    applyMode(cfg, currentMode(session));

    const runTurn = async (prompt, { askUser = null, confirm = null, approveWorkspace = null, quiet = false, images = [] } = {}) => {
      current = new AbortController();
      try {
        if (cfg.runner !== "hcode") {
          const approvalKey = `${cfg.runner}:${cfg.cwd}`;
          if (!workspaceApprovals.has(approvalKey)) {
            try { assertSafeExternalWorkspace(cfg.cwd); }
            catch {
              if (!approveWorkspace) throw Object.assign(new Error("this workspace needs owner approval; run hcode interactively"), { code: "workspace_approval_required" });
              const allowed = await approveWorkspace(cfg.cwd, cfg.runner);
              session.emit("workspace.approval", { runner: cfg.runner, cwd: cfg.cwd, decision: allowed ? "allow" : "deny", scope: "session" });
              if (!allowed) throw Object.assign(new Error("owner declined access to this workspace"), { code: "workspace_denied" });
              workspaceApprovals.add(approvalKey);
            }
          }
          if (!quiet) ui.info(`${cfg.runner} runs this turn (bounded by your policy: ${cfg.mode === "auto" || cfg.mode === "all" ? "may edit and run commands" : "read-only — it cannot ask you per action; use auto to let it write"}, network ${policy.network.default})`);
          let assistantOpen = false;
          const result = await runExternal({ id: cfg.runner, cfg, policy, session, prompt, images, signal: current.signal, resume: lastForeignSession(session, cfg.runner), allowUnsafeWorkspace: workspaceApprovals.has(approvalKey),
            onText: text => { if (quiet) process.stdout.write(text); else { if (!assistantOpen) { ui.assistantStart(cfg.runner); assistantOpen = true; } ui.assistantText(text); } },
            onTool: event => {
              if (quiet) return;
              if (assistantOpen) { ui.assistantEnd(); assistantOpen = false; }
              const label = event.input ? ui.toolLabel(event.name, event.input) : event.detail;
              if (event.phase === "end") ui.toolEnd(label, event.output, { state: event.state, durationMs: event.durationMs });
              else ui.toolStart(label, event.risk);
            } });
          if (!quiet && assistantOpen) ui.assistantEnd();
          return result;
        }
        return await runAgent({ cfg, settings, session, prompt, attachments: images, attachmentStore, askUser, confirm, quiet, signal: current.signal,
          onEvent: quiet ? null : ev => {
            // auto mode shows the diff of each edit as it runs (ask mode already showed it in the permission prompt)
            if (ev.type === "item" && ev.item.kind === "tool_call" && ev.item.tool === "edit_file" && ev.item.state === "running" && cfg.mode !== "ask") { const c = session.calls.get(ev.item.id); if (c?.input) ui.block(renderDiff(c.input.old_string, c.input.new_string, 20)); }
            if (ev.type === "compaction") ui.info(`context compacted (${ev.estTokens} to budget ${ev.budget} tokens); facts and decisions stayed in the thread`);
          } });
      } finally { current = null; }
    };

    if (args.print) {
      if (!task) { ui.error("-p needs a task"); return 64; }
      const t0 = Date.now();
      // resume replays past calls into session.calls; snapshot what was already denied so
      // only refusals from THIS headless run are counted.
      const deniedBefore = new Set([...session.calls.values()].filter(c => c.state === "denied").map(c => c.id));
      const r = cfg.runner === "hcode" ? await runMission({ session, mission: task,
        runTurn: prompt => runTurn(prompt, { quiet: true }),
        budget: { steps: cfg.missionStepBudget, tokens: cfg.missionTokenBudget, wallMs: cfg.missionWallMs } }) : await runTurn(task, { quiet: true });
      if (cfg.runner !== "hcode" && r.text && !r.text.endsWith("\n")) process.stdout.write("\n");
      if (process.stderr.isTTY) ui.usage(r.usage, Date.now() - t0, { stderr: true });
      if (r.truncated) ui.error(r.truncatedBy === "max_tokens" ? `stopped: the reply hit the ${cfg.maxTokens}-token output cap ${MAX_CONTINUATIONS + 1} times (--max-tokens raises it)` : `stopped after ${cfg.maxTurns} steps (--max-turns raises it)`);
      if (r.stopped) ui.error(`objective stopped: ${r.stopReason} ${r.budget} budget exhausted; next: ${r.nextStep}`);
      // -p can never ask a human, so a permission refusal is a FAILED task, not a partial
      // answer that exits 0. Say which tools were refused and fail with a distinct code
      // (0 ok · 1 stopped/cancelled · 3 denied by the gate) so a headless worker can tell
      // "the gate refused this" from "the budget ran out" — and never silently retry.
      const refused = [...session.calls.values()].filter(c => c.state === "denied" && !deniedBefore.has(c.id));
      if (refused.length) {
        ui.error(`denied by the permission gate with no human to ask: ${[...new Set(refused.map(c => c.tool))].join(", ")}`);
        process.stderr.write(`hcode-print: denied=${refused.length}\n`);
      }
      if (r.truncated || r.stopped || r.cancelled) return 1;
      if (refused.length) return 3;
      return 0;
    }

    // The banner goes through the composer when there is one, so the composer knows the
    // transcript starts at the top of a freshly cleared page and can fill it downward.
    const showBanner = () => {
      ui.banner(cfg, session.id, { runner: cfg.runner, network: policy.network.default, sandbox: sb.adapter });
      if (sb.degraded) ui.warn(`sandbox: ${sb.reason} — commands run unconfined on this machine (policy still applies: network stays off, secrets refused by path)`);
      if (policy.problems.length) ui.warn(`policy.json: ${policy.problems.join("; ")} (ignored)`);
    };
    let composer = null;
    let ask; let close; let select;   // select: arrow-key menu, only when a composer is present
    let bridgeExitCode = null;
    if (!task && supportsComposer(process.stdin, process.stdout, process.env)) {
      attachmentStore = new AttachmentStore();
      composer = new TerminalComposer();
      ui.attachComposer(composer);
      composer.start();
      showBanner();
      ui.intro();
      ask = question => composer.ask(question);
      select = spec => composer.select(spec);
      close = () => { composer.close(); ui.attachComposer(null); attachmentStore?.cleanup(); attachmentStore = null; };
    } else {
      const input = prompter();
      input.rl.on("SIGINT", handleInterrupt);
      // No composer, so read Esc off stdin ourselves: readline's keypress parser never reports a
      // lone Esc (it holds the byte until the next one arrives). Same rule as the composer — a
      // bare \x1b with nothing behind it within a keystroke is the key, not a sequence.
      let escapeTimer = null;
      const onStdin = chunk => {
        clearTimeout(escapeTimer); escapeTimer = null;
        if (String(chunk) === "\x1b") escapeTimer = setTimeout(() => { escapeTimer = null; handleCancel(); }, 40);
      };
      if (process.stdin.isTTY) process.stdin.on("data", onStdin);
      requestInteractiveExit = code => { bridgeExitCode = code; input.close(); };
      ask = input.ask;
      close = () => {
        input.rl.off("SIGINT", handleInterrupt); clearTimeout(escapeTimer);
        if (process.stdin.isTTY) process.stdin.off("data", onStdin);
        input.close(); requestInteractiveExit = null;
        // A session ending is the moment the snapshot store can be counted honestly. Bounded, best
        // effort, and never a reason to fail an exit — leaving hcode is not where a sweep gets to matter.
        try { reclaimOnClose(cfg.sessionsDir); } catch { /* the TTL backstop still applies */ }
      };
      showBanner();
      if (!task) ui.intro();
    }
    const shouldChooseStartupPermission = offerStartupPermission && process.stdin.isTTY && !task && !startupCommand && !args.resume && !cfg.unattended;
    if (shouldChooseStartupPermission) {
      const result = await chooseStartupPermission({ cwd: cfg.cwd, ask, select, show: text => ui.block(text) });
      if (result.error) ui.warn(result.error);
      else {
        applyPermissionChoice(cfg, result.mode);
        if (result.saved) policy.mode = result.mode;
        if (result.saveError) ui.warn(result.saveError);
        ui.done(`${result.mode === "all" ? "Full agency" : `Permission ${result.mode}`} is on${result.saved ? " · remembered for this project" : " · hcode will ask again next startup"}.`);
      }
    } else if (!task && cfg.mode === "all") {
      ui.done(`Full agency is on${policy.mode === "all" ? " · remembered for this project" : ""}. Hard gates still protect secrets, money, publishing, deletion and owner intent. /permissions changes it.`);
    }
    // Unattended (a supervisor watching a pane, no human): never inject the interactive confirm
    // callback. An ask then takes the honest "no human was available" refusal instead of recording
    // an automated keypress as a human decision — a bare Enter is a decision too (2026-08-28,
    // 张良 layer two: "not an unobserved failure, a recorded decision that looks human and is not").
    if (cfg.unattended) ui.warn("unattended: permission asks are refused honestly (no human present); nothing will be recorded as a human decision");
    const confirm = cfg.unattended ? null : makeConfirm(ask);
    const askUser = cfg.unattended ? null : (q => ask(ui.question(q)));
    const approveWorkspace = async (cwd, runner) => /^y(es)?$/i.test(await ask(ui.workspacePermission(cwd, runner)));
    const changePermission = async requested => {
      const options = { current: cfg.mode, cwd: cfg.cwd, sandbox: `${policy.sandbox} → ${sb.adapter}${sb.degraded ? " (degraded)" : ""}`, ask, select, show: text => ui.block(text) };
      const result = requested ? await confirmPermissionMode({ ...options, mode: requested })
        : await openPermissions({ ...options, book: policy.book, info: text => ui.info(text), warn: text => ui.warn(text) });
      if (result.error) { ui.warn(result.error); return; }
      if (result.rules) policy.rules = result.rules;    // the edited book takes effect on the next tool call
      applyPermissionChoice(cfg, result.mode);
      // A remembered mode is also this project's default from now on, so the loaded policy carries it
      // too: a later reload must not answer with the value the owner just replaced.
      if (result.saved) policy.mode = result.mode;
      if (result.cleared) policy.mode = null;
      if (result.saveError) ui.warn(result.saveError);
      if (result.declined) ui.warn("Full access was not enabled. Permission is ask before changes.");
      else if (result.saved) ui.done(`permission for this project: ${result.mode}`);
      else if (result.cleared) ui.done(`permission for this session: ${result.mode} · hcode will ask again next startup`);
      else if (result.changed) ui.done(`permission for this session: ${result.mode}`);
      else ui.info(`permission unchanged: ${result.mode}`);
    };
    const changeAgency = requested => {
      const raw = String(requested ?? "").trim();
      if (!/^[0-9]$/.test(raw)) { ui.warn("Use /permission 0-9. Level 9 also requires a process-start --agency-budget-usd ceiling."); return; }
      let level = Number(raw);
      if (level === 9 && !(cfg.agencyBudgetUsd > 0)) { ui.warn("Agency 9 has no owner-set budget ceiling; effective level remains 8."); level = 8; }
      if (!cfg.agencyCanon) cfg.agencyCanon = loadAgencyCanon();
      cfg.agencyCanon = cfg.agencyCanon.replace(/\n\n# Active grant[\s\S]*$/, "") + `\n\n# Active grant\nAgency level: ${level}/9. ${level === 9 ? `Owner-set financial ceiling: USD ${cfg.agencyBudgetUsd}.` : "Financial authority is locked."}`;
      cfg.agencyLevel = level; applyAgencyGrant(cfg, { agencyLevel: level, agencyBudgetUsd: level === 9 ? cfg.agencyBudgetUsd : null, unattended: cfg.unattended });
      session.emit("agency.level.changed", { level, budgetUsd: level === 9 ? cfg.agencyBudgetUsd : null, scope: "session" });
      ui.done(`agency for this session: ${level}/9`);
    };
    const openConfig = async () => {
      ui.block(`Configuration for this session\n  permission  ${cfg.mode}\n  model       ${cfg.model}\n  effort      ${cfg.effort}\n  detail      ${ui.isVerbose() ? "verbose" : "quiet"}\n\nPersistent project safety stays in .hcode/policy.json. /permissions can remember a mode or ask again next startup.`);
      const choice = String(await ask("Choose [p]ermissions / [m]odel / [e]ffort / [v]erbose, or Enter to close\n> ") || "").trim().toLowerCase();
      if (/^(p|permission|permissions)$/.test(choice)) await changePermission();
      else if (/^(m|model)$/.test(choice)) {
        const model = String(await ask(`Model id (current: ${cfg.model}; Enter keeps it)\n> `) || "").trim();
        if (!model) ui.info(`model unchanged: ${cfg.model}`);
        else if (/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) { cfg.model = model; ui.done(`model for this session: ${model}`); }
        else ui.warn("Model id may contain letters, numbers, dot, underscore, colon, slash and dash.");
      } else if (/^(e|effort|thinking)$/.test(choice)) {
        const effort = String(await ask(`Reasoning effort [low/medium/high] (current: ${cfg.effort}; Enter keeps it)\n> `) || "").trim().toLowerCase();
        if (!effort) ui.info(`effort unchanged: ${cfg.effort}`);
        else if (["low", "medium", "high"].includes(effort)) { cfg.effort = effort; ui.done(`reasoning effort for this session: ${effort}`); }
        else ui.warn("Effort must be low, medium or high.");
      } else if (/^(v|verbose|detail)$/.test(choice)) { ui.setVerbose(!ui.isVerbose()); ui.done(`verbose activity: ${ui.isVerbose() ? "on" : "off"}`); }
      else if (choice) ui.warn("Choose permissions, model, effort or verbose.");
    };
    // esc esc (and /rewind): pick an earlier point, fork the thread there and put the files hcode
    // changed since back the way they were. The old thread is never destroyed — it stays in
    // `hcode sessions` — and a file someone else touched is reported, not overwritten.
    let rewinding = false;
    const rewindNow = async () => {
      if (rewinding) return;
      if (current && !current.signal.aborted) { ui.warn("A turn is running. Esc stops it, then esc esc rewinds."); return; }
      rewinding = true;
      try {
        const result = await openRewind({ session, store: new SnapshotStore(session.dir), root: cfg.cwd, select, ask,
          show: text => ui.block(text), info: text => ui.info(text), warn: text => ui.warn(text) });
        if (result) { session = result.session; spend = sessionSpend(session.events); lastPrompt = 0; refreshMeter(); }
      } catch (error) { ui.error(error.message); }
      finally { rewinding = false; }
    };
    let lastUsage = null;
    // What this session has spent, in the four classes the brain bills, live. The context figure is
    // the same one the compactor decides on (max of the estimate and the last real prompt), so the
    // meter and the compaction it is warning about can never disagree. Never an action: the top band
    // says /handoff and nothing more — hcode does not clear or hand off a conversation by itself.
    let spend = sessionSpend(session.events);
    let lastPrompt = 0;
    const refreshMeter = () => {
      // Presence watches whichever thread the owner is on. hcode's own brain attaches itself
      // (agent.js), so what is left over is a session whose brain is claude or codex: its child
      // ledger is still this thread's, and without this the board under the input box would stay
      // empty for exactly the sessions that spawn the most helpers. It sits with the meter because
      // the meter is already "re-read the thread" — both are stale the moment /clear or /resume
      // hands `session` a different object, and the same call sites fix both. observe() is
      // idempotent by thread, so saying it again costs one comparison.
      if (cfg.runner !== "hcode") presence.observe(session);
      if (!composer) return;
      const tokens = Math.max(estimateTokens(session.messages), lastPrompt);
      composer.setMeter(contextMeter({ tokens, window: effectiveBudget(cfg), spend, prices: cfg.prices,
        model: cfg.model, effort: cfg.effort, sessionMode: currentMode(session), permission: cfg.mode }));
    };
    let lastTurnFailed = false;
    const runOne = async (prompt, images = []) => {
      const t0 = Date.now();
      lastTurnFailed = false;
      ui.turnStart();
      try { const r = await runTurn(prompt, { askUser, confirm, approveWorkspace, images }); lastUsage = { usage: r.usage, ms: Date.now() - t0 }; for (const key of Object.keys(spend)) spend[key] += Number(r.usage?.[key] || 0); lastPrompt = Math.max(Number(r.contextTokens || 0), 0); if (ui.isVerbose()) ui.usage(r.usage, lastUsage.ms); if (r.truncated) ui.error(`stopped after ${cfg.maxTurns} steps — say "continue" to go on`); if (r.cancelled) ui.warn("turn cancelled; what was running is marked cancelled in the session"); return r.truncated || r.cancelled ? 1 : 0; }
      catch (e) {
        lastTurnFailed = true;
        if (e?.status === 401 || e?.status === 403) ui.brainDisconnected(brainChoices(cfg));
        else if (e?.code === "workspace_denied") ui.warn("Not run. Choose another folder or use /brain to choose another brain.");
        else ui.error(e.message);
        return 1;
      } finally { ui.turnEnd(); refreshMeter(); }
    };
    if (task) { const taskExitCode = await runOne(task); close(); return bridgeExitCode ?? taskExitCode; }
    const handleLine = async (line, images = [], { startup = false } = {}) => {
      if (!line && !images.length) return false;
      if (images.length && line.startsWith("/")) ui.warn("Pasted images are sent with ordinary requests, not slash commands.");
      if (line === "/exit" || line === "/quit" || line === "/q") return true;
      if (line === "/logout") { const name = cfg.hoopName || cfg.defaultHoop; if (name) await logoutHoop(name); forgetDefaultHoop(); ui.done("Logged out on this machine. Claude Code and Codex logins were not changed."); return true; }
      if (line.startsWith("/login ")) {
        const name = line.slice(7).trim();
        try {
          ui.info("Opening hoopgram.ai account approval. Your Hoop desktop login is separate; if hoopgram.ai is not signed in, its email link is expected.");
          const account = await loginHoop(name, { onCode: ({ userCode, verificationUri }) => ui.info(`Browser sign-in: ${verificationUri}\nconfirmation code: ${userCode}`) });
          tunnel?.close(); tunnel = null; applyHoopSession(cfg, account); saveDefaultHoop(account.hoop); ui.done(`Connected ${account.hoop}.hoopgram.ai.`);
        } catch (error) { ui.error(error.message); }
        return false;
      }
      if (line === "/compact") { const event = compactNow(session, cfg); lastPrompt = 0; refreshMeter(); event ? ui.done("Context compacted. Important requests, decisions, files and completed actions remain.") : ui.info("Context is already compact."); return false; }
      // /handoff [done|active] [task] — the ledger is written from the event log and this process, and
      // nothing else happens: hcode says the session can be restarted and never restarts it.
      if (line === "/handoff" || line.startsWith("/handoff ")) {
        try {
          const words = line.slice(9).trim().split(/\s+/).filter(Boolean);
          const wanted = ["done", "active"].includes(words[0]) ? words.shift() : "";
          const evidence = threadEvidence(session);
          const status = wanted || suggestStatus(evidence);
          const facts = await collectFacts(cfg.cwd);
          const result = writeLedger({ session, cfg, settings, task: words.join(" "), status, facts,
            baseline: baselineConfig(), lookup: findBinary });
          ui.done(`${result.existed ? "Updated" : "Wrote"} ${result.file} (${result.bytes} bytes, 状态: ${status}${wanted ? "" : " — evidence says so; /handoff done|active overrides"}).`);
          ui.block(["Restart this work in a fresh session with one line:", "", "  " + result.restart, "",
            `Nothing was cleared. /clear starts fresh here, \`hcode --resume ${session.id}\` reopens this thread, and a 状态: done ledger is filed away by the next /continue.`].join("\n"));
        } catch (error) { ui.error(error.message); }
        return false;
      }
      // /continue [filter] — file what is finished, open the newest ledger that is not, restore its mode.
      if (line === "/continue" || line.startsWith("/continue ")) {
        try {
          const filter = line.slice(10).trim();
          const root = ledgerRoot(cfg.cwd, settings);
          const result = continueFrom(root, { filter });
          ui.block(formatContinue(result, { root, filter }));
          // Filing a finished ledger is the moment its thread's snapshot blobs stop being spoken for.
          // Best-effort by construction: the ledgers are already moved, and a store that cannot be
          // reclaimed must never turn a successful archive into a failed /continue — the TTL backstop
          // and `hcode --reclaim` both still apply.
          const retire = retiredThreads(result.archived, { keep: session.id });
          if (retire.length) {
            try {
              const swept = reclaimSnapshots({ dir: cfg.sessionsDir, retire });
              if (swept.removed) ui.info(formatReclaim(swept));
            } catch { /* the archive stands; the store is collected on close or by --reclaim */ }
          }
          if (result.ledger) {
            const restored = ["savetoken", "default"].includes(result.ledger.mode) ? result.ledger.mode : "default";
            if (restored !== currentMode(session)) { setMode(session, restored); applyMode(cfg, restored); ui.info(modeNotice(restored)); }
            ui.info(`Read ${result.ledger.file} — the whole ledger is that file; nothing was sent to the brain.`);
          }
        } catch (error) { ui.error(error.message); }
        return false;
      }
      if (line === "/handoffs") { const root = ledgerRoot(cfg.cwd, settings); ui.block(formatLedgers(listLedgers(root), { root })); return false; }
      // /savetoken and /usedefault may prefix the request they modify: `/savetoken fix this`
      // changes the mode first, then sends only `fix this`. The switch is still recorded on the
      // thread, so --resume and /continue restore it whether or not this invocation carried work.
      const modeCommand = /^\/(savetoken|usedefault)(?:\s+([\s\S]*))?$/.exec(line);
      if (modeCommand) {
        const wanted = modeCommand[1] === "savetoken" ? "savetoken" : "default";
        if (wanted === currentMode(session)) ui.info(`Already in ${wanted} mode. ${modeNotice(wanted)}`);
        else { setMode(session, wanted); applyMode(cfg, wanted); ui.done(modeNotice(wanted)); }
        refreshMeter();
        const prompt = modeCommand[2] || "";
        if (prompt || images.length) await runOne(prompt, images);
        return false;
      }
      if (line === "/clear") {
        const mode = currentMode(session);
        session.checkpoint("cleared by owner");
        session = new Session(cfg.sessionsDir, null, { cwd: cfg.cwd, runner: cfg.runner, model: cfg.model, effort: cfg.effort, tokenBudget: cfg.tokenBudget });
        spend = sessionSpend(session.events);
        if (mode !== "default") setMode(session, mode);            // /clear frees the context, it does not undo a mode
        lastPrompt = 0; refreshMeter();                            // the meter reads the new, empty thread
        ui.done(`Started a fresh conversation${mode === "default" ? "" : ` in ${mode} mode`}. The previous session remains available in \`hcode sessions\`.`);
        return false;
      }
      if (line === "/rewind") { await rewindNow(); return false; }
      if (line === "/config") { await openConfig(); refreshMeter(); return false; }
      if (line === "/context") { const work = openWork(cfg.cwd); const waiting = work ? Object.values(work.state.lanes).filter(lane => lane.waitingOn).map(lane => `${lane.id}→${lane.waitingOn}`).join(", ") : ""; ui.block(contextSummary(session, cfg, { estimatedTokens: estimateTokens(session.messages), budget: effectiveBudget(cfg), instructionChars: projectContext(cfg.cwd).length }) + `\n  mode        ${currentMode(session)}\n  task contract ${work ? `complete · ${work.id} · checkpoint seq ${work.seq}${waiting ? ` · waiting ${waiting}` : ""}` : "none"}`); return false; }
      if (line === "/init") { try { const result = initializeProject(cfg.cwd); result.created ? ui.done(result.message) : ui.warn(result.message); } catch (error) { ui.error(error.message); } return false; }
      if (line === "/diff") {
        const label = "Checking Git changes"; ui.toolStart(label, ["read"]);
        try { const diff = await projectDiff(cfg.cwd); ui.toolEnd(label, "", { state: "done" }); ui.block(diff); }
        catch (error) { ui.toolEnd(label, "", { state: "failed" }); ui.error(error.message); }
        return false;
      }
      if (line === "/review") {
        const previous = cfg.mode; cfg.mode = "read";
        ui.info("Review mode: read-only. hcode will inspect current changes and report findings without editing.");
        try { await runOne("Review the current uncommitted changes. Inspect the Git diff and relevant files. Do not modify anything. Report concrete bugs, regressions, security risks and missing tests first, with file references; say clearly if you find none."); }
        finally { cfg.mode = previous; }
        return false;
      }
      if (line === "/work") { ui.block(formatWork(openWork(cfg.cwd), { columns: process.stdout.columns || 80 })); return false; }
      if (line === "/plan") { const work = openWork(cfg.cwd); ui.block(work ? formatPlan(work.contract) : "No proposed plan. Use /plan <goal>."); return false; }
      if (line.startsWith("/plan ")) {
        const request = line.slice(6).trim();
        if (request === "approve") {
          const store = openWork(cfg.cwd);
          if (!store) { ui.warn("No plan to approve. Use /plan <goal> first."); return false; }
          if (store.state.status !== "proposed") { ui.warn(`Plan is already ${store.state.status}.`); return false; }
          store.append("plan.approved", { by: "owner" }); writeWorkStatus(store); const supervisor = launchSupervisor(store);
          ui.progress(`Approved ${store.id}. hcode supervisor ${supervisor.pid} is coordinating in the background; /work shows the durable state.`);
          return false;
        }
        try { const contract = proposeWork({ cwd: cfg.cwd, objective: request, runners: listRunners() }); new CoordinatorStore(cfg.cwd, contract); ui.block(formatPlan(contract)); }
        catch (error) { ui.error(error.message); }
        return false;
      }
      if (line === "/mcp" || line === "/connectors") {
        const label = "Checking connectors"; ui.toolStart(label, ["read"]);
        try {
          const rows = await listMcpConnectors({ cwd: cfg.cwd });
          ui.toolEnd(label, "", { state: rows.some(row => row.available && !row.ok) ? "failed" : "done" });
          ui.block(connectorsTable(rows));
        } catch (error) { ui.toolEnd(label, "", { state: "failed" }); ui.error(error.message); }
        return false;
      }
      if (line === "/model") {
        // the Hoop keyproxy whitelist plus whatever is currently set; any other id via `/model <id>`
        const known = [
          { id: "deepseek-v4-pro", description: "reasoning brain — best quality, slowest (thinking on by default)" },
          { id: "deepseek-v4-flash", description: "lighter tier, 1/3 the price — barely faster while thinking stays on" },
        ];
        if (!known.some(m => m.id === cfg.model)) known.unshift({ id: cfg.model, description: "the model this session is using now" });
        const options = known.map(m => ({ label: m.id, description: m.description, current: m.id === cfg.model }));
        const index = await selectOption({ title: "Model for this session", options, initial: options.findIndex(o => o.current),
          hint: "Enter confirms, Esc keeps the current model; any other id via /model <id>", select, ask, show: text => ui.block(text) });
        if (index !== null && options[index].label !== cfg.model) { cfg.model = options[index].label; ui.done(`model for this session: ${cfg.model}`); }
        else ui.info(`model unchanged: ${cfg.model}`);
        refreshMeter(); return false;
      }
      if (line.startsWith("/model ")) { const model = line.slice(7).trim(); if (/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) { cfg.model = model; ui.done(`model for this process: ${model}`); } else ui.error("invalid model id"); refreshMeter(); return false; }
      if (line === "/effort") {
        const tiers = [
          { id: "low", description: "fastest — on the DeepSeek brain this switches thinking off entirely (2.7× faster on the yardstick)" },
          { id: "medium", description: "balanced; DeepSeek keeps its default thinking" },
          { id: "high", description: "full reasoning — best for hard problems" },
        ];
        const options = tiers.map(t => ({ label: t.id, description: t.description, current: t.id === cfg.effort }));
        const index = await selectOption({ title: "Reasoning effort for this session", options, initial: options.findIndex(o => o.current),
          hint: "Enter confirms, Esc keeps the current effort", select, ask, show: text => ui.block(text) });
        if (index !== null && options[index].label !== cfg.effort) { cfg.effort = options[index].label; ui.done(`reasoning effort for this session: ${cfg.effort}`); }
        else ui.info(`reasoning effort unchanged: ${cfg.effort}`);
        refreshMeter(); return false;
      }
      if (line.startsWith("/effort ")) { const effort = line.slice(8).trim().toLowerCase(); if (["low", "medium", "high"].includes(effort)) { cfg.effort = effort; ui.done(`reasoning effort for this process: ${effort}`); } else ui.error("effort must be low, medium or high"); refreshMeter(); return false; }
      if (line === "/permissions") { await changePermission(); refreshMeter(); return false; }
      if (line === "/permission") { ui.info(`agency for this session: ${cfg.agencyLevel ?? 0}/9; use /permission 0-9 to change it`); return false; }
      if (line.startsWith("/permission ")) { changeAgency(line.slice(12)); return false; }
      if (line === "/doctor") { await doctor(cfg, { cli: args, json: false, write: value => ui.block(value) }); return false; }
      // /update never blocks the prompt on a network fetch: it reports the last background run (if
      // any), then — unless one is already in flight — starts a fresh one the same way /claude and
      // /codex start theirs, a detached re-invocation of hcode's own binary.
      if (line === "/update") {
        const previous = readUpdateState();
        if (previous) previous.status === "done" && previous.result?.ok ? ui.done(updateSummaryLine(previous)) : ui.info(updateSummaryLine(previous));
        const state = startBackgroundUpdate();
        if (!previous || state.startedAt !== previous.startedAt) ui.progress("update: checking for a fast-forward in the background");
        return false;
      }
      if (line === "/cost" || line.startsWith("/cost ")) {
        const days = Number(/--days\s+(\d+)/.exec(line)?.[1] || 0);      // /cost --days 7 → only sessions that started this week
        ui.block(formatCost(scanCosts(cfg.sessionsDir, { days })));
        return false;
      }
      // /tune proposes and never applies: a change to what hcode may do without asking is the owner's.
      if (line === "/tune" || line.startsWith("/tune ")) {
        const days = Number(/--days\s+(\d+)/.exec(line)?.[1] || 0);
        ui.block(formatTune(tuneReport(cfg.sessionsDir, { days })));
        return false;
      }
      if (line === "/resume" || line.startsWith("/resume ")) { const wanted = line.slice(7).trim() || Session.latest(cfg.sessionsDir); if (!wanted) ui.warn("No session to resume."); else try { session = new Session(cfg.sessionsDir, wanted); spend = sessionSpend(session.events); lastPrompt = 0; refreshMeter(); ui.done(`Resumed ${wanted}.`); } catch (error) { ui.error(error.message); } return false; }
      if (line === "/brain") { await chooseBrain(cfg, ask, { select }); refreshMeter(); return false; }
      if (line === "/agents") { ui.block(listRunners().filter(r => r.id !== "hcode").map(r => `${r.id.padEnd(7)} ${r.enabled && r.available ? color.green("[ready subagent]") : color.dim("[unavailable]")}  ${r.label}`).join("\n")); return false; }
      if (line === "/tasks") { const rows = listTasks(); const work = openWork(cfg.cwd); const waiting = work ? Object.values(work.state.lanes).filter(lane => lane.waitingOn).map(lane => `${lane.id}→${lane.waitingOn}`).join(", ") : ""; ui.block([...(work ? [`coordinator ${work.id}  ${work.state.status}  ${waiting || work.state.stopReason || "active"}`] : []), ...rows.map(taskSummary)].join("\n") || "(no background tasks or coordinated work)"); return false; }
      if (line.startsWith("/claude ") || line.startsWith("/codex ")) {
        const runner = line.startsWith("/claude ") ? "claude" : "codex";
        let flags; try { flags = parseDelegateFlags(line.slice(runner.length + 2)); } catch (error) { ui.error(error.message); return false; }
        if (!flags.prompt) { ui.error(`usage: /${runner} [--kind search|mechanical|implement | --model <id>] <task>`); return false; }
        // The brain is settled before the workspace question: a refused model never costs the owner a prompt.
        let chosen;
        try { chosen = resolveSubagentModel({ runner, model: flags.model, kind: flags.kind, task: flags.prompt, coordinatorModel: cfg.model, allowFlagship: flags.allowFlagship, tiers: subagentTiers(settings.subagentModels), syntax: "command", defaultKind: cfg.subagentDefaultKind || "" }); }
        catch (error) { ui.error(error.message); return false; }
        if (chosen.note) ui.info(chosen.note);
        let allowUnsafeWorkspace = false;
        try { assertSafeExternalWorkspace(cfg.cwd); } catch { allowUnsafeWorkspace = await approveWorkspace(cfg.cwd, runner); }
        if (!allowUnsafeWorkspace) { try { assertSafeExternalWorkspace(cfg.cwd); } catch { ui.warn("Background task not started."); return false; } }
        // Naming a flagship brain and paying for one are two decisions; --allow-flagship only made the first.
        const gate = spendGateFor({ runner, model: chosen.model, coordinatorModel: cfg.model });
        if (gate && !/^y(es)?$/i.test(String(await ask(ui.question(`${gate.why}. Start it anyway? [y/N]`)) || "").trim())) { ui.warn("Background task not started."); return false; }
        try { const state = startTask({ runner, prompt: flags.prompt, cwd: cfg.cwd, mode: cfg.mode, effort: cfg.effort, policy, allowUnsafeWorkspace, agencyLevel: cfg.agencyLevel ?? null, agencyBudgetUsd: cfg.agencyBudgetUsd ?? null, unattended: cfg.unattended, model: chosen.model, allowFlagship: true, spendApproved: Boolean(gate), coordinatorModel: cfg.model }); ui.progress(`${state.id} started in background on ${state.model}. /attach ${state.id} shows its work; /task ${state.id} <message> continues it.`); } catch (error) { ui.error(error.message); }
        return false;
      }
      // /btw: one aside question, answered by a one-off subagent. The answer is printed and kept in the
      // child ledger; it is deliberately never appended to this thread, so it costs one call and not a
      // permanent seat in every later prompt.
      if (line === "/btw" || line.startsWith("/btw ")) {
        let flags; try { flags = parseDelegateFlags(line.slice(4)); } catch (error) { ui.error(error.message); return false; }
        if (!flags.prompt) { ui.error("usage: /btw [--agent claude|codex] [--kind search|mechanical|implement | --model <id>] <question>"); return false; }
        const ready = listRunners().filter(runner => runner.id !== "hcode" && runner.enabled && runner.available);
        const runner = flags.agent || ready[0]?.id;
        if (!runner) { ui.error("No subagent is installed. /btw asks Claude Code or Codex; install one yourself, then `hcode runner add claude`."); return false; }
        const label = `Asking ${runner} aside`; ui.toolStart(label, ["external"]);
        // An aside spawns a foreign CLI and can take minutes; until now nothing could stop it, because
        // only a turn owned an AbortController. It takes the same one, so Esc (and Ctrl-C) reach it
        // through the existing cancel channel, and the child is marked cancelled in its own ledger.
        current = new AbortController();
        try {
          const aside = await askAside({ cfg, policy, session, runner, question: flags.prompt, model: flags.model, kind: flags.kind || cfg.subagentDefaultKind || "search",
            allowFlagship: flags.allowFlagship, tiers: subagentTiers(settings.subagentModels), run: runExternal, signal: current.signal });
          ui.toolEnd(label, "", { state: aside.cancelled ? "cancelled" : "done" });
          if (aside.cancelled) { ui.warn(`aside ${aside.childId} cancelled; nothing was added to this conversation`); return false; }
          ui.block(String(aside.text || "").trim() || "(the subagent answered nothing)");
          ui.info(`aside ${aside.childId} · ${runner} ${aside.model} · kept out of this conversation's context; /attach ${aside.childId} reopens it`);
        } catch (error) { ui.toolEnd(label, "", { state: current?.signal.aborted ? "cancelled" : "failed" }); if (current?.signal.aborted) ui.warn("aside cancelled"); else ui.error(error.message); }
        finally { current = null; }
        return false;
      }
      if (line.startsWith("/task ")) { const [, id, ...words] = line.split(/\s+/); try { const state = sendTask(id, words.join(" ")); ui.progress(`${state.id} continued in background.`); } catch (error) { ui.error(error.message); } return false; }
      if (line === "/attach" || line.startsWith("/attach ")) {
        const id = line.slice(8).trim();
        const children = childLedger(session);
        if (!id) { ui.block(formatSubagents({ children, tasks: listTasks().map(taskSummary) })); return false; }
        const child = children.find(row => row.childId === id);
        try {
          if (child) ui.block(openChild(child, { dir: path.join(cfg.sessionsDir, SUBAGENT_DIR) }));
          else if (id.startsWith("work-")) ui.block(formatWork(openWork(cfg.cwd, id), { columns: process.stdout.columns || 80 }));
          else { const state = readTask(id); const text = taskTranscript(id); ui.block(taskSummary(state) + (text ? "\n\n" + text.trimEnd() : "")); }
        } catch (error) { ui.error(error.message); }
        return false;
      }
      if (line.startsWith("/stop ")) { try { ui.info(taskSummary(stopTask(line.slice(6).trim()))); } catch (error) { ui.error(error.message); } return false; }
      if (line === "/status") { const name = cfg.hoopName || cfg.defaultHoop; ui.status(cfg, session.id, { runner: cfg.runner, network: policy.network.default, sandbox: sb.adapter, account: name ? describeHoopSession(name) : { connected: false } }); return false; }
      if (line === "/quota") {
        try {
          const authHeaders = cfg.apiKey ? { "x-api-key": cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` } : {};
          const r = await getJson(cfg, "/v1/quota", { headers: authHeaders, timeoutMs: 10000 });
          if (!r.ok) { ui.error(`quota not answerable (HTTP ${r.status})`); return false; }
          const q = await r.json();
          ui.info(`spend pool $${q.pool.usd.toFixed(2)} of $${q.pool.capUsd.toFixed(2)}/month${q.pool.usd >= q.pool.capUsd ? " — DRAINED: pool-backed models refused until the month rolls over" : ""}; byo $${Number(q.byo?.usd || 0).toFixed(2)} (${q.byo?.turns || 0} turns)`);
          for (const [id, p] of Object.entries(q.providers || {})) {
            const obs = p.quota?.state === "OBSERVED" ? `remaining ${p.quota.remaining}` : `UNOBSERVED — ${p.quota?.reason || "no observation"}`;
            ui.info(`  ${id}: ${p.kind} · ${obs}`);
          }
        } catch (error) { ui.error(`quota not answerable: ${error.message}`); }
        return false;
      }
      if (line === "/account") { const name = cfg.hoopName || cfg.defaultHoop; ui.account(name ? describeHoopSession(name) : { connected: false }); return false; }
      if (line === "/mode") { await changePermission(); refreshMeter(); return false; }
      if (line.startsWith("/mode ")) { await changePermission(line.slice(6).trim()); refreshMeter(); return false; }
      if (line === "/verbose" || line.startsWith("/verbose ")) { const wanted = line.split(/\s+/)[1]; ui.setVerbose(wanted ? /^(on|yes|1|true)$/i.test(wanted) : !ui.isVerbose()); ui.done(`verbose activity: ${ui.isVerbose() ? "on" : "off"}`); return false; }
      if (line === "/usage") { if (lastUsage) ui.usage(lastUsage.usage, lastUsage.ms); else ui.info("No turn usage yet in this process."); return false; }
      if (line === "/policy") { ui.block(JSON.stringify({ mode: cfg.mode, network: policy.network, allow: policy.allow, rules: policy.rules.map(rule => ({ action: rule.action, tool: rule.tool, ...(rule.command !== undefined ? { command: rule.command } : {}), ...(rule.path !== undefined ? { path: rule.path } : {}), source: rule.source })), gates: GATE_CLASSES, sandbox: `${policy.sandbox} → ${sb.adapter}${sb.degraded ? " (degraded)" : ""}` }, null, 2)); return false; }
      if (line === "/sessions") { ui.block(sessionsTable(Session.list(cfg.sessionsDir, 10))); return false; }
      if (line === "/help") { ui.block(helpText()); return false; }
      // /command: one line turns a prompt you keep retyping into /<name>. Nothing here executes.
      if (line === "/command" || line === "/commands" || line.startsWith("/command ")) {
        const rest = line.replace(/^\/commands?\s*/, "").trim();
        const [verb, ...tail] = rest.split(/\s+/);
        try {
          if (!verb || verb === "list") ui.block(customCommandsHelp(customCommands, { cwd: cfg.cwd }));
          else if (verb === "show") {
            const found = customCommands.find(command => command.name === tail[0]?.toLowerCase());
            found ? ui.block(`${found.file}${found.shadowed ? "  [shadowed by the built-in /" + found.name + "]" : ""}\n\n${found.body}`) : ui.warn(`No custom command /${tail[0] || ""}. /command list shows what there is.`);
          } else if (verb === "new" || verb === "add") {
            const spec = parseCommandNew(rest.slice(verb.length).replace(/^[ \t]+/, ""));
            const saved = saveCustomCommand({ cwd: cfg.cwd, scope: spec.scope, name: spec.name, body: spec.body, builtins: BUILTIN_NAMES });
            refreshCustomCommands();
            saved.shadowed ? ui.warn(saved.message) : ui.done(saved.message);
          } else ui.error("usage: /command new [--user] <name> <prompt> · /command list · /command show <name>");
        } catch (error) { ui.error(error.message); }
        return false;
      }
      if (line.startsWith("/")) {
        // Last, so a built-in always wins: a custom command runs its stored prompt as an ordinary turn.
        const custom = findCustomCommand(line, customCommands);
        if (custom) { await runOne(expandCustomCommand(custom, line.slice(custom.name.length + 1)), images); return false; }
        // A launch argument that matches no command name is a prompt, not a typo — the shell that
        // typed it had no completion to check it against, and refusing it would drop the whole
        // sentence. In the composer, where `/` completes as you type, an unknown name is far more
        // likely a slip, so that path still says so instead of spending a turn on it.
        if (startup) { await runOne(line, images); return false; }
        ui.warn(`Unknown command ${line.split(/\s+/, 1)[0]}. Type / to search or /help to list commands.`);
        return false;
      }
      await runOne(line, images);
      return false;
    };

    if (startupCommand && await handleLine(startupCommand, [], { startup: true })) { close(); return bridgeExitCode ?? 0; }

    if (!composer) {
      for (;;) {
        const line = await ask(ui.prompt());
        if (bridgeExitCode !== null) break;
        if (await handleLine(line)) break;
      }
      close(); return bridgeExitCode ?? 0;
    }

    // Observation is on from the first frame, not from the first turn: a resumed thread already
    // carries context, and the owner should see how much before they spend anything on it.
    refreshMeter();
    let exitCode = 0;
    await new Promise(resolve => {
      const queue = [];
      let draining = false; let stopped = false;
      const stop = code => {
        if (stopped) return;
        stopped = true; exitCode = code;
        composer.off("line", onLine); composer.off("paste-image", onPasteImage); composer.off("interrupt", onInterrupt); composer.off("cancel", onCancel); composer.off("eof", onEof); composer.off("rewind", onRewind); composer.off("editor", onEditor); composer.off("command", onCommand);
        requestInteractiveExit = null;
        close();
        resolve();
      };
      requestInteractiveExit = stop;
      const drain = async () => {
        if (draining || stopped) return;
        draining = true;
        while (queue.length && !stopped) {
          const { line, images } = queue.shift();
          composer.setQueueCount(queue.length);
          composer.setBusy(true);
          const shouldExit = await handleLine(line, images);
          composer.setBusy(false);
          if (shouldExit) { stop(0); break; }
        }
        draining = false;
      };
      const onLine = (line, images = []) => {
        if (line.trim()) ui.ownerLine(line);
        if (images.length) composer.print(images.map(formatAttachment).join("\n") + "\n");
        queue.push({ line, images }); composer.setQueueCount(queue.length - (draining ? 0 : 1)); void drain();
      };
      let imagePasteRunning = false;
      const onPasteImage = async () => {
        if (imagePasteRunning || stopped) return;
        if (composer.attachments.length >= MAX_IMAGES_PER_MESSAGE) { ui.warn(`A message can include at most ${MAX_IMAGES_PER_MESSAGE} images.`); return; }
        imagePasteRunning = true; composer.setAttachmentStatus("Reading image from clipboard…");
        try {
          const image = await attachmentStore.captureClipboard();
          if (!stopped) composer.addAttachment(image);
        } catch (error) {
          if (!stopped) { composer.setAttachmentStatus(""); ui.warn(error.message); }
        } finally { imagePasteRunning = false; }
      };
      const onInterrupt = () => handleInterrupt();
      const onCancel = () => handleCancel();
      const onEof = () => stop(0);
      // esc esc only reaches here on an idle composer, but a queued message may still be draining:
      // rewinding under a turn that is about to run would fork the thread out from under it.
      const onRewind = () => { if (!stopped && !draining && !queue.length) void rewindNow(); };
      // Ctrl-G: the draft goes to $EDITOR and comes back. The composer hands the terminal over and
      // takes it back; the temp file is this process's, mode 0600, and is removed either way — the
      // composer itself still never writes a draft to disk.
      let editing = false;
      const onEditor = draft => {
        if (editing || stopped) return;
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) { ui.warn("Ctrl-G needs $EDITOR (or $VISUAL) — for example `export EDITOR=vim`."); return; }
        editing = true;
        const file = path.join(os.tmpdir(), `hcode-draft-${process.pid}-${Date.now()}.md`);
        try {
          fs.writeFileSync(file, String(draft || ""), { mode: 0o600 });
          composer.suspend();
          const run = spawnSync(editor, [file], { stdio: "inherit", shell: !/^[\w./-]+$/.test(editor) });
          composer.resume();
          if (run.error) ui.warn(`Could not start ${editor}: ${run.error.message}`);
          else composer.setBuffer(fs.readFileSync(file, "utf8").replace(/\n+$/, ""));
        } catch (error) { composer.resume(); ui.warn(`Ctrl-G: ${error.message}`); }
        finally { try { fs.rmSync(file, { force: true }); } catch { /* the editor may have moved it */ } editing = false; }
      };
      // Ctrl-T and anything else that is really a slash command: the same queue an owner line takes.
      const onCommand = line => { if (!stopped) onLine(line); };
      composer.on("line", onLine); composer.on("paste-image", onPasteImage); composer.on("interrupt", onInterrupt); composer.on("cancel", onCancel); composer.on("eof", onEof); composer.on("rewind", onRewind); composer.on("editor", onEditor); composer.on("command", onCommand);
    });
    close(); return exitCode;
  } finally { process.off("SIGINT", onSigint); process.off("exit", cleanup); cleanup(); }
}
