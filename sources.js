/*
 * MoulikCheck sources.js — V2 internet sources (shared browser + Node).
 * All fetching for Sources A (Wikipedia), B (Crossref + Semantic Scholar)
 * and D (Serper / Tavily whole-web). Source C (Library) is offline in
 * engine.js. No API keys are stored in this file — Source D keys are
 * passed in per call by the app (from localStorage) or by tests.
 *
 * Honesty rules baked in:
 *  - Every stage returns a status object: ok | partial | failed |
 *    not-enabled | skipped. Failures (HTTP errors, 429 rate limits,
 *    network errors) are reported with the reason, never swallowed.
 *  - Semantic Scholar's shared no-key pool is rate-limited
 *    (~100 req / 5 min, and 429s are common in practice — observed live
 *    on 10 Nov 2026). Calls are throttled to >=1.1s apart and a 429
 *    stops further S2 calls for that run, with the failure surfaced.
 */
(function (global) {
  'use strict';

  function fetchImpl() {
    if (typeof fetch !== 'undefined') return fetch;
    throw new Error('fetch is not available in this environment');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function classifyUrl(url) {
    var host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return 'website'; }
    if (host.indexOf('wikipedia.org') !== -1 || host.indexOf('wikimedia.org') !== -1) return 'wikipedia';
    if (/(^|\.)(reddit\.com|quora\.com|stackexchange\.com|stackoverflow\.com)/.test(host) ||
        host.indexOf('forum') !== -1 || host.indexOf('community.') === 0) return 'forum';
    if (/(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|threads\.net)/.test(host)) return 'social';
    if (/(doi\.org|semanticscholar\.org|crossref\.org|arxiv\.org|sciencedirect\.com|springer\.com|researchgate\.net|academia\.edu|jstor\.org|\.edu$|\.ac\.)/.test(host)) return 'academic';
    return 'website';
  }

  var TYPE_LABELS = {
    wikipedia: 'Wikipedia', academic: 'Academic', library: 'Slide-Library',
    self: 'Self-duplication', website: 'Website', forum: 'Forum', social: 'Social'
  };
  function typeLabel(t) { return TYPE_LABELS[t] || 'Website'; }

  function stripTags(s) { return String(s || '').replace(/<[^>]+>/g, ' '); }

  // ---------------- Source A: Wikipedia ----------------
  var WIKI_API = 'https://en.wikipedia.org/w/api.php';

  // Wikimedia rate-limits unauthenticated bursts (HTTP 429 observed live
  // on 10 Nov 2026 after several rapid calls). Retry a 429 once, after a
  // 3s backoff, before giving up — and surface it if it still fails.
  async function wikiFetchJson(url) {
    var f = fetchImpl();
    var res = await f(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 429) {
      await sleep(3000);
      res = await f(url, { headers: { 'Accept': 'application/json' } });
    }
    return res;
  }

  async function wikipediaCorpusForSentence(sentence, opts) {
    opts = opts || {};
    var searchUrl = WIKI_API + '?action=query&list=search&format=json&origin=*' +
      '&srlimit=3&srwhat=text&srsearch=' + encodeURIComponent('"' + sentence + '"');
    var sRes = await wikiFetchJson(searchUrl);
    if (!sRes.ok) throw new Error('Wikipedia search HTTP ' + sRes.status);
    var sJson = await sRes.json();
    var hits = (sJson.query && sJson.query.search) || [];
    if (!hits.length) {
      // Fallback: unquoted search on the sentence's words (phrase may be split in the article)
      var s2 = await wikiFetchJson(WIKI_API + '?action=query&list=search&format=json&origin=*&srlimit=3&srwhat=text&srsearch=' +
        encodeURIComponent(sentence));
      if (!s2.ok) throw new Error('Wikipedia search HTTP ' + s2.status);
      var j2 = await s2.json();
      hits = (j2.query && j2.query.search) || [];
    }
    if (!hits.length) return [];
    var title = hits[0].title;
    var eRes = await wikiFetchJson(WIKI_API + '?action=query&prop=extracts&explaintext=1&format=json&origin=*&titles=' +
      encodeURIComponent(title));
    if (!eRes.ok) throw new Error('Wikipedia extract HTTP ' + eRes.status);
    var eJson = await eRes.json();
    var pages = (eJson.query && eJson.query.pages) || {};
    var page = pages[Object.keys(pages)[0]] || {};
    if (!page.extract) return [];
    return [{
      name: 'Wikipedia \u2014 ' + title,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
      type: 'wikipedia',
      text: page.extract
    }];
  }

  async function fetchWikipediaArticle(title) {
    var eRes = await wikiFetchJson(WIKI_API + '?action=query&prop=extracts&explaintext=1&format=json&origin=*&titles=' +
      encodeURIComponent(title));
    if (!eRes.ok) throw new Error('Wikipedia extract HTTP ' + eRes.status);
    var eJson = await eRes.json();
    var pages = (eJson.query && eJson.query.pages) || {};
    var page = pages[Object.keys(pages)[0]] || {};
    return { title: page.title || title, extract: page.extract || '' };
  }

  // ---------------- Source B: Crossref ----------------
  async function crossrefCorpusForSentence(sentence) {
    var f = fetchImpl();
    var url = 'https://api.crossref.org/works?rows=5&select=title,abstract,URL,DOI&query.bibliographic=' +
      encodeURIComponent(sentence);
    var res = await f(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Crossref HTTP ' + res.status);
    var json = await res.json();
    var items = (json.message && json.message.items) || [];
    return items.map(function (it) {
      var title = (it.title && it.title[0]) || 'Untitled work';
      return {
        name: title, url: it.URL || (it.DOI ? 'https://doi.org/' + it.DOI : null),
        type: 'academic', text: title + '. ' + stripTags(it.abstract || '')
      };
    }).filter(function (d) { return d.text.trim().length > 10; });
  }

  // ---------------- Source B: Semantic Scholar (throttled) ----------------
  var s2LastCall = 0;
  async function semanticScholarCorpusForSentence(sentence) {
    var wait = 1100 - (Date.now() - s2LastCall);
    if (wait > 0) await sleep(wait);
    s2LastCall = Date.now();
    var f = fetchImpl();
    var url = 'https://api.semanticscholar.org/graph/v1/paper/search?limit=5&fields=title,abstract,tldr,url&query=' +
      encodeURIComponent(sentence);
    var res = await f(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 429) {
      var err = new Error('Semantic Scholar rate-limited (HTTP 429) \u2014 shared no-key pool exhausted; try again later');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!res.ok) throw new Error('Semantic Scholar HTTP ' + res.status);
    var json = await res.json();
    var data = json.data || [];
    return data.map(function (p) {
      var text = (p.title || '') + '. ' + (p.abstract || '') + ' ' + ((p.tldr && p.tldr.text) || '');
      return { name: p.title || 'Untitled paper', url: p.url || null, type: 'academic', text: text };
    }).filter(function (d) { return d.text.trim().length > 10; });
  }

  // ---------------- Source D: Serper / Tavily ----------------
  function buildSerperRequest(sentence, apiKey) {
    return {
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: '"' + sentence + '"', num: 5 })
    };
  }
  function buildTavilyRequest(sentence, apiKey) {
    return {
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sentence, max_results: 5, search_depth: 'basic' })
    };
  }

  async function serperCorpusForSentence(sentence, apiKey) {
    if (!apiKey) return { status: 'not-enabled', corpus: [] };
    var f = fetchImpl();
    var req = buildSerperRequest(sentence, apiKey);
    var res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) throw new Error('Serper HTTP ' + res.status);
    var json = await res.json();
    var organic = json.organic || [];
    return { status: 'ok', corpus: organic.map(function (r) {
      return { name: r.title || r.link, url: r.link, type: classifyUrl(r.link), text: (r.title || '') + '. ' + (r.snippet || '') };
    }).filter(function (d) { return d.url && d.text.trim().length > 10; }) };
  }

  async function tavilyCorpusForSentence(sentence, apiKey) {
    if (!apiKey) return { status: 'not-enabled', corpus: [] };
    var f = fetchImpl();
    var req = buildTavilyRequest(sentence, apiKey);
    var res = await f(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) throw new Error('Tavily HTTP ' + res.status);
    var json = await res.json();
    var results = json.results || [];
    return { status: 'ok', corpus: results.map(function (r) {
      return { name: r.title || r.url, url: r.url, type: classifyUrl(r.url), text: (r.title || '') + '. ' + (r.content || '') };
    }).filter(function (d) { return d.url && d.text.trim().length > 10; }) };
  }

  // ---------------- Stage runners (shared app + tests) ----------------
  // Each runner mutates sentence results via engine.pickBetter and returns
  // {source, status, queries, matched, detail}.

  function dedupeIndexes(engine, results, indexes) {
    var byNorm = {};
    indexes.forEach(function (i) {
      var norm = engine.normalizeText(results[i].text);
      (byNorm[norm] = byNorm[norm] || []).push(i);
    });
    return Object.keys(byNorm).map(function (k) { return byNorm[k]; }); // groups of indexes
  }

  async function runWikipediaStage(engine, results, opts) {
    opts = opts || {};
    var cap = typeof opts.cap === 'number' ? opts.cap : 40;
    var delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 350; // polite pacing vs Wikimedia 429s
    var stats = { source: 'Wikipedia', status: 'ok', queries: 0, matched: 0, detail: '' };
    var idxs = [];
    results.forEach(function (r, i) { if (r.status !== 'quoted' && r.wordCount >= 8) idxs.push(i); });
    var groups = dedupeIndexes(engine, results, idxs).slice(0, cap);
    var failures = 0;
    for (var g = 0; g < groups.length; g++) {
      if (opts.isCancelled && opts.isCancelled()) { stats.status = 'partial'; stats.detail = 'Cancelled by user after ' + stats.queries + ' queries.'; return stats; }
      var sentence = results[groups[g][0]].text;
      try {
        var corpus = await wikipediaCorpusForSentence(sentence);
        stats.queries++;
        if (corpus.length) {
          var m = engine.matchSentence(sentence, corpus, { minMatchWords: opts.minMatchWords });
          if (m.status !== 'original') {
            groups[g].forEach(function (i) {
              var before = results[i].status;
              engine.pickBetter(results[i], m);
              if (results[i].status !== before) stats.matched++;
            });
          }
        }
      } catch (e) { failures++; stats.detail = e.message; }
      if (opts.onProgress) opts.onProgress('Wikipedia', stats.queries, groups.length);
      if (delayMs) await sleep(delayMs);
    }
    if (failures && stats.queries === 0) stats.status = 'failed';
    else if (failures) { stats.status = 'partial'; stats.detail = failures + ' Wikipedia request(s) failed (last: ' + stats.detail + ')'; }
    else stats.detail = stats.queries + ' searches, ' + stats.matched + ' sentence(s) matched.';
    return stats;
  }

  async function runAcademicStage(engine, results, opts) {
    opts = opts || {};
    var delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 150;
    var crossrefCap = typeof opts.crossrefCap === 'number' ? opts.crossrefCap : 15;
    var s2Cap = typeof opts.s2Cap === 'number' ? opts.s2Cap : 10;
    var out = {
      crossref: { source: 'Crossref', status: 'ok', queries: 0, matched: 0, detail: '' },
      s2: { source: 'Semantic Scholar', status: 'ok', queries: 0, matched: 0, detail: '' }
    };
    var idxs = [];
    results.forEach(function (r, i) { if (r.status !== 'quoted' && r.wordCount >= 8) idxs.push(i); });
    var groups = dedupeIndexes(engine, results, idxs);

    async function applyFor(group, corpus, stats) {
      var sentence = results[group[0]].text;
      var m = engine.matchSentence(sentence, corpus, { minMatchWords: opts.minMatchWords });
      if (m.status !== 'original') {
        group.forEach(function (i) {
          var before = results[i].status;
          engine.pickBetter(results[i], m);
          if (results[i].status !== before) stats.matched++;
        });
      }
    }

    var crGroups = groups.slice(0, crossrefCap);
    for (var g = 0; g < crGroups.length; g++) {
      if (opts.isCancelled && opts.isCancelled()) { out.crossref.status = 'partial'; break; }
      try {
        var corpus = await crossrefCorpusForSentence(results[crGroups[g][0]].text);
        out.crossref.queries++;
        if (corpus.length) await applyFor(crGroups[g], corpus, out.crossref);
      } catch (e) { out.crossref.status = out.crossref.queries ? 'partial' : 'failed'; out.crossref.detail = e.message; }
      if (opts.onProgress) opts.onProgress('Crossref', out.crossref.queries, crGroups.length);
      if (delayMs) await sleep(delayMs);
    }
    if (!out.crossref.detail) out.crossref.detail = out.crossref.queries + ' searches, ' + out.crossref.matched + ' matched. (Crossref returns mostly titles/abstracts.)';

    var s2Groups = groups.slice(0, s2Cap);
    for (var h = 0; h < s2Groups.length; h++) {
      if (opts.isCancelled && opts.isCancelled()) { out.s2.status = 'partial'; break; }
      try {
        var corpus2 = await semanticScholarCorpusForSentence(results[s2Groups[h][0]].text);
        out.s2.queries++;
        if (corpus2.length) await applyFor(s2Groups[h], corpus2, out.s2);
      } catch (e) {
        out.s2.status = out.s2.queries ? 'partial' : 'failed';
        out.s2.detail = e.message;
        if (e.code === 'RATE_LIMIT') break; // stop hammering a rate-limited pool
      }
      if (opts.onProgress) opts.onProgress('Semantic Scholar', out.s2.queries, s2Groups.length);
    }
    if (!out.s2.detail) out.s2.detail = out.s2.queries + ' searches, ' + out.s2.matched + ' matched.';
    return [out.crossref, out.s2];
  }

  async function runWebStage(engine, results, opts) {
    opts = opts || {};
    var stats = { source: 'Whole web (Serper/Tavily)', status: 'ok', queries: 0, matched: 0, detail: '' };
    var provider = opts.serperKey ? 'serper' : (opts.tavilyKey ? 'tavily' : null);
    if (!provider) {
      stats.status = 'not-enabled';
      stats.detail = 'Not enabled \u2014 add a free Serper or Tavily key in Settings to check the whole web (websites, forums, social media). Wikipedia, academic and Library checks still ran.';
      return stats;
    }
    var cap = typeof opts.cap === 'number' ? opts.cap : 30;
    var delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 250;
    stats.source = provider === 'serper' ? 'Whole web (Serper \u2014 Google results)' : 'Whole web (Tavily)';
    var idxs = [];
    results.forEach(function (r, i) { if (r.status === 'original' && r.wordCount >= 10) idxs.push(i); });
    var groups = dedupeIndexes(engine, results, idxs).slice(0, cap);
    var failures = 0;
    for (var g = 0; g < groups.length; g++) {
      if (opts.isCancelled && opts.isCancelled()) { stats.status = 'partial'; stats.detail = 'Cancelled after ' + stats.queries + ' web queries.'; return stats; }
      var sentence = results[groups[g][0]].text;
      try {
        var res = provider === 'serper'
          ? await serperCorpusForSentence(sentence, opts.serperKey)
          : await tavilyCorpusForSentence(sentence, opts.tavilyKey);
        stats.queries++;
        if (res.corpus && res.corpus.length) {
          var m = engine.matchSentence(sentence, res.corpus, { minMatchWords: opts.minMatchWords });
          if (m.status !== 'original') {
            groups[g].forEach(function (i) {
              var before = results[i].status;
              engine.pickBetter(results[i], m);
              if (results[i].status !== before) stats.matched++;
            });
          }
        }
      } catch (e) { failures++; stats.detail = e.message; }
      if (opts.onProgress) opts.onProgress(stats.source, stats.queries, groups.length);
      if (delayMs) await sleep(delayMs);
    }
    if (failures && stats.queries === 0) stats.status = 'failed';
    else if (failures) { stats.status = 'partial'; stats.detail = failures + ' web request(s) failed (last: ' + stats.detail + '). ' + stats.queries + ' queries used.'; }
    else stats.detail = stats.queries + ' web queries used (cap ' + cap + '), ' + stats.matched + ' sentence(s) matched.';
    return stats;
  }

  var api = {
    classifyUrl: classifyUrl, typeLabel: typeLabel,
    wikipediaCorpusForSentence: wikipediaCorpusForSentence,
    fetchWikipediaArticle: fetchWikipediaArticle,
    crossrefCorpusForSentence: crossrefCorpusForSentence,
    semanticScholarCorpusForSentence: semanticScholarCorpusForSentence,
    buildSerperRequest: buildSerperRequest, buildTavilyRequest: buildTavilyRequest,
    serperCorpusForSentence: serperCorpusForSentence, tavilyCorpusForSentence: tavilyCorpusForSentence,
    runWikipediaStage: runWikipediaStage, runAcademicStage: runAcademicStage, runWebStage: runWebStage,
    sleep: sleep
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MoulikSources = api;
})(typeof window !== 'undefined' ? window : globalThis);
