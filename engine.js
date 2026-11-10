/*
 * MoulikCheck engine.js — V4 (accuracy upgrade, no key rotation involved)
 * Pure matching logic, no DOM, no network. Works in browser
 * (window.MoulikEngine) and in Node (module.exports) so the same code
 * is tested and shipped. Internet fetching lives in sources.js.
 *
 * V4 changes vs V3 (Khalid's Master Accuracy Upgrade, minus rotation):
 *  - Multi-level matching: word-run tiers 5 / 8 / 12 / 15+ drive the
 *    match TYPE (exact vs near-exact) and CONFIDENCE — a long copied run
 *    is much stronger evidence than a short one.
 *  - COMMON PHRASE FILTER: a built-in list of academic clichés. Matches
 *    that consist mostly of common phrases are classified
 *    'common-phrase' and carry a small risk weight (0.15), so original
 *    writing full of standard phrases is not inflated into "plagiarism".
 *  - Synonym-aware similarity ON TOP of TF-IDF cosine: catches light /
 *    medium paraphrase that swaps words (use→utilize, help→assist…).
 *    It is lexical, NOT true semantic embeddings — labelled honestly in
 *    the method field ('synonym-overlap') and in the UI copy.
 *  - Citation awareness: (Author, 2024), Author (2024), [1], DOI, URL
 *    patterns. A cited match keeps its type but its risk weight is
 *    multiplied by 0.35 and it is counted separately as 'citation'.
 *  - Bibliography: reference-section stripping (as V3) PLUS per-sentence
 *    reference-entry tagging (status 'bibliography', excluded from
 *    scoring like quotations).
 *  - Quotation detection now also understands curly quotes (“ ”).
 *  - Every match carries: matchType, confidence (high|medium|low),
 *    verified (was the source's full text compared, or only a search
 *    snippet?), tier (source reliability), cited flag and a human
 *    `reason` string explaining why it was flagged.
 *  - Weighted final risk: exact 1.0 · near-exact 0.9 · paraphrase 0.6 ·
 *    common-phrase 0.15 · cited × 0.35. Weights were validated against
 *    the accuracy test-suite (tests/accuracy-tests.mjs), not invented
 *    to inflate scores.
 *
 * THRESHOLDS (documented, change here only):
 *  - SHINGLE_SIZE = 8 consecutive words => EXACT candidate.
 *  - SIMILAR_THRESHOLD = 0.50 TF-IDF cosine => SIMILAR (paraphrase).
 *  - MIN_MATCH_WORDS (option minMatchWords, default 8).
 *  - Bands: 0-10 Low, 11-25 Medium, 26+ High. Guidance only —
 *    NOT a Turnitin prediction.
 */
