/*
 * MoulikCheck engine.js — V1 (Layers 1 + 3 only, NO semantic Layer 2)
 * Pure logic, no DOM, no network. Works in browser (window.MoulikEngine)
 * and in Node (module.exports) so the same code is tested and shipped.
 *
 * THRESHOLDS (documented, change here only):
 *  - SHINGLE_SIZE = 8 consecutive words => an overlap is an EXACT (red) match.
 *    8 words is a common fingerprint length: short common phrases rarely
 *    reach 8 identical consecutive words, real copy-paste usually does.
 *  - SIMILAR_THRESHOLD = 0.50 TF-IDF cosine (sentence vs best Library
 *    sentence) => SIMILAR (yellow). Below that: ORIGINAL (green).
 *    0.50 is deliberately mid-range: light paraphrases keeping ~half+
 *    of their weighted words land above it; unrelated writing on a
 *    different topic usually lands well below it. It is a risk flag,
 *    not proof — heavily paraphrased text WILL fall below it and be missed.
 *  - SELF_DUP_COSINE = 0.95 => a repeated sentence inside the same
 *    document is flagged EXACT with source "Self (duplication)".
 *  - Risk score: Total Risk % = (exactWords + 0.6 * similarWords)
 *    / scoredWords * 100. Bands: 0-10 Low, 11-25 Medium, 26+ High.
 *    These bands are guidance only — NOT a Turnitin prediction.
 */
