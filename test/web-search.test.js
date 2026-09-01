import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResults, searchWeb } from "../src/web-search.js";

const PAGE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc&amp;x=1">Anope — official audio</a>
  <a class="result__snippet">Listen to the official song on YouTube &amp; learn more.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://example.com/anope">Anope background</a>
  <div class="result__snippet">Artist and release notes.</div>
</div>`;

test("public web search accepts a query, not a URL target, and preserves source links", async () => {
  const seen = [];
  const output = await searchWeb("site:youtube.com anope song", { maxResults: 2, request: async target => { seen.push(target); return PAGE; } });
  assert.equal(seen.length, 1); assert.equal(seen[0].origin, "https://html.duckduckgo.com");
  assert.equal(seen[0].searchParams.get("q"), "site:youtube.com anope song");
  assert.match(output, /Anope — official audio/); assert.match(output, /https:\/\/www\.youtube\.com\/watch\?v=abc/);
  assert.match(output, /official song on YouTube & learn more/); assert.match(output, /source pages were not opened/);
});

test("search result parsing unwraps provider redirects and drops unsafe links", () => {
  const rows = parseSearchResults(PAGE + '<a class="result__a" href="javascript:alert(1)">bad</a>', 8);
  assert.equal(rows.length, 2); assert.equal(rows[0].url, "https://www.youtube.com/watch?v=abc");
  assert.equal(rows[1].snippet, "Artist and release notes.");
});

test("web search validates query and result bounds before any network call", async () => {
  await assert.rejects(searchWeb("", { request: async () => PAGE }), /query required/);
  await assert.rejects(searchWeb("x".repeat(301), { request: async () => PAGE }), /300 characters/);
});
