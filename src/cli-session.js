// One interactive session, in the order it happens: open the thread → choose a render path → answer
// the startup permission → attach the channels that can ask the owner something → feed the loop.
// The phases share one named context object rather than a closure, because four of the values move
// underneath them — the thread itself (/clear, /resume, esc esc), its spend, its last prompt size,
// and the AbortController of the turn that is running right now.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, loadProjectSettings, normalizeRunner, DIRECT_RUNNER, EFFORT_LEVELS } from "./config.js";
import { getJson } from "./api.js";
import { Session } from "./session.js";
import { scanCosts, formatCost, contextMeter, sessionSpend } from "./cost.js";
import { runAgent, compactNow, estimateTokens, effectiveBudget, projectContext, MAX_CONTINUATIONS } from "./agent.js";
import { doctor } from "./doctor.js";
import { GATE_CLASSES } from "./gates.js";
import { listRunners, findBinary, runExternal, lastForeignSession, assertSafeExternalWorkspace } from "./runners.js";
import { brainChoices, saveDefaultHoop, forgetDefaultHoop } from "./brain.js";
import { startTask, sendTask, stopTask, readTask, listTasks, taskTranscript, taskSummary, spendGateFor } from "./tasks.js";
import { startBackgroundUpdate, readUpdateState, updateSummaryLine } from "./update.js";
import { loginHoop, logoutHoop, applyHoopSession, describeHoopSession } from "./auth.js";
import * as sandbox from "./sandbox.js";
import { ui, color, renderDiff } from "./ui.js";
import { TerminalComposer, supportsComposer } from "./composer.js";
import { BUILTIN_NAMES, setCustomCommands } from "./commands.js";
import { customCommandsHelp, expandCustomCommand, findCustomCommand, loadCustomCommands, parseCommandNew, saveCustomCommand } from "./custom-commands.js";
import { formatTune, tuneReport } from "./tune.js";
import { chooseStartupPermission, confirmPermissionMode, openPermissions } from "./permissions.js";
import { selectOption } from "./select.js";
import { listMcpConnectors, connectorsTable } from "./connectors.js";
import { initializeProject, projectDiff, contextSummary } from "./project-commands.js";
import { collectFacts, continueFrom, formatContinue, formatLedgers, ledgerRoot, listLedgers, retiredThreads, suggestStatus, threadEvidence, writeLedger } from "./handoff.js";
import { applyMode, currentMode, modeNotice, setMode } from "./modes.js";
import { SUBAGENT_DIR, askAside, childLedger, formatSubagents, openChild, parseDelegateFlags, resolveSubagentModel, subagentTiers } from "./subagents.js";
import { AttachmentStore, MAX_IMAGES_PER_MESSAGE, formatAttachment } from "./attachments.js";
import { CoordinatorStore } from "./coordinator.js";
import { formatPlan, formatWork, openWork, proposeWork } from "./work.js";
import { launchSupervisor, writeWorkStatus } from "./supervise.js";
import { SnapshotStore, openRewind, reclaimOnClose, reclaimSnapshots, formatReclaim } from "./rewind.js";
import { runMission } from "./mission.js";
import { loadAgencyCanon, applyAgencyGrant } from "./agency.js";
import { presence } from "./presence.js";
import { prompter, makeConfirm, chooseBrain, applyPermissionChoice } from "./cli-prompts.js";
import { helpText, sessionsTable } from "./cli-commands.js";

// What a plain `hcode` in this environment would give a session. A handoff's restart line repeats only
// the flags this session actually moved away from that, so the line stays one paste long.
const baselineConfig = () => { try { return loadConfig({}); } catch { return {}; } };

// ---- the context ------------------------------------------------------------------------------

function openSessionContext({ args, cfg, policy, tunnel, task, startupCommand, offerStartupPermission }) {
  const ctx = {
    args, cfg, policy, tunnel, task, startupCommand, offerStartupPermission,
    settings: loadProjectSettings(cfg.cwd),
    customCommands: [],
    attachmentStore: null,
    session: null,
    current: null,               // AbortController of the running turn (Ctrl-C cancels it; a second Ctrl-C exits)
    spend: null, lastPrompt: 0, lastUsage: null,
    composer: null, ask: null, close: null, select: null,   // select: arrow-key menu, only when a composer is present
    lastInterrupt: 0, requestInteractiveExit: null, bridgeExitCode: null, rewinding: false,
    sb: null, workspaceApprovals: new Set(),
  };
  // The owner's own commands join the slash catalog before the composer is built, and again whenever
  // one is saved, so a command written mid-session is in the popup on the next keystroke.
  ctx.refreshCustomCommands = () => { ctx.customCommands = loadCustomCommands(cfg.cwd, { builtins: BUILTIN_NAMES }); setCustomCommands(ctx.customCommands); return ctx.customCommands; };
  ctx.refreshCustomCommands();
  ctx.cleanup = () => { ctx.attachmentStore?.cleanup(); ctx.attachmentStore = null; ctx.tunnel?.close(); };
  ctx.handleInterrupt = () => interruptSession(ctx);
  ctx.handleCancel = () => cancelTurn(ctx);
  ctx.sb = sandbox.detect(policy.sandbox);
  return ctx;
}

function interruptSession(ctx) {
  const now = Date.now();
  if (now - ctx.lastInterrupt <= 1500) {
    ctx.requestInteractiveExit?.(130);
    if (!ctx.requestInteractiveExit) { ctx.cleanup(); process.exit(130); }
    return;
  }
  ctx.lastInterrupt = now;
  if (ctx.current && !ctx.current.signal.aborted) {
    ctx.current.abort();
    ui.warn("Cancelling this turn… Press Ctrl-C again to exit.");
  } else ui.warn("Press Ctrl-C again to exit Hoop Code.");
}

