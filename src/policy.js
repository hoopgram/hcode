// Policy = the capability broker's rule book (CONTRACTS-V027 §3). <cwd>/.hcode/policy.json, owner-written:
//   {"v":1,"mode":"read|ask|auto|all","network":{"default":"off","allow":["api.github.com"]},
//    "allow":["bash:git *","write_file:src/**"],"allowedRoots":["/absolute/read-only/root"],
//    "allowedTempRoots":["/absolute/scratch/dir"],"sandbox":"auto|sandbox-exec|bwrap|systemd-run|none"}
// allowedRoots are exact READ grants (an agent may read its work orders outside the project root;
// writes there still refuse). allowedTempRoots are declared writable scratch — the bounded home of
// self-verification (hide a file, watch the gate go red, restore it); reads and writes inside them
// pass, everything else outside the root still refuses (2026-08-28 order: exceptions with edges,
// not backdoors).
// The 0.1.0 file .hcode/settings.json {"allow":[…]} is still read (merged into allow). The model never sees
// or edits this file: .hcode/ is on the secret-path blacklist.
//
// 0.8 adds two layers above the mode, both enforced here at the single decision the tool loop calls:
//   * typed rules (rules.js) — the owner's declarative rule book from .hcode/settings.json, project and
//     user level merged, deny beating ask beating allow. A deny is checked before any mode, so `auto` and
//     the session-only `all` cannot walk past one;
//   * consequence gates (gates.js) — four built-in classes of *outcome* (spend, irreversible, exposure,
//     deletion) read off the command itself. A hit asks by default and says which class it hit. A specific
//     allow rule can cover a specific command; nothing can switch the four classes off wholesale.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson } from "./config.js";
import { loadRules, matchRules, ruleReason, commandSegments, globToRegex } from "./rules.js";
import { classifyConsequences, gateClasses, gateSentence, GATE_LABELS } from "./gates.js";

export { globToRegex };
export const MODES = ["read", "ask", "auto", "all"];
export const SANDBOXES = ["auto", "sandbox-exec", "bwrap", "systemd-run", "none"];
// readJson is shared from config.js (identical try/JSON.parse/catch-null behavior, formerly duplicated here).

// policy.js must not import tools.js (tools.js imports this file); the judge is injected, with a lazy default.
let judgeImpl = null;
export function setPathJudge(fn) { judgeImpl = fn; }
function judgeFor(root, p, cwd) { if (!judgeImpl) throw new Error("no path judge"); return judgeImpl(root, p, cwd); }

export function loadPolicy(cwd, { home = undefined } = {}) {
  const file = path.join(cwd, ".hcode", "policy.json");
  const raw = readJson(file) || {};
  const legacy = readJson(path.join(cwd, ".hcode", "settings.json")) || {};
  const problems = [];
  const book = home === undefined ? loadRules(cwd) : loadRules(cwd, { home });
  problems.push(...book.problems);
  const policy = { v: 1, mode: null, network: { default: "off", allow: [] }, allow: [], allowedRoots: [], allowedTempRoots: [], sandbox: "auto", file, rules: book.rules, book, fromFile: Boolean(raw && Object.keys(raw).length) };
  if (raw.mode !== undefined) { if (MODES.includes(raw.mode)) policy.mode = raw.mode; else problems.push(`mode must be read|ask|auto|all (got ${JSON.stringify(raw.mode)})`); }
  if (raw.network && typeof raw.network === "object") {
    if (raw.network.default !== undefined) { if (["off", "on"].includes(raw.network.default)) policy.network.default = raw.network.default; else problems.push("network.default must be off|on"); }
    if (Array.isArray(raw.network.allow)) policy.network.allow = raw.network.allow.filter(d => typeof d === "string" && /^[a-z0-9.*-]+$/i.test(d)).map(d => d.toLowerCase());
  }
  for (const rule of [...(Array.isArray(legacy.allow) ? legacy.allow : []), ...(Array.isArray(raw.allow) ? raw.allow : [])]) if (typeof rule === "string" && rule) policy.allow.push(rule);
  if (raw.allowedRoots !== undefined) {
    if (!Array.isArray(raw.allowedRoots)) problems.push("allowedRoots must be an array of absolute existing directories");
    else for (const entry of raw.allowedRoots) {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) { problems.push(`allowedRoots entry must be absolute (got ${JSON.stringify(entry)})`); continue; }
      try {
        const real = fs.realpathSync(entry);
        if (!fs.statSync(real).isDirectory()) problems.push(`allowedRoots entry is not a directory: ${entry}`);
        else if (!policy.allowedRoots.includes(real)) policy.allowedRoots.push(real);
      } catch { problems.push(`allowedRoots entry does not exist: ${entry}`); }
    }
  }
  if (raw.allowedTempRoots !== undefined) {
    if (!Array.isArray(raw.allowedTempRoots)) problems.push("allowedTempRoots must be an array of absolute paths");
    else for (const entry of raw.allowedTempRoots) {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) { problems.push(`allowedTempRoots entry must be absolute (got ${JSON.stringify(entry)})`); continue; }
      try {
        // the declaration itself materializes the scratch dir: an agent may never mkdir outside
        // the root, so requiring pre-existence would make the grant unusable by its intended user
        fs.mkdirSync(entry, { recursive: true });
        const real = fs.realpathSync(entry);
        const root = path.parse(real).root;
        let cwdReal = null; try { cwdReal = fs.realpathSync(cwd); } catch { }
        const projectScratch = cwdReal ? path.join(cwdReal, ".hcode", "tmp") : null;
        const scratchRel = projectScratch ? path.relative(projectScratch, real) : "..";
        if (!fs.statSync(real).isDirectory()) problems.push(`allowedTempRoots entry is not a directory: ${entry}`);
        else if (real === root) problems.push("allowedTempRoots entry may not be the filesystem root");
        else if (policy.allowedRoots.includes(real)) problems.push(`allowedTempRoots entry is also an allowedRoots read grant — read grants stay read-only: ${entry}`);
        else if (!projectScratch || scratchRel.startsWith("..") || path.isAbsolute(scratchRel))
          problems.push(`allowedTempRoots entry must be inside the project's .hcode/tmp directory: ${entry}`);
        else if (!policy.allowedTempRoots.includes(real)) policy.allowedTempRoots.push(real);
      } catch (e) { problems.push(`allowedTempRoots entry unusable: ${entry} (${e.message})`); }
    }
  }
  if (raw.sandbox !== undefined) { if (SANDBOXES.includes(raw.sandbox)) policy.sandbox = raw.sandbox; else problems.push("sandbox must be auto|sandbox-exec|bwrap|systemd-run|none"); }
  policy.problems = problems;
  return policy;
}

