---
name: render-paths
description: hcode has three render paths, one semantic UI table, and automatic gates against path drift
type: project
---

- **Composer** (`src/composer.js`) owns terminal geometry and the bottom-pinned live frame.
- **Readline** (`ui.prompt()` in `src/ui.js`) is the interactive fallback.
- **Plain** (`--print`, pipes, `NO_COLOR`, `TERM=dumb`) is control-free and copyable.

**Why:** on 2026-08-30 the first "input box" fix landed only in the readline path and the owner's
screenshot still showed one rule. The paths should not look identical, but they must express the
same semantic action and only composer may own full-screen geometry.

**Single source:** `createUI()`'s `toolAction()` produces active/done/kind once. Readline paints it,
composer receives active/kind through `setActivity()`, and plain keeps the same completed words
without ANSI or carriage returns. Do not copy those labels into `composer.js` or a second strings file.

**Automatic gates:**

- `test/ui.test.js` table-drives tool actions through composer, readline and plain.
- `test/render-property.test.js` runs seeded real-tmux composer sequences and forbids a fourth
  cursor/scroll painter. Widen with `HCODE_RENDER_SEEDS=n`; never weaken the invariant to pass.
- `test/frame.test.js` and `test/composer.test.js` are the fast geometry/input layer.

For a UI change, run the nearest gate; run seeded PTY only when geometry changes. The public system
shape lives in `ARCHITECTURE.md`, not in this memory.
