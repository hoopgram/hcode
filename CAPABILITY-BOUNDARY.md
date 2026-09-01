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

## `hcode task`

- Starts or resumes one explicitly selected, owner-installed Claude or Codex CLI as a bounded background child.
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
```

For the coordinated evaluation, start interactive hcode in the intended project, enter `/plan <bounded review>`,
inspect the printed contract, explicitly enter `/plan approve`, then inspect `/work`, `/tasks`, and `/context`.
Approval is never implied by starting hcode. Tests involving tmux use an independent `-L` socket; production guard
uses only the owner-configured registry and timer.