// The owner saying "from now on" writes the mode into the same .hcode/policy.json loadPolicy reads at
// startup, and touches nothing else in the file — everything around the mode is theirs. All four modes
// in MODES are writable, `all` included: standing full access is the owner's explicit decision about
// their own machine, gated by its own extra confirmation (permissions.js) and announced on every start
// that loads it, never a silent default. The fixed safety boundaries apply the same under a persisted
// `all` as under a session-only one, so what changes here is only how much the owner is asked again.
export function savePolicyMode(cwd, mode) {
  if (!MODES.includes(mode)) throw new Error(`only read|ask|auto|all can be remembered for a project (got ${mode})`);
  const dir = path.join(cwd, ".hcode");
  const file = path.join(dir, "policy.json");
  const raw = readJson(file) || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, ...raw, mode }, null, 2) + "\n");
  return file;
}

// "Ask me every startup" removes only the remembered mode. Network, sandbox and hand-written rules
// stay byte-for-byte equivalent JSON values; the next plain interactive launch will open the chooser.
export function clearPolicyMode(cwd) {
  const dir = path.join(cwd, ".hcode"); const file = path.join(dir, "policy.json");
  const raw = readJson(file) || {};
  if (!("mode" in raw)) return file;
  delete raw.mode;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, ...raw }, null, 2) + "\n");
  return file;
}

// ---- glob / allow rules (shared with tools.js; the glob itself now lives in rules.js) ---------------
// Allow-list matching: "bash:git *" / "write_file:src/**" / "glob"
export function allowed(settings, name, input) {
  const rules = Array.isArray(settings?.allow) ? settings.allow : [];
  for (const rule of rules) {
    const [tool, ...rest] = String(rule).split(":"); const pat = rest.join(":");
    if (tool !== name) continue;
    if (!pat) return true;
    const subject = name === "bash" ? String(input.command || "") : String(input.path || "");
    if (globToRegex(pat).test(subject) || (name === "bash" && pat.endsWith(" *") && subject.startsWith(pat.slice(0, -1)))) return true;
  }
  return false;
}

export function domainAllowed(policy, host) {
  host = String(host || "").toLowerCase();
  if (!host) return false;
  return (policy?.network?.allow || []).some(d => d === host || (d.startsWith("*.") && host.endsWith(d.slice(1))) || d === "*");
}

