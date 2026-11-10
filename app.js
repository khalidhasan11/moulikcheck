/* MoulikCheck app.js — V3 UI layer.
 * Checking logic: engine.js (matching) + sources.js (internet stages).
 * File reading: .txt natively; .docx via Mammoth (CDN); .pdf via PDF.js (CDN).
 * If a CDN failed to load, DOCX/PDF show a clear fallback message and
 * .txt / paste keep working — nothing is faked.
 * V3: there are NO API keys anywhere in this app and no key is ever asked
 * from the user. Whole-web checking goes through the project's own secure
 * proxy (Cloudflare Worker), which holds the keys as encrypted secrets.
 */
(function () {
  'use strict';
  var E = window.MoulikEngine;
  var S = window.MoulikSources;
  var LS_LIB_V3 = 'moulikcheck_library_v3';
  var LS_LIB_V2 = 'moulikcheck_library_v2'; // migrated read-only if V3 empty
  var LS_LIB_V1 = 'moulikcheck_library_v1'; // migrated read-only if V3/V2 empty
  var LS_PRIVACY = 'moulikcheck_v3_privacy_ack';
  var LS_LIMIT = 4500000;
  var library = [];
  var lastResult = null;
  var lastSourceStatus = [];
  var lastWebQueries = 0;
  var cancelFlag = { cancelled: false };
  var PALETTE = ['#f5b7b1', '#f9e79f', '#aed6f1', '#a9dfbf', '#d2b4de', '#f5cba7', '#a3e4db', '#f1948a', '#85c1e9', '#f8c471', '#82e0aa', '#bb8fce', '#f0b27a', '#7fb3d5'];
  var sourceColors = {}; // source key -> colour

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sourceKeyOf(m) { return (m.sourceName || 'Source') + '|' + (m.sourceUrl || ''); }

  // ---------- Options (V3: no API keys exist on this site — nothing to set) ----------
  function currentSettings() {
    return {
      webCap: Math.max(1, parseInt($('opt-web-cap').value, 10) || 30)
    };
  }

  // ---------- File extraction ----------
  function setStatus(id, msg) { $(id).textContent = msg || ''; }

  async function extractText(file) {
    var name = file.name || '';
    var ext = name.split('.').pop().toLowerCase();
    if (ext === 'txt') return await file.text();
    if (ext === 'docx') {
      if (!window.mammoth) throw new Error('DOCX reader (Mammoth CDN) failed to load — check your internet connection, or copy-paste the text instead. .txt and paste still work.');
      var buf = await file.arrayBuffer();
      var res = await window.mammoth.extractRawText({ arrayBuffer: buf });
      return res.value || '';
    }
    if (ext === 'pdf') {
      if (!window.pdfjsLib) throw new Error('PDF reader (PDF.js CDN) failed to load — check your internet connection, or copy-paste the text instead. .txt and paste still work.');
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        var data = await file.arrayBuffer();
        var pdf = await window.pdfjsLib.getDocument({ data: data }).promise;
        var out = [];
        for (var p = 1; p <= pdf.numPages; p++) {
          var page = await pdf.getPage(p);
          var tc = await page.getTextContent();
          out.push(tc.items.map(function (it) { return it.str; }).join(' '));
        }
        return out.join('\n');
      } catch (e) {
        throw new Error('Could not read that PDF in the browser (' + e.message + '). If it is a scanned/image PDF it has no text layer — paste the text instead.');
      }
    }
    throw new Error('Unsupported file type ".' + ext + '". Use .txt, .docx or .pdf, or paste the text.');
  }

  // ---------- Main document input ----------
  function updateCounts() {
    var t = $('main-text').value;
    $('word-count').textContent = E.tokenize(t).length + ' words';
    $('sentence-count').textContent = E.splitSentences(t).length + ' sentences';
  }
  $('main-text').addEventListener('input', updateCounts);

  async function handleMainFile(file) {
    try {
      setStatus('main-file-status', 'Reading ' + file.name + ' …');
      var text = await extractText(file);
      $('main-text').value = text;
      updateCounts();
      setStatus('main-file-status', 'Loaded "' + file.name + '" (' + E.tokenize(text).length + ' words). Review the text below, then press Check.');
    } catch (e) { setStatus('main-file-status', '⚠ ' + e.message); }
  }
  $('main-file').addEventListener('change', function () { if (this.files[0]) handleMainFile(this.files[0]); });

  function wireDrop(zoneId, onFile) {
    var z = $(zoneId);
    ['dragover', 'dragenter'].forEach(function (ev) { z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.remove('over'); }); });
    z.addEventListener('drop', function (e) { var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onFile(f); });
  }
  wireDrop('drop-zone', handleMainFile);

  // ---------- Library ----------
  function saveLibrary() {
    try {
      var json = JSON.stringify(library);
      if (json.length > LS_LIMIT) {
        $('lib-storage-warning').textContent = '⚠ Library is too large for browser storage (' + Math.round(json.length / 1024) + ' KB) — it will work for this session but may NOT be saved. Remove large files.';
        try { localStorage.setItem(LS_LIB_V3, json); } catch (e) { /* session-only */ }
        return;
      }
      $('lib-storage-warning').textContent = '';
      localStorage.setItem(LS_LIB_V3, json);
    } catch (e) {
      $('lib-storage-warning').textContent = '⚠ Could not save Library in this browser (storage full/blocked). It will work for this session only.';
    }
  }
  function loadLibrary() {
    try {
      var raw = localStorage.getItem(LS_LIB_V3);
      if (!raw) raw = localStorage.getItem(LS_LIB_V2); // V2 -> V3 migration on same origin
      if (!raw) raw = localStorage.getItem(LS_LIB_V1); // V1 -> V3 migration on same origin
      if (raw) library = JSON.parse(raw) || [];
    } catch (e) { library = []; }
  }
  function renderLibrary() {
    var ul = $('lib-list');
    ul.innerHTML = '';
    if (!library.length) {
      ul.innerHTML = '<li>No Library documents yet — add slides / chapters / past assignments above.</li>';
      return;
    }
    library.forEach(function (doc) {
      var li = document.createElement('li');
      var words = E.tokenize(doc.text).length;
      li.innerHTML = '<span><b>' + esc(doc.name) + '</b> · ' + words + ' words</span>';
      var btn = document.createElement('button');
      btn.textContent = 'Remove';
      btn.addEventListener('click', function () {
        library = library.filter(function (d) { return d.id !== doc.id; });
        saveLibrary(); renderLibrary();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }
  function addToLibrary(name, text) {
    if (!text || E.tokenize(text).length < 10) { setStatus('lib-file-status', '⚠ That source has too little readable text to be useful (under 10 words).'); return; }
    library.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: name, text: text });
    saveLibrary(); renderLibrary();
    setStatus('lib-file-status', 'Added "' + name + '" to Library. Total: ' + library.length + ' document(s).');
  }
  async function handleLibFiles(files) {
    for (var i = 0; i < files.length; i++) {
      try {
        setStatus('lib-file-status', 'Reading ' + files[i].name + ' …');
        var text = await extractText(files[i]);
        addToLibrary(files[i].name, text);
      } catch (e) { setStatus('lib-file-status', '⚠ ' + files[i].name + ': ' + e.message); }
    }
  }
  $('lib-file').addEventListener('change', function () { handleLibFiles(this.files); });
  wireDrop('lib-drop-zone', function (f) { handleLibFiles([f]); });
  $('lib-add-paste').addEventListener('click', function () {
    var name = $('lib-paste-name').value.trim() || 'Pasted source';
    addToLibrary(name, $('lib-paste-text').value);
    $('lib-paste-text').value = ''; $('lib-paste-name').value = '';
  });

  // ---------- Privacy notice ----------
  function privacyGate() {
    return new Promise(function (resolve) {
      var ack = false;
      try { ack = !!localStorage.getItem(LS_PRIVACY); } catch (e) { ack = false; }
      if (ack) { resolve(false); return; }
      $('privacy-notice').classList.remove('hidden');
      $('privacy-accept').onclick = function () {
        try { localStorage.setItem(LS_PRIVACY, '1'); } catch (e) {}
        $('privacy-notice').classList.add('hidden');
        resolve(false);
      };
      $('privacy-offline').onclick = function () {
        $('privacy-notice').classList.add('hidden');
        $('opt-offline').checked = true;
        resolve(true);
      };
    });
  }

  // ---------- Checking pipeline ----------
  function setProgress(stageIdx, totalStages, label, fracWithin) {
    $('progress-wrap').classList.remove('hidden');
    $('stage-label').textContent = label;
    var pct = Math.round(((stageIdx + (fracWithin || 0)) / totalStages) * 100);
    $('progress-bar').style.width = Math.min(100, pct) + '%';
    $('query-counter').textContent = 'Whole-web queries used in this check so far: ' + lastWebQueries;
  }

  $('cancel-btn').addEventListener('click', function () { cancelFlag.cancelled = true; });

  $('check-btn').addEventListener('click', async function () {
    var text = $('main-text').value;
    if (E.tokenize(text).length < 20) { $('check-warning').textContent = '⚠ Please add at least ~20 words of text to check.'; return; }
    $('check-warning').textContent = '';
    var offline = $('opt-offline').checked;
    if (!offline) offline = await privacyGate();
    var settings = currentSettings();
    var minMatch = Math.max(1, parseInt($('opt-min-match').value, 10) || 8);
    var engineOpts = { stripReferences: $('opt-strip-refs').checked, excludeQuoted: $('opt-exclude-quoted').checked, minMatchWords: minMatch };

    cancelFlag = { cancelled: false };
    $('check-btn').disabled = true;
    $('cancel-btn').classList.remove('hidden');
    lastSourceStatus = [];
    lastWebQueries = 0;
    var totalStages = offline ? 1 : 5;

    try {
      // Stage 1 — Library (offline)
      setProgress(0, totalStages, 'Stage 1/' + totalStages + ' — Library (slides) check…', 0.5);
      var base = E.analyzeDocument(text, library.map(function (d) { return { name: d.name, text: d.text }; }), engineOpts);
      lastResult = { sentences: base.sentences, summary: base.summary };
      lastSourceStatus.push({ source: 'Library (slides)', status: 'ok', detail: library.length ? 'Checked against ' + library.length + ' Library document(s), ' + base.summary.librarySentenceCount + ' sentences.' : 'Library is empty — only self-duplication could be checked in this stage.' });
      renderResult();

      if (!offline && !cancelFlag.cancelled) {
        // Stage 2 — Wikipedia
        var wiki = await S.runWikipediaStage(E, lastResult.sentences, {
          minMatchWords: minMatch, isCancelled: function () { return cancelFlag.cancelled; },
          onProgress: function (src, done, total) { setProgress(1, totalStages, 'Stage 2/' + totalStages + ' — Wikipedia check (' + done + '/' + total + ')…', total ? done / total : 0); }
        });
        lastSourceStatus.push(wiki);
        refreshSummary(base.summary); renderResult();
      }
      if (!offline && !cancelFlag.cancelled) {
        // Stage 3 — Academic (Crossref + Semantic Scholar)
        var acad = await S.runAcademicStage(E, lastResult.sentences, {
          minMatchWords: minMatch, isCancelled: function () { return cancelFlag.cancelled; },
          onProgress: function (src, done, total) { setProgress(2, totalStages, 'Stage 3/' + totalStages + ' — Academic check: ' + src + ' (' + done + '/' + total + ')…', total ? done / total : 0); }
        });
        acad.forEach(function (st) { lastSourceStatus.push(st); });
        refreshSummary(base.summary); renderResult();
      }
      if (!offline) {
        // Stage 4 — Whole web (only if not cancelled; if cancelled, mark partial)
        if (cancelFlag.cancelled) {
          lastSourceStatus.push({ source: 'Whole web (secure proxy)', status: 'partial', detail: 'Skipped — check was cancelled before this stage.' });
        } else {
          var web = await S.runWebStage(E, lastResult.sentences, {
            cap: settings.webCap,
            minMatchWords: minMatch, isCancelled: function () { return cancelFlag.cancelled; },
            onProgress: function (src, done, total) { lastWebQueries = done; setProgress(3, totalStages, 'Stage 4/' + totalStages + ' — ' + src + ' (' + done + '/' + total + ')…', total ? done / total : 0); }
          });
          lastWebQueries = web.queries;
          lastSourceStatus.push(web);
          refreshSummary(base.summary); renderResult();
        }
        // Stage 5 — Page verification: re-check web matches against the
        // real page text (search snippets alone are not proof).
        if (!cancelFlag.cancelled) {
          var verify = await S.runVerifyStage(E, lastResult.sentences, {
            minMatchWords: minMatch, isCancelled: function () { return cancelFlag.cancelled; },
            onProgress: function (src, done, total) { setProgress(4, totalStages, 'Stage 5/' + totalStages + ' — Verifying pages (' + done + '/' + total + ')…', total ? done / total : 0); }
          });
          lastSourceStatus.push(verify);
          refreshSummary(base.summary); renderResult();
        }
      } else {
        lastSourceStatus.push({ source: 'Wikipedia', status: 'skipped', detail: 'Skipped — Offline only mode.' });
        lastSourceStatus.push({ source: 'Crossref', status: 'skipped', detail: 'Skipped — Offline only mode.' });
        lastSourceStatus.push({ source: 'Semantic Scholar', status: 'skipped', detail: 'Skipped — Offline only mode.' });
        lastSourceStatus.push({ source: 'Whole web (secure proxy)', status: 'skipped', detail: 'Skipped — Offline only mode.' });
        lastSourceStatus.push({ source: 'Page verification', status: 'skipped', detail: 'Skipped — Offline only mode.' });
        renderResult();
      }
      setProgress(totalStages, totalStages, cancelFlag.cancelled ? 'Check cancelled — showing partial results.' : 'Check complete.', 0);
    } catch (e) {
      $('check-warning').textContent = '⚠ Check stopped: ' + e.message + ' (partial results, if any, are shown below)';
      if (lastResult) renderResult();
    } finally {
      $('check-btn').disabled = false;
      $('cancel-btn').classList.add('hidden');
    }
  });

  function refreshSummary(meta) {
    var keep = { referencesStripped: meta.referencesStripped, librarySentenceCount: meta.librarySentenceCount, libraryDocCount: meta.libraryDocCount };
    lastResult.summary = E.computeSummary(lastResult.sentences, keep);
  }

  // ---------- Rendering ----------
  function renderResult() {
    var r = lastResult, s = r.summary;
    $('result-card').classList.remove('hidden');
    $('detail-card').classList.remove('hidden');
    $('risk-pct').textContent = s.totalRisk + '%';
    $('exact-pct').textContent = s.exactPct + '%';
    $('similar-pct').textContent = s.similarPct + '%';
    $('original-pct').textContent = s.originalPct + '%';
    $('band').textContent = s.band;
    $('web-queries-line').textContent = 'Whole-web queries used in this check: ' + lastWebQueries;
    var tc = s.typeCounts || {};
    var nSources = E.sourceBreakdown(r.sentences).length;
    $('match-summary').textContent = 'Matched: ' + (s.matchedWords || 0) + ' of ' + s.scoredWords + ' words · ' + nSources + ' source(s)' +
      ' · Exact ' + (tc.exact || 0) + ' · Near-exact ' + (tc['near-exact'] || 0) + ' · Paraphrase ' + (tc.paraphrase || 0) +
      ' · Common phrase ' + (tc['common-phrase'] || 0) + ' · Cited ' + (tc.citation || 0) + ' · Quoted ' + (tc.quotation || 0) +
      ' · Bibliography ' + (tc.bibliography || 0) + ' · Page-verified sources: ' + (s.verifiedSourceCount || 0);
    $('disclaimer').textContent = '⚠ ' + s.disclaimer +
      (s.referencesStripped ? ' A References/Bibliography section was detected and removed before scoring.' : '');

    // Source status list — failures and not-enabled are always visible.
    var ul = $('source-status');
    ul.innerHTML = '';
    lastSourceStatus.forEach(function (st) {
      var li = document.createElement('li');
      var icon = { ok: '✅', partial: '⚠️', failed: '❌', 'not-enabled': '🔑', skipped: '⏭️' }[st.status] || '•';
      li.innerHTML = icon + ' <b>' + esc(st.source) + '</b> — ' + esc(st.status) + (st.detail ? ' · ' + esc(st.detail) : '');
      ul.appendChild(li);
    });

    // Breakdown with per-source colours
    var breakdown = E.sourceBreakdown(r.sentences);
    sourceColors = {};
    breakdown.forEach(function (src, i) { sourceColors[src.key] = PALETTE[i % PALETTE.length]; });
    var bd = $('breakdown');
    bd.innerHTML = breakdown.length ? '' : '<p class="hint">No matched sources — nothing was attributed to any source.</p>';
    breakdown.forEach(function (src) {
      var div = document.createElement('div');
      div.className = 'src-card';
      div.style.borderLeft = '8px solid ' + sourceColors[src.key];
      var label = S.typeLabel(src.type);
      div.innerHTML = '<b>' + esc(src.name) + '</b> <span class="tag">' + esc(label) + '</span>' +
        (src.verified ? ' <span class="tag">✓ Page-verified</span>' : ' <span class="tag">Search result</span>') + '<br>' +
        '<span class="src-pct">' + src.pct + '%</span> of document · ' + src.sentences + ' sentence(s)' +
        (src.url ? ' · <a href="' + esc(src.url) + '" target="_blank" rel="noopener">Open source</a>' : '');
      div.addEventListener('click', function () { filterBySource(src.key); });
      bd.appendChild(div);
    });

    var rep = $('report');
    rep.innerHTML = '';
    rep.classList.remove('dim-nonmatch');
    r.sentences.forEach(function (sent) {
      var span = document.createElement('span');
      span.className = 's ' + sent.status;
      span.dataset.status = sent.status;
      if (sent.bestMatch && (sent.status === 'exact' || sent.status === 'similar')) {
        span.dataset.sourceKey = sourceKeyOf(sent.bestMatch);
        var col = sourceColors[span.dataset.sourceKey];
        if (col) span.style.background = sent.status === 'exact' ? col : col + '99';
      }
      span.textContent = sent.text + ' ';
      span.title = sent.status.toUpperCase() + (sent.bestMatch && sent.status !== 'original' ? ' — ' + sent.bestMatch.sourceName : '');
      span.addEventListener('click', function () { showDetail(sent); });
      rep.appendChild(span);
    });
  }

  function filterBySource(key) {
    var rep = $('report');
    rep.classList.add('dim-nonmatch');
    rep.querySelectorAll('.s').forEach(function (sp) { sp.classList.toggle('f-match', sp.dataset.sourceKey === key); });
  }

  document.querySelectorAll('.filter').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.filter').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var f = btn.dataset.filter;
      var rep = $('report');
      if (f === 'all') { rep.classList.remove('dim-nonmatch'); rep.querySelectorAll('.s').forEach(function (sp) { sp.classList.remove('f-match'); }); return; }
      rep.classList.add('dim-nonmatch');
      rep.querySelectorAll('.s').forEach(function (sp) { sp.classList.toggle('f-match', sp.dataset.status === f); });
    });
  });

  function showDetail(sent) {
    var b = $('detail-body');
    var m = sent.bestMatch;
    var html = '<p><b>Status:</b> ' + esc(sent.status.toUpperCase()) + ' · ' + sent.wordCount + ' words</p>';
    html += '<div class="side"><div class="box"><h4>Your sentence</h4><p>' + esc(sent.text) + '</p></div>';
    if (m && sent.status !== 'original') {
      html += '<div class="box"><h4>Matched: ' + esc(m.sourceName) + '</h4>' +
        '<p><span class="tag">' + esc(S.typeLabel(m.sourceType)) + '</span>' +
        (m.matchType ? ' · <b>Type:</b> ' + esc(m.matchType) : '') +
        (m.confidence ? ' · <b>Confidence:</b> ' + esc(m.confidence) : '') +
        ' · ' + (m.verified ? '✓ Verified against the source text' : 'Found via search — not fully verified') +
        (m.cited ? ' · Citation detected (weight reduced)' : '') + '</p>' +
        (m.reason ? '<p><b>Why flagged:</b> ' + esc(m.reason) + '</p>' : '') +
        (m.verifyNote ? '<p class="hint">' + esc(m.verifyNote) + '</p>' : '') +
        '<p class="hint">Method ' + esc(m.method) +
        ', similarity ' + Math.round((m.similarity || 0) * 100) + '%' +
        (m.matchWords ? ', matched segment ~' + m.matchWords + ' words' : '') +
        (m.shingleOverlap ? ', ' + m.shingleOverlap + ' exact 8-word match(es)' : '') + '</p>' +
        '<p>' + esc(m.sourceSentence) + '</p>' +
        (m.sourceUrl ? '<p><a href="' + esc(m.sourceUrl) + '" target="_blank" rel="noopener">Open the source page</a></p>' : '') + '</div>';
    } else if (m) {
      html += '<div class="box"><h4>Closest source sentence (below flag threshold)</h4><p>' + esc(m.sourceSentence) + '</p><p class="hint">Similarity ' + Math.round((m.similarity || 0) * 100) + '% — under the flag line, or the matched segment was under the small-match limit, so this sentence counts as original.</p></div>';
    } else {
      html += '<div class="box"><h4>No match found</h4><p class="hint">No enabled source matched this sentence. That is not a guarantee — see About &amp; Limits.</p></div>';
    }
    html += '</div>';
    html += '<a class="search-btn" target="_blank" rel="noopener" href="' + esc(sent.googleSearchUrl) + '">🔍 Search this exact sentence on Google yourself</a>';
    b.innerHTML = html;
    $('detail-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- Export / print ----------
  function buildExportHtml() {
    var s = lastResult.summary;
    var breakdown = E.sourceBreakdown(lastResult.sentences);
    var statusRows = lastSourceStatus.map(function (st) {
      return '<tr><td>' + esc(st.source) + '</td><td>' + esc(st.status) + '</td><td>' + esc(st.detail || '') + '</td></tr>';
    }).join('');
    var bdRows = breakdown.map(function (src) {
      return '<tr><td>' + esc(src.name) + '</td><td>' + esc(S.typeLabel(src.type)) + '</td><td>' + src.pct + '%</td><td>' + src.sentences + '</td><td>' + (src.url ? '<a href="' + esc(src.url) + '">link</a>' : '—') + '</td></tr>';
    }).join('');
    var rows = lastResult.sentences.map(function (sent) {
      var m = sent.bestMatch;
      return '<tr><td>' + esc(sent.status) + '</td><td>' + esc(sent.text) + '</td><td>' +
        (m && sent.status !== 'original' ? esc(m.sourceName) + ' [' + esc(S.typeLabel(m.sourceType)) + '] (' + Math.round((m.similarity || 0) * 100) + '%): ' + esc(m.sourceSentence) + (m.sourceUrl ? ' — <a href="' + esc(m.sourceUrl) + '">source</a>' : '') : '—') +
        '</td><td>' + (m && sent.status !== 'original' ? esc(m.matchType || '') + ' / ' + esc(m.confidence || '') + (m.verified ? ' / verified' : ' / unverified') + (m.reason ? '<br>' + esc(m.reason) : '') : '—') +
        '</td><td><a href="' + esc(sent.googleSearchUrl) + '">Google search</a></td></tr>';
    }).join('');
    var highlighted = lastResult.sentences.map(function (sent) {
      var colors = { exact: '#f8d7da', similar: '#fff3cd', original: 'transparent', quoted: '#e8eaf6' };
      if ((sent.status === 'exact' || sent.status === 'similar') && sent.bestMatch) {
        var c = sourceColors[sourceKeyOf(sent.bestMatch)];
        if (c) colors[sent.status] = c;
      }
      return '<span style="background:' + colors[sent.status] + '">' + esc(sent.text) + '</span> ';
    }).join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>MoulikCheck V4 Report</title></head><body style="font-family:system-ui;max-width:800px;margin:20px auto;line-height:1.7">' +
      '<h1>MoulikCheck V4 Report</h1><p>Generated ' + new Date().toLocaleString() + '</p>' +
      '<p><b>Similarity / Total Risk: ' + s.totalRisk + '% (' + s.band + ')</b> · Exact ' + s.exactPct + '% · Similar ' + s.similarPct + '% · Original ' + s.originalPct + '% · ' + s.totalWords + ' words · Whole-web queries used: ' + lastWebQueries + '</p>' +
      '<p style="background:#fff8e1;padding:10px">' + esc(s.disclaimer) + '</p>' +
      '<h2>Source status</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>Source</th><th>Status</th><th>Detail</th></tr>' + statusRows + '</table>' +
      '<h2>Source breakdown</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>Source</th><th>Type</th><th>% of document</th><th>Sentences</th><th>Link</th></tr>' + bdRows + '</table>' +
      '<h2>Highlighted text</h2><p>' + highlighted + '</p>' +
      '<h2>Sentence details</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>Status</th><th>Sentence</th><th>Match</th><th>Type / Confidence</th><th>Web check</th></tr>' + rows + '</table></body></html>';
  }
  $('export-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var blob = new Blob([buildExportHtml()], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'moulikcheck-v4-report.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('print-btn').addEventListener('click', function () { window.print(); });

  loadLibrary();
  renderLibrary();
  updateCounts();
})();
