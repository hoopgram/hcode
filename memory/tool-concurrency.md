---
name: tool-concurrency
description: only undecided reads overlap, and only an async tool can prove it — the local read tools are synchronous
type: project
---

**The rule (code: `isConcurrentRead` / `runReadBatch` in `src/agent.js`):** a call joins a concurrent
batch only when it is idempotent, its whole risk is `read`, its input is valid, it is not a replay, and
the broker allows it without asking. Judging is always serial and always in the model's order, so an
owner is never asked two questions at once; a batch is a contiguous slice of the model's own list, so a
write can never be overtaken by a read proposed after it.

**Why the order still holds:** `decide()` is pure and a read-only allow writes no approval event, which
is the only reason the verdict may be computed ahead of execution without reordering a single event.
If a future change makes the read path emit anything during judging, that early call has to move back
into `executeCall` or the ledger will reorder.

**Testing trap:** `read_file`, `list_dir`, `grep` and `glob` are implemented with synchronous `fs`
calls. Three of them "in parallel" still execute one after another inside the event loop, so they can
neither demonstrate concurrency nor benefit from it today — the win is structural (and real for any
tool that actually awaits I/O). `test/parallel-tools.test.js` therefore drives a fake Hoop over HTTP
with `hoop_memory` and asserts on the server's own in-flight counter, not on a wall clock.

**How to apply:** measure concurrency with an awaiting tool and an in-flight counter; keep new tools
honest about `idempotent` and `risk` in `src/tools.js`, because those two fields are what decide
whether hcode may run a call beside another one.