// Esc stops the turn and nothing else: it never arms the 1.5s double press, so it can never
// exit hcode. Everything after the abort (the cancelled marks, the notice) is Ctrl-C's path.
function cancelTurn(ctx) {
  if (ctx.current && !ctx.current.signal.aborted) { ctx.current.abort(); ui.warn("Cancelling this turn…"); }
}

// ---- phase: the thread ---------------------------------------------------------------------------

export function openThread(ctx) {
  const { args, cfg } = ctx;
  if (args.resume) {
    const id = args.resume === true ? Session.latest(cfg.sessionsDir) : String(args.resume);
    if (!id) { ui.error("no session to resume (hcode sessions)"); return 1; }
    try { ctx.session = new Session(cfg.sessionsDir, id); } catch (e) { ui.error(`cannot open session ${id}: ${e.message}`); return 1; }
    // the session's own agency grant wins over the ask default on resume — a supervisor's
    // `hcode --resume <id> -p …` must not silently drop the --agency the mission started with
    const grant = ctx.session.agencyGrant();
    if (grant && args.agencyLevel === undefined && !args.fullAgency) {
      applyAgencyGrant(cfg, grant);
      ui.info(`resuming with this session's agency grant: level ${grant.agencyLevel}/9 (mode ${cfg.mode}${cfg.unattended ? ", unattended" : ""})`);
    }
    if (args.resume === true && !args.print) { const recent = Session.list(cfg.sessionsDir, 5); if (recent.length > 1) ui.info("recent sessions (resuming the first; `hcode --resume <id>` picks another):\n" + sessionsTable(recent)); }
  } else ctx.session = new Session(cfg.sessionsDir, null, { cwd: cfg.cwd, runner: cfg.runner, model: cfg.model, effort: cfg.effort, tokenBudget: cfg.tokenBudget });
  // A mode is a property of the conversation, so a resumed thread comes back in the mode it was in.
  applyMode(cfg, currentMode(ctx.session));
  // Detection chooses an executor for a new thread only. A resume keeps the executor recorded by
  // that thread when it is still usable; otherwise a foreign CLI would start an unrelated history.
  // An explicit CLI/env/saved choice still wins, and an unavailable recorded runner is not revived.
  if (args.resume && !cfg.runnerExplicit) {
    const threadRunner = normalizeRunner(ctx.session.header?.runner || "");
    const usable = threadRunner === DIRECT_RUNNER || listRunners().some(r => r.id === threadRunner && r.enabled && r.available);
    if (threadRunner && threadRunner !== cfg.runner && usable) {
      cfg.runner = threadRunner;
      if (!args.print) ui.info(`resuming with this thread's runner: ${threadRunner === DIRECT_RUNNER ? "direct" : threadRunner}`);
    }
  }
  return null;
}

// ---- phase: one turn -----------------------------------------------------------------------------

