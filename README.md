# ○ Hoop Code (`hcode`)

The concise security and coordination contract for `task`, `work`, and `guard` is in
[CAPABILITY-BOUNDARY.md](CAPABILITY-BOUNDARY.md).

Since 0.9.4, **菊与刀**, hcode opens in Full Agency by default while keeping its fixed hard gates. A real
interactive first launch asks whether to remember that choice or ask again next time. Public-web search is
a first-class sourced tool instead of a Bash workaround or a failed Hoop-memory fallback.

HoopGram's AI coding agent for your terminal. **Zero third-party runtime packages** — native releases
carry their own pinned Node runtime; source/npm mode uses only Node ≥ 20 built-ins. On a [Hoop](https://hoopgram.ai/hoop) it is already wired to your
own brain; on your laptop it can sign in through hoopgram.ai, borrow your Hoop's brain through an SSH tunnel, or talk to any
Anthropic-compatible endpoint. The current build makes it something you can *depend on*: an append-only event
stream per session, crash recovery that never repeats a side effect, an OS sandbox, a policy file,
and — if you installed them — Claude Code or Codex as bounded subagents behind the same gate.

## Architecture

Start with the **[ten-minute architecture map](ARCHITECTURE.md)**. It follows one request around the agent loop,
draws the responsibility and trust boundaries, explains the composer/readline/plain render paths, and gives a
file-and-test route for each common kind of change. The compact invariant is: brains propose; policy decides;
tools act; the append-only session records; the terminal projects.

## Install channels: one version, two entrances

hcode has one source tree and one version number. npm and native are distribution channels, not forks:

- **npm/source is the default macOS channel until HoopGram has Developer ID signing and notarization.** It
  needs Node ≥ 20, uses no third-party runtime package, and remains fully supported.
- **Native is self-contained.** Node 24 LTS is inside the executable; ordinary owners do not install Node,
  npm or a package manager. Linux and macOS each build on their own architecture. Until notarization exists,
  macOS native files are explicitly labelled preview artifacts rather than the default public install.
- **Nix remains Nix-managed.** A Nix store executable never self-modifies; update the flake/profile instead.

The four native files and npm package must all name the same version and source commit. A normal feature is
implemented once. The matrix only repeats packaging and platform probes.

```sh
npm i -g @hoopgram/hcode
hcode doctor                 # config · brain · sandbox · policy · runners — in plain words
hcode setup                  # connect the hcode coordinator
hcode login mina             # browser account + subscription approval; no provider key on the laptop
hcode "fix the three typos in README.md"
hcode                        # interactive
hcode -p "summarise src/"    # non-interactive, for scripts
hcode connect mina           # your Hoop becomes the brain + a read-only private-data source
hcode                        # hcode may propose a bounded Codex/Claude subtask; you approve yes/no
hcode task start claude "inspect the parser"  # persistent background conversation
```

A native preview includes `install.sh`, four host-built binaries, one source-bound manifest and checksums. The
installer and `/update` discover the highest published release that carries a verified binary for this host,
including prereleases while notarization is pending; GitHub's stable-only `releases/latest` shortcut is deliberately not used. They install versions below
`~/.local/share/hcode/versions/`, switch `~/.local/bin/hcode` atomically, and keep one verified previous
version for `hcode rollback`. `/update` fast-forwards a source checkout, downloads and verifies a native
manifest for a native install, and refuses to mutate Nix.

## What it does

* Works inside **one project directory** with a small tool belt: `read_file`, `write_file`,
  `edit_file` (exact replacement, atomic), `list_dir`, `glob`, `grep`, `web_search` (fixed provider,
  sourced results, no arbitrary URL), `bash` (sandboxed), `ask_user`,
  `update_plan` (live goal/checkpoint/steps), and `delegate_agent` (owner-approved, read-only Codex/Claude investigation; report returns to hcode).
  `hcode tools --json` prints the contract: input/output schema, risk labels, idempotency.
* Renders common Markdown as readable terminal text and pins a calm, terminal-native composer to the bottom while work runs. Type `/` to
  search commands, paste multiline text as one message, press Ctrl-V to attach a clipboard image, and queue the next message without waiting. Images live only in a private process temp directory; session JSONL stores a digest/reference, never base64. A brain without declared vision is told that it cannot see the image, and an image-capable Codex/Claude subagent receives it only after the normal owner yes/no gate. Answers project
  progressively. Read/search activity replaces one live row instead of filling the transcript; edits, writes and commands leave compact `Edited`/`Wrote`/`Ran` records, and multi-step work updates a goal/checkpoint plan. The live work word carries a reduced-motion-safe gold sweep and `esc to interrupt`; its same-height repaint changes only that row, avoiding full-footer flashes.
  `/verbose` reveals raw tool details and `/usage` shows tokens; pipes and print mode stay plain.
  Interactive launch uses one short golden-Hoop charge before the composer takes the screen. Set
  `HCODE_REDUCE_MOTION=1` (all optional motion) or `HCODE_SPLASH=0` (launch only) to keep it static.
* Reads `HCODE.md → AGENTS.md → CLAUDE.md` and `.hcode/skills/*/SKILL.md` from the project root into its instructions.
* Keeps two worlds explicit: file/command tools and Codex/Claude always belong to the machine running hcode;
  `hoop_status`, `hoop_finance`, `hoop_files`, `hoop_calendar`, and `hoop_memory` read a connected Hoop and
  return a `[source: Hoop … · …]` label. The Hoop tools have no write, send, delete, payment, or trade action.
* Keeps every session as an **append-only JSONL event stream** (`~/.hcode/sessions/`, on a Hoop `~/mind/hcode/`):
  turns, tool calls with stable ids and idempotency keys, approvals, compactions, checkpoints, errors.
  `hcode --resume` continues it; 0.1.0 sessions still open. The first Ctrl-C cancels or warns; a second within
  1.5 seconds exits and restores the terminal.
* **Rewinds.** `esc esc` (or `/rewind`) on an idle prompt lists the points you can go back to — each request you
  made, each file hcode changed, the thread's own checkpoints — and going back forks the thread there and puts
  those files back the way they were. Every `write_file`/`edit_file` is snapshotted before it runs into a bounded
  content-addressed store beside the sessions (2 MB per file, 64 MB per store, both recorded when they bite).
  A blob lives as long as some thread still names it, so a fork keeps what it inherited and a deleted thread
  frees only what was private to it; the sweep runs when a session ends, when the store needs room, and on
  demand with `hcode sessions --reclaim`, with a seven-day TTL as the backstop;
  `bash` is not snapshotted, because hcode cannot name in advance what a command will touch. The thread you left
  is never destroyed — it stays in `hcode sessions` — and a file changed outside hcode since hcode last wrote it
  is named and left alone unless you say to overwrite it.
* **Recovers honestly.** If hcode (or the machine) dies mid-action, the next `--resume` cancels the
  interrupted write/command instead of running it again, re-runs only read-only calls, and tells you.
* **Keeps the context within a budget** (`--token-budget`, default 120k): older work is compacted into a
  summary event that keeps the files read, files changed, commands run and decisions taken.
* Uses one portable reasoning control, `--effort low|medium|high` (or `/effort`), across hcode, Claude Code and
  Codex. Native provider controls are used when supported; another compatible brain receives the same explicit
  behavioral tier without an API field its gateway may reject. On a DeepSeek brain, `low` disables thinking
  (`thinking: {type:"disabled"}` on the wire) — in the 6-exercise polyglot pilot this cut mean wall time from
  117s to 42.8s (2.7×) at unchanged pass@2, where dropping to the flash tier changed almost nothing.

## Terminal contract

The first frame says where the work happens, which runner is acting, and what permission boundary is active.
Hoop Code treats normal content as PAPER, an owner approval as the only KEY action, and paths/session/usage as
quiet GHOST facts. The approval protocol is still `y` once / `n` no / `a` for this session, with no selected
answer or countdown; Enter without a choice does not run the action.

ANSI is added only for an interactive sink. `NO_COLOR` (including an empty value), `TERM=dumb`, pipes, JSON
stdout, and `-p` stdout remain plain and copyable, with no cursor-return control characters; stderr is judged
independently and may decorate human-only status when it is a TTY. Colour never carries a
meaning by itself: `◌`, `✓`, `✗`, `▲`, and `○` remain alongside readable state words where a word is needed. The
renderer consumes session events but never writes terminal decoration back into the JSONL thread. C0/C1
control bytes from a model, runner, command, diff, or file preview are shown literally as `\xNN`; they can
never control the terminal or disappear from an owner decision. When an approval contains actual non-printing
input, a safety line says that the preview is escaped and execution still receives the original characters;
ordinary literal text such as `\x1b` does not receive that warning.

The live page uses a two-cell gutter on both sides of assistant output; wrapping is measured in terminal cells,
so CJK and emoji do not collide with the right edge. The shortcut and meter rows begin in the same column as
the input cursor. The input band follows the terminal rather than assuming a white page: it uses a non-blocking
OSC 11 background query when available, a `COLORFGBG` hint when present, and the terminal's native background
when neither can answer. `HCODE_INPUT_THEME=dark` or `light` is the explicit override. Only a complete known
slash command is luminous yellow on a dark field and contrast-safe gold on a light one; unknown slash text remains ordinary.

## The status footer

The bottom of a live session gives shortcuts and session use their own rows, from the first frame and
without any setup. A row is shown only when its complete fact fits; hcode never prints half a shortcut
or a truncated budget.

```
  Enter send · Shift+Enter newline · ? keys · Ctrl-C twice to exit
  deepseek-v4-pro · high · savetoken · ask
  ↓ 21.6K tokens · Context 38% left · 74.4K/120K · 4.5K cu
```

The context figure is the same number the compactor decides on — the larger of the estimate over the
thread and the real prompt the brain last billed — so the meter and the compaction it is warning about
can never disagree. The denominator is `--token-budget` (default 120,000). Three bands: under 60% cyan,
60–80% gold, over 80% bold red with `· /handoff` appended. **That is the whole of what the usage band
does.** hcode never clears, compacts or hands off a conversation because of this meter; `/handoff` then
`/clear` stays the owner's move, and `hcode --resume <id>` reopens the thread either way. (Automatic
compaction at the `--token-budget` line is a separate, older mechanism and is unchanged.)

