---
name: render-paths
description: hcode has three render paths — composer, readline, plain sink — and a terminal-UI change counts as done only when each is handled
type: project
---

- **Composer** (`src/composer.js`): the bottom-pinned input box the owner actually sees in an
  interactive session. Draws its own frame (`draw()`), never echoes the sent line (use
  `ui.ownerLine`), tracks `transcriptRow` so output fills from the top, and keeps a bounded
  **transcript ring** of every line it has printed (`remember` / `transcriptTail` /
  `replayTranscript`, 0.7.0) so a reflow or a frame that gives rows back repaints the page
  instead of losing it. The page is a function of (ring, frame): anything that puts a line on
  the page has to go through `print()`, or the ring — and every repaint after it — is wrong.
- **Readline** (`ui.prompt()` in `src/ui.js`): used when the composer is unavailable and by
  most tests.
- **Plain sink** (`--print`, pipes, `NO_COLOR`, `TERM=dumb`): byte-for-byte verbatim; no
  speaker line, no indent, no control sequences.

**Why:** on 2026-08-30 the first "input box" fix landed only in the readline path and the owner's
screenshot still showed one rule — the composer is what they look at.

**How to apply:** for any UI change, touch composer + readline, prove the plain sink is unchanged
in a test, and check the result with `hcode demo` (readline shape) and `hcode` (composer).

**The rule is a test now, not a memo** (2026-08-31). Each path has a gate that fails if it is
skipped, so "I only changed one path" stops being possible:

- **Composer** — `test/render-property.test.js`, "random PTY sequences…": the real composer in a
  real tmux PTY, seeded random event sequences (resize 40–160, CJK/emoji paste, streamed output,
  menus, approvals, ticks), asserting the *whole screen* equals a fresh `draw()` of the same
  state and that what is above the scroll region is the newest unbroken run of what was printed,
  with no frame furniture. `HCODE_RENDER_SEEDS=n` widens the sweep. Both invariants were weaker
  in 0.6.0 (they gave up once anything had scrolled away); do not weaken them again to make a
  change pass — the ring exists so they can stay whole.
- **Readline + plain sink** — `test/render-property.test.js`, "no fourth render path": static, and
  the only place `src/ui.js` is allowed to write terminal geometry. Anything new that wants to
  paint the terminal has to go through `composer.paint()`/`erase()` or add itself to that
  whitelist in the open.
- **Frame model** — `test/frame.test.js` (golden 40/60/80/120 columns, 100 random resizes) and
  `test/composer.test.js` (CJK, paste, pinned scroll region) stay the fast unit layer under both.
