# hcode capability boundary

hcode coordinates work on the owner's machine. It is not root, a deployment controller, a payment agent, or
an owner substitute. Its durable records—the task session stream, work contract/event ledger, work-status
projection, guard registry, and guard audit—remain local and portable.

## Full Agency and public search

- Full Agency is the 0.9.4 default for ordinary project work. A real first interactive launch makes the choice
  visible and lets the owner remember it or ask again next time; `/permissions` can change or forget it.
- It does not grant spending, owner-data deletion, constitutional wording changes, new public exposure, or action
  against recorded owner intent. Secret paths and root/home deletion remain unreachable at the tool boundary.
- `web_search` sends only the owner's query to one fixed public search provider and returns titles, snippets, and
  source URLs. It cannot accept or open an arbitrary URL, cannot read a result page, and does not enable Bash
  networking. Public result text is untrusted input, never an instruction.
- Request-shape fields only Anthropic's own Messages API is known to accept — `output_config.effort` and
  `cache_control` prompt cache breakpoints — are sent only to native Claude model routes. Every other
  Anthropic-compatible endpoint receives the portable body, and no cache setting can add a tool, a path, a URL,
  or any capability: it changes what the provider bills, never what hcode may do.

## Who runs the turn

- hcode is a kernel with a session, permission and evidence layer around it. Calling a model is a job it can do
  (`--runner direct`, `src/api.js`) but not one it claims by default: with `codex` or `claude` on `PATH`, the
  owner's own CLI runs the turn and hcode makes zero direct model calls.
- Selection is: `--runner` › `HCODE_RUNNER` › a `runner` saved in `~/.hcode/config.json` › detection
  (`codex`, else `claude`, else `direct`). Anything the owner said stops the detection entirely, and `direct` is
  never reached automatically while an installed runner is available. `hcode runner remove <id>` takes one out
  of the detection; `hcode doctor` names the runner that will answer next and says whether it was chosen or found.
- Detection asks one question about two fixed names on `PATH`. hcode never installs a runner, never accepts a
  path or command as the runner to execute, and never reads or forwards a runner's own login material.
- The executor does not change the record: the same append-only v2 thread carries `header.runner`, the turn
  boundaries, every message and tool call, and the same policy, sandbox, workspace and secret-path boundaries
  apply to a foreign CLI (bounded flags, stripped credentials, refused symlinked or secret-shaped workspaces).
- `--runner hcode` is the older spelling of `direct` and still works; `hcode` remains the id on the wire, so no
  saved config and no stored thread has to be rewritten.

## `hcode task`

- Starts or resumes one explicitly selected, owner-installed Claude or Codex CLI as a bounded background child.
  `hcode launch <runner> <prompt>` is the same command under a shorter name — one handler, one workspace
  question, one spend gate, one ledger.
- Uses fixed runner arguments, the selected project directory, hcode policy, timeout, and a private v2 event log.
- The child is an adviser, never hcode's final voice. `task show`, `task send`, and `task stop` are the complete
  lifecycle surface; a stopped or failed child is recorded, not silently called complete.
- It does not install runners, grant provider credentials, bypass secret/path/network boundaries, merge, publish,
  deploy, spend, or approve an owner gate.

## `hcode work`

- Creates an immutable, owner-approved contract with named lanes, dependencies, ownership, verification, retry,
  concurrency, child, heartbeat, and wall limits. The append-only JSONL ledger is authoritative.
- Codex and Claude return evidence; hcode independently verifies it and remains the final speaker. Verified lanes
  are not rerun. Waiting for a durable owner gate neither retries nor consumes active wall time.
- `work supervise` can resume bounded work, detect stale heartbeats, hand verified dependencies onward, and stop
  after two no-evidence rounds by raising an owner gate. It cannot expand the contract or self-approve that gate.
- A dirty/unknown Git baseline, overlapping ownership, degraded write sandbox, missing evidence, failed verification,
  unenforceable budget, timeout, or orphan fails closed or becomes `needs-review`.

## `hcode guard`

- Patrols an explicit owner registry of Claude, Codex, and work lanes. It reads tmux session/command/cursor metadata,
  registered log timestamps, registered ledger door markers, and work-status v1—never pane content or secrets.
- Mechanical rules are the hard ceiling. A schema-validated hcode/Claude/Codex judgment may choose only `none`,
  `nudge`, `door`, or `resume`, and may not exceed that ceiling. Working, fresh, owner-waiting, and complete entries
  are never nudged; after two nudges without newer registered-log evidence, the only escalation is an owner door.
- Nudge requires an empty cursor and a newer registered-log timestamp after literal delivery plus Enter. Resume uses
  only the registered type/resume id/cwd. Door appends only the registered ledger and optional notify hook. Every
  outcome is appended to `$HCODE_HOME/guard/audit.jsonl`.
- Guard has no kill, arbitrary shell, Git, merge, publish, deploy, payment, or owner-approval action. It cannot infer
  semantic progress from a cursor or mtime; those are delivery evidence only.

## Owner verification

On god after a signed installation:

```sh
hcode --version
hcode doctor
hcode guard status
hcode runner list --json
hcode task start codex "Read-only review of hcode guard boundaries; return file and test evidence, change nothing."
hcode launch codex "Same review, one-word spelling of the command above."
```

For the coordinated evaluation, start interactive hcode in the intended project, enter `/plan <bounded review>`,
inspect the printed contract, explicitly enter `/plan approve`, then inspect `/work`, `/tasks`, and `/context`.
Approval is never implied by starting hcode. Tests involving tmux use an independent `-L` socket; production guard
uses only the owner-configured registry and timer.