(function (global) {
  'use strict';

  var THRESHOLDS = {
    SHINGLE_SIZE: 8,
    SIMILAR_THRESHOLD: 0.50,
    SELF_DUP_COSINE: 0.95,
    SIMILAR_WEIGHT: 0.6,
    BAND_LOW_MAX: 10,
    BAND_MEDIUM_MAX: 25
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

  function normalizeText(text) {
    return tokenize(text).join(' ');
  }

  // Sentence splitter: handles ., !, ? and line breaks. Abbreviations like
  // "Dr." may split early — a known, documented V1 limitation.
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
      if (m) {
        // Only strip if the heading is in the last 60% of the document,
        // to avoid cutting a document that mentions "References" early.
        if (m.index > src.length * 0.35) {
          return { text: src.slice(0, m.index).trim(), stripped: true };
        }
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

  function isQuotedSentence(sentence) {
    // "Properly quoted" in V1 = at least 60% of the sentence sits inside
    // double quotes. Single-quote-only text is not treated as a quote.
    return quotedFraction(sentence) >= 0.6;
  }

  function shinglesForWords(words, size) {
    var n = size || THRESHOLDS.SHINGLE_SIZE;
    var out = [];
    if (words.length < n) return out;
    for (var i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
    return out;
  }

  function buildTfidf(sentWordArrays) {
    // IDF over the given corpus (Library sentences). Terms absent from the
    // corpus get a max-ish IDF when vectorising query sentences.
    var N = sentWordArrays.length;
    var df = {};
    sentWordArrays.forEach(function (words) {
      var seen = {};
      words.forEach(function (w) { seen[w] = true; });
      Object.keys(seen).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
    });
    var idf = {};
    Object.keys(df).forEach(function (w) {
      idf[w] = Math.log(1 + N / (1 + df[w])) + 1;
    });
    var defaultIdf = Math.log(1 + Math.max(N, 1)) + 1;
    return { idf: idf, defaultIdf: defaultIdf, corpusSize: N };
  }

  function tfidfVector(words, tfidf) {
    var tf = {};
    words.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
    var vec = {};
    var normSq = 0;
    Object.keys(tf).forEach(function (w) {
      var v = (tf[w] / words.length) * (tfidf.idf[w] || tfidf.defaultIdf);
      vec[w] = v;
      normSq += v * v;
    });
    return { vec: vec, norm: Math.sqrt(normSq) || 1 };
  }

  function cosine(a, b) {
    var dot = 0;
    var small = Object.keys(a.vec).length < Object.keys(b.vec).length ? a : b;
    var other = small === a ? b : a;
    Object.keys(small.vec).forEach(function (w) {
      if (other.vec[w]) dot += small.vec[w] * other.vec[w];
    });
    return dot / (a.norm * b.norm);
  }

  function googleSearchUrl(sentence) {
    return 'https://www.google.com/search?q=' + encodeURIComponent('"' + String(sentence).trim() + '"');
  }

  /*
   * analyzeDocument(mainText, libraryDocs, options)
   *  libraryDocs: [{id?, name, text}]
   *  options: {stripReferences=true, excludeQuoted=true}
   */
  function analyzeDocument(mainText, libraryDocs, options) {
    var opts = Object.assign({ stripReferences: true, excludeQuoted: true }, options || {});
    libraryDocs = libraryDocs || [];

    var refResult = opts.stripReferences
      ? stripReferences(mainText)
      : { text: String(mainText || ''), stripped: false };

    var mainSentTexts = splitSentences(refResult.text);
    var mainSents = mainSentTexts.map(function (t) {
      var words = tokenize(t);
      return { text: t, words: words, wordCount: words.length, quoted: isQuotedSentence(t) };
    });

    // Library preparation
    var libSents = []; // {docName, text, words, shingleSet}
    libraryDocs.forEach(function (doc) {
      splitSentences(doc.text).forEach(function (t) {
        var words = tokenize(t);
        libSents.push({ docName: doc.name || 'Library document', text: t, words: words });
      });
    });

    var tfidf = buildTfidf(libSents.map(function (s) { return s.words; }));
    libSents.forEach(function (s) { s.vector = tfidfVector(s.words, tfidf); });

    // Shingle index: shingle -> array of library sentence indexes
    var shingleIndex = {};
    libSents.forEach(function (s, idx) {
      shinglesForWords(s.words).forEach(function (sh) {
        (shingleIndex[sh] = shingleIndex[sh] || []).push(idx);
      });
    });

    var mainVectors = mainSents.map(function (s) { return tfidfVector(s.words, tfidf); });

    var results = mainSents.map(function (s, i) {
      var base = {
        index: i,
        text: s.text,
        wordCount: s.wordCount,
        googleSearchUrl: googleSearchUrl(s.text)
      };

      if (opts.excludeQuoted && s.quoted) {
        return Object.assign(base, { status: 'quoted', bestMatch: null });
      }

      // --- Exact: 8-word shingle overlap with Library ---
      var myShingles = shinglesForWords(s.words);
      var hitCounts = {}; // lib sentence idx -> matched shingle count
      myShingles.forEach(function (sh) {
        (shingleIndex[sh] || []).forEach(function (idx) { hitCounts[idx] = (hitCounts[idx] || 0) + 1; });
      });
      var bestShingleIdx = -1, bestShingleCount = 0;
      Object.keys(hitCounts).forEach(function (k) {
        if (hitCounts[k] > bestShingleCount) { bestShingleCount = hitCounts[k]; bestShingleIdx = Number(k); }
      });

      // --- Best TF-IDF cosine vs Library ---
      var bestCos = 0, bestCosIdx = -1;
      if (libSents.length && s.words.length) {
        for (var j = 0; j < libSents.length; j++) {
          var c = cosine(mainVectors[i], libSents[j].vector);
          if (c > bestCos) { bestCos = c; bestCosIdx = j; }
        }
      }

      // --- Self-duplication (earlier sentence in the same document) ---
      var selfMatch = null;
      var myNorm = s.words.join(' ');
      for (var k = 0; k < i; k++) {
        var prev = mainSents[k];
        if (prev.words.join(' ') === myNorm && myNorm.length > 0) {
          selfMatch = { sentenceIndex: k, similarity: 1, method: 'identical-repeat' };
          break;
        }
        if (prev.words.length >= THRESHOLDS.SHINGLE_SIZE && s.words.length >= THRESHOLDS.SHINGLE_SIZE) {
          var shared = shinglesForWords(s.words).filter(function (sh) {
            return shinglesForWords(prev.words).indexOf(sh) !== -1;
          }).length;
          if (shared > 0) { selfMatch = { sentenceIndex: k, similarity: 0.99, method: 'shingle-repeat', shingleOverlap: shared }; break; }
        }
      }

      if (bestShingleCount > 0) {
        var ls = libSents[bestShingleIdx];
        return Object.assign(base, {
          status: 'exact',
          bestMatch: {
            sourceType: 'library', sourceName: ls.docName, sourceSentence: ls.text,
            similarity: Math.round(bestCos * 100) / 100,
            shingleOverlap: bestShingleCount, method: '8-word-shingle'
          }
        });
      }
      if (selfMatch) {
        return Object.assign(base, {
          status: 'exact',
          bestMatch: {
            sourceType: 'self', sourceName: 'Self (duplication in this document)',
            sourceSentence: mainSents[selfMatch.sentenceIndex].text,
            similarity: selfMatch.similarity,
            shingleOverlap: selfMatch.shingleOverlap || 0, method: selfMatch.method
          }
        });
      }
      if (bestCosIdx >= 0 && bestCos >= THRESHOLDS.SIMILAR_THRESHOLD) {
        var bs = libSents[bestCosIdx];
        return Object.assign(base, {
          status: 'similar',
          bestMatch: {
            sourceType: 'library', sourceName: bs.docName, sourceSentence: bs.text,
            similarity: Math.round(bestCos * 100) / 100,
            shingleOverlap: 0, method: 'tfidf-cosine'
          }
        });
      }
      return Object.assign(base, {
        status: 'original',
        bestMatch: bestCosIdx >= 0 ? {
          sourceType: 'library', sourceName: libSents[bestCosIdx].docName,
          sourceSentence: libSents[bestCosIdx].text,
          similarity: Math.round(bestCos * 100) / 100,
          shingleOverlap: 0, method: 'tfidf-cosine-below-threshold'
        } : null
      });
    });

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

    return {
      sentences: results,
      summary: {
        totalWords: totalWords, scoredWords: scoredWords,
        sentenceCount: results.length,
        exactWords: exactWords, similarWords: similarWords,
        originalWords: originalWords, quotedWords: quotedWords,
        exactPct: pct(exactWords), similarPct: pct(similarWords), originalPct: pct(originalWords),
        totalRisk: totalRisk, band: band,
        referencesStripped: refResult.stripped,
        librarySentenceCount: libSents.length,
        libraryDocCount: libraryDocs.length,
        disclaimer: 'This is a risk estimate from MoulikCheck V1 (exact + similarity checks against your Library, plus one-click web verification). It is NOT a Turnitin prediction and NOT 100% accurate. A low score means no risk was found by these checks — it does not guarantee any other checker will give the same result.'
      }
    };
  }

  var api = {
    THRESHOLDS: THRESHOLDS,
    tokenize: tokenize,
    normalizeText: normalizeText,
    splitSentences: splitSentences,
    stripReferences: stripReferences,
    isQuotedSentence: isQuotedSentence,
    quotedFraction: quotedFraction,
    shinglesForWords: shinglesForWords,
    googleSearchUrl: googleSearchUrl,
    analyzeDocument: analyzeDocument
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MoulikEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
