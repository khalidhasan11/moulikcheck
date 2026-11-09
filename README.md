# MoulikCheck V2

Free plagiarism **risk** checker with automatic internet sources and a Turnitin-style similarity report. NOT 100% accurate, NOT a Turnitin prediction — see the About/Limits section in the app.

**Live:** https://khalidhasan11.github.io/moulikcheck/

## How to open locally
Serve this folder over http (file:// can block some browser storage/CDN behaviour):

```
cd ~/workspace/moulikcheck
python3 -m http.server 8000
```
Then open http://localhost:8000/ — it also works under a subpath (all asset paths are relative `./`), e.g. serving `~/workspace` and opening `/moulikcheck/`.

## Files
- `index.html` / `style.css` / `app.js` — UI (staged pipeline, settings, breakdown, detail, export)
- `engine.js` — pure matching engine (8-word shingles + TF-IDF, exclude-small-matches, source breakdown), shared by browser and Node tests
- `sources.js` — internet sources + stage runners, shared by browser and Node tests
- `tests/` — real test harness (`node tests/run-tests-v2.js`), fixtures, full results

## Sources (in checking order)
1. **Library / slides** (offline, your files in localStorage; V1 Library on the same origin is migrated automatically)
2. **Wikipedia** — MediaWiki API, no key, automatic
3. **Academic** — Crossref + Semantic Scholar, no key, automatic (Semantic Scholar's shared pool can rate-limit; the report shows it if so)
4. **Whole web** — optional: your own free Serper (Google results) or Tavily key, entered in Settings, stored only in this browser. Covers websites, forums and public social posts that search engines have indexed. Without a key this stage shows "not enabled" — it is never silently skipped.

PDF/DOCX reading uses PDF.js / Mammoth from CDN; if the CDN is unreachable, .txt upload and paste still work and the app says so clearly.
