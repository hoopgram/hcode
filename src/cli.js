// Command surface:
//   hcode                      interactive
//   hcode "task"               one task, then exit
//   hcode -p "task"            non-interactive print mode (scripts, routines): no confirmations, stdout only
//   hcode --resume [id|list]   reopen the latest (or given) session; `list` shows recent ones
//   hcode --runner codex|claude|direct  who runs the turn (default: first installed external CLI)
//   hcode connect <name> [...] use your Hoop as the brain through an SSH tunnel
//   hcode doctor · sessions · tools [--json] · runner list|add|remove <id> · --version · --help
//
// This file is the launch, and only the launch: read the arguments, settle the configuration and the
// agency grant, let a one-shot subcommand answer (cli-commands.js), attach a brain, then hand the
// process to one interactive session (cli-session.js). main() below is that order, in that order.
import { loadConfig, ensureHome, VERSION } from "./config.js";
import { loadPolicy } from "./policy.js";
import { openTunnel, brainDownHint, hoopHost } from "./connect.js";
import { listRunners } from "./runners.js";
import { brainChoices, needsBrainSetup, saveDefaultHoop } from "./brain.js";
import { loadHoopSession, applyHoopSession } from "./auth.js";
import { ui } from "./ui.js";
import { supportsComposer } from "./composer.js";
import { loadAgencyCanon, applyAgencyGrant } from "./agency.js";
import { applyPermissionChoice, chooseBrain, makeConfirm, setupPrompter } from "./cli-prompts.js";
import { answerLiveBenchmark, answerOneShot, helpText, sessionsTable, toolsTable } from "./cli-commands.js";
import { runSession } from "./cli-session.js";

// The catalog and the prompts moved into their own modules; these four stay exported here because
// this is the module their callers and tests already know by name. helpText is not among them: it
// had no export before the split and still has none, so the public surface is unchanged.
export { chooseBrain, makeConfirm, sessionsTable, toolsTable };

const safeHoopHost = name => { try { return hoopHost(name); } catch { return name; } };
const bridgeSuffix = tunnel => tunnel.viaBridge ? " (via ssh stdio bridge; sshd forbids port forwarding)" : "";
const busyPorts = tunnel => tunnel.reassigned ? ` (default ports busy; using localhost ${tunnel.localPort}/${tunnel.hoopLocalPort})` : "";

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

// ---- phase: what this process is, before it is anything else -------------------------------------

// Config, project policy and the agency grant this invocation was given, settled once so that every
// later phase reads the same answer. Returns an exit code instead of a context when the launch is
// refused: 64 for an argument hcode cannot honour, 78 for an agency canon that would not load.
async function openLaunch(args, sub) {
  let cfg;
  try { cfg = loadConfig(args); } catch (e) { ui.error(e.message); return { exitCode: 64 }; }
  ensureHome();
  // The identity beat belongs to launch itself, before a remembered Hoop opens a tunnel or setup
  // asks a question. Explicit subcommands/tasks stay immediate; an interactive resume still wakes.
  if (!sub && !args.print && !args.unattended && supportsComposer(process.stdin, process.stdout, process.env)) await ui.splash();
  const policy = loadPolicy(cfg.cwd);
  const offerStartupPermission = !cfg.modeExplicit && !policy.mode && !args.fullAgency && args.agencyLevel === undefined;
  if (policy.mode && !cfg.modeExplicit) {
    cfg.mode = policy.mode;     // policy.json sets the project default; --mode / HCODE_MODE win
  }
  cfg.policy = policy;
  if (args.fullAgency || args.agencyLevel !== undefined) {
    let requested = args.fullAgency ? 8 : args.agencyLevel;
    if (!Number.isInteger(requested) || requested < 0 || requested > 9) { ui.error("--agency must be an integer from 0 to 9"); return { exitCode: 64 }; }
    if (requested === 9 && !(args.agencyBudgetUsd > 0)) { ui.warn("agency 9 needs a positive --agency-budget-usd; using agency 8"); requested = 8; }
    try { cfg.agencyCanon = loadAgencyCanon(); } catch (error) { ui.error(error.message); return { exitCode: 78 }; }
    cfg.agencyLevel = requested;
    cfg.agencyCanon += `\n\n# Active grant\nAgency level: ${requested}/9. ${requested === 9 ? `Owner-set financial ceiling: USD ${args.agencyBudgetUsd}.` : "Financial authority is locked."}`;
    applyAgencyGrant(cfg, { agencyLevel: requested, agencyBudgetUsd: requested === 9 ? args.agencyBudgetUsd : null, unattended: args.unattended });
  } else if (cfg.mode === "all") {
    try { applyPermissionChoice(cfg, "all"); } catch (error) { ui.error(error.message); return { exitCode: 78 }; }
  }
  if (args.unattended) cfg.unattended = true;
  if (cfg.runner === "hcode" && needsBrainSetup(cfg) && cfg.defaultHoop) {
    const account = loadHoopSession(cfg.defaultHoop);
    if (account) applyHoopSession(cfg, account);
  }
  return { exitCode: null, cfg, policy, offerStartupPermission };
}

