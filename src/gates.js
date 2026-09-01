// Consequence gates: dividing power by what a thing *does*, not by which tool did it.
//
// hcode's older risk labels answer "what kind of tool is this" — read, write, network, destructive. That is
// the right vocabulary for a sandbox and the wrong one for an owner. `bash` is one tool; `ls` and
// `git push --force` are not one decision. So four classes of outcome are read off the command itself:
//
//   spend         it costs money — a metered API call, a cloud resource, another billed agent
//   irreversible  it cannot be undone — rm -rf, a force push, a hard reset, an overwrite with no copy left
//   exposure      it becomes public — a push to a remote, a publish, a release, a file sent to another host
//   deletion      it removes things — files, branches, images, cloud objects
//
// A hit does not block. It asks, and it says which class it hit and why, because an owner who is told
// "this deletes things (rm removes files) and cannot be undone (rm -rf removes a tree with no undo)" can
// answer in a second, while one told "bash: destructive" has to go read the command themselves.
//
// The classification is a pattern table on purpose — no model call. A gate that needs a brain to run is a
// gate that fails when the brain is down, costs money to ask about money, and can be argued with.
// Overlap is expected and wanted: `rm -rf build` is both deletion and irreversible, and both are said.
//
// A specific rule (rules.js) may allow a specific command past a gate — that is the owner's own hand on
// the gate. What no setting can do is switch a class off wholesale: there is no `gates: false`, because a
// blanket "stop asking about money" is exactly the decision an owner should have to make one command at a
// time. False positives are the intended failure direction; asking twice is cheaper than spending once.
import { commandSegments } from "./rules.js";

export const GATE_CLASSES = ["spend", "irreversible", "exposure", "deletion"];
export const GATE_LABELS = {
  spend: "spends money",
  irreversible: "cannot be undone",
  exposure: "puts work where others can see it",
  deletion: "deletes things",
};

// Segments led by these read the world and change nothing; their arguments routinely quote the very
// commands below (`grep -n "git push" .`), so they are not scanned. `find` is deliberately absent —
// `find . -delete` is a deletion however harmless the verb looks.
const READ_VERBS = new Set(["grep", "rg", "egrep", "fgrep", "ag", "ack", "cat", "head", "tail", "less", "more", "echo", "printf", "wc", "sort", "uniq", "cut", "tr", "jq", "yq", "column", "nl", "man", "which", "type", "diff", "cmp", "comm", "awk", "sed"]);

