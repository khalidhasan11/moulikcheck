# MoulikCheck V1

Free, unlimited, private plagiarism **risk** checker. NOT 100% accurate, NOT a Turnitin prediction — see the About/Limits section in the app.

**Live:** https://khalidhasan11.github.io/moulikcheck/

## How to open locally
Serve this folder over http (file:// can block some browser storage/CDN behaviour):

```
cd ~/workspace/moulikcheck
python3 -m http.server 8000
```
Then open http://localhost:8000/ — it also works under a subpath (all asset paths are relative `./`), e.g. serving `~/workspace` and opening `/moulikcheck/`.

- `index.html` / `style.css` / `app.js` — UI
- `engine.js` — pure checking engine (Layers 1 + 3), shared by browser and Node tests
- `tests/` — fixtures, test runner, full results (`node tests/run-tests.js`)

PDF/DOCX reading uses PDF.js / Mammoth from CDN; if the CDN is unreachable, .txt upload and paste still work and the app says so clearly.
