# Benchmark yardstick: the polyglot lane, and where hcode stands

`hcode benchmark --polyglot` is the parity measure against Codex and Claude Code (Aider's
public polyglot benchmark, pass@2). First pilot, 2026-08-30, 6 exercises, one machine:

| runner | pass@1 | pass@2 | mean s | output tokens |
|---|---|---|---|---|
| hcode (reasoning brain on the owner's Hoop) | 5/6 | 6/6 | 117 | 40k |
| Claude Code (default model) | 6/6 | 6/6 | 28 | 8k |
| Codex (default model) | 6/6 | 6/6 | 104 | 25k |

What it means: quality is level on this sample; the gap is wall time, and the time is the brain's
reasoning output (5× Claude's tokens), not hcode's tool loop — effort is not forwarded to
non-Claude brains (`nativeEffortConfig`), so the brain reasons at its own default. The one
hcode pass@1 miss was a reply cut at the output cap, fixed in 0.5.0 by continuation.

How to apply: before claiming a speed gain, rerun the same `--n` subset (it is deterministic) and
compare rows, not anecdotes; a full 83-exercise run costs real money and time, so the owner
decides when. The levers for the next versions are on the brain side (model tier / thinking
budget for coding tasks) and on the loop side (parallel read-only tool calls, which the ledger
and approval flow make a real refactor, not a one-liner).

## Second pilot, 2026-08-31: the speed levers measured (same 6 exercises)

| run | pass@1 | pass@2 | mean s | tokens in/out |
|---|---|---|---|---|
| hcode deepseek-v4-pro, thinking OFF (`--effort low`) | 5/6 | 6/6 | **42.8** | 27k/6k |
| hcode deepseek-v4-flash, thinking on | 6/6 | 6/6 | 113.5 | 55k/48k |
| glm (Claude Code against z.ai, glm-5.3) | 6/6 | 6/6 | 72.4 | 1.32M/15k |

What it means: **turning thinking off is the speed lever** — 117s → 42.8s (2.7×) at unchanged
pass@2; dropping to flash changes almost nothing (the thinking volume stays). The wire control
is `thinking: {type:"disabled"}`; the gateway ignores budget_tokens and reasoning_effort
(probed live, see CHANGELOG Unreleased). glm's $1.63 in the report is Claude Code's nominal
Anthropic-price calc, not z.ai's real (far cheaper) billing. Pilot-review fixes now in the lane:
claude model always pinned (default opus), cash cap default $2 (was $0.5 and truncated 3 of 6
pilot rows), `--effort` passed down to the hcode child, `--models k=v` pins any runner.
Reports: `~/.hcode/benchmarks/2026-08-30T23-{37-32,48-58,53-20}-*.json`.

## n=20 review, 2026-08-31: four runners, shared `--effort low`

| runner | pass@1 | pass@2 | mean s | tokens in/out | cost |
|---|---|---|---|---|---|
| claude (opus) | 100% | 100% | 44.6 | 2.96M/59k | $5.99 |
| glm (glm-5.3) | 100% | 100% | 97.7 | 4.31M/88k | $5.84 nominal |
| hcode (deepseek-v4-pro, thinking off) | 80% | 100% | 90 | 138k/58k | n/a |
| codex (default) | 100% | 100% | 114.4 | 3.58M/94k | n/a |

What it means: quality parity **holds** at n=20 — every runner 100% pass@2 — and thinking-off
hcode is now faster than codex and glm, ~2× opus wall time. hcode is the only runner needing
second attempts (4/20: js/book-store, js/grade-school, js/palindrome-products, py/forth) —
first-attempt reliability, not speed, is now hcode's gap. The n=6 mean (42.8s) did not transfer
to the harder 20-spread (90s): speed claims are subset-dependent, always name the `--n`.
**Cost lesson**: claude's real cash was $5.99, not the <$1 extrapolated from the pilot — estimate
from per-exercise token draw on the target subset, not by scaling row counts; a full 83-run at
this rate is ~$25 claude cash. glm's $5.84 stays nominal (z.ai bills far less).
Report: `~/.hcode/benchmarks/2026-08-31T00-24-41-314Z-hcode-polyglot-v1.json`.
