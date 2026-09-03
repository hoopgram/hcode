// How hcode asks the owner something before (or outside) a session: queued line input, the setup
// picker, the y/n/a decision gate, the brain chooser, and the one switch that applies a permission mode.
import readline from "node:readline";
import { ui } from "./ui.js";
import { TerminalComposer, supportsComposer } from "./composer.js";
import { selectOption } from "./select.js";
import { listRunners } from "./runners.js";
import { brainChoices, resolveBrainChoice, saveRunner, saveDefaultHoop } from "./brain.js";
import { loginHoop, applyHoopSession } from "./auth.js";
import { loadAgencyCanon, applyAgencyGrant } from "./agency.js";

export function prompter() {
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
export function setupPrompter() {
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
export function makeConfirm(ask, { interactive = process.stdin.isTTY } = {}) {
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

// One switch for the one permission concept the owner sees. `all` is Full Agency level 8; changing
// away from it removes that continuation grant as well as its broker mode, so the UI and runtime can
// never disagree about whether hcode is autonomous.
export function applyPermissionChoice(cfg, mode) {
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