// ---- bash command risk classifier (CONTRACTS-V027 §2: bash = [write, network?, destructive?]) -------
const READ_ONLY = new Set(["cd", "ls", "cat", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep", "find", "wc", "echo", "printf", "pwd", "which", "whoami", "id", "date", "env", "printenv", "stat", "file", "du", "df", "tree", "diff", "cmp", "sort", "uniq", "cut", "awk", "tr", "basename", "dirname", "realpath", "readlink", "md5sum", "sha256sum", "shasum", "jq", "yq", "true", "false", "test", "[", "type", "uname", "hostname", "sleep", "seq", "xargs", "column", "nl", "tac", "od", "hexdump", "strings", "ps", "top", "uptime", "free", "lsof", "ss", "netstat"]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat", "ping", "dig", "nslookup", "host", "ip", "ifconfig", "gh", "hcloud", "aws", "gcloud", "az", "kubectl", "helm", "terraform", "ansible", "mail", "sendmail", "openssl"]);
const NETWORK_SUB = { git: ["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"], npm: ["install", "i", "ci", "publish", "update", "audit", "view", "search", "login", "whoami", "pack"], pnpm: ["install", "add", "publish", "update"], yarn: ["install", "add", "publish", "upgrade"], pip: ["install", "download"], pip3: ["install", "download"], brew: ["install", "update", "upgrade", "tap"], apt: ["install", "update", "upgrade"], "apt-get": ["install", "update", "upgrade"], nix: ["build", "flake", "run", "shell", "develop", "copy", "profile"], cargo: ["build", "install", "publish", "update", "fetch"], go: ["get", "mod", "install"], docker: ["pull", "push", "run", "build", "login"], node: [] };
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "grep", "ls-files", "blame", "describe", "tag", "stash list", "remote -v", "config --get", "worktree list", "cat-file", "shortlog"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "dd", "mkfs", "shred", "truncate", "shutdown", "reboot", "halt", "poweroff", "kill", "pkill", "killall", "chown", "chgrp", "chmod", "umount", "mount", "fdisk", "parted", "crontab", "systemctl", "launchctl", "nixos-rebuild", "sudo", "doas", "su", "format", "diskutil"]);
const ABSOLUTE_TRANSFER_PATTERN = /\b(mv|cp)\s+.*\s\/\S*$/;
const DESTRUCTIVE_PATTERNS = [/\bgit\s+(reset\s+--hard|clean\b|push\s+.*(--force|-f\b)|checkout\s+(--\s+)?\.|branch\s+-D|rebase\b|filter-branch|stash\s+(drop|clear))/, /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)/, ABSOLUTE_TRANSFER_PATTERN, /:\(\)\s*\{/, /\bmkfs\b/, /\bdd\s+if=/, />\s*\/dev\/(sd|disk|nvme)/, /\bdrop\s+(table|database)\b/i];

// split on ; && || | newlines, outside quotes (good enough for a risk label; policy + sandbox do the
// enforcing). One splitter for the classifier, the rule matcher and the consequence gates — rules.js.
const segments = commandSegments;

// Paths named anywhere in a command — including inside quotes and inside `node -e "…"` — so the gate can judge
// what a command *touches*, not only its verb. URLs, flags and harmless system paths are skipped.
const SYSTEM_OK = [/^\/dev\/(null|stdout|stderr|tty|zero|urandom)$/, /^\/(usr|bin|sbin|lib|lib64|opt|proc|sys|nix\/store|System|Library|Applications)(\/|$)/, /^\/etc\/(hosts|passwd|profile|resolv\.conf)$/];
const SECRET_BASENAMES = /^(\.env(\..+)?|\.npmrc|\.netrc|auth\.json|credentials|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.+\.(pem|key|p12|pfx))$/;

// A heredoc body is stdin data for an interpreter — HTML, code, prose — not argv of the outer command.
// On 2026-08-28 `</p>` inside a python heredoc was extracted as the path `/p` and blocked a whole
// audit lane; heredoc bodies are stripped before any path is read. Only a starter line that carries
// nothing but the marker is treated as a heredoc, so `<<EOF > /file` keeps its redirect visible.
function stripHeredocBodies(command) {
  let s = String(command || "").replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|(?![\s\S]))/gm, " ");
  const open = /<<-?\s*['"]?[A-Za-z_]\w*/.exec(s);
  if (open) s = s.slice(0, open.index + open[0].length);      // unterminated: everything after is body
  return s;
}