// The single place a request reaches a brain, whichever brain that is: hcode's own kernel, or a
// foreign CLI bounded by this project's policy. Both hand the AbortController to the cancel channel.
function attachTurnRunner(ctx) {
  const { cfg, policy, settings } = ctx;
  ctx.runTurn = async (prompt, { askUser = null, confirm = null, approveWorkspace = null, quiet = false, images = [] } = {}) => {
    ctx.current = new AbortController();
    try {
      if (cfg.runner !== "hcode") {
        const approvalKey = `${cfg.runner}:${cfg.cwd}`;
        if (!ctx.workspaceApprovals.has(approvalKey)) {
          try { assertSafeExternalWorkspace(cfg.cwd); }
          catch {
            if (!approveWorkspace) throw Object.assign(new Error("this workspace needs owner approval; run hcode interactively"), { code: "workspace_approval_required" });
            const allowed = await approveWorkspace(cfg.cwd, cfg.runner);
            ctx.session.emit("workspace.approval", { runner: cfg.runner, cwd: cfg.cwd, decision: allowed ? "allow" : "deny", scope: "session" });
            if (!allowed) throw Object.assign(new Error("owner declined access to this workspace"), { code: "workspace_denied" });
            ctx.workspaceApprovals.add(approvalKey);
          }
        }
        if (!quiet) ui.info(`${cfg.runner} runs this turn (bounded by your policy: ${cfg.mode === "auto" || cfg.mode === "all" ? "may edit and run commands" : "read-only — it cannot ask you per action; use auto to let it write"}, network ${policy.network.default})`);
        let assistantOpen = false;
        const result = await runExternal({ id: cfg.runner, cfg, policy, session: ctx.session, prompt, images, signal: ctx.current.signal, resume: lastForeignSession(ctx.session, cfg.runner), allowUnsafeWorkspace: ctx.workspaceApprovals.has(approvalKey),
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
      return await runAgent({ cfg, settings, session: ctx.session, prompt, attachments: images, attachmentStore: ctx.attachmentStore, askUser, confirm, quiet, signal: ctx.current.signal,
        onEvent: quiet ? null : ev => {
          // auto mode shows the diff of each edit as it runs (ask mode already showed it in the permission prompt)
          if (ev.type === "item" && ev.item.kind === "tool_call" && ev.item.tool === "edit_file" && ev.item.state === "running" && cfg.mode !== "ask") { const c = ctx.session.calls.get(ev.item.id); if (c?.input) ui.block(renderDiff(c.input.old_string, c.input.new_string, 20)); }
          if (ev.type === "compaction") ui.info(`context compacted (${ev.estTokens} to budget ${ev.budget} tokens); facts and decisions stayed in the thread`);
        } });
    } finally { ctx.current = null; }
  };
}

// ---- phase: -p, the run with nobody watching -----------------------------------------------------

async function answerInPrintMode(ctx) {
  const { cfg, task } = ctx;
  if (!task) { ui.error("-p needs a task"); return 64; }
  const t0 = Date.now();
  // resume replays past calls into session.calls; snapshot what was already denied so
  // only refusals from THIS headless run are counted.
  const deniedBefore = new Set([...ctx.session.calls.values()].filter(c => c.state === "denied").map(c => c.id));
  const r = cfg.runner === "hcode" ? await runMission({ session: ctx.session, mission: task,
    runTurn: prompt => ctx.runTurn(prompt, { quiet: true }),
    budget: { steps: cfg.missionStepBudget, tokens: cfg.missionTokenBudget, wallMs: cfg.missionWallMs } }) : await ctx.runTurn(task, { quiet: true });
  if (cfg.runner !== "hcode" && r.text && !r.text.endsWith("\n")) process.stdout.write("\n");
  if (process.stderr.isTTY) ui.usage(r.usage, Date.now() - t0, { stderr: true });
  if (r.truncated) ui.error(r.truncatedBy === "max_tokens" ? `stopped: the reply hit the ${cfg.maxTokens}-token output cap ${MAX_CONTINUATIONS + 1} times (--max-tokens raises it)` : `stopped after ${cfg.maxTurns} steps (--max-turns raises it)`);
  if (r.stopped) ui.error(`objective stopped: ${r.stopReason} ${r.budget} budget exhausted; next: ${r.nextStep}`);
  // -p can never ask a human, so a permission refusal is a FAILED task, not a partial
  // answer that exits 0. Say which tools were refused and fail with a distinct code
  // (0 ok · 1 stopped/cancelled · 3 denied by the gate) so a headless worker can tell
  // "the gate refused this" from "the budget ran out" — and never silently retry.
  const refused = [...ctx.session.calls.values()].filter(c => c.state === "denied" && !deniedBefore.has(c.id));
  if (refused.length) {
    ui.error(`denied by the permission gate with no human to ask: ${[...new Set(refused.map(c => c.tool))].join(", ")}`);
    process.stderr.write(`hcode-print: denied=${refused.length}\n`);
  }
  if (r.truncated || r.stopped || r.cancelled) return 1;
  if (refused.length) return 3;
  return 0;
}

// ---- phase: which of the three render paths this sink gets ---------------------------------------

// ARCHITECTURE.md §3: this is the only place the composer path is chosen. Everything else — a pipe,
// a dumb terminal, NO_COLOR, or a task typed on the command line — takes readline, and ui.js decides
// within that whether the sink gets colour or plain copyable text. A task has no input box to draw,
// so it never gets a composer even on the most capable terminal.
export function chooseRenderPath({ task, stdin = process.stdin, stdout = process.stdout, env = process.env }) {
  return !task && supportsComposer(stdin, stdout, env) ? "composer" : "readline";
}

function openRenderPath(ctx) {
  const { cfg, policy, sb, task } = ctx;
  // The banner goes through the composer when there is one, so the composer knows the
  // transcript starts at the top of a freshly cleared page and can fill it downward.
  const showBanner = () => {
    ui.banner(cfg, ctx.session.id, { runner: cfg.runner, network: policy.network.default, sandbox: sb.adapter });
    if (sb.degraded) ui.warn(`sandbox: ${sb.reason} — commands run unconfined on this machine (policy still applies: network stays off, secrets refused by path)`);
    if (policy.problems.length) ui.warn(`policy.json: ${policy.problems.join("; ")} (ignored)`);
  };
  if (chooseRenderPath({ task }) === "composer") {
    ctx.attachmentStore = new AttachmentStore();
    const composer = new TerminalComposer();
    ctx.composer = composer;
    ui.attachComposer(composer);
    composer.start();
    showBanner();
    ui.intro();
    ctx.ask = question => composer.ask(question);
    ctx.select = spec => composer.select(spec);
    ctx.close = () => { composer.close(); ui.attachComposer(null); ctx.attachmentStore?.cleanup(); ctx.attachmentStore = null; };
    return;
  }
  const input = prompter();
  input.rl.on("SIGINT", ctx.handleInterrupt);
  // No composer, so read Esc off stdin ourselves: readline's keypress parser never reports a
  // lone Esc (it holds the byte until the next one arrives). Same rule as the composer — a
  // bare \x1b with nothing behind it within a keystroke is the key, not a sequence.
  let escapeTimer = null;
  const onStdin = chunk => {
    clearTimeout(escapeTimer); escapeTimer = null;
    if (String(chunk) === "\x1b") escapeTimer = setTimeout(() => { escapeTimer = null; ctx.handleCancel(); }, 40);
  };
  if (process.stdin.isTTY) process.stdin.on("data", onStdin);
  ctx.requestInteractiveExit = code => { ctx.bridgeExitCode = code; input.close(); };
  ctx.ask = input.ask;
  ctx.close = () => {
    input.rl.off("SIGINT", ctx.handleInterrupt); clearTimeout(escapeTimer);
    if (process.stdin.isTTY) process.stdin.off("data", onStdin);
    input.close(); ctx.requestInteractiveExit = null;
    // A session ending is the moment the snapshot store can be counted honestly. Bounded, best
    // effort, and never a reason to fail an exit — leaving hcode is not where a sweep gets to matter.
    try { reclaimOnClose(cfg.sessionsDir); } catch { /* the TTL backstop still applies */ }
  };
  showBanner();
  if (!task) ui.intro();
}

// ---- phase: the one permission question a launch is allowed to ask -------------------------------

async function settleStartupPermission(ctx) {
  const { cfg, policy, args, task, startupCommand, offerStartupPermission } = ctx;
  const shouldChooseStartupPermission = offerStartupPermission && process.stdin.isTTY && !task && !startupCommand && !args.resume && !cfg.unattended;
  if (shouldChooseStartupPermission) {
    const result = await chooseStartupPermission({ cwd: cfg.cwd, ask: ctx.ask, select: ctx.select, show: text => ui.block(text) });
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
}

// ---- phase: every way this session can ask the owner something -----------------------------------

function attachOwnerChannels(ctx) {
  const { cfg, policy, sb } = ctx;
  // Unattended (a supervisor watching a pane, no human): never inject the interactive confirm
  // callback. An ask then takes the honest "no human was available" refusal instead of recording
  // an automated keypress as a human decision — a bare Enter is a decision too (2026-08-28,
  // 张良 layer two: "not an unobserved failure, a recorded decision that looks human and is not").
  if (cfg.unattended) ui.warn("unattended: permission asks are refused honestly (no human present); nothing will be recorded as a human decision");
  ctx.confirm = cfg.unattended ? null : makeConfirm(ctx.ask);
  ctx.askUser = cfg.unattended ? null : (q => ctx.ask(ui.question(q)));
  ctx.approveWorkspace = async (cwd, runner) => /^y(es)?$/i.test(await ctx.ask(ui.workspacePermission(cwd, runner)));
  ctx.changePermission = async requested => {
    const options = { current: cfg.mode, cwd: cfg.cwd, sandbox: `${policy.sandbox} → ${sb.adapter}${sb.degraded ? " (degraded)" : ""}`, ask: ctx.ask, select: ctx.select, show: text => ui.block(text) };
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
  ctx.changeAgency = requested => {
    const raw = String(requested ?? "").trim();
    if (!/^[0-9]$/.test(raw)) { ui.warn("Use /permission 0-9. Level 9 also requires a process-start --agency-budget-usd ceiling."); return; }
    let level = Number(raw);
    if (level === 9 && !(cfg.agencyBudgetUsd > 0)) { ui.warn("Agency 9 has no owner-set budget ceiling; effective level remains 8."); level = 8; }
    if (!cfg.agencyCanon) cfg.agencyCanon = loadAgencyCanon();
    cfg.agencyCanon = cfg.agencyCanon.replace(/\n\n# Active grant[\s\S]*$/, "") + `\n\n# Active grant\nAgency level: ${level}/9. ${level === 9 ? `Owner-set financial ceiling: USD ${cfg.agencyBudgetUsd}.` : "Financial authority is locked."}`;
    cfg.agencyLevel = level; applyAgencyGrant(cfg, { agencyLevel: level, agencyBudgetUsd: level === 9 ? cfg.agencyBudgetUsd : null, unattended: cfg.unattended });
    ctx.session.emit("agency.level.changed", { level, budgetUsd: level === 9 ? cfg.agencyBudgetUsd : null, scope: "session" });
    ui.done(`agency for this session: ${level}/9`);
  };
  ctx.openConfig = async () => {
    ui.block(`Configuration for this session\n  permission  ${cfg.mode}\n  model       ${cfg.model}\n  effort      ${cfg.effort}\n  detail      ${ui.isVerbose() ? "verbose" : "quiet"}\n\nPersistent project safety stays in .hcode/policy.json. /permissions can remember a mode or ask again next startup.`);
    const choice = String(await ctx.ask("Choose [p]ermissions / [m]odel / [e]ffort / [v]erbose, or Enter to close\n> ") || "").trim().toLowerCase();
    if (/^(p|permission|permissions)$/.test(choice)) await ctx.changePermission();
    else if (/^(m|model)$/.test(choice)) {
      const model = String(await ctx.ask(`Model id (current: ${cfg.model}; Enter keeps it)\n> `) || "").trim();
      if (!model) ui.info(`model unchanged: ${cfg.model}`);
      else if (/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) { cfg.model = model; ui.done(`model for this session: ${model}`); }
      else ui.warn("Model id may contain letters, numbers, dot, underscore, colon, slash and dash.");
    } else if (/^(e|effort|thinking)$/.test(choice)) {
      // Changing effort starts a new prompt-cache prefix (api.js): the rest of this session
      // re-reads its history at full price, so say so instead of making it look free.
      const effort = String(await ctx.ask(`Reasoning effort [${EFFORT_LEVELS.join("/")}] (current: ${cfg.effort}; Enter keeps it; changing it re-reads this session's context at full price)\n> `) || "").trim().toLowerCase();
      if (!effort) ui.info(`effort unchanged: ${cfg.effort}`);
      else if (EFFORT_LEVELS.includes(effort)) { cfg.effort = effort; ui.done(`reasoning effort for this session: ${effort}`); }
      else ui.warn(`Effort must be one of ${EFFORT_LEVELS.join(", ")}.`);
    } else if (/^(v|verbose|detail)$/.test(choice)) { ui.setVerbose(!ui.isVerbose()); ui.done(`verbose activity: ${ui.isVerbose() ? "on" : "off"}`); }
    else if (choice) ui.warn("Choose permissions, model, effort or verbose.");
  };
}

// ---- phase: what a turn costs, and how to take one back ------------------------------------------

function attachThreadControls(ctx) {
  const { cfg } = ctx;
  // esc esc (and /rewind): pick an earlier point, fork the thread there and put the files hcode
  // changed since back the way they were. The old thread is never destroyed — it stays in
  // `hcode sessions` — and a file someone else touched is reported, not overwritten.
  ctx.rewindNow = async () => {
    if (ctx.rewinding) return;
    if (ctx.current && !ctx.current.signal.aborted) { ui.warn("A turn is running. Esc stops it, then esc esc rewinds."); return; }
    ctx.rewinding = true;
    try {
      const result = await openRewind({ session: ctx.session, store: new SnapshotStore(ctx.session.dir), root: cfg.cwd, select: ctx.select, ask: ctx.ask,
        show: text => ui.block(text), info: text => ui.info(text), warn: text => ui.warn(text) });
      if (result) { ctx.session = result.session; ctx.spend = sessionSpend(ctx.session.events); ctx.lastPrompt = 0; ctx.refreshMeter(); }
    } catch (error) { ui.error(error.message); }
    finally { ctx.rewinding = false; }
  };
  // What this session has spent, in the four classes the brain bills, live. The context figure is
  // the same one the compactor decides on (max of the estimate and the last real prompt), so the
  // meter and the compaction it is warning about can never disagree. Never an action: the top band
  // says /handoff and nothing more — hcode does not clear or hand off a conversation by itself.
  ctx.spend = sessionSpend(ctx.session.events);
  ctx.refreshMeter = () => {
    // Presence watches whichever thread the owner is on. hcode's own brain attaches itself
    // (agent.js), so what is left over is a session whose brain is claude or codex: its child
    // ledger is still this thread's, and without this the board under the input box would stay
    // empty for exactly the sessions that spawn the most helpers. It sits with the meter because
    // the meter is already "re-read the thread" — both are stale the moment /clear or /resume
    // hands `session` a different object, and the same call sites fix both. observe() is
    // idempotent by thread, so saying it again costs one comparison.
    if (cfg.runner !== "hcode") presence.observe(ctx.session);
    if (!ctx.composer) return;
    const tokens = Math.max(estimateTokens(ctx.session.messages), ctx.lastPrompt);
    ctx.composer.setMeter(contextMeter({ tokens, window: effectiveBudget(cfg), spend: ctx.spend, prices: cfg.prices,
      model: cfg.model, effort: cfg.effort, sessionMode: currentMode(ctx.session), permission: cfg.mode }));
  };
  ctx.runOne = async (prompt, images = []) => {
    const t0 = Date.now();
    ui.turnStart();
    try { const r = await ctx.runTurn(prompt, { askUser: ctx.askUser, confirm: ctx.confirm, approveWorkspace: ctx.approveWorkspace, images }); ctx.lastUsage = { usage: r.usage, ms: Date.now() - t0 }; for (const key of Object.keys(ctx.spend)) ctx.spend[key] += Number(r.usage?.[key] || 0); ctx.lastPrompt = Math.max(Number(r.contextTokens || 0), 0); if (ui.isVerbose()) ui.usage(r.usage, ctx.lastUsage.ms); if (r.truncated) ui.error(`stopped after ${cfg.maxTurns} steps — say "continue" to go on`); if (r.cancelled) ui.warn("turn cancelled; what was running is marked cancelled in the session"); return r.truncated || r.cancelled ? 1 : 0; }
    catch (e) {
      if (e?.status === 401 || e?.status === 403) ui.brainDisconnected(brainChoices(cfg));
      else if (e?.code === "workspace_denied") ui.warn("Not run. Choose another folder or use /brain to choose another brain.");
      else ui.error(e.message);
      return 1;
    } finally { ui.turnEnd(); ctx.refreshMeter(); }
  };
}

// ---- phase: the slash catalog --------------------------------------------------------------------
// Each group answers `true` (leave), `false` (handled, stay) or null (not mine). The order they are
// consulted in is the order the single if-chain used to be in; a built-in always wins over a custom
// command because the custom lookup is last.

// Leaving, and the HoopGram account this machine holds.
async function handleLeaveCommand(ctx, line) {
  const { cfg } = ctx;
  if (line === "/exit" || line === "/quit" || line === "/q") return true;
  if (line === "/logout") { const name = cfg.hoopName || cfg.defaultHoop; if (name) await logoutHoop(name); forgetDefaultHoop(); ui.done("Logged out on this machine. Claude Code and Codex logins were not changed."); return true; }
  if (line.startsWith("/login ")) {
    const name = line.slice(7).trim();
    try {
      ui.info("Opening hoopgram.ai account approval. Your Hoop desktop login is separate; if hoopgram.ai is not signed in, its email link is expected.");
      const account = await loginHoop(name, { onCode: ({ userCode, verificationUri }) => ui.info(`Browser sign-in: ${verificationUri}\nconfirmation code: ${userCode}`) });
      ctx.tunnel?.close(); ctx.tunnel = null; applyHoopSession(cfg, account); saveDefaultHoop(account.hoop); ui.done(`Connected ${account.hoop}.hoopgram.ai.`);
    } catch (error) { ui.error(error.message); }
    return false;
  }
  return null;
}

// The thread itself: what it carries, what it hands over, and how to put it back.
async function handleThreadCommand(ctx, line, images) {
  const { cfg, settings } = ctx;
  if (line === "/compact") { const event = compactNow(ctx.session, cfg); ctx.lastPrompt = 0; ctx.refreshMeter(); event ? ui.done("Context compacted. Important requests, decisions, files and completed actions remain.") : ui.info("Context is already compact."); return false; }
  // /handoff [done|active] [task] — the ledger is written from the event log and this process, and
  // nothing else happens: hcode says the session can be restarted and never restarts it.
  if (line === "/handoff" || line.startsWith("/handoff ")) {
    try {
      const words = line.slice(9).trim().split(/\s+/).filter(Boolean);
      const wanted = ["done", "active"].includes(words[0]) ? words.shift() : "";
      const evidence = threadEvidence(ctx.session);
      const status = wanted || suggestStatus(evidence);
      const facts = await collectFacts(cfg.cwd);
      const result = writeLedger({ session: ctx.session, cfg, settings, task: words.join(" "), status, facts,
        baseline: baselineConfig(), lookup: findBinary });
      ui.done(`${result.existed ? "Updated" : "Wrote"} ${result.file} (${result.bytes} bytes, 状态: ${status}${wanted ? "" : " — evidence says so; /handoff done|active overrides"}).`);
      ui.block(["Restart this work in a fresh session with one line:", "", "  " + result.restart, "",
        `Nothing was cleared. /clear starts fresh here, \`hcode --resume ${ctx.session.id}\` reopens this thread, and a 状态: done ledger is filed away by the next /continue.`].join("\n"));
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
      const retire = retiredThreads(result.archived, { keep: ctx.session.id });
      if (retire.length) {
        try {
          const swept = reclaimSnapshots({ dir: cfg.sessionsDir, retire });
          if (swept.removed) ui.info(formatReclaim(swept));
        } catch { /* the archive stands; the store is collected on close or by --reclaim */ }
      }
      if (result.ledger) {
        const restored = ["savetoken", "default"].includes(result.ledger.mode) ? result.ledger.mode : "default";
        if (restored !== currentMode(ctx.session)) { setMode(ctx.session, restored); applyMode(cfg, restored); ui.info(modeNotice(restored)); }
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
    if (wanted === currentMode(ctx.session)) ui.info(`Already in ${wanted} mode. ${modeNotice(wanted)}`);
    else { setMode(ctx.session, wanted); applyMode(cfg, wanted); ui.done(modeNotice(wanted)); }
    ctx.refreshMeter();
    const prompt = modeCommand[2] || "";
    if (prompt || images.length) await ctx.runOne(prompt, images);
    return false;
  }
  if (line === "/clear") {
    const mode = currentMode(ctx.session);
    ctx.session.checkpoint("cleared by owner");
    ctx.session = new Session(cfg.sessionsDir, null, { cwd: cfg.cwd, runner: cfg.runner, model: cfg.model, effort: cfg.effort, tokenBudget: cfg.tokenBudget });
    ctx.spend = sessionSpend(ctx.session.events);
    if (mode !== "default") setMode(ctx.session, mode);            // /clear frees the context, it does not undo a mode
    ctx.lastPrompt = 0; ctx.refreshMeter();                        // the meter reads the new, empty thread
    ui.done(`Started a fresh conversation${mode === "default" ? "" : ` in ${mode} mode`}. The previous session remains available in \`hcode sessions\`.`);
    return false;
  }
  if (line === "/rewind") { await ctx.rewindNow(); return false; }
  return null;
}

// This project: what hcode knows about it, what changed in it, and the coordinated work in flight.
async function handleProjectCommand(ctx, line) {
  const { cfg } = ctx;
  if (line === "/config") { await ctx.openConfig(); ctx.refreshMeter(); return false; }
  if (line === "/context") { const work = openWork(cfg.cwd); const waiting = work ? Object.values(work.state.lanes).filter(lane => lane.waitingOn).map(lane => `${lane.id}→${lane.waitingOn}`).join(", ") : ""; ui.block(contextSummary(ctx.session, cfg, { estimatedTokens: estimateTokens(ctx.session.messages), budget: effectiveBudget(cfg), instructionChars: projectContext(cfg.cwd).length }) + `\n  mode        ${currentMode(ctx.session)}\n  task contract ${work ? `complete · ${work.id} · checkpoint seq ${work.seq}${waiting ? ` · waiting ${waiting}` : ""}` : "none"}`); return false; }
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
    try { await ctx.runOne("Review the current uncommitted changes. Inspect the Git diff and relevant files. Do not modify anything. Report concrete bugs, regressions, security risks and missing tests first, with file references; say clearly if you find none."); }
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
  return null;
}

// What this session is set to and what it is allowed to do — all of it for this session only,
// except /permissions, which may be asked to remember a mode for the project.
async function handleSettingCommand(ctx, line) {
  const { cfg, args } = ctx;
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
      hint: "Enter confirms, Esc keeps the current model; any other id via /model <id>", select: ctx.select, ask: ctx.ask, show: text => ui.block(text) });
    if (index !== null && options[index].label !== cfg.model) { cfg.model = options[index].label; ui.done(`model for this session: ${cfg.model}`); }
    else ui.info(`model unchanged: ${cfg.model}`);
    ctx.refreshMeter(); return false;
  }
  if (line.startsWith("/model ")) { const model = line.slice(7).trim(); if (/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) { cfg.model = model; ui.done(`model for this process: ${model}`); } else ui.error("invalid model id"); ctx.refreshMeter(); return false; }
  if (line === "/effort") {
    const tiers = [
      { id: "low", description: "fastest — on the DeepSeek brain this switches thinking off entirely (2.7× faster on the yardstick)" },
      { id: "medium", description: "balanced; DeepSeek keeps its default thinking" },
      { id: "high", description: "full reasoning — best for hard problems" },
    ];
    const options = tiers.map(t => ({ label: t.id, description: t.description, current: t.id === cfg.effort }));
    const index = await selectOption({ title: "Reasoning effort for this session", options, initial: options.findIndex(o => o.current),
      hint: "Enter confirms, Esc keeps the current effort", select: ctx.select, ask: ctx.ask, show: text => ui.block(text) });
    if (index !== null && options[index].label !== cfg.effort) { cfg.effort = options[index].label; ui.done(`reasoning effort for this session: ${cfg.effort}`); }
    else ui.info(`reasoning effort unchanged: ${cfg.effort}`);
    ctx.refreshMeter(); return false;
  }
  if (line.startsWith("/effort ")) { const effort = line.slice(8).trim().toLowerCase(); if (EFFORT_LEVELS.includes(effort)) { cfg.effort = effort; ui.done(`reasoning effort for this process: ${effort}`); } else ui.error(`effort must be one of ${EFFORT_LEVELS.join(", ")}`); ctx.refreshMeter(); return false; }
  if (line === "/permissions") { await ctx.changePermission(); ctx.refreshMeter(); return false; }
  if (line === "/permission") { ui.info(`agency for this session: ${cfg.agencyLevel ?? 0}/9; use /permission 0-9 to change it`); return false; }
  if (line.startsWith("/permission ")) { ctx.changeAgency(line.slice(12)); return false; }
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
  return null;
}

// What the saved threads add up to, and reopening one of them here.
async function handleHistoryCommand(ctx, line) {
  const { cfg } = ctx;
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
  if (line === "/resume" || line.startsWith("/resume ")) { const wanted = line.slice(7).trim() || Session.latest(cfg.sessionsDir); if (!wanted) ui.warn("No session to resume."); else try { ctx.session = new Session(cfg.sessionsDir, wanted); ctx.spend = sessionSpend(ctx.session.events); ctx.lastPrompt = 0; ctx.refreshMeter(); ui.done(`Resumed ${wanted}.`); } catch (error) { ui.error(error.message); } return false; }
  return null;
}

// The brain this session thinks with, and the helpers it can hand work to.
async function handleHelperCommand(ctx, line) {
  const { cfg, policy, settings } = ctx;
  if (line === "/brain") { await chooseBrain(cfg, ctx.ask, { select: ctx.select }); ctx.refreshMeter(); return false; }
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
    try { assertSafeExternalWorkspace(cfg.cwd); } catch { allowUnsafeWorkspace = await ctx.approveWorkspace(cfg.cwd, runner); }
    if (!allowUnsafeWorkspace) { try { assertSafeExternalWorkspace(cfg.cwd); } catch { ui.warn("Background task not started."); return false; } }
    // Naming a flagship brain and paying for one are two decisions; --allow-flagship only made the first.
    const gate = spendGateFor({ runner, model: chosen.model, coordinatorModel: cfg.model });
    if (gate && !/^y(es)?$/i.test(String(await ctx.ask(ui.question(`${gate.why}. Start it anyway? [y/N]`)) || "").trim())) { ui.warn("Background task not started."); return false; }
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
    ctx.current = new AbortController();
    try {
      const aside = await askAside({ cfg, policy, session: ctx.session, runner, question: flags.prompt, model: flags.model, kind: flags.kind || cfg.subagentDefaultKind || "search",
        allowFlagship: flags.allowFlagship, tiers: subagentTiers(settings.subagentModels), run: runExternal, signal: ctx.current.signal });
      ui.toolEnd(label, "", { state: aside.cancelled ? "cancelled" : "done" });
      if (aside.cancelled) { ui.warn(`aside ${aside.childId} cancelled; nothing was added to this conversation`); return false; }
      ui.block(String(aside.text || "").trim() || "(the subagent answered nothing)");
      ui.info(`aside ${aside.childId} · ${runner} ${aside.model} · kept out of this conversation's context; /attach ${aside.childId} reopens it`);
    } catch (error) { ui.toolEnd(label, "", { state: ctx.current?.signal.aborted ? "cancelled" : "failed" }); if (ctx.current?.signal.aborted) ui.warn("aside cancelled"); else ui.error(error.message); }
    finally { ctx.current = null; }
    return false;
  }
  if (line.startsWith("/task ")) { const [, id, ...words] = line.split(/\s+/); try { const state = sendTask(id, words.join(" ")); ui.progress(`${state.id} continued in background.`); } catch (error) { ui.error(error.message); } return false; }
  if (line === "/attach" || line.startsWith("/attach ")) {
    const id = line.slice(8).trim();
    const children = childLedger(ctx.session);
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
  return null;
}

// What hcode will say about itself when asked: the state, the bill, the rule book, the catalog.
async function handleReportCommand(ctx, line) {
  const { cfg, policy, sb } = ctx;
  if (line === "/status") { const name = cfg.hoopName || cfg.defaultHoop; ui.status(cfg, ctx.session.id, { runner: cfg.runner, network: policy.network.default, sandbox: sb.adapter, account: name ? describeHoopSession(name) : { connected: false } }); return false; }
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
  if (line === "/mode") { await ctx.changePermission(); ctx.refreshMeter(); return false; }
  if (line.startsWith("/mode ")) { await ctx.changePermission(line.slice(6).trim()); ctx.refreshMeter(); return false; }
  if (line === "/verbose" || line.startsWith("/verbose ")) { const wanted = line.split(/\s+/)[1]; ui.setVerbose(wanted ? /^(on|yes|1|true)$/i.test(wanted) : !ui.isVerbose()); ui.done(`verbose activity: ${ui.isVerbose() ? "on" : "off"}`); return false; }
  if (line === "/usage") { if (ctx.lastUsage) ui.usage(ctx.lastUsage.usage, ctx.lastUsage.ms); else ui.info("No turn usage yet in this process."); return false; }
  if (line === "/policy") { ui.block(JSON.stringify({ mode: cfg.mode, network: policy.network, allow: policy.allow, rules: policy.rules.map(rule => ({ action: rule.action, tool: rule.tool, ...(rule.command !== undefined ? { command: rule.command } : {}), ...(rule.path !== undefined ? { path: rule.path } : {}), source: rule.source })), gates: GATE_CLASSES, sandbox: `${policy.sandbox} → ${sb.adapter}${sb.degraded ? " (degraded)" : ""}` }, null, 2)); return false; }
  if (line === "/sessions") { ui.block(sessionsTable(Session.list(cfg.sessionsDir, 10))); return false; }
  if (line === "/help") { ui.block(helpText()); return false; }
  // /command: one line turns a prompt you keep retyping into /<name>. Nothing here executes.
  if (line === "/command" || line === "/commands" || line.startsWith("/command ")) {
    const rest = line.replace(/^\/commands?\s*/, "").trim();
    const [verb, ...tail] = rest.split(/\s+/);
    try {
      if (!verb || verb === "list") ui.block(customCommandsHelp(ctx.customCommands, { cwd: cfg.cwd }));
      else if (verb === "show") {
        const found = ctx.customCommands.find(command => command.name === tail[0]?.toLowerCase());
        found ? ui.block(`${found.file}${found.shadowed ? "  [shadowed by the built-in /" + found.name + "]" : ""}\n\n${found.body}`) : ui.warn(`No custom command /${tail[0] || ""}. /command list shows what there is.`);
      } else if (verb === "new" || verb === "add") {
        const spec = parseCommandNew(rest.slice(verb.length).replace(/^[ \t]+/, ""));
        const saved = saveCustomCommand({ cwd: cfg.cwd, scope: spec.scope, name: spec.name, body: spec.body, builtins: BUILTIN_NAMES });
        ctx.refreshCustomCommands();
        saved.shadowed ? ui.warn(saved.message) : ui.done(saved.message);
      } else ui.error("usage: /command new [--user] <name> <prompt> · /command list · /command show <name>");
    } catch (error) { ui.error(error.message); }
    return false;
  }
  return null;
}

// Last, so a built-in always wins: a custom command runs its stored prompt as an ordinary turn.
async function handleCustomCommand(ctx, line, images, { startup }) {
  if (!line.startsWith("/")) return null;
  const custom = findCustomCommand(line, ctx.customCommands);
  if (custom) { await ctx.runOne(expandCustomCommand(custom, line.slice(custom.name.length + 1)), images); return false; }
  // A launch argument that matches no command name is a prompt, not a typo — the shell that
  // typed it had no completion to check it against, and refusing it would drop the whole
  // sentence. In the composer, where `/` completes as you type, an unknown name is far more
  // likely a slip, so that path still says so instead of spending a turn on it.
  if (startup) { await ctx.runOne(line, images); return false; }
  ui.warn(`Unknown command ${line.split(/\s+/, 1)[0]}. Type / to search or /help to list commands.`);
  return false;
}

export const SLASH_GROUPS = [handleLeaveCommand, handleThreadCommand, handleProjectCommand, handleSettingCommand, handleHistoryCommand, handleHelperCommand, handleReportCommand, handleCustomCommand];

function makeLineHandler(ctx) {
  return async (line, images = [], { startup = false } = {}) => {
    if (!line && !images.length) return false;
    if (images.length && line.startsWith("/")) ui.warn("Pasted images are sent with ordinary requests, not slash commands.");
    for (const handle of SLASH_GROUPS) {
      const verdict = await handle(ctx, line, images, { startup });
      if (verdict !== null) return verdict;
    }
    await ctx.runOne(line, images);
    return false;
  };
}

// ---- phase: the loop ------------------------------------------------------------------------------

async function runReadlineLoop(ctx, handleLine) {
  for (;;) {
    const line = await ctx.ask(ui.prompt());
    if (ctx.bridgeExitCode !== null) break;
    if (await handleLine(line)) break;
  }
  ctx.close(); return ctx.bridgeExitCode ?? 0;
}

async function runComposerLoop(ctx, handleLine) {
  const { composer } = ctx;
  // Observation is on from the first frame, not from the first turn: a resumed thread already
  // carries context, and the owner should see how much before they spend anything on it.
  ctx.refreshMeter();
  let exitCode = 0;
  await new Promise(resolve => {
    const queue = [];
    let draining = false; let stopped = false;
    const stop = code => {
      if (stopped) return;
      stopped = true; exitCode = code;
      composer.off("line", onLine); composer.off("paste-image", onPasteImage); composer.off("interrupt", onInterrupt); composer.off("cancel", onCancel); composer.off("eof", onEof); composer.off("rewind", onRewind); composer.off("editor", onEditor); composer.off("command", onCommand);
      ctx.requestInteractiveExit = null;
      ctx.close();
      resolve();
    };
    ctx.requestInteractiveExit = stop;
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
        const image = await ctx.attachmentStore.captureClipboard();
        if (!stopped) composer.addAttachment(image);
      } catch (error) {
        if (!stopped) { composer.setAttachmentStatus(""); ui.warn(error.message); }
      } finally { imagePasteRunning = false; }
    };
    const onInterrupt = () => ctx.handleInterrupt();
    const onCancel = () => ctx.handleCancel();
    const onEof = () => stop(0);
    // esc esc only reaches here on an idle composer, but a queued message may still be draining:
    // rewinding under a turn that is about to run would fork the thread out from under it.
    const onRewind = () => { if (!stopped && !draining && !queue.length) void ctx.rewindNow(); };
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
  ctx.close(); return exitCode;
}

// ---- the session ----------------------------------------------------------------------------------

export async function runSession(launch) {
  const ctx = openSessionContext(launch);
  process.once("exit", ctx.cleanup);
  const onSigint = () => ctx.handleInterrupt();
  process.on("SIGINT", onSigint);
  try {
    const refused = openThread(ctx);
    if (refused !== null) return refused;
    attachTurnRunner(ctx);
    if (ctx.args.print) return await answerInPrintMode(ctx);
    openRenderPath(ctx);
    await settleStartupPermission(ctx);
    attachOwnerChannels(ctx);
    attachThreadControls(ctx);
    if (ctx.task) { const taskExitCode = await ctx.runOne(ctx.task); ctx.close(); return ctx.bridgeExitCode ?? taskExitCode; }
    const handleLine = makeLineHandler(ctx);
    if (ctx.startupCommand && await handleLine(ctx.startupCommand, [], { startup: true })) { ctx.close(); return ctx.bridgeExitCode ?? 0; }
    return ctx.composer ? await runComposerLoop(ctx, handleLine) : await runReadlineLoop(ctx, handleLine);
  } finally { process.off("SIGINT", onSigint); process.off("exit", ctx.cleanup); ctx.cleanup(); }
}