// The pattern table. `verbs` match the leading word of a segment (after sudo/env/nohup are stripped);
// `patterns` match the whole segment. Each entry carries the sentence the owner will read.
export const GATE_PATTERNS = {
  spend: {
    verbs: {},
    patterns: [
      { re: /\b(hcloud|aws|gcloud|az|doctl|linode-cli)\s+[\w-]+(\s+[\w-]+)?\s+(create|run-instances|provision|launch|apply|deploy|allocate)\b/, why: "creates a cloud resource that is billed" },
      { re: /\bterraform\s+(apply|destroy)\b|\bpulumi\s+up\b/, why: "applies paid infrastructure changes" },
      { re: /\b(claude|codex|gemini|aider|cursor-agent)\b(?=[\s\S]*(?:\s-p\b|--print\b|\bexec\b|--model\b|--prompt\b))/, why: "runs another billed coding agent" },
      { re: /\b(api\.openai\.com|api\.anthropic\.com|api\.deepseek\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere)/i, why: "calls a metered model API" },
      { re: /\b(stripe|paypal|coinbase|braintree|adyen)\b/i, why: "talks to a payment provider" },
      { re: /--(amount|card|iban|cvv|wallet|payout)\b/i, why: "carries a payment argument" },
      { re: /\bhcode\s+task\s+start\b/, why: "starts a background agent conversation that bills tokens" },
    ],
  },
  irreversible: {
    verbs: { shred: "shred overwrites a file so it cannot be recovered", mkfs: "mkfs formats a filesystem" },
    patterns: [
      { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\b|-[a-zA-Z]*f[a-zA-Z]*\b)/, why: "rm -r/-f removes a tree with no undo" },
      { re: /\bgit\s+push\b[\s\S]*(--force\b|--force-with-lease\b|\s-f\b)/, why: "a force push rewrites history other people already have" },
      { re: /\bgit\s+reset\s+--hard\b/, why: "git reset --hard throws away uncommitted work" },
      { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: "git clean -f deletes untracked files permanently" },
      { re: /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, why: "git checkout . discards every uncommitted change" },
      { re: /\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+stash\s+(drop|clear)\b/, why: "rewrites or drops history that is not recoverable" },
      { re: /\bdd\s+if=/, why: "dd writes over a device or file wholesale" },
      { re: /\btruncate\s+-s\s*0/, why: "truncate -s 0 empties a file in place" },
      { re: /\b(cp|mv|ln)\s+-[a-zA-Z]*f/, why: "a forced copy or move overwrites the destination without a copy left" },
      { re: />\s*\/dev\/(sd|disk|nvme|hd)/, why: "writes straight to a disk device" },
      { re: /\bdrop\s+(table|database|schema)\b/i, why: "drops a database object" },
      { re: /\bnix-collect-garbage\s+-d\b/, why: "deletes every old system generation, so no rollback is left" },
    ],
  },
  exposure: {
    verbs: {},
    patterns: [
      { re: /\bgit\s+push\b/, why: "pushes commits to a remote where other people can read them" },
      { re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b|\bpoetry\s+publish\b/, why: "publishes a package to a public registry" },
      { re: /\bgh\s+(release\s+create|pr\s+create|gist\s+create|repo\s+create|repo\s+edit[\s\S]*--visibility)/, why: "creates something visible on GitHub" },
      { re: /\bdocker\s+push\b|\bpodman\s+push\b/, why: "pushes an image to a registry" },
      { re: /\b(aws\s+s3|gsutil|rclone)\s+(cp|sync|rsync)\b/, why: "copies files into remote object storage" },
      { re: /--(public|publish|world-readable)\b|--acl\s+public-read\b/, why: "asks for public visibility" },
      { re: /\b(scp|rsync|sftp)\b[\s\S]*\s[\w.@-]+:[^\s]/, why: "sends files to another machine" },
      { re: /\bcurl\b[\s\S]*(-F\b|--data-binary\b|--upload-file\b|\s-T\b)/, why: "uploads a file to a remote endpoint" },
    ],
  },
  deletion: {
    verbs: { rm: "rm removes files", rmdir: "rmdir removes a directory", unlink: "unlink removes a file", dropdb: "dropdb removes a database", dropuser: "dropuser removes a database user" },
    patterns: [
      { re: /\bfind\b[\s\S]*(-delete\b|-exec\s+rm\b)/, why: "find deletes every path it matches" },
      { re: /\bgit\s+(branch\s+-[dD]\b|tag\s+-d\b|worktree\s+remove\b|remote\s+remove\b)/, why: "removes a branch, tag, worktree or remote" },
      { re: /\bdocker\s+(rm\b|rmi\b|volume\s+rm\b|system\s+prune\b|image\s+prune\b)|\bpodman\s+rm\b/, why: "removes containers, images or volumes" },
      { re: /\bkubectl\s+delete\b|\bhelm\s+(uninstall|delete)\b/, why: "deletes a running cluster resource" },
      { re: /\b(hcloud|aws|gcloud|az|doctl)\s+[\w-]+(\s+[\w-]+)?\s+(delete|rm|destroy|terminate)\b/, why: "deletes a cloud resource" },
      { re: /\bterraform\s+destroy\b/, why: "tears down infrastructure" },
      { re: /\b(npm|pnpm|yarn)\s+unpublish\b/, why: "unpublishes a package" },
    ],
  },
};

// → [{class, why}], one entry per distinct (class, reason). Empty when nothing is at stake.
export function classifyConsequences(command) {
  const cmd = String(command || "");
  if (!cmd.trim()) return [];
  const hits = []; const seen = new Set();
  const add = (cls, why) => { const key = `${cls}:${why}`; if (seen.has(key)) return; seen.add(key); hits.push({ class: cls, why }); };
  for (const segment of commandSegments(cmd)) {
    const words = segment.replace(/^\s*(sudo|doas|env|time|nice|nohup|exec|xargs)\s+/, "").split(/\s+/).filter(Boolean);
    const verb = (words[0] || "").replace(/^.*\//, "");
    if (READ_VERBS.has(verb)) continue;
    for (const cls of GATE_CLASSES) {
      const table = GATE_PATTERNS[cls];
      if (table.verbs[verb]) add(cls, table.verbs[verb]);
      for (const entry of table.patterns) if (entry.re.test(segment)) add(cls, entry.why);
    }
  }
  return hits;
}

export const gateClasses = hits => GATE_CLASSES.filter(cls => hits.some(hit => hit.class === cls));

// "deletes things (rm removes files), and cannot be undone (rm -r/-f removes a tree with no undo)"
export function gateSentence(hits) {
  return gateClasses(hits)
    .map(cls => `${GATE_LABELS[cls]} (${[...new Set(hits.filter(hit => hit.class === cls).map(hit => hit.why))].slice(0, 2).join("; ")})`)
    .join(", and ");
}

// Delegation is the one consequence that is not a shell command: a helper on a flagship brain costs what
// the coordinator costs. `--allow-flagship` says the owner meant that model; this gate says they still
// get asked before the money is spent. Returns a gate hit or null.
export function flagshipGate({ model, coordinatorModel = "", runner = "subagent" }) {
  if (!model) return null;
  return { class: "spend", why: `a ${runner} helper on ${model} costs what the coordinator itself costs${coordinatorModel ? "" : ""}` };
}