// Path candidates come from parsed shell words, never from scanning the raw string: a quoted path
// with spaces is ONE path ("AI 协作系统" once split in half and killed every handoff), an HTML tag
// is a tag (`</p>` was once read as `/p`), and a flag value is a path only after `=`.
const PATH_START = /^(?:~\/|\.{1,2}\/|\/)/;
function pathWords(words) {
  const out = [];
  for (let w of words) {
    w = w.replace(/^[<>&|;,()]+/, "").replace(/[<>&|;,()]+$/, "");
    const eq = /^--?[A-Za-z][\w-]*=(.*)$/.exec(w);
    const cand = eq ? eq[1] : w;
    if (!cand || /^[a-z][a-z0-9+.-]*:/i.test(cand) || cand.includes("//")) continue;
    if (PATH_START.test(cand) || (cand.includes("/") && !/^[-<([{]/.test(cand))) out.push(cand);
  }
  return out;
}
// Quoted program text is real behavior when it names a path — `node -e "fs.writeFileSync('../x')"`
// must stay visible to the gate (A8). The interior scan only accepts escapes, `~/` and
// multi-segment absolutes, so `</p>` (a single-segment fragment) is never resurrected as a path.
function pathCandidates(seg) {
  const cands = pathWords(shellWords(seg));
  for (const w of shellWords(seg)) if (SECRET_BASENAMES.test(w.replace(/^.*\//, "")) && !cands.includes(w)) cands.push(w);
  for (const m of seg.matchAll(/("[^"]*")|('[^']*')/g)) {
    const inner = m[0].slice(1, -1);
    // a quoted string that IS a path literal ("/tmp/a b/c.md", '../x') is already captured whole at
    // word level — rescanning its interior would split it at spaces. Only program strings
    // (node -e "require('fs').writeFileSync('../outside.md','x')") need the interior scan.
    if (!/^(?:~\/|\.{1,2}\/|\/)/.test(inner.trimStart())) {
      // double-quoted interiors can be interpreter programs — scan them; single-quoted interiors are
      // usually literals (sed programs 's/sandbox/live/' must never look like paths), so only
      // escape/home prefixes count there. A single-segment escape ('../outside.md') is a real path;
      // a single-segment bare absolute ('/p' from '</p>') is markup, not a path — absolutes need 2+.
      const re = m[1] !== undefined
        ? /(?:\.\.\/|~\/)[\w@.+%-]+(?:\/[\w@.+%-]+)*\/?|\/[\w@.+%-]+(?:\/[\w@.+%-]+)+\/?/g
        : /(?:\.\.\/|~\/)[\w@.+%-]+(?:\/[\w@.+%-]+)*\/?/g;
      for (const t of inner.matchAll(re)) {
        const cand = t[0].replace(/\/+$/, "");
        if (cand && !cands.includes(cand)) cands.push(cand);
      }
    }
    for (const w of inner.split(/\s+/)) if (SECRET_BASENAMES.test(w.replace(/^.*\//, "")) && !cands.includes(w)) cands.push(w);
  }
  return cands;
}
export function pathsIn(command) {
  const clean = stripHeredocBodies(String(command || "")).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const out = new Set();
  for (const seg of segments(clean)) for (const t of pathCandidates(seg)) out.add(t);
  return [...out].filter(t => !SYSTEM_OK.some(re => re.test(t)));
}

// Money is classified from executable/action arguments only. Natural-language payloads (notably
// `git commit -m "buy ..."` and `grep` hits on payment words) are data, not behavior, and must
// never become an owner-door by keyword.
const MONEY_ACTION = /^(pay|payment|payments|charge|checkout|invoice|billing|transfer|wire|refund|payout|purchase|buy|paddle-live)([-_.\w]*)?(\.(js|mjs|ts|py|sh|rb|php))?$/i;
const MONEY_FLAG = /^--(amount|card|iban|cvv|account|wallet|private-key)(?:=|$)/i;
const MONEY_PROVIDER = /^(stripe|paypal|coinbase|paddle)$/i;
function shellWords(segment) {
  const words = []; let cur = "", q = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) { if (c === q && segment[i - 1] !== "\\") q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = ""; } } else cur += c;
  }
  if (cur) words.push(cur); return words;
}
function actionWords(segment) {
  const words = shellWords(segment); let sawCommand = false;
  while (words.length) {
    const first = words[0].replace(/^.*\//, "");
    if (["sudo", "doas", "time", "nice", "nohup", "exec"].includes(first)) { words.shift(); continue; }
    if (first === "env") {
      words.shift();
      while (words.length && (words[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
      continue;
    }
    if (first === "command" || first === "builtin") {
      sawCommand = true; words.shift();
      if (words[0] === "--") words.shift();
      if (first === "command" && (words[0] === "-v" || words[0] === "-V")) return { words: ["type", ...words.slice(1)], sawCommand };
      continue;
    }
    break;
  }
  return { words, sawCommand };
}
export function moneyAction(command) {
  for (const seg of segments(String(command || ""))) {
    const { words } = actionWords(seg);
    const executable = (words[0] || "").replace(/^.*\//, ""); if (!executable) continue;
    // Git's messages, paths and refs are data. Its executable actions cannot move money.
    if (executable === "git") continue;
    if (MONEY_ACTION.test(executable)) return true;
    // A money-named tool at token boundaries is a money action even with decorations:
    // `owner-live-money-status-from-god.sh` (the exact 007 owner tool) and friends.
    if (/(?:^|[-_.])(?:pay|payment|payments|money|charge|checkout|invoice|billing|transfer|wire|refund|payout|purchase|buy|paddle-live)(?:[-_.]|$)/i.test(executable)) return true;
    // Provider CLIs are money unless the segment is only asking them about themselves.
    if (MONEY_PROVIDER.test(executable) && !/\b(?:help|status|list|show|version)\b/.test(seg)) return true;
    // A paddle integration flipped to live — config rewrite, env switch, live arm flag — is armed
    // to charge real cards. It gates at EVERY agency level however innocent the verb looks
    // (2026-08-28 order: a paddle live flip that can be unlocked is a backdoor, not a feature).
    if (/\bPADDLE_\w+=live\b/i.test(seg)) return true;
    if (/(^|[^<>])>\s*"?[^|;&\s]*paddle/i.test(seg) && /\blive\b/i.test(seg)) return true;
    const paddleWrite = /^(awk|perl|tee|node|python3?|ruby|php|bash|sh|zsh|env)$/.test(executable)
      || (executable === "sed" && /(^|\s)(--in-place\b|-i\b|-i\W|-i$)/.test(seg));
    if (paddleWrite && /paddle/i.test(seg) && /\b(live|sandbox)\b/i.test(seg)) return true;
    const runtime = /^(node|python3?|ruby|php|bash|sh|zsh)$/.test(executable);
    const script = runtime ? words.slice(1).find(w => !w.startsWith("-")) : null;
    if (script && MONEY_ACTION.test(path.basename(script))) return true;
    if (runtime && words.slice(1).some(w => MONEY_FLAG.test(w))) return true;
    // A state-changing HTTP call to a payment endpoint moves money; a plain GET of docs does not.
    if (/^(curl|wget)$/.test(executable)) {
      const writes = /(?:^|\s)(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary)?|--form)\b/i.test(seg);
      const paymentEndpoint = /https?:\/\/[^\s]*(?:stripe|paypal|coinbase|paddle|\/payments?\b|\/charges?\b|\/refunds?\b|\/payouts?\b)/i.test(seg);
      if (writes && paymentEndpoint) return true;
    }
  }
  return false;
}

export function hostsIn(command) {
  const hosts = new Set();
  for (const m of String(command).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  for (const seg of segments(String(command))) {
    if (!/^(ssh|scp|rsync|sftp)\b/.test(seg.trim())) continue;
    for (const tok of seg.split(/\s+/).slice(1)) { const m = /^(?:[\w.-]+@)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::.*)?$/i.exec(tok); if (m) hosts.add(m[1].toLowerCase()); }
  }
  for (const m of String(command).matchAll(/git@([a-z0-9.-]+):/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts];
}

// Returns {risk:[…], readOnly, parseStatus, unknownCommands, reason}.
// Unknown shell syntax is a prompt-worthy classification failure, not evidence of destruction.
// `cwd` seeds relative-path resolution (bash starts at the project root); each `cd` in the command
// moves it, so `cd apps && cat ../share/x` is judged where the shell would really run it — the
// 2026-08-28 relative-path misblocks judged `../…` against the root and shut the whole lane down.
export function classifyCommand(command, { root = null, judge = null, cwd = null, readRoots = [], writeRoots = [] } = {}) {
  // Heredoc bodies are interpreter data, not shell segments: strip them before splitting, so
  // `import json` is never an executable and `</p>` is never a redirect (2026-08-28, twice).
  const cmd = stripHeredocBodies(String(command || ""));
  const risk = new Set(["write"]); const reasons = [];
  const unknownCommands = [];
  const paths = { secret: [], outside: [], critical: [] };
  let readOnly = true;
  let cwdDir = cwd || root;
  const judgeToken = judge || (root ? (p, c) => judgeFor(root, p, c) : null);
  const stripped = cmd.replace(/\d?>&\d/g, "").replace(/>\s*\/dev\/null/g, "");
  if (/(^|[^<>])>/.test(stripped) || /\btee\b/.test(cmd)) { readOnly = false; reasons.push("redirects output to a file"); }
  for (const seg of segments(cmd)) {
    const { words } = actionWords(seg);
    const first = (words[0] || "").replace(/^.*\//, "");
    const sub = words[1] || "";
    if (first === "cd" && words[1] && words[1] !== "-") {
      try { cwdDir = path.resolve(cwdDir, words[1].startsWith("~/") ? path.join(os.homedir(), words[1].slice(2)) : words[1]); } catch { }
    }
    if (/^(sudo|doas|su)$/.test(words[0] || "")) { risk.add("destructive"); reasons.push("privilege escalation"); readOnly = false; }
    if (!first || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) continue;
    if (/^(env|printenv)$/.test(first) && /\b(token|secret|password|credential|api[_-]?key|auth)\b/i.test(seg)) {
      risk.add("identity"); reasons.push("reads credential-bearing environment names or values");
    }
    // judge EVERY segment's path candidates BEFORE any `continue` below: node/npm/python live in
    // NETWORK_SUB and would otherwise skip path judging entirely (node -e writing ../outside must die).
    if (judgeToken) {
      for (const token of pathCandidates(seg)) {
        if (SYSTEM_OK.some(re => re.test(token))) continue;   // /dev/null & friends are not "outside"
        let j; try { j = judgeToken(token, cwdDir); } catch { continue; }
        if (!j) continue;
        const inGrant = r => { const rel = path.relative(r, j.real); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
        const inScratch = writeRoots.some(inGrant);
        // .hcode remains secret except for the explicitly declared .hcode/tmp scratch.
        if (j.secret && !inScratch) { paths.secret.push(token); risk.add("identity"); }
        else if (!j.inside) {
          // policy.json allowedRoots are exact READ grants: a read-only command may touch them,
          // a mutating one may not (what read_file refuses, bash may not fetch or change either).
          // allowedTempRoots are declared writable scratch: reads and writes both pass inside them
          // (self-verification lives there), and nothing else outside the root does.
          // A segment that redirects output (or tees) is mutating even under a READ_ONLY program:
          // `echo forged > /grant/inbox.md` must not write through a read grant (2026-08-28, found
          // by 张良's acceptance criteria for 007's handover grant, not by code review).
          const segMutating = !READ_ONLY.has(first) || /\btee\b/.test(seg) || /(^|[^<>])>/.test(seg.replace(/\d?>&\d/g, "").replace(/>\s*\/dev\/null/g, ""));
          const granted = (!segMutating && READ_ONLY.has(first) && readRoots.some(inGrant)) || writeRoots.some(inGrant);
          if (!granted) { paths.outside.push(token); risk.add("destructive"); }
        }
      }
    }
    if (DESTRUCTIVE.has(first)) { risk.add("destructive"); reasons.push(`${first} can destroy or change ownership`); readOnly = false; continue; }
    if (NETWORK.has(first)) { risk.add("network"); reasons.push(`${first} talks to the network`); readOnly = false; continue; }
    if (first in NETWORK_SUB) {
      if (first === "git" && [...GIT_READ].some(r => (sub + " " + (words[2] || "")).startsWith(r) || sub === r)) continue;
      if (NETWORK_SUB[first].includes(sub)) { risk.add("network"); reasons.push(`${first} ${sub} may use the network`); }
      readOnly = false; continue;
    }
    if (READ_ONLY.has(first)) continue;
    if (first === "sed" && !/(?:^|\s)--in-place(?:=|\s|$)|(?:^|\s)-[A-Za-z]*i[A-Za-z]*(?:\s|$)/.test(seg)) continue;
    readOnly = false;
    if (!/^(node|npm|npx|pnpm|yarn|python3?|pytest|make|cargo|go|bash|sh|zsh|nix-shell|mkdir|touch|cp|mv|ln|sed|tee|tar|zip|unzip|gzip|gunzip|patch|git|hcode|prettier|eslint|tsc|ruff|black|gofmt|rustfmt)$/.test(first)) {
      risk.add("unknown"); unknownCommands.push(first);
    }
    if (/^(mv|cp|sed|patch|tar|unzip|ln)$/.test(first) && /\s-[a-z]*(i|f)\b/.test(seg)) reasons.push(`${first} changes files in place`);
  }
  // `mv project-file .hcode/tmp/...` is the bounded self-destruction probe. The old absolute-
  // destination regex labelled every mv destructive without asking where it lands. Waive only
  // that coarse label when every observed path stays in-project or in the declared scratch and
  // at least one path is in scratch; outside moves retain the destructive label.
  const boundedScratchTransfer = (() => {
    if (!judgeToken || !writeRoots.length) return false;
    let transfer = false; let touchesScratch = false;
    for (const seg of segments(cmd)) {
      const { words } = actionWords(seg); const first = (words[0] || "").replace(/^.*\//, "");
      if (!/^(mv|cp)$/.test(first)) continue;
      transfer = true;
      for (const token of pathCandidates(seg)) {
        let j; try { j = judgeToken(token, cwdDir); } catch { return false; }
        const inScratch = writeRoots.some(r => { const rel = path.relative(r, j.real); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); });
        if (inScratch) touchesScratch = true;
        if ((!j.inside || j.secret) && !inScratch) return false;
      }
    }
    return transfer && touchesScratch;
  })();
  for (const re of DESTRUCTIVE_PATTERNS) {
    if (!re.test(cmd)) continue;
    if (re === ABSOLUTE_TRANSFER_PATTERN && boundedScratchTransfer) continue;
    risk.add("destructive"); reasons.push("destructive pattern"); readOnly = false; break;
  }
  if (!risk.has("network") && hostsIn(cmd).length) { risk.add("network"); reasons.push("mentions a remote host"); readOnly = false; }
  if (/\b(?:env|printenv)\b/.test(cmd) && /\b(token|secret|password|credential|api[_-]?key|auth)\b/i.test(cmd)) {
    risk.add("identity"); reasons.push("reads credential-bearing environment names or values"); readOnly = false;
  }
  if (moneyAction(cmd)) { risk.add("money"); reasons.push("looks like it moves money"); readOnly = false; }
  {
    if (paths.secret.length) { reasons.push(`touches a secret path (${paths.secret.slice(0, 3).join(", ")})`); readOnly = false; }
    if (paths.outside.length) { reasons.push(`touches ${paths.outside.slice(0, 3).join(", ")} outside the project`); readOnly = false; }
  }
  const mutatesCritical = /\b(?:rm|rmdir|dd|mkfs|shred|truncate|chmod|chown|chgrp)\b|\bfind\b[^\n;]*(?:-delete|-exec\s+rm\b)/.test(cmd);
  if (mutatesCritical) {
    const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const target = new RegExp(`(?:^|\\s)(?:["']?(?:/|/\\*|~|~/\\*|\\$HOME|\\$\\{HOME\\}|${home})(?:["']?)(?=\\s|$))`);
    if (target.test(cmd)) { paths.critical.push("root/home"); risk.add("destructive"); reasons.push("targets the root or home directory"); readOnly = false; }
  }
  if (readOnly) { risk.delete("write"); risk.add("read"); }
  else if (unknownCommands.length && [...risk].every(r => r === "write" || r === "unknown")) risk.delete("write");
  if (unknownCommands.length) reasons.push(`could not parse shell command or syntax: ${[...new Set(unknownCommands)].join(", ")}`);
  return { risk: [...risk], readOnly, parseStatus: unknownCommands.length ? "unknown" : "parsed", unknownCommands: [...new Set(unknownCommands)], reason: [...new Set(reasons)].join("; "), paths };
}

// The broker decision for one call: "allow" | "ask" | "deny" (+ why). mode is the effective mode.
//
// The order below is the whole security argument, read top to bottom:
//   fixed boundaries → the owner's deny rules → trust boundaries → mode → consequence gates → allowances.
// A deny rule sits above every mode on purpose: `auto` and the session-only `all` are statements about how
// much confirming the owner wants right now, not permission to undo a decision they already wrote down.
export function decide({ policy, mode, agencyLevel = null, name, input, risk, idempotent, root = null }) {
  const cls = name === "bash" ? classifyCommand(input.command, { root, judge: root ? p => judgeFor(root, p) : null, readRoots: policy?.allowedRoots || [], writeRoots: policy?.allowedTempRoots || [] }) : null;
  const rule = matchRules(policy?.rules, name, input);
  const hits = name === "bash" ? classifyConsequences(input.command) : [];
  const classes = gateClasses(hits);
  // one ruler: what read_file refuses outright, bash may not fetch either — in any mode, with or without a human
  if (cls?.paths.secret.length) return { decision: "deny", why: `this command would read or write ${cls.paths.secret.join(", ")} — a secret path; hcode refuses those the same way read_file does` };
  if (cls?.paths.critical.length) return { decision: "deny", why: "hcode never runs a command targeting the root or home directory, including in all mode" };
  // The rule book's strongest word. Nothing below can reach past it: not auto, not all, not an
  // "always" the owner clicked earlier in this session, not a matching allow in the other settings file.
  if (rule?.action === "deny") return { decision: "deny", why: `${ruleReason(rule)} — a deny rule holds in every mode`, rule: rule.id };
  // A foreign coding agent is a new trust boundary. Ordinary modes need a specific yes/no; the owner's
  // explicit session-only all decision covers it — unless the call asks for a flagship brain, which is
  // the spend gate, and a gate is not something a mode switches off.
  if (risk.includes("external")) {
    const spend = input.allow_flagship ? ` This asks for a flagship brain: it ${GATE_LABELS.spend} — a helper that costs what the coordinator costs.` : "";
    return mode === "all" && !input.allow_flagship ? { decision: "allow", why: "owner enabled all for this session" }
      : { decision: "ask", why: `send this bounded read-only task to ${input.agent}; hcode will review the report and remain in control.${spend}`, ...(spend ? { gates: ["spend"] } : {}) };
  }
  // A command whose consequence is named is never "just a read", however read-only its verbs looked.
  const mutating = risk.some(r => r !== "read") || classes.length > 0;
  if (!mutating) return agencyLevel === 0 ? { decision: "ask", why: "agency 0 asks before every action" }
    : rule?.action === "ask" ? { decision: "ask", why: ruleReason(rule), rule: rule.id } : { decision: "allow", why: "read-only" };
  if (risk.includes("destructive") && /\b(?:systemctl|launchctl|nixos-rebuild|shutdown|reboot|halt|poweroff|mount|umount)\b/.test(String(input.command || "")))
    return { decision: "ask", why: "this command changes live system state — only an observed owner decision may approve this destructive action" };
  // A parser failure is not a risk finding. It still needs the owner's eyes in every mode,
  // including all, because hcode cannot honestly claim to understand the executable action.
  if (cls?.parseStatus === "unknown") return { decision: "ask", why: "hcode could not parse this shell command safely — review it yourself before allowing it" };
  if (mode === "read") return { decision: "deny", why: `${name} is not allowed in read mode` };
  if (cls?.paths.outside.length) return mode === "auto" || mode === "all"
    ? { decision: "deny", why: `this command touches ${cls.paths.outside.join(", ")}, outside the project root; hcode keeps commands inside the project` }
    : { decision: "ask", why: `touches ${cls.paths.outside.join(", ")} outside the project root` };
  // Money and identity never run unasked, not even in auto/all (constitution:
  // the agent cannot touch money or act as the owner by itself).
  if (risk.includes("money") || risk.includes("identity")) return { decision: "ask", why: risk.includes("money") ? "this command looks like it moves money — only you can approve that" : "this command handles credentials or identity" };
  // The owner asked to be told about this shape of call. An ask rule outranks auto/all the same way a
  // deny rule does — it is a standing instruction, not a preference the current mode gets to override.
  if (rule?.action === "ask") return { decision: "ask", why: ruleReason(rule), rule: rule.id };
  // A rule that names the command or the path is the owner's yes to *that* call. A blanket
  // {"tool":"bash","action":"allow"} names nothing: it is a mood written down, and it neither repeals the
  // network policy nor switches off a consequence class — which is the whole difference between covering
  // one command you have thought about and turning off the part of hcode that makes you think.
  const namedAllow = rule?.action === "allow" && (rule.command !== undefined || rule.path !== undefined);
  // The four built-in classes.
  if (classes.length && !namedAllow) return { decision: "ask", why: `this command ${gateSentence(hits)}`, gates: classes };
  // A named allow also carries past the network default the way a host in network.allow does — otherwise
  // no rule could ever cover a push or a publish, which are network by nature.
  if (namedAllow) return { decision: "allow", why: ruleReason(rule), rule: rule.id };
  // Public search is a bounded product capability, not an arbitrary network client: the tool accepts
  // only a query and contacts hcode's fixed provider. Ask mode still exposes the outbound query;
  // auto/full agency may search directly. Bash and arbitrary URLs remain under network.default.
  if (name === "web_search") return mode === "auto" || mode === "all"
    ? { decision: "allow", why: "bounded public search in full agency" }
    : { decision: "ask", why: "send this query to hcode's public search provider" };
  if (risk.includes("network") && policy.network.default !== "on") {
    const hosts = name === "bash" ? hostsIn(input.command) : [];
    const listed = hosts.length && hosts.every(h => domainAllowed(policy, h));
    if (!listed) return mode === "auto" || mode === "all" ? { decision: "deny", why: `network is off by default; the owner can allow it in .hcode/policy.json (network.allow: ["${hosts[0] || "host"}"]) or approve it in ask mode` }
      : { decision: "ask", why: hosts.length ? `reaches ${hosts.join(", ")} (not in network.allow)` : "needs the network" };
  }
  if (rule?.action === "allow") return { decision: "allow", why: ruleReason(rule), rule: rule.id };
  if (agencyLevel !== null && agencyLevel < 3) return { decision: "ask", why: `agency ${agencyLevel} asks before applying changes` };
  if (mode === "auto" || mode === "all") return { decision: "allow", why: agencyLevel !== null ? `agency ${agencyLevel} allows this scoped action` : `${mode} mode` };
  if (allowed(policy, name, input)) return { decision: "allow", why: "policy allow rule" };
  return { decision: "ask", why: risk.join(", ") };
}
