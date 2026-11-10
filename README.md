# MoulikCheck V3

Free plagiarism **risk** checker with automatic internet sources and a Turnitin-style similarity report. NOT 100% accurate, NOT a Turnitin prediction — see the About/Limits section in the app.

**Live:** https://khalidhasan11.github.io/moulikcheck/
**Status:** V3 deployed Nov 10, 2026 (replaced V2 at the same URL, on Khalid's approval).

## What changed in V3 (Khalid's rule)
- **No API key anywhere on this site.** The V2 Settings key-entry fields are gone. Nobody using this page is ever asked for a key.
- Whole-web checking goes through the project's own **secure proxy** (a Cloudflare Worker): the Serper/Tavily keys live there as encrypted Cloudflare secrets — never in this site's code, never in this repo, never visible on the page.
- `sources.js` has a single `WORKER_URL` constant, currently the placeholder `https://moulikcheck-search.YOUR-SUBDOMAIN.workers.dev`. It will be replaced with the real Worker URL once, after the Worker is deployed and its secret is set. Until then the whole-web stage honestly reports **"not enabled (secure proxy not configured yet)"** — it is never silently skipped.
- Everything else is V2: dashboard, Library (your own sources), Wikipedia / Crossref / Semantic Scholar stages, Turnitin-style per-source breakdown, exports.

## How to open locally
Serve this folder over http (file:// can block some browser storage/CDN behaviour):

```
cd ~/workspace/moulikcheck
python3 -m http.server 8000
```
Then open http://localhost:8000/ — it also works under a subpath (all asset paths are relative `./`).

## Files
- `index.html` / `style.css` / `app.js` — UI (staged pipeline, breakdown, detail, export; NO settings/key UI)
- `engine.js` — pure matching engine (unchanged from V2), shared by browser and Node tests
- `sources.js` — internet sources + stage runners; Source D = Worker proxy client

## Sources (in checking order)
1. **Library / slides** (offline, your files in this browser's localStorage; V1/V2 Libraries on the same origin are migrated automatically)
2. **Wikipedia** — MediaWiki API, no key, automatic
3. **Academic** — Crossref + Semantic Scholar, no key, automatic (Semantic Scholar's shared pool can rate-limit; the report shows it if so)
4. **Whole web** — through the secure proxy Worker (Serper primary, Tavily fallback, keys encrypted in the Worker). Covers websites, forums and public social posts that search engines have indexed. Activates once the proxy is configured (see above).

PDF/DOCX reading uses PDF.js / Mammoth from CDN; if the CDN is unreachable, .txt upload and paste still work and the app says so clearly.