Spend is shown in **relative cost units** — the same weights `/cost` uses (uncached 1 · cache write 1.25 ·
cache read 0.1 · output 5) — because hcode's gateways publish no price list and a dollar figure would be
invented. Give it a price list and it shows dollars instead:

```jsonc
// ~/.hcode/config.json — USD per million tokens, per billed class
{ "prices": { "input": 3, "cacheWrite": 3.75, "cacheRead": 0.3, "output": 15 } }
```

`HCODE_PRICES` takes the same object as JSON. A malformed list is dropped whole rather than half-applied,
and the meter falls back to cost units. Nothing is ever inferred from the model name.

When a terminal is too narrow for a complete row, that row disappears. The other rows remain when
it fits, so unrelated facts never compete for space or wrap into terminal debris.

The active-turn line shares the page gutter and sits one unpainted row above the input band. It always shows
elapsed time; once the provider has reported usage it appends that observed token total. Before then hcode
shows time alone rather than estimating a number that the provider has not supplied.

## Keys

Press `?` on an empty input line for this table inside a session. It is generated from `KEY_HELP` in
`src/commands.js`, which is also what `/help` prints — there is no second list to drift.

| Key | What it does |
| --- | --- |
| `Enter` | send the message |
| `Shift-Enter` | newline without sending |
| `Ctrl-J` / `\` then `Enter` | newline fallbacks for terminals that cannot encode `Shift-Enter` |
| `Tab` | complete the slash command the list has selected |
| `↑` / `↓` | step through the slash list, or through what you sent before |
| `Ctrl-R` | search backwards through what you sent before |
| `Ctrl-G` | write the message in `$EDITOR` (or `$VISUAL`) and come back with it |
| `Ctrl-V` | paste an image from the clipboard |
| `←` / `→` | move one character |
| `Ctrl-A` / `Ctrl-E` | go to the start / end of the line |
| `Alt-B` / `Alt-F` | move back / forward one word |
| `Alt-D` | delete the word after the cursor |
| `Ctrl-W` / `Alt-⌫` | delete the word before the cursor |
| `Ctrl-U` / `Ctrl-K` | delete to the start / end of the line |
| `?` | this key table, when the input line is empty |
| `Ctrl-O` | read the transcript back: `↑↓` and `PgUp`/`PgDn` page, `/` searches, `Esc` leaves |
| `Ctrl-F` | open a subagent's conversation: same panel, and it follows while the helper works |
| `Ctrl-L` | repaint the screen from the transcript |
| `Ctrl-T` | background tasks and coordinated work (`/tasks`) |
| `Esc` | stop the running turn, or close what is open |
| `Esc Esc` | rewind to an earlier point (idle only) |
| `Ctrl-C` | cancel the running turn; `Ctrl-C` twice in a row exits |
| `Ctrl-D` | exit, on an empty line |

`Ctrl-O` reads the page back. It shows the composer's transcript ring — the same bounded, line-level
record the composer repaints the page from — so there is nothing to scroll to that hcode did not itself
print, and reading it changes nothing: the draft, the ring and the running turn are untouched. It opens at
the newest line and keeps following new output while you are at the end; scrolling up or jumping to a search
hit stops it following, `G` starts again. `/` searches every line the ring kept, not just the page on screen,
and `n`/`N` step between hits. When the ring has dropped its oldest lines the header says how many, rather
than looking complete. The terminal's own scrollback still works as it always did; this is the part hcode
can guarantee, at any width.

Under the input box, one line per subagent this session started — `○ claude  Reading frame.js…  4m 34s ·
↓ 109.7k tokens` — with the mark carrying the state (lavender still working, green done, red failed, amber
cancelled), what it is doing now, and how long it has taken and cost. Running helpers come first, the rest
stay in the order they were started, and past four the board says `… +3` instead of growing. A session that
has delegated nothing shows nothing at all: no heading, no empty state, no reserved band. `Ctrl-F` opens one
helper's whole conversation in the `Ctrl-O` panel — the owner's prompt bold, the helper's words plain, tools
in cyan, the machinery dim — and it keeps following while the helper works, stopping the moment you scroll
up. The numbers are the ones the helper's own runner reported, so the board and `hcode cost` cannot disagree.

Keys other coding CLIs bind that hcode deliberately does not:

- **`Ctrl-B` (send the running task to the background).** hcode's own turn runs in this process and cannot be
  detached from it. Background work is started as background work — `/claude`, `/codex`, `/plan` — and `/tasks`
  (or `Ctrl-T`) shows it.
- **`Ctrl-P` / `Ctrl-N` for history.** `↑` / `↓` already do it, and the same two keys have to stay free for the
  slash list; a second binding for one behaviour is noise.
- **`Shift-Tab` (cycle permission mode).** Permission is a decision with consequences: it stays `/permissions`
  and `/mode`, which name what is being granted and record it.

## First run: connect the coordinator, not an API error

On a Hoop, the local brain is already ready. Everywhere else, an unconfigured interactive launch opens one
owner choice before it opens a session: HoopGram account, an owner-supplied API provider, or an owner-managed
Hoop. hcode remains the coordinator and final speaker. Installed Codex and Claude CLIs appear under `/agents`
as optional subagents, never primary-brain choices. Each bounded delegation shows the exact agent and task and
requires yes/no; the subagent is read-only and its report returns to hcode for verification and integration.

`hcode login <name>` opens hoopgram.ai, uses the website's existing account flow, checks ownership and an active
or complimentary subscription, and returns a revocable device session. The provider API key never leaves the
Hoop/keyproxy. `~/.hcode/auth.json` contains only that device session and is mode 0600; `/logout` revokes it and
removes the local copy. `hcode connect <name>` remains the advanced SSH path for an owner-managed Hoop.

The legacy explicit `--runner` compatibility path is not saved as a default. If it is opened directly in a broad folder such as the owner's home, hcode keeps the private-path
check but turns it into an owner gate: `[y]es / [n]o`, with Enter meaning no. Yes grants that runner access only
for the current hcode session and writes a `workspace.approval` event; scripts and print mode remain fail-closed.

## Permission modes

| mode | reads | writes / edits | `bash` | network (inside `bash`) |
|---|---|---|---|---|
| `read` | yes | refused | refused | — |
| `ask` | yes | confirmed each time | confirmed each time | confirmed each time |
| `auto` | yes | yes | yes | **off** unless the policy allows the host |
| `all` / Full Agency (default) | yes | yes | yes | Bash follows project network policy; bounded `web_search` is available |

In `ask` mode the prompt says what will happen and why it needs permission; you answer `y` / `n` / `a`
(always, this session). Every answer is written to the session as an `approval` event — that is the audit.
`hcode -p` never asks: in `ask` mode it refuses mutating calls, so use `--mode auto` for scripted edits you trust.
Because a headless run has no human, a permission refusal is a **failed task**, not a partial answer:
`-p` names the refused tools on stderr, prints a machine-readable `hcode-print: denied=N` line, and exits
`3` (distinct from `1` = stopped/cancelled, `0` = clean). A worker that retries exit 3 without escalating
is retrying something a human already needs to see. `--agency N` is stamped into the session trail: a later
`--resume` re-applies the same grant (a supervisor's resume must not silently fall back to ask-per-action —
the hard edges money/identity/secrets/root-home/network still ask or refuse at every level). Passing
`--agency` again on the resume invocation replaces the stored grant. `--unattended` runs without the
interactive confirm: permission asks are refused honestly ("no human was available") instead of waiting for
a keypress, so an automated Enter can never be recorded as a human decision.

On a real interactive first launch, hcode offers Full Agency first and asks whether to remember the choice for
this project or ask again on every startup. `/permissions` changes the mode later and can also forget the project
default. Full Agency bypasses ordinary prompts inside the project; the five owner gates—overspend, owner-data
deletion, constitutional wording, new public exposure, and owner-intent conflict—still stop, while secret paths
and root/home deletion remain technically unreachable. Codex/Claude subagents keep separate credentials and
retain workspace boundaries. Pipes, `-p`, slash-command startup and resume never stop for the startup chooser.

`web_search` accepts only a query, contacts hcode's fixed public search provider, and returns titles, snippets and
source URLs. It never accepts or opens a result URL. `ask` confirms sending the query; `auto` and Full Agency search
directly. This does not switch Bash networking on and does not use connected-Hoop memory as a public-web fallback.

## Policy: `.hcode/policy.json`

```json
{ "v": 1, "mode": "ask",
  "network": { "default": "off", "allow": ["api.github.com", "*.hoopgram.ai"] },
  "allow": ["bash:git *", "bash:npm test", "write_file:docs/**"],
  "sandbox": "auto" }
