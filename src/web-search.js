// A deliberately narrow public-web capability. The model supplies a query, never a URL; hcode
// contacts one fixed search endpoint and returns source links without fetching any result page.
// This keeps "search the web" useful without turning the tool belt into an arbitrary network client.
import https from "node:https";
import { VERSION } from "./config.js";

const SEARCH_ORIGIN = "https://html.duckduckgo.com";
const MAX_BODY = 1_000_000;

const codePoint = raw => { const value = Number(raw); return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "�"; };
const decode = value => String(value || "")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, n) => codePoint(n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)));

const text = html => decode(String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

function sourceUrl(href) {
  try {
    const decoded = decode(href);
    const target = new URL(decoded, SEARCH_ORIGIN);
    const unwrapped = target.searchParams.get("uddg");
    const source = unwrapped ? new URL(unwrapped) : target;
    if (!/^https?:$/.test(source.protocol) || source.username || source.password) return null;
    return source.href;
  } catch { return null; }
}

export function parseSearchResults(html, maxResults = 5) {
  const source = String(html || ""); const rows = [];
  const anchor = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(source)) && rows.length < maxResults) {
    const url = sourceUrl(match[1]); const title = text(match[2]);
    if (!url || !title) continue;
    const tail = source.slice(anchor.lastIndex, anchor.lastIndex + 5000);
    const snippetMatch = tail.match(/<(?:a|div)\b(?=[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    rows.push({ title: title.slice(0, 300), url, snippet: text(snippetMatch?.[1] || "").slice(0, 600) });
  }
  return rows;
}

export function requestSearchPage(target, { timeoutMs = 10000, signal = null, redirects = 0 } = {}) {
  const url = target instanceof URL ? target : new URL(target);
  if (url.origin !== SEARCH_ORIGIN) return Promise.reject(new Error("search redirect left the fixed provider"));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { accept: "text/html", "user-agent": `hcode/${VERSION}` }, signal }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
        res.resume();
        if (redirects >= 2) { reject(new Error("search provider redirected too many times")); return; }
        try { resolve(requestSearchPage(new URL(String(res.headers.location || ""), url), { timeoutMs, signal, redirects: redirects + 1 })); }
        catch { reject(new Error("search provider returned a bad redirect")); }
        return;
      }
      const chunks = []; let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_BODY) req.destroy(new Error("search response exceeded 1 MB"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`search provider answered HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("web search timed out")));
    req.on("error", reject);
  });
}

export async function searchWeb(query, { maxResults = 5, signal = null, request = requestSearchPage } = {}) {
  const clean = String(query || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("search query required");
  if (clean.length > 300) throw new Error("search query is longer than 300 characters");
  const limit = Math.max(1, Math.min(8, Number(maxResults) || 5));
  const target = new URL("/html/", SEARCH_ORIGIN); target.searchParams.set("q", clean);
  const rows = parseSearchResults(await request(target, { signal }), limit);
  if (!rows.length) return `No public web results found for "${clean}".`;
  return [`Public web results for "${clean}" (source pages were not opened):`, ...rows.flatMap((row, index) => [
    `${index + 1}. ${row.title}`, `   ${row.url}`, ...(row.snippet ? [`   ${row.snippet}`] : []),
  ])].join("\n");
}
