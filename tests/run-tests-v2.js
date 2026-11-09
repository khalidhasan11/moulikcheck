/*
 * MoulikCheck V2 — REAL test harness (Node, no extra deps).
 * Uses the SAME engine.js + sources.js the browser app ships.
 * Run: node tests/run-tests-v2.js
 * Writes tests/results-v2.json and tests/results-v2.txt.
 * Detection misses are recorded, never hidden; harness errors exit 1.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const engine = require('../engine.js');
const sources = require('../sources.js');

const OUT = { startedAt: new Date().toISOString(), tests: {} };
const lines = [];
function log(s) { lines.push(s); console.log(s); }

async function main() {
  const v1Fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'moulikcheck', 'tests', 'fixtures.json'), 'utf8'));

  // ---------- Test W: REAL Wikipedia pipeline ----------
  log('=== Test W: Wikipedia (REAL, live API) ===');
  const article = await sources.fetchWikipediaArticle('Photosynthesis');
  const allSents = engine.splitSentences(article.extract);
  const wikiSents = [];
  for (const s of allSents) {
    const w = engine.tokenize(s).length;
    if (w >= 12 && w <= 30 && !/[\[\]{}|<>]/.test(s) && (s.match(/,/g) || []).length <= 4) wikiSents.push(s);
    if (wikiSents.length === 5) break;
  }
  if (wikiSents.length < 5) throw new Error('Could not extract 5 usable sentences from live Wikipedia article (got ' + wikiSents.length + ')');
  fs.writeFileSync(path.join(__dirname, 'wiki-fixture.json'), JSON.stringify({
    article: article.title, url: 'https://en.wikipedia.org/wiki/Photosynthesis',
    fetchedAt: new Date().toISOString(), sentences: wikiSents
  }, null, 2));
  log('Live article: "' + article.title + '" — using 5 real sentences (' + allSents.length + ' sentences in extract).');

  const originals = v1Fixtures.cleanTest.slice(0, 5);
  const docParts = [];
  const wikiIdx = [], origIdx = [];
  for (let i = 0; i < 5; i++) { wikiIdx.push(docParts.length); docParts.push(wikiSents[i]); origIdx.push(docParts.length); docParts.push(originals[i]); }
  const docText = docParts.join(' ');
  const base = engine.analyzeDocument(docText, [], { minMatchWords: 8 });
  const results = base.sentences;
  const wikiStats = await sources.runWikipediaStage(engine, results, { minMatchWords: 8, delayMs: 100 });
  const wDetail = wikiIdx.map((idx, i) => {
    const r = results[idx];
    return {
      n: i + 1, sentence: wikiSents[i].slice(0, 90) + '…', status: r.status,
      attributedSource: r.bestMatch ? r.bestMatch.sourceName : null,
      correctArticle: !!(r.bestMatch && /photosynthesis/i.test(r.bestMatch.sourceName || '')),
      similarity: r.bestMatch ? r.bestMatch.similarity : null
    };
  });
  const wFlagged = wDetail.filter(d => d.status === 'exact' || d.status === 'similar').length;
  const wCorrect = wDetail.filter(d => d.correctArticle).length;
  const oFlagged = origIdx.filter(idx => results[idx].status === 'exact' || results[idx].status === 'similar').length;
  OUT.tests.wikipedia = { stats: wikiStats, flagged: wFlagged + '/5', correctArticle: wCorrect + '/5', originalsFalselyFlagged: oFlagged + '/5', detail: wDetail };
  log('Wikipedia stage: ' + JSON.stringify(wikiStats));
  wDetail.forEach(d => log('  W' + d.n + ': ' + d.status + ' | correctArticle=' + d.correctArticle + ' | ' + (d.attributedSource || '—')));
  log('  Originals falsely flagged: ' + oFlagged + '/5');
  const summaryW = engine.computeSummary(results, {});
  log('  Doc risk after Wikipedia stage: ' + summaryW.totalRisk + '% (' + summaryW.band + ')');

  // ---------- Test A1: Crossref smoke (REAL) ----------
  log('=== Test A1: Crossref smoke (REAL) ===');
  try {
    const corpus = await sources.crossrefCorpusForSentence('Performance appraisal is a systematic process through which managers evaluate employee achievements and development needs');
    OUT.tests.crossref = { ok: true, resultsParsed: corpus.length, firstTitle: corpus[0] ? corpus[0].name : null, firstUrl: corpus[0] ? corpus[0].url : null };
    log('  Crossref responded OK, parsed ' + corpus.length + ' results. First: "' + (corpus[0] ? corpus[0].name : '—') + '" ' + (corpus[0] ? corpus[0].url : ''));
  } catch (e) {
    OUT.tests.crossref = { ok: false, error: e.message };
    log('  Crossref FAILED: ' + e.message);
  }

  // ---------- Test A2: Semantic Scholar smoke (REAL, may 429) ----------
  log('=== Test A2: Semantic Scholar smoke (REAL) ===');
  let s2Outcome = null;
  for (let attempt = 1; attempt <= 2 && !s2Outcome; attempt++) {
    try {
      const corpus = await sources.semanticScholarCorpusForSentence('Performance appraisal systems and employee motivation in organizations');
      s2Outcome = { ok: true, attempt, resultsParsed: corpus.length, firstTitle: corpus[0] ? corpus[0].name : null };
      log('  S2 responded OK on attempt ' + attempt + ', parsed ' + corpus.length + ' results.');
    } catch (e) {
      log('  S2 attempt ' + attempt + ' failed: ' + e.message);
      if (attempt === 2) s2Outcome = { ok: false, attempt, error: e.message, rateLimited: e.code === 'RATE_LIMIT' || /429/.test(e.message) };
      else await sources.sleep(6000);
    }
  }
  OUT.tests.semanticScholar = s2Outcome;

  // ---------- Test L: Library slide regression (V1 fixture) ----------
  log('=== Test L: Library slide regression (V1 fixture) ===');
  const hrm = v1Fixtures.libraryDocs.find(d => d.name.indexOf('HRM') === 0);
  const slideDoc = hrm.sentences.slice(0, 5).concat([v1Fixtures.copyTestOriginals[0], v1Fixtures.copyTestOriginals[1]]).join(' ');
  const libDocs = v1Fixtures.libraryDocs.map(d => ({ name: d.name, text: d.sentences.join(' ') }));
  const slideRes = engine.analyzeDocument(slideDoc, libDocs, { minMatchWords: 8 });
  let slideFlagged = 0, slideCorrect = 0;
  for (let i = 0; i < 5; i++) {
    const r = slideRes.sentences[i];
    if (r.status === 'exact' || r.status === 'similar') { slideFlagged++; if (r.bestMatch && r.bestMatch.sourceName === hrm.name) slideCorrect++; }
  }
  const slideFP = [5, 6].filter(i => slideRes.sentences[i].status === 'exact' || slideRes.sentences[i].status === 'similar').length;
  OUT.tests.slideRegression = { flagged: slideFlagged + '/5', correctSource: slideCorrect + '/5', distractorFalsePositives: slideFP + '/2', risk: slideRes.summary.totalRisk };
  log('  Slide: flagged ' + slideFlagged + '/5, correct source ' + slideCorrect + '/5, distractor FPs ' + slideFP + '/2, risk ' + slideRes.summary.totalRisk + '%');

  // ---------- Test C: Clean (offline pipeline) ----------
  log('=== Test C: Clean originals vs V1 Library (offline) ===');
  const cleanRes = engine.analyzeDocument(v1Fixtures.cleanTest.join(' '), libDocs, { minMatchWords: 8 });
  const cleanFP = cleanRes.sentences.filter(r => r.status === 'exact' || r.status === 'similar').length;
  OUT.tests.clean = { risk: cleanRes.summary.totalRisk, band: cleanRes.summary.band, falsePositives: cleanFP + '/10' };
  log('  Clean: risk ' + cleanRes.summary.totalRisk + '% (' + cleanRes.summary.band + '), false positives ' + cleanFP + '/10');

  // ---------- Test S: Exclude-small-matches ----------
  log('=== Test S: Exclude small matches (minMatchWords) ===');
  const libDoc = [{ name: 'FoxDoc', text: 'The quick brown fox jumps over the lazy dog near the river bank today.' }];
  const q = "The quick brown fox jumps over my neighbour's fence every single morning before breakfast.";
  const withDefault = engine.matchSentence(q, libDoc, { minMatchWords: 8 });
  const withFive = engine.matchSentence(q, libDoc, { minMatchWords: 5 });
  OUT.tests.smallMatch = {
    sharedRunWords: engine.longestCommonRun(engine.tokenize(q), engine.tokenize(libDoc[0].text)),
    min8: withDefault.status, min5: withFive.status, min5matchWords: withFive.bestMatch ? withFive.bestMatch.matchWords : null
  };
  log('  Shared run = ' + OUT.tests.smallMatch.sharedRunWords + ' words; minMatchWords=8 -> ' + withDefault.status + ' (expected original); minMatchWords=5 -> ' + withFive.status);

  // ---------- Test D: Source D unit-level (NO key) ----------
  log('=== Test D: Source D unit-level (no key available) ===');
  const sr = sources.buildSerperRequest('Test sentence here', 'TEST_KEY');
  const tv = sources.buildTavilyRequest('Test sentence here', 'TEST_KEY');
  const noKeySerper = await sources.serperCorpusForSentence('Any sentence', '');
  const noKeyTavily = await sources.tavilyCorpusForSentence('Any sentence', '');
  const dummy = engine.analyzeDocument('This is a wholly original sentence about my balcony garden watering routine and morning habits.', [], {});
  const webStage = await sources.runWebStage(engine, dummy.sentences, { serperKey: '', tavilyKey: '' });
  OUT.tests.sourceD = {
    serperShape: { url: sr.url, method: sr.method, hasKeyHeader: !!sr.headers['X-API-KEY'], bodyHasQuotedQuery: JSON.parse(sr.body).q === '"Test sentence here"' },
    tavilyShape: { url: tv.url, method: tv.method, authHeader: tv.headers.Authorization === 'Bearer TEST_KEY', bodyQuery: JSON.parse(tv.body).query === 'Test sentence here' },
    noKeySerperStatus: noKeySerper.status, noKeyTavilyStatus: noKeyTavily.status,
    webStageNoKey: { status: webStage.status, queries: webStage.queries },
    classify: {
      reddit: sources.classifyUrl('https://www.reddit.com/r/AskAcademia/comments/xyz'),
      facebook: sources.classifyUrl('https://www.facebook.com/somepage/posts/123'),
      bbc: sources.classifyUrl('https://www.bbc.com/news/articles/abc'),
      wikipedia: sources.classifyUrl('https://en.wikipedia.org/wiki/Photosynthesis'),
      doi: sources.classifyUrl('https://doi.org/10.1000/xyz123')
    },
    liveKeyTest: 'UNTESTED — no Serper/Tavily key was available in this environment'
  };
  log('  Serper req: ' + sr.url + ' ' + sr.method + ' keyHeader=' + !!sr.headers['X-API-KEY']);
  log('  Tavily req: ' + tv.url + ' ' + tv.method + ' bearer=' + (tv.headers.Authorization === 'Bearer TEST_KEY'));
  log('  No-key states: serper=' + noKeySerper.status + ', tavily=' + noKeyTavily.status + ', webStage=' + webStage.status + ' (queries=' + webStage.queries + ')');
  log('  classifyUrl: ' + JSON.stringify(OUT.tests.sourceD.classify));
  log('  Live Source D with a real key: UNTESTED (no key available)');

  OUT.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, 'results-v2.json'), JSON.stringify(OUT, null, 2));
  fs.writeFileSync(path.join(__dirname, 'results-v2.txt'), lines.join('\n') + '\n');
  log('Saved results-v2.json / results-v2.txt');
}

main().catch(e => {
  console.error('HARNESS ERROR:', e);
  OUT.harnessError = e.message;
  try {
    fs.writeFileSync(path.join(__dirname, 'results-v2.json'), JSON.stringify(OUT, null, 2));
    fs.writeFileSync(path.join(__dirname, 'results-v2.txt'), lines.join('\n') + '\nHARNESS ERROR: ' + e.message + '\n');
  } catch (_) {}
  process.exit(1);
});
