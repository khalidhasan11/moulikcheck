/* MoulikCheck app.js — UI layer. All checking logic lives in engine.js.
 * File reading: .txt natively; .docx via Mammoth (CDN); .pdf via PDF.js (CDN).
 * If a CDN failed to load, DOCX/PDF show a clear fallback message and
 * .txt / paste keep working — nothing is faked.
 */
(function () {
  'use strict';
  var E = window.MoulikEngine;
  var LS_KEY = 'moulikcheck_library_v1';
  var LS_LIMIT = 4500000; // ~4.5 MB guard for localStorage
  var library = [];
  var lastResult = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
        $('lib-storage-warning').textContent = '⚠ Library is too large for browser storage (' + Math.round(json.length / 1024) + ' KB) — it will work for this session but may NOT be saved. Remove large files, or keep them under a few MB of text in total.';
        try { localStorage.setItem(LS_KEY, json); } catch (e) { /* session-only */ }
        return;
      }
      $('lib-storage-warning').textContent = '';
      localStorage.setItem(LS_KEY, json);
    } catch (e) {
      $('lib-storage-warning').textContent = '⚠ Could not save Library in this browser (storage full/blocked). It will work for this session only.';
    }
  }
  function loadLibrary() {
    try {
      var raw = localStorage.getItem(LS_KEY);
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

  // ---------- Checking ----------
  $('check-btn').addEventListener('click', function () {
    var text = $('main-text').value;
    if (E.tokenize(text).length < 20) { $('check-warning').textContent = '⚠ Please add at least ~20 words of text to check.'; return; }
    $('check-warning').textContent = library.length ? '' :
      'Note: your Library is empty, so only self-duplication inside this document can be flagged automatically. Every sentence still gets a one-click web-search link in its detail view.';
    lastResult = E.analyzeDocument(text, library.map(function (d) { return { name: d.name, text: d.text }; }), {
      stripReferences: $('opt-strip-refs').checked,
      excludeQuoted: $('opt-exclude-quoted').checked
    });
    renderResult();
  });

  function renderResult() {
    var r = lastResult, s = r.summary;
    $('result-card').classList.remove('hidden');
    $('detail-card').classList.remove('hidden');
    $('risk-pct').textContent = s.totalRisk + '%';
    $('exact-pct').textContent = s.exactPct + '%';
    $('similar-pct').textContent = s.similarPct + '%';
    $('original-pct').textContent = s.originalPct + '%';
    $('band').textContent = s.band;
    $('disclaimer').textContent = '⚠ ' + s.disclaimer +
      (s.referencesStripped ? ' A References/Bibliography section was detected and removed before scoring.' : '') +
      ' Checked against ' + s.libraryDocCount + ' Library document(s) (' + s.librarySentenceCount + ' sentences).';
    var rep = $('report');
    rep.innerHTML = '';
    rep.classList.remove('dim-nonmatch');
    r.sentences.forEach(function (sent) {
      var span = document.createElement('span');
      span.className = 's ' + sent.status;
      span.dataset.status = sent.status;
      span.textContent = sent.text + ' ';
      span.title = sent.status.toUpperCase() + (sent.bestMatch && sent.status !== 'original' ? ' — ' + sent.bestMatch.sourceName : '');
      span.addEventListener('click', function () { showDetail(sent); });
      rep.appendChild(span);
    });
    $('result-card').scrollIntoView({ behavior: 'smooth' });
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
      html += '<div class="box"><h4>Matched: ' + esc(m.sourceName) + ' (' + esc(m.method) + ', similarity ' + Math.round((m.similarity || 0) * 100) + '%' +
        (m.shingleOverlap ? ', ' + m.shingleOverlap + ' exact 8-word match(es)' : '') + ')</h4><p>' + esc(m.sourceSentence) + '</p></div>';
    } else if (m) {
      html += '<div class="box"><h4>Closest Library sentence (below flag threshold)</h4><p>' + esc(m.sourceSentence) + '</p><p class="hint">Similarity ' + Math.round((m.similarity || 0) * 100) + '% — under the 50% flag line, so this sentence counts as original.</p></div>';
    } else {
      html += '<div class="box"><h4>No Library match</h4><p class="hint">Nothing in your Library matched this sentence. Use the web search below to check it online yourself.</p></div>';
    }
    html += '</div>';
    html += '<a class="search-btn" target="_blank" rel="noopener" href="' + esc(sent.googleSearchUrl) + '">🔍 Search this exact sentence on Google (Layer 3 web check)</a>';
    html += '<p class="hint">The Google search opens with the sentence in quotes — if the exact line exists on a website, it should appear there. That check is manual by design: it keeps MoulikCheck free and unlimited.</p>';
    b.innerHTML = html;
    $('detail-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- Export / print ----------
  function buildExportHtml() {
    var s = lastResult.summary;
    var rows = lastResult.sentences.map(function (sent) {
      var m = sent.bestMatch;
      return '<tr><td>' + esc(sent.status) + '</td><td>' + esc(sent.text) + '</td><td>' +
        (m && sent.status !== 'original' ? esc(m.sourceName) + ' (' + Math.round((m.similarity || 0) * 100) + '%): ' + esc(m.sourceSentence) : '—') +
        '</td><td><a href="' + esc(sent.googleSearchUrl) + '">Google search</a></td></tr>';
    }).join('');
    var highlighted = lastResult.sentences.map(function (sent) {
      var colors = { exact: '#f8d7da', similar: '#fff3cd', original: 'transparent', quoted: '#e8eaf6' };
      return '<span style="background:' + colors[sent.status] + '">' + esc(sent.text) + '</span> ';
    }).join('');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>MoulikCheck Report</title></head><body style="font-family:system-ui;max-width:800px;margin:20px auto;line-height:1.7">' +
      '<h1>MoulikCheck Report</h1><p>Generated ' + new Date().toLocaleString() + '</p>' +
      '<p><b>Total Risk: ' + s.totalRisk + '% (' + s.band + ')</b> · Exact ' + s.exactPct + '% · Similar ' + s.similarPct + '% · Original ' + s.originalPct + '% · ' + s.totalWords + ' words</p>' +
      '<p style="background:#fff8e1;padding:10px">' + esc(s.disclaimer) + '</p>' +
      '<h2>Highlighted text</h2><p>' + highlighted + '</p>' +
      '<h2>Sentence details</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>Status</th><th>Sentence</th><th>Match</th><th>Web check</th></tr>' + rows + '</table></body></html>';
  }
  $('export-btn').addEventListener('click', function () {
    if (!lastResult) return;
    var blob = new Blob([buildExportHtml()], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'moulikcheck-report.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('print-btn').addEventListener('click', function () { window.print(); });

  loadLibrary();
  renderLibrary();
  updateCounts();
})();