(function (global) {
  'use strict';

  var THRESHOLDS = {
    SHINGLE_SIZE: 8,
    SIMILAR_THRESHOLD: 0.50,
    SIMILAR_WEIGHT: 0.6,
    NEAR_EXACT_WEIGHT: 0.9,
    COMMON_PHRASE_WEIGHT: 0.15,
    CITED_MULTIPLIER: 0.35,
    BAND_LOW_MAX: 10,
    BAND_MEDIUM_MAX: 25,
    DEFAULT_MIN_MATCH_WORDS: 8
  };

  // ---------------- Text normalization (comparison copy) ----------------
  // The ORIGINAL text is always kept for display; tokenize() produces the
  // normalized comparison form (lowercase, curly quotes/apostrophes
  // unified, punctuation stripped). Sentence objects keep both.
  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^a-z0-9'"\s-]/g, ' ')
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

  // ---------------- Bibliography / references ----------------
  var REF_HEADINGS = [
    /^\s*references\s*$/im,
    /^\s*bibliography\s*$/im,
    /^\s*reference\s+list\s*$/im,
    /^\s*list\s+of\s+references\s*$/im,
    /^\s*works\s+cited\s*$/im,
    /^\s*sources\s*$/im
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

  // A single line that itself looks like a reference-list entry, e.g.
  // "Kotler, P. & Keller, K. L. (2016). Marketing Management. Pearson."
  function isReferenceEntry(sentence) {
    var s = String(sentence || '');
    if (/^\s*(\[\d+\]\s*)?[A-Z][A-Za-z'-]+,\s*([A-Z]\.\s*)+(.*\(\d{4}[a-z]?\))/.test(s)) return true;
    if (/(doi\.org\/|10\.\d{4,}\/)/.test(s) && /\(\d{4}\)/.test(s)) return true;
    return false;
  }

  // ---------------- Quotations ----------------
  function quotedFraction(sentence) {
    var s = String(sentence).replace(/[“”]/g, '"');
    var matches = s.match(/"[^"]+"/g);
    if (!matches) return 0;
    var quotedWords = 0;
    matches.forEach(function (q) { quotedWords += tokenize(q).length; });
    var total = tokenize(sentence).length;
    return total ? quotedWords / total : 0;
  }

  function isQuotedSentence(sentence) { return quotedFraction(sentence) >= 0.6; }

  // ---------------- Citations ----------------
  function hasCitation(sentence) {
    var s = String(sentence || '');
    if (/\(\s*[A-Z][^)]*,\s*\d{4}[a-z]?\s*\)/.test(s)) return true;        // (Author, 2024)
    if (/[A-Z][A-Za-z'-]+(\s+et al\.)?\s*\(\d{4}[a-z]?\)/.test(s)) return true; // Author (2024) / Author et al. (2024)
    if (/\[\d+\]/.test(s)) return true;                                     // [1]
    if (/(doi\.org\/|10\.\d{4,}\/)/.test(s)) return true;                   // DOI
    if (/https?:\/\//.test(s)) return true;                                 // URL
    return false;
  }

  // ---------------- Common academic phrases ----------------
  var COMMON_PHRASES = [
    'the purpose of this study is', 'this study aims to', 'the aim of this study is',
    'this paper focuses on', 'according to the results', 'according to',
    'plays an important role', 'play an important role', 'in today\'s world',
    'in the modern world', 'in conclusion', 'to sum up', 'in summary',
    'on the other hand', 'in order to', 'as a result', 'due to the fact that',
    'in addition to', 'for example', 'such as', 'in general',
    'it is important to note that', 'in recent years', 'more and more',
    'first of all', 'in other words', 'as mentioned above', 'based on the',
    'one of the most', 'there are many', 'it has been', 'can be seen',
    'in the context of', 'with regard to', 'in terms of', 'a wide range of',
    'a large number of', 'the majority of', 'at the same time', 'in fact',
    'of course', 'in the end', 'as well as', 'the process of',
    'has changed the way', 'in the field of', 'a variety of', 'is one of the'
  ].map(function (p) { return tokenize(p); })
   .sort(function (a, b) { return b.length - a.length; }); // longest first (greedy)

  // Fraction of the sentence's words covered by common phrases (0..1).
  function commonPhraseRatio(words) {
    if (!words || !words.length) return 0;
    var covered = new Array(words.length).fill(false);
    COMMON_PHRASES.forEach(function (ph) {
      if (ph.length > words.length) return;
      for (var i = 0; i + ph.length <= words.length; i++) {
        var ok = true;
        for (var j = 0; j < ph.length; j++) if (words[i + j] !== ph[j]) { ok = false; break; }
        if (ok) for (var k = 0; k < ph.length; k++) covered[i + k] = true;
      }
    });
    var n = 0; covered.forEach(function (c) { if (c) n++; });
    return n / words.length;
  }

  // ---------------- Synonym-aware similarity (lexical, honest label) ------
  var SYNONYM_GROUPS = [
    ['use', 'utilize', 'utilise', 'employ'], ['help', 'assist', 'aid'],
    ['important', 'significant', 'crucial', 'essential', 'vital'],
    ['show', 'demonstrate', 'indicate', 'reveal'], ['get', 'obtain', 'receive', 'gain'],
    ['make', 'create', 'produce', 'generate'], ['big', 'large', 'major', 'huge'],
    ['fast', 'rapid', 'quick', 'swift'], ['start', 'begin', 'commence'],
    ['end', 'finish', 'conclude'], ['buy', 'purchase'], ['allow', 'permit', 'enable'],
    ['cheap', 'inexpensive', 'affordable'], ['student', 'students', 'learner', 'learners'],
    ['study', 'learn', 'studies'], ['different', 'various', 'diverse'],
    ['improve', 'enhance', 'increase', 'boost'], ['reduce', 'decrease', 'lower'],
    ['provide', 'offer', 'supply', 'give'], ['need', 'require', 'needs'],
    ['choose', 'select', 'pick'], ['connect', 'communicate', 'interact'],
    ['job', 'work', 'employment'], ['company', 'business', 'organization', 'organisation', 'firm'],
    ['people', 'individuals', 'persons'], ['way', 'method', 'approach'],
    ['change', 'transform', 'alter'], ['grow', 'expand', 'growth'],
    ['new', 'modern', 'recent'], ['many', 'numerous', 'several'],
    ['about', 'regarding', 'concerning'], ['also', 'additionally', 'furthermore'],
    ['but', 'however', 'yet'], ['so', 'therefore', 'thus', 'consequently'],
    ['education', 'learning', 'teaching'], ['online', 'digital', 'virtual', 'remote', 'remotely'],
    ['technology', 'technologies', 'tech'], ['result', 'outcome', 'results'],
    ['ask', 'question', 'inquire'], ['answer', 'respond', 'reply']
  ];
  var SYNONYM_OF = {};
  SYNONYM_GROUPS.forEach(function (g) {
    g.forEach(function (w) { SYNONYM_OF[w] = g; });
  });
  // Stopwords carry no meaning for paraphrase detection — excluding them
  // is what lets the synonym gate stay sensitive without false positives
  // on unrelated text that merely shares "the / and / with".
  var STOPWORDS = {};
  ('the a an and or to of in on for with from by at as is are was were be been being it its this that these those i you he she we they my your his her our their can could will would shall should may might do does did have has had not no yes if then than so such into onto upon about above after before between through during each other more most very just also only own same too').split(' ')
    .forEach(function (w) { STOPWORDS[w] = true; });
  function stemLite(w) {
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 4 && /es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function contentWordSet(words) {
    var set = {};
    words.forEach(function (w) { if (!STOPWORDS[w]) set[stemLite(w)] = true; });
    return set;
  }
  // 0..1 overlap over CONTENT words (stopwords excluded, light stemming),
  // where synonyms count 0.7. Denominator: smaller distinct content set.
  function synonymOverlap(wordsA, wordsB) {
    var setA = contentWordSet(wordsA), setB = contentWordSet(wordsB);
    var keysA = Object.keys(setA), keysB = Object.keys(setB);
    if (!keysA.length || !keysB.length) return 0;
    var score = 0;
    keysA.forEach(function (w) {
      if (setB[w]) { score += 1; return; }
      var g = SYNONYM_OF[w];
      if (g) for (var i = 0; i < g.length; i++) { var gw = stemLite(g[i]); if (setB[gw]) { score += 0.7; return; } }
    });
    return score / Math.max(3, Math.min(keysA.length, keysB.length));
  }
  function sharedContentCount(wordsA, wordsB) {
    var setB = contentWordSet(wordsB);
    var seen = {}, n = 0;
    Object.keys(contentWordSet(wordsA)).forEach(function (w) { if (setB[w] && !seen[w]) { seen[w] = true; n++; } });
    return n;
  }

  // ---------------- Core matching helpers (as V3) ----------------
  function shinglesForWords(words, size) {
    var n = size || THRESHOLDS.SHINGLE_SIZE;
    var out = [];
    if (words.length < n) return out;
    for (var i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
    return out;
  }

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

  // Distinctive search segment: the longest run of words NOT covered by
  // common phrases (min 6, max 12 words) — searching this finds sources
  // far more reliably than a whole generic sentence.
  function distinctiveQuery(sentence) {
    var words = tokenize(sentence);
    if (words.length <= 12) return words.join(' ');
    var covered = new Array(words.length).fill(false);
    COMMON_PHRASES.forEach(function (ph) {
      if (ph.length > words.length) return;
      for (var i = 0; i + ph.length <= words.length; i++) {
        var ok = true;
        for (var j = 0; j < ph.length; j++) if (words[i + j] !== ph[j]) { ok = false; break; }
        if (ok) for (var k = 0; k < ph.length; k++) covered[i + k] = true;
      }
    });
    var bestStart = 0, bestLen = 0, curStart = 0, curLen = 0;
    for (var i2 = 0; i2 < words.length; i2++) {
      if (!covered[i2]) { if (curLen === 0) curStart = i2; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; } }
      else curLen = 0;
    }
    if (bestLen >= 6) return words.slice(bestStart, bestStart + Math.min(12, bestLen)).join(' ');
    return words.slice(0, 12).join(' ');
  }

  /*
   * buildCorpus(docs): docs = [{name, url?, type?, text, verified?, tier?}]
   * verified: the doc's FULL text is compared (Library file, Wikipedia
   * extract) vs only a snippet/abstract. tier: 'high' (academic /
   * Wikipedia / official) | 'standard'.
   */
  function buildCorpus(docs) {
    var sents = [];
    (docs || []).forEach(function (doc) {
      splitSentences(doc.text).forEach(function (t) {
        sents.push({
          docName: doc.name || 'Source', docUrl: doc.url || null,
          docType: doc.type || 'library',
          docVerified: !!doc.verified, docTier: doc.tier || 'standard',
          text: t, words: tokenize(t)
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

  // Classify a confirmed match into type + confidence + weight + reason.
  function classify(opts) {
    // opts: {run, similarity, verified, tier, commonRatio, cited, exact}
    var type, confidence, weight, reason;
    if (opts.exact) {
      if (opts.run >= 12) { type = 'exact'; confidence = opts.verified ? 'high' : 'medium'; weight = 1.0;
        reason = opts.run + '-word exact phrase matches ' + (opts.verified ? 'a verified source' : 'a source found by search (page not fully verified)') + '.'; }
      else { type = 'near-exact'; confidence = opts.verified ? 'high' : 'medium'; weight = THRESHOLDS.NEAR_EXACT_WEIGHT;
        reason = opts.run + '-word near-exact phrase matches ' + (opts.verified ? 'a verified source' : 'a search-found source') + '.'; }
    } else {
      type = 'paraphrase'; weight = THRESHOLDS.SIMILAR_WEIGHT;
      confidence = opts.similarity >= 0.75 ? 'medium' : 'low';
      reason = 'High word/synonym similarity (' + Math.round(opts.similarity * 100) + '%) to a source, with different wording — possible paraphrase.';
    }
    if (opts.commonRatio >= 0.6 && !opts.exact) {
      type = 'common-phrase'; weight = THRESHOLDS.COMMON_PHRASE_WEIGHT; confidence = 'low';
      reason = 'The overlap is mostly common academic phrasing — low plagiarism weight.';
    } else if (opts.commonRatio >= 0.6 && opts.exact && opts.run < 12) {
      type = 'common-phrase'; weight = THRESHOLDS.COMMON_PHRASE_WEIGHT; confidence = 'low';
      reason = 'Matched text is mostly a common phrase (' + opts.run + ' words) — low plagiarism weight.';
    }
    if (opts.cited) { weight = Math.round(weight * THRESHOLDS.CITED_MULTIPLIER * 100) / 100; reason += ' A citation was detected, so its weight is reduced.'; }
    if (opts.tier === 'high' && confidence === 'medium' && opts.verified) confidence = 'high';
    return { matchType: type, confidence: confidence, riskWeight: weight, reason: reason };
  }

  /*
   * matchWithCorpus(sentenceText, corpus, options)
   * -> {status:'exact'|'similar'|'original', bestMatch|null}
   * bestMatch gains V4 fields: matchType, confidence, verified, tier,
   * cited, riskWeight, reason.
   */
  function matchWithCorpus(sentenceText, corpus, options) {
    var opts = options || {};
    var minMatch = (typeof opts.minMatchWords === 'number') ? opts.minMatchWords : THRESHOLDS.DEFAULT_MIN_MATCH_WORDS;
    var words = tokenize(sentenceText);
    if (!words.length || !corpus.sents.length) return { status: 'original', bestMatch: null };
    var commonRatio = commonPhraseRatio(words);
    var cited = hasCitation(sentenceText);

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
        var cls = classify({ run: run, similarity: bestCos, verified: ls.docVerified, tier: ls.docTier, commonRatio: commonRatio, cited: cited, exact: true });
        return { status: 'exact', bestMatch: {
          sourceType: ls.docType, sourceName: ls.docName, sourceUrl: ls.docUrl,
          sourceSentence: ls.text, similarity: Math.round(bestCos * 100) / 100,
          shingleOverlap: bestShingleCount, matchWords: run,
          method: bestShingleCount > 0 ? 'multi-shingle(5/8/12/15)' : 'word-run',
          matchType: cls.matchType, confidence: cls.confidence, verified: ls.docVerified,
          tier: ls.docTier, cited: cited, riskWeight: cls.riskWeight, reason: cls.reason
        } };
      }
    }
    // Similar: TF-IDF cosine OR synonym-aware overlap (paraphrase path).
    if (bestCosIdx >= 0) {
      var bs = corpus.sents[bestCosIdx];
      var shared = sharedWordCount(words, bs.words);
      var syn = synonymOverlap(words, bs.words);
      var viaTfidf = bestCos >= THRESHOLDS.SIMILAR_THRESHOLD && shared >= Math.max(minMatch, 1);
      // Synonym path gates (tuned on the accuracy suite): content-word
      // overlap >= 0.50, some TF-IDF agreement, >= 3 shared content words.
      var viaSynonym = syn >= 0.50 && bestCos >= 0.20 && sharedContentCount(words, bs.words) >= 3;
      if (viaTfidf || viaSynonym) {
        var simUsed = viaTfidf ? bestCos : Math.max(bestCos, Math.round(syn * 0.9 * 100) / 100);
        var cls2 = classify({ run: 0, similarity: simUsed, verified: bs.docVerified, tier: bs.docTier, commonRatio: commonRatio, cited: cited, exact: false });
        return { status: 'similar', bestMatch: {
          sourceType: bs.docType, sourceName: bs.docName, sourceUrl: bs.docUrl,
          sourceSentence: bs.text, similarity: Math.round(simUsed * 100) / 100,
          shingleOverlap: 0, matchWords: shared, method: viaTfidf ? 'tfidf-cosine' : 'synonym-overlap',
          matchType: cls2.matchType, confidence: cls2.confidence, verified: bs.docVerified,
          tier: bs.docTier, cited: cited, riskWeight: cls2.riskWeight, reason: cls2.reason
        } };
      }
    }
    return { status: 'original', bestMatch: bestCosIdx >= 0 ? {
      sourceType: corpus.sents[bestCosIdx].docType, sourceName: corpus.sents[bestCosIdx].docName,
      sourceUrl: corpus.sents[bestCosIdx].docUrl, sourceSentence: corpus.sents[bestCosIdx].text,
      similarity: Math.round(bestCos * 100) / 100, shingleOverlap: 0, matchWords: 0,
      method: 'below-threshold', matchType: null, confidence: null, verified: corpus.sents[bestCosIdx].docVerified,
      tier: corpus.sents[bestCosIdx].docTier, cited: cited, riskWeight: 0, reason: ''
    } : null };
  }

  function matchSentence(sentenceText, corpusDocs, options) {
    return matchWithCorpus(sentenceText, buildCorpus(corpusDocs), options);
  }

  var STATUS_RANK = { original: 0, similar: 1, exact: 2 };
  function pickBetter(result, candidate) {
    if (!candidate || !candidate.bestMatch || candidate.status === 'original') return result;
    if (result.status === 'quoted' || result.status === 'bibliography') return result;
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
    var totalWords = 0, scoredWords = 0, exactWords = 0, similarWords = 0, originalWords = 0,
        quotedWords = 0, biblioWords = 0, riskWords = 0;
    var typeCounts = { exact: 0, 'near-exact': 0, paraphrase: 0, 'common-phrase': 0, citation: 0, quotation: 0, bibliography: 0 };
    var verifiedSources = {};
    results.forEach(function (r) {
      totalWords += r.wordCount;
      if (r.status === 'quoted') { quotedWords += r.wordCount; typeCounts.quotation++; return; }
      if (r.status === 'bibliography') { biblioWords += r.wordCount; typeCounts.bibliography++; return; }
      scoredWords += r.wordCount;
      if (r.status === 'exact') exactWords += r.wordCount;
      else if (r.status === 'similar') similarWords += r.wordCount;
      else originalWords += r.wordCount;
      if ((r.status === 'exact' || r.status === 'similar') && r.bestMatch) {
        var t = r.bestMatch.matchType || (r.status === 'exact' ? 'exact' : 'paraphrase');
        if (typeCounts[t] !== undefined) typeCounts[t]++;
        if (r.bestMatch.cited) typeCounts.citation++;
        riskWords += r.wordCount * (typeof r.bestMatch.riskWeight === 'number' ? r.bestMatch.riskWeight : (r.status === 'exact' ? 1 : THRESHOLDS.SIMILAR_WEIGHT));
        if (r.bestMatch.verified) verifiedSources[(r.bestMatch.sourceName || '') + '|' + (r.bestMatch.sourceUrl || '')] = true;
      }
    });
    var denom = scoredWords || 1;
    var pct = function (n) { return Math.round((n / denom) * 1000) / 10; };
    var totalRisk = Math.round((riskWords / denom) * 1000) / 10;
    var band = totalRisk <= THRESHOLDS.BAND_LOW_MAX ? 'Low' : (totalRisk <= THRESHOLDS.BAND_MEDIUM_MAX ? 'Medium' : 'High');
    return Object.assign({
      totalWords: totalWords, scoredWords: scoredWords, sentenceCount: results.length,
      exactWords: exactWords, similarWords: similarWords, originalWords: originalWords,
      quotedWords: quotedWords, bibliographyWords: biblioWords,
      matchedWords: exactWords + similarWords,
      exactPct: pct(exactWords), similarPct: pct(similarWords), originalPct: pct(originalWords),
      totalRisk: totalRisk, band: band,
      typeCounts: typeCounts, verifiedSourceCount: Object.keys(verifiedSources).length,
      disclaimer: 'This is a risk estimate from MoulikCheck V4 (Library + Wikipedia + academic + whole-web checks with page verification). It is NOT a Turnitin prediction and NOT 100% accurate. A low score means no risk was found by these checks — it does not guarantee any other checker will give the same result. Turnitin\u2019s private student-paper database cannot be checked by any free tool.'
    }, meta || {});
  }

  function sourceBreakdown(results) {
    var scored = 0;
    var bySource = {};
    results.forEach(function (r) {
      if (r.status === 'quoted' || r.status === 'bibliography') return;
      scored += r.wordCount;
      if ((r.status === 'exact' || r.status === 'similar') && r.bestMatch) {
        var key = (r.bestMatch.sourceName || 'Source') + '|' + (r.bestMatch.sourceUrl || '');
        if (!bySource[key]) {
          bySource[key] = {
            key: key, name: r.bestMatch.sourceName, url: r.bestMatch.sourceUrl || null,
            type: r.bestMatch.sourceType || 'library', words: 0, sentences: 0,
            verified: !!r.bestMatch.verified, tier: r.bestMatch.tier || 'standard'
          };
        }
        bySource[key].words += r.wordCount;
        bySource[key].sentences += 1;
        if (r.bestMatch.verified) bySource[key].verified = true;
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
   *  libraryDocs: [{id?, name, text}] (Source C, offline; always treated
   *  as verified — the full file text is compared directly.)
   *  options: {stripReferences=true, excludeQuoted=true, minMatchWords=8}
   * V4: reference-entry sentences are tagged 'bibliography' (excluded);
   * sentences that are >=80% common phrases are flagged noWebSearch so
   * the web stage does not burn quota on them.
   */
  function analyzeDocument(mainText, libraryDocs, options) {
    var opts = Object.assign({ stripReferences: true, excludeQuoted: true, minMatchWords: THRESHOLDS.DEFAULT_MIN_MATCH_WORDS }, options || {});
    libraryDocs = (libraryDocs || []).map(function (d) {
      return { name: d.name, url: d.url || null, type: d.type || 'library', text: d.text, verified: true, tier: 'standard' };
    });

    var refResult = opts.stripReferences ? stripReferences(mainText) : { text: String(mainText || ''), stripped: false };
    var corpus = buildCorpus(libraryDocs);

    var results = splitSentences(refResult.text).map(function (t, i) {
      var words = tokenize(t);
      var base = { index: i, text: t, wordCount: words.length, googleSearchUrl: googleSearchUrl(t) };
      if (opts.excludeQuoted && isQuotedSentence(t)) {
        return Object.assign(base, { status: 'quoted', bestMatch: null });
      }
      if (isReferenceEntry(t)) {
        return Object.assign(base, { status: 'bibliography', bestMatch: null });
      }
      var r = Object.assign(base, matchWithCorpus(t, corpus, opts));
      if (commonPhraseRatio(words) >= 0.8) r.noWebSearch = true;
      return r;
    });

    var seenNorm = {};
    results.forEach(function (r, i) {
      var norm = normalizeText(r.text);
      if (r.status === 'original' && norm && seenNorm[norm] !== undefined) {
        r.status = 'exact';
        r.bestMatch = {
          sourceType: 'self', sourceName: 'Self (duplication in this document)', sourceUrl: null,
          sourceSentence: results[seenNorm[norm]].text, similarity: 1,
          shingleOverlap: 0, matchWords: r.wordCount, method: 'identical-repeat',
          matchType: 'exact', confidence: 'high', verified: true, tier: 'standard',
          cited: false, riskWeight: 1, reason: 'This sentence is repeated word-for-word inside the same document.'
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
    isReferenceEntry: isReferenceEntry, hasCitation: hasCitation,
    commonPhraseRatio: commonPhraseRatio, synonymOverlap: synonymOverlap,
    distinctiveQuery: distinctiveQuery,
    shinglesForWords: shinglesForWords, longestCommonRun: longestCommonRun,
    sharedWordCount: sharedWordCount, googleSearchUrl: googleSearchUrl,
    buildCorpus: buildCorpus, matchWithCorpus: matchWithCorpus, matchSentence: matchSentence,
    pickBetter: pickBetter, computeSummary: computeSummary, sourceBreakdown: sourceBreakdown,
    analyzeDocument: analyzeDocument
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MoulikEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