```

`mode` is the project default (`--mode` wins). `network.allow` lists hosts a command may reach without
asking; everything else stays off. `allow` pre-approves tool patterns. `sandbox` is `auto` (pick the OS
adapter), a specific adapter, or `none`. The old `.hcode/settings.json { "allow": […] }` is still read.

## Rules: `.hcode/settings.json`

A rule says what hcode does about a shape of call, so you decide once instead of every time.

```json
{ "rules": [
  { "tool": "bash", "command": "git push --force*", "action": "deny", "why": "never from here" },
  { "tool": "bash", "command": "npm test*", "action": "allow" },
  { "tool": "write_file", "path": "migrations/**", "action": "ask" }
] }
```

| field | meaning |
|---|---|
| `tool` | tool name or a glob (`*`). A rule with `command` and no `tool` is a `bash` rule. |
| `command` | glob against the bash command — matched against the whole line **and** each `;`/`&&`/`\|` segment, so a harmless prefix hides nothing |
| `path` | glob against the call's `path` (`src/**`) |
| `action` | `deny`, `ask` or `allow` — required |
| `why` | the sentence you will read when the rule fires |

Two files are merged into one book: **`~/.hcode/settings.json`** (every project) and
**`<project>/.hcode/settings.json`**. Conflicts are settled by consequence, never by file order or by
which pattern looks more specific: **`deny` beats `ask` beats `allow`.** A user-level `deny` cannot be
undone by a project-level `allow` — a repository cannot talk its way past a decision you made once for
every repository.

A `deny` is checked before the permission mode, so `auto`, the session-only `all`, an `allow` in
`policy.json` and an "always" you clicked earlier in the session all fail to reach past it. An `ask` rule
likewise outranks `auto`: it is a standing instruction, not a preference the current mode overrides. An
`allow` rule that names a `command` or `path` also satisfies the network default for that one call; a
blanket `{"tool":"bash","action":"allow"}` names nothing and stays below the network policy.

Rules are enforced in the broker, at the one point every tool call passes through — not by a line in the
system prompt. The model cannot read or edit them either: `.hcode/` is on the secret-path blacklist.

## Consequence gates

`bash` is one tool, but `ls` and `git push --force` are not one decision. Before a command runs, hcode
reads four classes of **outcome** off it and asks when one is at stake, saying which and why:

| class | what it means | hits |
|---|---|---|
| `spend` | it costs money | `terraform apply`, `hcloud server create`, a metered model API, another billed agent |
| `irreversible` | it cannot be undone | `rm -rf`, `git push --force`, `git reset --hard`, `dd if=`, a forced overwrite |
| `exposure` | it becomes visible to others | `git push`, `npm publish`, `gh release create`, `docker push`, an upload |
| `deletion` | it removes things | `rm`, `git branch -D`, `kubectl delete`, `find -delete`, a cloud `delete` |

Overlap is the point: `rm -rf dist` is both `irreversible` and `deletion`, and the prompt says both. The
classification is a pattern table, never a model call — a gate that needs a brain fails when the brain is
down, costs money to ask about money, and can be argued with. Segments are read separately, so
`npm run build && rm -rf dist` is gated on the second half; commands led by a read-only verb (`grep`,
`echo`, `cat`, …) are not scanned, so grepping *for* `git push` is not pushing.

**A gate asks in every mode, `auto` and session-only `all` included.** A specific `allow` rule that names
the command covers a command you have already thought about (`{"tool":"bash","command":"rm -rf build*",
"action":"allow"}`); a blanket `{"tool":"bash","action":"allow"}` names nothing and does not. There is no
setting that switches a class off, because "stop asking me about money" is exactly the decision that
should be made one command at a time. A `deny` rule still outranks a gate, and the fixed boundaries
(secret paths, root/home) are still checked first.

Delegation has the same gate: a helper on a **flagship** brain spends what the coordinator spends, so
`--allow-flagship` / `allow_flagship:true` names the model but does not buy it — you are still asked, and
a non-interactive `hcode task start` refuses rather than quietly billing.

`/permissions` shows the modes and the rules on one screen and edits them in place: a number moves a rule
`deny → ask → allow → gone`, and `+ bash "git push*" ask` adds one. Every edit is written straight back
to the file it came from, leaving the rest of that `settings.json` untouched.
Two bounded exceptions reach outside the project root — both **owner-written in policy.json** (the model
never sees or edits `.hcode/`), both with edges, not backdoors:

- `"allowedRoots": ["/abs/dir"]` — exact **read-only** grants. `read_file`, `list_dir`, `glob`, `grep` and
  read-only `bash` (cat/grep/sed -n/…) may touch them; any mutation there still refuses. This is how an
  agent reads its work orders when the project root is a worktree and the handover lives elsewhere.
- `"allowedTempRoots": ["/abs/scratch"]` — declared **writable scratch**, materialized at load. Reads and
  writes inside them pass (`mv file /abs/scratch/`, `write_file`, restore back into the project): this is
  the bounded home of self-verification — hide a file, watch the gate honestly go red, restore it.
  `mv` to any other outside path still refuses, a grant may not also be a read grant, may not contain
  the project root, and may not be `/`.

**Full Agency and the step budget:** at agency level ≥ 8 the `--max-turns` budget renews itself instead of
halting (`stopped after N steps — say continue`) — every renewal is accounted in the session trail as an
`agency.auto-continue` event plus a checkpoint. Lower levels still stop at the limit: it is their spend
brake. Budget/circuit failures and permission refusals stop any level.

## Sandbox

`bash` runs inside an OS sandbox when the OS offers one — **macOS `sandbox-exec`**, **Linux `bwrap`**
(else `systemd-run` properties): writes only under the project and temp dirs, secret directories
unreadable, network off unless the policy or you allowed it for that call. hcode probes the adapter at
start by actually trying to write outside the project; if the OS refuses to confine (for example
`systemd-run --user` on a hardened host), `hcode doctor` and the banner say **degraded** and nothing
pretends otherwise — the policy (network off, secret paths refused, project-root writes) still applies
in-process.

## Codex and Claude subagents

Claude Code CLI and Codex CLI are **optional subagents you install and sign into yourself** on each machine.
hcode only detects their binaries; it never reads their login material. Mac hcode calls Mac-local CLIs; hcode
running in a PA calls that PA's CLIs. `hcode connect` does not move them to the remote Hoop. The coordinator can
call one through `delegate_agent` for a single read-only, network-off investigation after an explicit owner
yes/no. Child lifecycle events and the report are audited in the hcode session. hcode evaluates the report,
makes any approved edits with its own tools, and gives the final answer. `hcode runner list` and `/agents` show
availability. The legacy explicit `--runner` flag remains only as a one-shot compatibility escape hatch and is
never restored from saved config.

Every subagent names the brain it runs on; none inherits the foreign CLI's own default. A call either names a
model or declares the work and takes that tier — `search` (claude `haiku`, codex `gpt-5.6-luna`) for
searching, scanning and reading logs, `mechanical` (`sonnet` / `gpt-5.6-terra`) for repetitive edits, `implement`
(`opus` / `gpt-5.6-sol`) for designing and writing code. Any cell can be replaced in
`.hcode/settings.json` (`{"subagentModels":{"codex":{"search":"o4-mini"}}}`) — the installed CLI and the model
names it knows are yours. A flagship brain — `fable`, or whatever this session's own coordinator runs on — is
refused as a helper unless the call says `allow_flagship` (`--allow-flagship` from the owner's side): delegation
is for spending less, not the same. The flag names that brain but does not buy it — the spend gate still asks,
and a non-interactive `hcode task start` refuses rather than quietly billing. Every refusal prints the exact
call to write instead.

A call that declares **nothing** is read rather than told off: if the task is looking rather than building —
searching, scanning, locating, listing, reading output — hcode takes the smallest tier and says so in the
report (`(haiku — this reads as search work, so hcode took the smallest tier; a bigger brain is explicit …)`).
Work that would build something is still refused with the call to write instead. Saving money is the default;
spending it stays explicit, and neither is a guess about what you meant.

Long-running work has a separate persistent background lane. `/claude [--kind implement] <task>` and
`/codex <task>` start concurrent conversations; `/tasks` lists them, `/attach` lists this session's subagents and
`/attach <id>` opens one — a background conversation's transcript, or a finished one-off subagent's own thread —
`/task <id> <message>` resumes the same foreign conversation, and `/stop <id>` stops its worker. The equivalent
scriptable commands are under `hcode task` (`--agent-model` / `--kind` choose the brain). Their registry and
transcripts are mode 0600 under `~/.hcode/tasks/`. These lanes do not become the main speaker: hcode remains the
coordinator, and its normal `delegate_agent` path still returns a bounded report for hcode to verify and integrate.

`/btw <question>` is one aside: a one-off read-only subagent answers it, the answer is printed to you and kept in
the child ledger, and it never enters the conversation — a side question buys one call, not a permanent seat in
every later prompt. `/btw --agent codex --kind search …` picks the runner and tier; `/attach <c-…>` reopens the
aside's own thread afterwards.

For coordinated hour-scale work, `/plan <goal>` creates an immutable contract and `/plan approve` starts a
detached supervisor. Runner text and tool events refresh a durable activity heartbeat; silence past the contract
limit becomes `orphaned`, never “completed.” Owner decisions are append-only gates: inspect them with
`hcode gate list [workId]`, then use `hcode gate approve|reject <workId> <gateId> [--note <text>]`. Waiting on a
gate neither retries nor consumes the active wall budget. `hcode work status [workId]` shows the same truth and
`hcode work supervise [workId] [--stop]` manages its guard process. Hoop OS reads the atomic v1 projection under
`$HCODE_HOME/work-status/`; the source of truth remains the portable contract and JSONL ledger in the project.
Optional `--tmux` creates only hcode-named observation sessions; agent control never travels through terminal
keystrokes or screen contents.

`hcode guard --once --registry <path>` patrols an owner-maintained registry of Claude, Codex, and coordinated
work lanes. It reads only process, cursor, registered-log timestamps, and work-status metadata—never pane text.
Mechanical safety rules bound a schema-validated brain judgment to `none`, `nudge`, `door`, or `resume`; two
nudges without newer evidence always become an owner door. `hcode guard status` reads the private append-only
audit under `$HCODE_HOME/guard/`. A system timer should invoke `--once`; `--interval 15m` is available for a
foreground supervisor. Tests that exercise tmux should pass `--tmux-socket <independent-name>`.

The registry is owner-maintained JSON; every path and resume id is explicit—guard never discovers prompts or
reads agent logs. A minimal file is:

```json
{"v":1,"idleMinutes":30,"sessions":[
  {"name":"review","type":"codex","resumeId":"thread-id","cwd":"/home/me/project","ledger":"/home/me/ledger.md","logPath":"/home/me/codex-rollout.jsonl","expected":"working"},
  {"name":"inspect","type":"work","workId":"work-feedface","cwd":"/home/me/project","ledger":"/home/me/ledger.md","expected":"working"}
]}
```

`expected` is `working`, `waiting-owner`, or `complete`. For work entries, `name` is the lane id and `workId`
selects the atomic work-status file. Use global `--runner claude|codex` to ask an installed external runner for
the bounded judgment; otherwise guard uses hcode's configured brain.

`/mcp` (alias `/connectors`) and scriptable `hcode mcp list [--json]` summarize connectors through fixed
`codex mcp list` and `claude mcp list` calls. hcode does not open either agent's config/auth files, strips hcode
provider credentials from the subprocess environment, redacts secret-shaped output, caps bytes, and enforces a
deadline. Add, remove, authenticate, and scope connectors in the owner CLI that owns them.

On a PA, the terminal checks the owner's conventional `$HOME/.local/bin` and `$HOME/.nix-profile/bin` before
the system PATH. This makes separately installed CLIs discoverable without placing them or their credentials in
the Hoop closure.

## Configuration

Priority: command line › environment › `~/.hcode/config.json` › defaults.

| setting | flag | env | default |
|---|---|---|---|
| base URL | `--base-url` | `HCODE_BASE_URL` / `ANTHROPIC_BASE_URL` | on a Hoop `http://127.0.0.1:8092`, else `https://api.anthropic.com` |
| API key | `--api-key` | `HCODE_API_KEY` / `ANTHROPIC_API_KEY` | on a Hoop `gram-local` (the real key never leaves the Hoop) |
| model | `--model` | `HCODE_MODEL` / `ANTHROPIC_MODEL` | on a Hoop `deepseek-v4-pro`, else `claude-sonnet-5` |
| fallback models | config `fallbackModels` | `HCODE_FALLBACK_MODELS` (comma-separated; empty disables) | on a Hoop `glm-5.3,deepseek-v4-flash` (vendor-diverse: cross-provider first) |
| mode | `--mode` | `HCODE_MODE` | `all` / Full Agency (or the policy file's `mode`) |
| token budget | `--token-budget` | `HCODE_TOKEN_BUDGET` | `120000` |
| prices | — | `HCODE_PRICES` | none — the status meter stays in relative cost units |
| runner | `--runner` | `HCODE_RUNNER` | `hcode` |

Provider authentication failures are translated into one owner action: run `hcode setup` and choose a ready
brain. Raw provider-header errors are not part of the normal interaction.
After bounded 429 retries, hcode may continue the same session on a known agentic fallback and records that
change in the session log. Eligibility comes from the provider's `/v1/model-capabilities` declaration and a
fresh nonce-bound live probe that must agree on context tokens and agentic tier. Missing, malformed, stale or
contradictory evidence is `UNOBSERVED`; a context below `fallbackMinContextTokens` (default 16000) or a tier
below `agentic` is refused. The durable session and objective remain resumable after either refusal.

Interactive commands include `/help`, `/config`, `/status`, `/init`, `/model`, `/permissions`, `/context`,
`/compact`, `/handoff`, `/continue`, `/handoffs`, `/savetoken`, `/usedefault`, `/clear`, `/rewind`, `/resume`, `/sessions`, `/review`, `/diff`, `/plan`, `/work`, `/gate`, `/agents`, `/tasks`, `/claude`, `/codex`,
`/btw`, `/attach`, `/mcp`, `/brain`, `/login`, `/logout`, `/doctor`, `/verbose`, `/usage`, `/cost`, `/command`, `/tune`, and `/exit`.
`/usage` is the turn you just ran; `/cost` (also `hcode cost [--days N]`) reads every saved session log instead —
uncached input, cache write, cache read and output added up across all of them, a relative **cost unit** weight
(uncached 1, cache write 1.25, cache read 0.1, output 5 — never a dollar figure, because the gateway publishes no
price list), and then the biggest sessions by that weight with their turn count and peak context. It counts each
`seq` once, so a thread whose tail was rewritten by crash recovery is not billed twice.
`/compact` appends a deterministic local summary event; `/clear` starts a new thread without deleting the old one;
`/rewind` (or `esc esc` at an idle prompt) forks the thread at an earlier point and puts the files hcode changed
since that point back the way they were.
`/handoff [done|active] [task]` files a **handoff ledger** — a work contract someone else can pick up, not a
compressed history. It is written from the thread's own event log and from this process (no brain call, no cost,
the same file for the same log) into `<project>/交接/hcode/active/hcode-<task>.md`, in six numbered sections:
a machine-readable line 0 (`0. 模式: … | 状态: …`), goal and progress, next steps, verified versions and file
hashes, open questions, and a restart line. The restart line is generated, not typed — the cwd, the launcher,
the session flags that differ from a plain `hcode`, and the non-secret environment variables, as one line ending
in `"/continue <task>"`. Credentials can never reach it. `状态` defaults to what the evidence says (anything
unfinished or unanswered → `active`) and `/handoff done` overrides. Re-running `/handoff` for the same task
overwrites the same file: one agent plus one task is one ledger.

`/continue [filter]` is the other half. It first files every `状态: done` ledger into `archive/YYYY-MM/` — the
only thing that ever archives one, so a finished task cannot sit in `active/` forever and an unfinished one is
never touched however old — then opens the newest ledger still active (optionally filtered by a word in its
name), restores the mode it recorded, and prints three lines: goal, next, open. `hcode "/continue parser"` runs
it on a fresh session at launch, which is exactly what a restart line pastes — a launch argument whose first
word names no command (built-in or custom) is sent whole as an ordinary prompt instead, since the shell had no
`/` list to complete it against; typed into the composer, which does, an unknown name is still refused as a
typo. `/handoffs` lists what is active.
`HCODE_HANDOFF_DIR` or `.hcode/settings.json` `{"handoffDir": "..."}` moves the ledger directory.
From 120K tokens of real prompt, hcode says so once per tier (120K/150K/180K) and points at `/handoff`; it
never clears the context, and never restarts the session, for you.

`/savetoken` turns on token-saving mode for the conversation; `/usedefault` cancels it. It does three things
and nothing else: the system prompt gains a section saying delegation is the default and this context is the
exception (searching, scanning and any check across more than three files go to a subagent; a known file is read
as a bounded range; the answer is conclusion-first and short — with an explicit escape that correctness outranks
the token rule, so hard debugging, architecture and security reasoning still read directly), a delegation that
names neither a model nor a kind takes the **smallest** tier instead of being refused, and the mode is written
to the thread as a `mode` event. Because it lives on the thread and not in a config file, `hcode --resume`
brings it back, `/clear` keeps it while freeing the context, `/context` shows it, and a handoff ledger carries
it on line 0 for `/continue` to restore. It never touches permission mode, the brain, the sandbox, or the
flagship rule: a mode that exists to spend less cannot buy a bigger helper.

`/command new <name> <prompt>` turns a prompt you keep retyping into `/<name>`. It writes
`.hcode/commands/<name>.md` in the project (`--user` writes `~/.hcode/commands/<name>.md` for every
project); `$ARGUMENTS` in the body is replaced by whatever follows the command, and without it the
arguments are appended rather than dropped. Nothing executes and nothing is fetched — the file is markdown
you can read, edit in an editor, diff and commit, and running `/<name>` is exactly the same as having typed
its body. A saved command joins the `/` popup and `/help` immediately, no restart. `/command list` shows
what there is, `/command show <name>` prints one. A **built-in always wins**: a file named after one is
saved, listed and reported as shadowed, but never dispatched. A project file wins over a user file of the
same name and says which one it shadows. Same directory layout and frontmatter (`description:`) as Claude
Code, so existing command files can be copied in unchanged; 40 commands per directory, 8,000 characters
each — a longer procedure belongs in `.hcode/skills/<name>/SKILL.md`.

`/tune` (also `hcode tune [--days N]`) reads the saved session logs and proposes three things your own
history argues for: the approvals **you** kept granting, as `.hcode/policy.json` allow rules that will match
again (`bash:npm test *`, not the exact command line); the requests you kept retyping, grouped by shape —
paths and numbers replaced, which is precisely where `$ARGUMENTS` goes — as `/command new` lines; and the big
files that were read whole more than once, which want an `offset`/`limit` range or a subagent. Every row
carries how many times it happened and one `session:seq` pointer to open. It reads only what the owner
already granted (a `by:"policy"` approval cost nobody a keystroke and is not proposed as a rule), it
de-duplicates on `seq` the way `/cost` does so a crash-recovered tail is not counted twice, and when the
logs cannot support a class it says the data is thin rather than filling the section with a plausible guess.
**It changes nothing** — a change to what hcode may do without asking is the owner's to make.

## `hcode connect <name>`

Opens one SSH process with two owner-key tunnels: `18092 → keyproxy:8092` for the brain and
`18095 → mind:8095` for whitelisted read-only Hoop capabilities. Local files, commands, and subagents stay on
the machine where hcode was launched. Nothing is written on the client side: no API key, password, or token —
the provider key stays on the Hoop, metered and capped there. Options: `--user`, `--port`, `--hoop-port`,
`--identity`.

## Security

* Writes and edits never leave the project root; `..` and absolute paths outside it are refused; they are
  atomic (tmp + rename), so a failure never leaves a half-written file.
* Reads may look outside the root but never at secret-shaped paths (`~/.ssh`, `~/.secrets`, `~/.hoopgram`,
  `~/.hcode`, `~/.codex/auth.json`, `~/.claude/settings*.json`, `~/.npmrc`, `.env*`, `*.pem`, `*.key`, `id_*`, …).
* `bash` runs as you, in the project root, sandboxed, with a timeout; each command is classified
  (`write` / `network` / `destructive`; unknown commands count as destructive) before the gate decides.
* Model keys never enter the session file, the logs, `doctor` output, or the environment of commands.
* On a Hoop, every model call goes through keyproxy: the monthly pool cap and the `think` audit
  apply to hcode exactly as they do to the chat.

## Session format (v2)

One JSON object per line. Line 1 is the header; every other line carries `v:2`, `ts`, a monotonic `seq`,
the `turn` id and a `type`: `turn.start` · `turn.end` · `item` (`message` / `tool_call` / `tool_result` /
`approval` / `compaction` / `checkpoint`) · `text` · `approval` · `compaction` · `checkpoint` · `error`.
A `tool_call` carries `idem = sha256(tool + input + turn)`; on resume, the same key is never executed twice.
A corrupt last line (killed mid-write) is dropped and recorded as `error{tail_corrupt}`; the session stays readable.

## Public low-cost benchmark

`hcode benchmark` is deterministic and makes no model calls. It publishes a fixture SHA-256, stresses 240 turns of
repeated automatic compaction, verifies that 32 simulated child reports remain distinct in the evidence ledger, and
self-checks its graders. `hcode benchmark --describe` prints the complete fixed manifest so another implementation can
run the same coding and planning prompts. The 32-child lane measures ledger capacity, not the quality of 32 live agents.

`hcode benchmark --live --budget-usd 0.75` additionally runs one small coding task and one constrained planning task,
sequentially, through hcode, Codex and Claude Code at the shared nominal `low` effort tier. Equal tier names are controls,
not evidence of equal compute across providers. Planning must preserve v2 resumability, overlap protocol, secret exclusion,
idempotent side effects, lossless rollback and owner control; headings alone cannot pass. Claude receives a hard per-call cash cap; subscription/quota runners may
not expose exact incremental cash cost, so the JSON report separates known cost from the owner ceiling. Wall time, first
process output, sampled process-tree CPU and peak RSS are recorded alongside runner versions, commands, execution order
and an explicit no-cold/warm-claim state. macOS has no safe unprivileged per-process GPU
attribution; an owner-run Instruments trace is required for a defensible GPU number. Reports are mode 0600 under
`~/.hcode/benchmarks/`.

`hcode benchmark --polyglot --exercises <clone>` runs the Aider polyglot benchmark (Exercism practice exercises with hidden unit
tests, scored pass@2 — a second attempt sees the failing tests) through hcode, Codex and Claude Code as products, with the same
prompt and a fresh workspace each. JavaScript and Python tracks; no docker. Clone `github.com/Aider-AI/polyglot-benchmark`,
run `npm install` once in `<clone>/javascript` with any exercise's `package.json`, and point `HCODE_POLYGLOT_PYTHON` at an
interpreter that has pytest. `--n <k>` picks the same spread subset on every machine, `--runners`, `--langs` narrow the run,
`--effort <tier>` passes the shared reasoning tier down to every runner (`low` is the measured speed
lever on a DeepSeek brain, see above), `--resume-rows <jsonl>` continues an interrupted one. The table gives pass@1, pass@2, mean wall seconds, tokens and known cost
per runner and names every failed exercise; each Claude call carries a hard cash cap (`--budget-usd`).

## Develop

```sh
npm test          # node --test — event stream, recovery, policy, sandbox, two-world routing, owner gates, runners, terminal UI
npm run check     # node --check on every file
hcode demo        # one scripted turn through the real renderer (no brain, no ssh) — look at a UI change in 1 s
```

The iteration loop we keep (screenshot-driven, demo → test → commit, three render paths) is
written down in `HCODE.md` → "Iteration loop"; read it before changing the terminal UI.

AGPL-3.0 · Hoop Code is part of [HoopGram](https://hoopgram.ai). Hoop is HoopGram's first product.
