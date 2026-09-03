# Start here — Hoop Code development

This is the single entry for a human or coding agent changing hcode. Machine-specific agent files point here;
they do not repeat the rules below.

## 60-second orientation

1. Read the repository-root instructions and active task list. Create one task record, one branch and one worktree.
2. State the owner-visible problem, affected surface, invariants, nearest proof and stop condition before editing.
3. Use `UI-MAP.md` for a UI pointer, `ARCHITECTURE.md` for system boundaries and `DEVELOPING.md` for the test/release ladder.
4. Read the nearest test before its implementation. Keep CLI and HoopOS embedding impacts explicit.
5. Commit one bounded behavior. Push, main merge, public release, npm, signing and production remain separate owner gates.

## One source, several machines

Git commits are the source transport. Never copy a working tree between machines, and never install a binary built
for another OS or architecture. A remote builder produces a clean candidate commit; each target host fetches that
exact commit, runs its risk profile, builds its own native artifact, verifies the manifest/version/SHA and switches
atomically. Public GitHub is a release projection, not the scratch transport for private iteration.

A remote implementation becomes runnable as soon as its exact base is reachable through the internal Git remote.
Do not serialize it behind unrelated documentation, delivery-adapter or local integration work: launch the remote
dependency lane, then continue independent local lanes while its run emits heartbeat and completion evidence. In the
HoopGram monorepo, the repository-root `START.md` points to that private god adapter; standalone/public hcode does not
infer a host, remote, push or release authority from this rule.

For a simple UI change:

```sh
cd nixos/apps/hcode
npm run local:ui -- --note "Describe one visible change" --agent Codex
```

For a target host pulling an integrated internal candidate:

```sh
cd nixos/apps/hcode
npm run local:pull -- --remote <named-remote> --branch <candidate-branch> --profile balanced
```

`balanced` means syntax + the full hcode suite once + host-native build/install. `fast` keeps syntax and native
proof only; `full` adds a second full run and package dry-run. None of these profiles publishes or deploys HoopOS.

## Canonical map

- `DEVELOPING.md` — how to change, verify, integrate and stop.
- `ARCHITECTURE.md` — the only architecture map and event/render/runtime boundaries.
- `UI-MAP.md` — generated owner-visible UI pointers and nearest proofs.
- `CAPABILITY-BOUNDARY.md` — tools, network, permissions and subagent trust boundaries.
- `HCODE.md` — compact hard rules injected by hcode itself.

If these documents or runtime evidence disagree, stop and use current Git, the owner instruction and the project
constitution/operations sources as truth. Do not resolve disagreement by silently choosing the easiest copy.
