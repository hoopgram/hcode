# hcode agent memory — index

One line per memory; the fact itself lives in the linked file. Any agent working on hcode
(Claude, Codex, hcode) reads this index at the start of a task and adds a file when it learns
something durable that the code, CHANGELOG or git history does not already record.
Rules: one fact per file · public-safe (no hostnames, addresses, usernames, private paths,
secrets) · write "the owner", never a name · update or delete a wrong memory, never duplicate.

- [Iteration loop](iteration-loop.md) — the method is HCODE.md → "Iteration loop"; this is the pointer and why it exists
- [How the owner gives feedback](owner-feedback.md) — screenshot + one sentence; never show intermediates or ask style questions
- [Three render paths](render-paths.md) — composer, readline, plain sink; a UI change is done only when all three are handled
- [Release contract](release-state.md) — Git, GitHub, npm, local symlink and Hoop/Nix are separate evidence layers; query each live and bind them to one verified tree
- [Tool concurrency](tool-concurrency.md) — only undecided reads overlap; the local read tools are synchronous, so only an awaiting tool can prove it
- [Benchmark yardstick](benchmark-yardstick.md) — polyglot lane numbers; quality level with Codex/Claude, gap is brain reasoning time