// ---- phase: the brain on the other end -----------------------------------------------------------

// `hcode connect <hoop>` opens the tunnel and remembers the Hoop; a plain `hcode` reopens whichever
// Hoop is already remembered. Local files and subagents stay on this machine either way.
async function attachBrain({ sub, args, cfg }) {
  let tunnel = null;
  if (sub === "connect") {
    const name = args._[1]; if (!name) { ui.error("usage: hcode connect <hoop-name> [task]"); return { exitCode: 64 }; }
    try { tunnel = await openTunnel({ name, user: args.user, localPort: args.port, hoopLocalPort: args.hoopPort, identity: args.identity, autoPort: args.port === undefined && args.hoopPort === undefined }); }
    catch (e) { ui.error(e.message); return { exitCode: 1 }; }
    if (!tunnel.brainAlive) {
      ui.error(tunnel.hint || brainDownHint(tunnel.host, tunnel.user, tunnel.remotePort));
      tunnel.close(); tunnel = null;
      return { exitCode: 1 };
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
        return { exitCode: 1 };
      }
    }
  }
  return { exitCode: null, tunnel };
}

// A coordinator with no brain cannot start. On a terminal, offer the same picker `hcode setup` uses;
// anywhere a question would go unread (a pipe, -p, a resume) say what is missing and exit 78.
async function ensureBrainReady({ cfg, args }) {
  if (!(cfg.runner === "hcode" && needsBrainSetup(cfg))) return null;
  if (process.stdin.isTTY && !args.print && !args.resume) {
    const { ask, select, close } = setupPrompter();
    try {
      if (!(await chooseBrain(cfg, ask, { required: true, select }))) return 1;
    } finally { close(); }
    return null;
  }
  ui.brainUnavailable(brainChoices(cfg));
  return 78;
}

// A foreign runner the owner removed, or never installed, is refused here rather than at the first
// turn: hcode never installs another vendor's CLI for you.
function ensureRunnerAvailable({ cfg, tunnel }) {
  if (cfg.runner === "hcode") return null;
  const r = listRunners().find(x => x.id === cfg.runner);
  if (!r || !r.enabled) { ui.error(`${cfg.runner} was removed from hcode — \`hcode runner add ${cfg.runner}\` to enable it again, or use --runner direct`); tunnel?.close(); return 64; }
  if (!r.available) { ui.error(`${r.label} is not installed (no \`${cfg.runner}\` on PATH). hcode never installs it for you; install it, or use --runner direct`); tunnel?.close(); return 64; }
  return null;
}

// ---- the launch ------------------------------------------------------------------------------------

export async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { ui.error(e.message); return 64; }
  if (args.help) { console.log(helpText()); return 0; }
  if (args.version) { console.log(VERSION); return 0; }
  // One spelling, one handler: `launch` is only transport sugar for the durable background-task
  // path, so it cannot create a second workspace approval, spend gate or ledger implementation.
  if (args._[0] === "launch") args._ = ["task", "start", ...args._.slice(1)];
  const sub = args._[0];

  const launch = await openLaunch(args, sub);
  if (launch.exitCode !== null) return launch.exitCode;
  const { cfg, policy, offerStartupPermission } = launch;

  const answered = await answerOneShot({ sub, args, cfg, policy });
  if (answered !== null) return answered;

  const brain = await attachBrain({ sub, args, cfg });
  if (brain.exitCode !== null) return brain.exitCode;
  const tunnel = brain.tunnel;

  // `hcode "/continue parser"` is a slash command, not a prompt: it runs on the fresh session and then
  // hands the terminal over, which is what makes a handoff's restart line one paste instead of two.
  // The name is matched first and only then decided on: an argument naming no command is sent whole
  // as an ordinary prompt (see handleCustomCommand's `startup`), because nothing at the shell could
  // complete it. `connect` has already spliced its own two words out of args._ by now.
  let task = args._.join(" ").trim();
  let startupCommand = "";
  if (!args.print && task.startsWith("/")) { startupCommand = task; task = ""; }

  const brainReady = await ensureBrainReady({ cfg, args });
  if (brainReady !== null) return brainReady;

  const runnerReady = ensureRunnerAvailable({ cfg, tunnel });
  if (runnerReady !== null) return runnerReady;

  const benchmarked = await answerLiveBenchmark({ sub, args, cfg, tunnel });
  if (benchmarked !== null) return benchmarked;

  return await runSession({ args, cfg, policy, tunnel, task, startupCommand, offerStartupPermission });
}
