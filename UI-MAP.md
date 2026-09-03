# hcode UI pointer map

This is a generated pointer index, not a second architecture document. Stable symbols are authoritative;
`npm run local:ui` refreshes line numbers before proof and commit. System rules remain in `ARCHITECTURE.md`.

| Owner-visible surface | Implementation anchor | Nearest proof | Lane |
| --- | --- | --- | --- |
| Opening date | `src/ui.js:44` · `formatWelcomeDate` | `test/ui.test.js` | token |
| Welcome projection | `src/ui.js:402` · `banner(cfg, sessionId` | `test/ui.test.js` | semantic |
| Input theme tokens | `src/ui.js:78` · `INPUT_THEME_TOKENS` | `test/ui.test.js` | token |
| Input theme detection | `src/ui.js:60` · `inputTheme` | `test/ui.test.js` | semantic |
| Input frame geometry | `src/composer.js:53` · `INPUT_FRAME` | `test/composer.test.js` | geometry |
| Input row projection | `src/composer.js:444` · `fieldRow(content` | `test/composer.test.js` | geometry |
| Composer frame assembly | `src/composer.js:238` · `draw()` | `test/render-property.test.js` | geometry |
| Three render-path semantics | `src/ui.js:268` · `createUI({` | `test/ui.test.js` | semantic |
| Footer priority projection | `src/composer.js:417` · `statusRows(action)` | `test/composer.test.js` | geometry |
| Footer real PTY fixture | `test/render-property.test.js:24` · `real PTYs keep the idle and busy footer` | `test/render-property.test.js` | geometry |
| Working gold sweep | `src/composer.js:126` · `goldenSweep` | `test/composer.test.js` | token |
| Hoop robot and charge | `src/brand.js:17` · `robotHoopRows` | `test/brand.test.js` | geometry |
| Native build | `scripts/build-native.mjs:81` · `buildNative` | `test/native-build.test.js` | native |
| Atomic native install | `src/native-install.js:59` · `installNativeCandidate` | `test/native-install.test.js` | native |

## Fast lane

- token: copy, colour or semantic token; default targeted proof.
- semantic: all affected composer/readline/plain projections.
- geometry: add `--geometry` so the real tmux render-property gate runs.
- native: leave this UI fast lane and use the native/release contract.
