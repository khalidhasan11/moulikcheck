/*
 * MoulikCheck engine.js — V2
 * Pure matching logic, no DOM, no network. Works in browser
 * (window.MoulikEngine) and in Node (module.exports) so the same code
 * is tested and shipped. Internet fetching lives in sources.js.
 *
 * THRESHOLDS (documented, change here only):
 *  - SHINGLE_SIZE = 8 consecutive words => an overlap is an EXACT match.
 *  - SIMILAR_THRESHOLD = 0.50 TF-IDF cosine (sentence vs best corpus
 *    sentence) => SIMILAR. Below that: ORIGINAL. It is a risk flag, not
 *    proof — heavily paraphrased text WILL fall below it and be missed.
 *  - MIN_MATCH_WORDS (option minMatchWords, default 8): a match whose
 *    matched segment is shorter than this is ignored ("exclude small
 *    matches", Turnitin-style). Matched segment = longest common
 *    consecutive word run for exact matches; number of shared distinct
 *    words for similar matches.
 *  - Risk score: Total Risk % = (exactWords + 0.6 * similarWords)
 *    / scoredWords * 100. Bands: 0-10 Low, 11-25 Medium, 26+ High.
 *    Guidance only — NOT a Turnitin prediction.
 */
(function (global) {
  'use strict';

  var THRESHOLDS = {
    SHINGLE_SIZE: 8,
    SIMILAR_THRESHOLD: 0.50,
    SIMILAR_WEIGHT: 0.6,
    BAND_LOW_MAX: 10,
    BAND_MEDIUM_MAX: 25,
    DEFAULT_MIN_MATCH_WORDS: 8
  };

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9'\s-]/g, ' ')
      .replace(/-/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 0; });
  }

  function normalizeText(text) { return tokenize(text).join(' '); }

  // Sentence splitter: handles ., !, ? and line breaks. Abbreviations like
  // "Dr." may split early — a known, documented limitation.
  function splitSentences(text) {
    if (!text) return [];
    var cleaned = String(text).replace(/\r\n/g, '\n');
    var parts = [];
    var re = /[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+$/g;
    var m;
    while ((m = re.exec(cleaned)) !== null) {
      var s = m[0].trim();
      if (s && tokenize(s).length >= 3) parts.push(s);
    }
    return parts;
  }

  var REF_HEADINGS = [
    /^\s*references\s*$/im,
    /^\s*bibliography\s*$/im,
    /^\s*reference\s+list\s*$/im,
    /^\s*works\s+cited\s*$/im
  ];

  function stripReferences(text) {
    var src = String(text || '');
    for (var i = 0; i < REF_HEADINGS.length; i++) {
      var m = REF_HEADINGS[i].exec(src);
      if (m && m.index > src.length * 0.35) {
        return { text: src.slice(0, m.index).trim(), stripped: true };
      }
    }
    return { text: src, stripped: false };
  }

  function quotedFraction(sentence) {
    var matches = String(sentence).match(/"[^"]+"/g);
    if (!matches) return 0;
    var quotedWords = 0;
    matches.forEach(function (q) { quotedWords += tokenize(q).length; });
    var total = tokenize(sentence).length;
    return total ? quotedWords / total : 0;
  }

  function isQuotedSentence(sentence) { return quotedFraction(sentence) >= 0.6; }

  function shinglesForWords(words, size) {
    var n = size || THRESHOLDS.SHINGLE_SIZE;
    var out = [];
    if (words.length < n) return out;
    for (var i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
    return out;
  }

  // Longest common consecutive word run between two word arrays.
  function longestCommonRun(a, b) {
    if (!a.length || !b.length) return 0;
    var best = 0, prev = new Array(b.length + 1).fill(0), cur = new Array(b.length + 1).fill(0);
    for (var i = 1; i <= a.length; i++) {
      for (var j = 1; j <= b.length; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
        if (cur[j] > best) best = cur[j];
      }
      var t = prev; prev = cur; cur = t.fill(0);
    }
    return best;
  }

  function sharedWordCount(a, b) {
    var setB = {}; b.forEach(function (w) { setB[w] = true; });
    var seen = {}, n = 0;
    a.forEach(function (w) { if (setB[w] && !seen[w]) { seen[w] = true; n++; } });
    return n;
  }

  function buildTfidf(sentWordArrays) {
    var N = sentWordArrays.length;
    var df = {};
    sentWordArrays.forEach(function (words) {
      var seen = {};
      words.forEach(function (w) { seen[w] = true; });
      Object.keys(seen).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
    });
    var idf = {};
    Object.keys(df).forEach(function (w) { idf[w] = Math.log(1 + N / (1 + df[w])) + 1; });
    var defaultIdf = Math.log(1 + Math.max(N, 1)) + 1;
    return { idf: idf, defaultIdf: defaultIdf, corpusSize: N };
  }

  function tfidfVector(words, tfidf) {
    var tf = {};
    words.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
    var vec = {}, normSq = 0;
    Object.keys(tf).forEach(function (w) {
      var v = (tf[w] / words.length) * (tfidf.idf[w] || tfidf.defaultIdf);
      vec[w] = v; normSq += v * v;
    });
    return { vec: vec, norm: Math.sqrt(normSq) || 1 };
  }

  function cosine(a, b) {
    var dot = 0;
    var small = Object.keys(a.vec).length < Object.keys(b.vec).length ? a : b;
    var other = small === a ? b : a;
    Object.keys(small.vec).forEach(function (w) { if (other.vec[w]) dot += small.vec[w] * other.vec[w]; });
    return dot / (a.norm * b.norm);
  }

  function googleSearchUrl(sentence) {
    return 'https://www.google.com/search?q=' + encodeURIComponent('"' + String(sentence).trim() + '"');
  }

  /*
   * buildCorpus(docs): docs = [{name, url?, type?, text}]
   * Returns prepared sentences with per-doc metadata for attribution.
   */
  function buildCorpus(docs) {
    var sents = [];
    (docs || []).forEach(function (doc) {
      splitSentences(doc.text).forEach(function (t) {
        sents.push({
          docName: doc.name || 'Source', docUrl: doc.url || null,
          docType: doc.type || 'library', text: t, words: tokenize(t)
        });
      });
    });
    var tfidf = buildTfidf(sents.map(function (s) { return s.words; }));
    sents.forEach(function (s) { s.vector = tfidfVector(s.words, tfidf); });
    var shingleIndex = {};
    sents.forEach(function (s, idx) {
      shinglesForWords(s.words).forEach(function (sh) {
        (shingleIndex[sh] = shingleIndex[sh] || []).push(idx);
      });
    });
    return { sents: sents, tfidf: tfidf, shingleIndex: shingleIndex };
  }

  /*
   * matchWithCorpus(sentenceText, corpus, options)
   * -> {status:'exact'|'similar'|'original', bestMatch|null}
   * bestMatch: {sourceType, sourceName, sourceUrl,
   *             sourceSentence, similarity, shingleOverlap, matchWords, method}
   */
  function matchWithCorpus(sentenceText, corpus, options) {
    var opts = options || {};
    var minMatch = (typeof opts.minMatchWords === 'number') ? opts.minMatchWords : THRESHOLDS.DEFAULT_MIN_MATCH_WORDS;
    var words = tokenize(sentenceText);
    if (!words.length || !corpus.sents.length) return { status: 'original', bestMatch: null };

    var qVec = tfidfVector(words, corpus.tfidf);

    var hitCounts = {};
    shinglesForWords(words).forEach(function (sh) {
      (corpus.shingleIndex[sh] || []).forEach(function (idx) { hitCounts[idx] = (hitCounts[idx] || 0) + 1; });
    });
    var bestShingleIdx = -1, bestShingleCount = 0;
    Object.keys(hitCounts).forEach(function (k) {
      if (hitCounts[k] > bestShingleCount) { bestShingleCount = hitCounts[k]; bestShingleIdx = Number(k); }
    });

    var bestCos = 0, bestCosIdx = -1;
    for (var j = 0; j < corpus.sents.length; j++) {
      var c = cosine(qVec, corpus.sents[j].vector);
      if (c > bestCos) { bestCos = c; bestCosIdx = j; }
    }

    // If small matches below the 8-word shingle size are allowed
    // (minMatch < 8), shingles alone cannot see them — scan for the
    // longest common run directly so the setting behaves as documented.
    if (bestShingleIdx < 0 && minMatch < THRESHOLDS.SHINGLE_SIZE) {
      var bestRun = 0;
      for (var ri = 0; ri < corpus.sents.length; ri++) {
        var r = longestCommonRun(words, corpus.sents[ri].words);
        if (r > bestRun) { bestRun = r; bestShingleIdx = ri; }
      }
      if (bestRun < minMatch) bestShingleIdx = -1;
    }

    if (bestShingleIdx >= 0) {
      var ls = corpus.sents[bestShingleIdx];
      var run = longestCommonRun(words, ls.words);
      if (run >= Math.max(minMatch, 1)) {
        return { status: 'exact', bestMatch: {
          sourceType: ls.docType, sourceName: ls.docName, sourceUrl: ls.docUrl,
          sourceSentence: ls.text, similarity: Math.round(bestCos * 100) / 100,
          shingleOverlap: bestShingleCount, matchWords: run, method: bestShingleCount > 0 ? '8-word-shingle' : 'word-run'
        } };
      }
      // Run too short -> small match excluded; fall through to similar test.
    }
    if (bestCosIdx >= 0 && bestCos >= THRESHOLDS.SIMILAR_THRESHOLD) {
      var bs = corpus.sents[bestCosIdx];
      var shared = sharedWordCount(words, bs.words);
      if (shared >= Math.max(minMatch, 1)) {
        return { status: 'similar', bestMatch: {
          sourceType: bs.docType, sourceName: bs.docName, sourceUrl: bs.docUrl,
          sourceSentence: bs.text, similarity: Math.round(bestCos * 100) / 100,
          shingleOverlap: 0, matchWords: shared, method: 'tfidf-cosine'
        } };
      }
    }
    return { status: 'original', bestMatch: bestCosIdx >= 0 ? {
      sourceType: corpus.sents[bestCosIdx].docType, sourceName: corpus.sents[bestCosIdx].docName,
      sourceUrl: corpus.sents[bestCosIdx].docUrl, sourceSentence: corpus.sents[bestCosIdx].text,
      similarity: Math.round(bestCos * 100) / 100, shingleOverlap: 0, matchWords: 0,
      method: 'below-threshold'
    } : null };
  }

  function matchSentence(sentenceText, corpusDocs, options) {
    return matchWithCorpus(sentenceText, buildCorpus(corpusDocs), options);
  }

  var STATUS_RANK = { original: 0, similar: 1, exact: 2 };
  // Upgrade a sentence result with a candidate match from another source.
  function pickBetter(result, candidate) {
    if (!candidate || !candidate.bestMatch || candidate.status === 'original') return result;
    if (result.status === 'quoted') return result;
    var curRank = STATUS_RANK[result.status] || 0;
    var candRank = STATUS_RANK[candidate.status] || 0;
    if (candRank > curRank ||
        (candRank === curRank && !result.bestMatch) ||
        (candRank === curRank && result.bestMatch &&
         (candidate.bestMatch.similarity || 0) > (result.bestMatch.similarity || 0))) {
      result.status = candidate.status;
      result.bestMatch = candidate.bestMatch;
    }
    return result;
  }

  function computeSummary(results, meta) {
    var totalWords = 0, scoredWords = 0, exactWords = 0, similarWords = 0, originalWords = 0, quotedWords = 0;
    results.forEach(function (r) {
      totalWords += r.wordCount;
      if (r.status === 'quoted') { quotedWords += r.wordCount; return; }
      scoredWords += r.wordCount;
      if (r.status === 'exact') exactWords += r.wordCount;
      else if (r.status === 'similar') similarWords += r.wordCount;
      else originalWords += r.wordCount;
    });
    var denom = scoredWords || 1;
    var pct = function (n) { return Math.round((n / denom) * 1000) / 10; };
    var totalRisk = Math.round(((exactWords + THRESHOLDS.SIMILAR_WEIGHT * similarWords) / denom) * 1000) / 10;
    var band = totalRisk <= THRESHOLDS.BAND_LOW_MAX ? 'Low' : (totalRisk <= THRESHOLDS.BAND_MEDIUM_MAX ? 'Medium' : 'High');
    return Object.assign({
      totalWords: totalWords, scoredWords: scoredWords, sentenceCount: results.length,
      exactWords: exactWords, similarWords: similarWords, originalWords: originalWords, quotedWords: quotedWords,
      exactPct: pct(exactWords), similarPct: pct(similarWords), originalPct: pct(originalWords),
      totalRisk: totalRisk, band: band,
      disclaimer: 'This is a risk estimate from MoulikCheck V2 (Library + Wikipedia + academic + optional whole-web checks). It is NOT a Turnitin prediction and NOT 100% accurate. A low score means no risk was found by these checks \u2014 it does not guarantee any other checker will give the same result. Turnitin\u2019s private student-paper database cannot be checked by any free tool.'
    }, meta || {});
  }

  // Source breakdown: distinct sources ranked by share of scored words.
  function sourceBreakdown(results) {
    var scored = 0;
    var bySource = {};
    results.forEach(function (r) {
      if (r.status === 'quoted') return;
      scored += r.wordCount;
      if ((r.status === 'exact' || r.status === 'similar') && r.bestMatch) {
        var key = (r.bestMatch.sourceName || 'Source') + '|' + (r.bestMatch.sourceUrl || '');
        if (!bySource[key]) {
          bySource[key] = {
            key: key, name: r.bestMatch.sourceName, url: r.bestMatch.sourceUrl || null,
            type: r.bestMatch.sourceType || 'library', words: 0, sentences: 0
          };
        }
        bySource[key].words += r.wordCount;
        bySource[key].sentences += 1;
      }
    });
    var denom = scored || 1;
    return Object.keys(bySource).map(function (k) {
      var s = bySource[k];
      s.pct = Math.round((s.words / denom) * 1000) / 10;
      return s;
    }).sort(function (a, b) { return b.words - a.words; });
  }

  /*
   * analyzeDocument(mainText, libraryDocs, options)
   *  libraryDocs: [{id?, name, text}] (Source C, offline)
   *  options: {stripReferences=true, excludeQuoted=true, minMatchWords=8}
   */
  function analyzeDocument(mainText, libraryDocs, options) {
    var opts = Object.assign({ stripReferences: true, excludeQuoted: true, minMatchWords: THRESHOLDS.DEFAULT_MIN_MATCH_WORDS }, options || {});
    libraryDocs = (libraryDocs || []).map(function (d) {
      return { name: d.name, url: d.url || null, type: d.type || 'library', text: d.text };
    });

    var refResult = opts.stripReferences ? stripReferences(mainText) : { text: String(mainText || ''), stripped: false };
    var corpus = buildCorpus(libraryDocs);

    var results = splitSentences(refResult.text).map(function (t, i) {
      var words = tokenize(t);
      var base = { index: i, text: t, wordCount: words.length, googleSearchUrl: googleSearchUrl(t) };
      if (opts.excludeQuoted && isQuotedSentence(t)) {
        return Object.assign(base, { status: 'quoted', bestMatch: null });
      }
      return Object.assign(base, matchWithCorpus(t, corpus, opts));
    });

    // Self-duplication pass: an exact repeat inside the same document is
    // flagged when nothing stronger matched (a Library match wins, as V1).
    var seenNorm = {};
    results.forEach(function (r, i) {
      var norm = normalizeText(r.text);
      if (r.status === 'original' && norm && seenNorm[norm] !== undefined) {
        r.status = 'exact';
        r.bestMatch = {
          sourceType: 'self', sourceName: 'Self (duplication in this document)', sourceUrl: null,
          sourceSentence: results[seenNorm[norm]].text, similarity: 1,
          shingleOverlap: 0, matchWords: r.wordCount, method: 'identical-repeat'
        };
      }
      if (seenNorm[norm] === undefined) seenNorm[norm] = i;
    });

    return {
      sentences: results,
      summary: computeSummary(results, {
        referencesStripped: refResult.stripped,
        librarySentenceCount: corpus.sents.length,
        libraryDocCount: libraryDocs.length
      })
    };
  }

  var api = {
    THRESHOLDS: THRESHOLDS,
    tokenize: tokenize, normalizeText: normalizeText,
    splitSentences: splitSentences, stripReferences: stripReferences,
    isQuotedSentence: isQuotedSentence, quotedFraction: quotedFraction,
    shinglesForWords: shinglesForWords, longestCommonRun: longestCommonRun,
    sharedWordCount: sharedWordCount, googleSearchUrl: googleSearchUrl,
    buildCorpus: buildCorpus, matchWithCorpus: matchWithCorpus, matchSentence: matchSentence,
    pickBetter: pickBetter, computeSummary: computeSummary, sourceBreakdown: sourceBreakdown,
    analyzeDocument: analyzeDocument
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MoulikEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
