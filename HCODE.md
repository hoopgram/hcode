# HCODE.md — project instructions for coding agents

## Purpose

`hcode` (Hoop Code) is HoopGram's zero-dependency AI coding agent for the terminal.
It runs inside one project directory with a small tool belt (read_file, write_file,
edit_file, list_dir, glob, grep, web_search, bash, ask_user, update_plan, delegate_agent), writes every session as an append-only
event stream (src/session.js), gates tools through a policy + OS sandbox (src/policy.js,
src/sandbox.js), and streams answers over the
Anthropic Messages API (or a Hoop's keyproxy / any compatible endpoint).

## Hard rules

- **Zero dependencies.** Node.js >= 20 built-ins only (`node:fs`, `node:os`, `node:path`,
  `node:child_process`, `node:readline`, `node:net`, `node:crypto`, `node:stream`, …).
- **ESM only.** `"type": "module"`; use `import` / `export`.
- **No TUI frameworks.** Semantic plain text first; ANSI only for an interactive sink (see `src/ui.js`).
  No spinner, high-frequency full-frame rewriting, or colour-only state. `NO_COLOR`, `TERM=dumb`, pipes, JSON stdout and `-p` stdout stay clean.
  Untrusted C0/C1 controls are rendered visibly as `\xNN`; never silently remove bytes from an approval. Mark an approval
  when its preview is escaped so real control characters remain distinguishable from literal escape text.
- **Never read or write secret-shaped paths.** Respect `src/tools.js` `isSecretPath`
  (`~/.ssh`, `.env*`, `*.pem`, `*.key`, `~/.hcode`, `~/.hoopgram`, `~/.aws`, `~/.gnupg`, …).
- **Writes/edits stay inside the project root.** Reads may look outside the root but
  still must skip secret-shaped paths. Never touch hcode's own config, secrets, or keys.
- Do not add dependencies, lockfiles, or build steps. Keep everything in `bin/` + `src/`.

## How to test

- `npm test` — run the test suite (`node --test test/*.test.js`).
- `npm run check` — syntax-check `bin/hcode.js` and every `src/*.js` with `node --check`.
Run both before finishing a change.

## File map

- `bin/hcode.js` — entrypoint; calls `main()` from `src/cli.js`.
- `src/cli.js` — command surface: interactive, one task, `-p` print mode, `--resume`, `connect`, `doctor`, `sessions`, `--version`, `--help`.
- `src/agent.js` — agent loop (prompt → stream → run tools with permissions); loads `HCODE.md`/`AGENTS.md`/`CLAUDE.md`.
- `src/api.js` — Anthropic Messages API streaming (SSE) with tool use; `ApiError`, `sseEvents`, `streamMessage`.
- `src/config.js` — config resolution (cli > env `HCODE_*`/`ANTHROPIC_*` > `~/.hcode/config.json` > defaults); `VERSION`, `HOME`, `ON_HOOP`.
- `src/connect.js` — `hcode connect <name>`: SSH tunnel to your Hoop's keyproxy.
- `src/doctor.js` — `hcode doctor` diagnostics (config source, brain check, write check).
- `src/session.js` — JSONL sessions (`~/.hcode/sessions/`); resume support.
- `src/tools.js` — the tool belt, path/secret guards, glob/regex helpers, allow-list matching.
- `src/web-search.js` — fixed-provider public search; query in, source-labelled results out, never an arbitrary URL fetch.
- `src/ui.js` — plain terminal output helpers, colours, `ui`.
  `createUI({out,err,env,columns})` is the injected renderer used by tests; it never owns session state.
- `src/brain.js` — read-only brain discovery plus owner-selected runner persistence; credentials never pass through it.

## Commit style

- Imperative subject, e.g. `Fix path guard for symlinked dirs`.
- One logical change per commit; split unrelated edits.
- No dependency or lockfile changes unless explicitly required (and then reconsider).

## Iteration loop (how hcode ships fast — keep this pace on any machine)

Proven on 2026-08-30: twelve commits in one afternoon, 209 → 213 tests, on a laptop, with the
owner watching the real product instead of mockups. Same loop on any machine and from any agent;
nothing here needs a server.

1. **Local, on a branch.** `git worktree` + branch. UI and CLI work never touches a Hoop or any
   server. Pushing, merging to main and releasing are the owner's decisions, never the agent's.
2. **Owner feedback = screenshot + one sentence.** The agent does not ask style questions and
   never shows an intermediate state. It decides the final shape, ships it, and says in one line
   what to launch and where to look. If the owner wants it different, they say so with the next screenshot.
3. **One feedback batch is one change.** Freeze its shared layout/behavior contract once, edit the
   affected paths together, then run the nearest unit tests → `hcode demo` (one scripted turn,
   1 s, no brain, no ssh) → the seeded PTY test when frame geometry changed → `npm test` once at
   the commit gate. Do not restart the full suite after every assertion fix; use it to close the
   integrated change. Commit by owner-visible topic and report in one line. Interactive check when
   needed: `hcode` (composer) — it always runs the current worktree.
4. **Three render paths, every UI change:** the composer (bottom-pinned box, `src/composer.js`),
   the readline path (`ui.prompt()` in `src/ui.js`), and the plain sink (`--print`, pipes,
   `NO_COLOR`) which must stay byte-for-byte unchanged. A change that only lands in one of the
   first two is not done — the owner sees the composer, tests mostly see the readline path.
5. **Tests describe the shape.** Assert on `stripAnsi(out.text)` (drop `\r` and `\x1b[2K` for
   redrawn activity lines). Composer frame tests pin row numbers: adding a frame row shifts
   `\x1b[1;Nr`, the print row and the cursor row by one — update them deliberately, never loosen them.
6. **Networking changes get a live check:** `hcode --print "reply OK"` twice against the
   remembered Hoop (first run may learn, second must be faster), then `pgrep -fl "ssh.*<host>"`
   must be empty. An unfamiliar address in an ssh error is often a VPN or proxy's fake IP, not the Hoop.
7. **No version bump mid-stream.** Append bullets under the unreleased CHANGELOG version;
   bump when the owner releases.
8. **State lives in three places only:** the code + CHANGELOG (facts), the agent's own task /
   handoff file (updated every commit; hand off and clear context at milestones), and this
   section (the method). Nothing private belongs in any of them: no hostnames, addresses,
   usernames or paths of real machines — the code is meant to be public.

Traps found the hard way: a lone Esc is the prefix of every escape sequence (flush it after
~40 ms); the composer never echoes the owner's line — commit it to the transcript yourself
(`ui.ownerLine`); after `\x1b[2J` the transcript row is 1; resize must clear from the old
frame's top before redrawing; `doctor` must probe the URL a real run would use, not `cfg.baseUrl`.

## Agent memory: `memory/`

Durable lessons about working on hcode live in `memory/` next to this file — not in any one
agent's private memory. `memory/MEMORY.md` is the index (one line per memory); each memory is
one file holding one fact with a short frontmatter (`name`, `description`, `type`), followed by
**Why** and **How to apply**. Read the index at the start of a task; add a file when you learn
something the code, CHANGELOG or git history does not already record; update or delete a wrong
one rather than adding a duplicate. Everything in it is public-safe: no hostnames, addresses,
usernames, private paths or secrets, and "the owner" instead of names.
