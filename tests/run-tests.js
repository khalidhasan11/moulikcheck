/*
 * MoulikCheck V1 — honesty tests (plan Section 8), Node only, no deps.
 * Uses the SAME engine.js that ships in the browser app.
 * Run: node tests/run-tests.js
 * Writes: tests/results.json and tests/results.txt with full detail,
 * including misses and false positives — nothing is filtered out.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const engine = require('../engine.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

const libDocs = fx.libraryDocs.map(d => ({ name: d.name, text: d.sentences.join(' ') }));
const webLib = [libDocs[0]];
const slideLib = [libDocs[1]];

const lines = [];
function log(s) { lines.push(s || ''); }

function evaluate(docSentencesWithLabels, library, labelOfInterest) {
  const docText = docSentencesWithLabels.map(s => s.text).join(' ');
  const result = engine.analyzeDocument(docText, library, {});
  const perSentence = result.sentences.map((r, i) => ({
    index: i,
    label: docSentencesWithLabels[i] ? docSentencesWithLabels[i].label : 'unknown',
    expectedText: docSentencesWithLabels[i] ? docSentencesWithLabels[i].text : '',
    status: r.status,
    similarity: r.bestMatch ? r.bestMatch.similarity : null,
    sourceName: r.bestMatch ? r.bestMatch.sourceName : null,
    method: r.bestMatch ? r.bestMatch.method : null,
    flagged: r.status === 'exact' || r.status === 'similar'
  }));
  return { result, perSentence };
}

const out = { generatedAt: new Date().toISOString(), thresholds: engine.THRESHOLDS, tests: {} };

// ---------- Test 1: Copy test ----------
(function () {
  log('=== TEST 1: COPY TEST (10 copied from Library + 10 original, interleaved) ===');
  const items = [];
  const source = fx.libraryDocs[0].sentences;
  for (let i = 0; i < 10; i++) {
    items.push({ text: source[i], label: 'copied' });
    items.push({ text: fx.copyTestOriginals[i], label: 'original' });
  }
  const { result, perSentence } = evaluate(items, webLib);
  const copied = perSentence.filter(s => s.label === 'copied');
  const originals = perSentence.filter(s => s.label === 'original');
  const copiedFlagged = copied.filter(s => s.flagged).length;
  const copiedExact = copied.filter(s => s.status === 'exact').length;
  const falsePos = originals.filter(s => s.flagged);
  out.tests.copyTest = {
    copiedTotal: copied.length, copiedFlagged, copiedExact,
    originalTotal: originals.length, falsePositives: falsePos.length,
    falsePositiveDetails: falsePos, summary: result.summary, perSentence
  };
  log(`Copied sentences flagged: ${copiedFlagged}/${copied.length} (exact: ${copiedExact})`);
  log(`Original sentences falsely flagged: ${falsePos.length}/${originals.length}`);
  falsePos.forEach(s => log(`  FALSE POSITIVE #${s.index}: [${s.status}] ${s.expectedText}`));
  copied.filter(s => !s.flagged).forEach(s => log(`  MISSED COPY #${s.index}: ${s.expectedText}`));
  log(`Summary: risk ${result.summary.totalRisk}% band ${result.summary.band}`);
  log('');
})();

// ---------- Test 2: Slide test ----------
(function () {
  log('=== TEST 2: SLIDE TEST (5 sentences copied from fake slide file in Library + 2 original distractors) ===');
  const slideSents = fx.libraryDocs[1].sentences.slice(0, 5);
  const items = slideSents.map(t => ({ text: t, label: 'slide-copy' }));
  items.push({ text: fx.cleanTest[0], label: 'original' });
  items.push({ text: fx.cleanTest[1], label: 'original' });
  const { result, perSentence } = evaluate(items, slideLib);
  const slideItems = perSentence.filter(s => s.label === 'slide-copy');
  const flagged = slideItems.filter(s => s.flagged);
  const withCorrectSource = flagged.filter(s => s.sourceName === 'HRM301_Chapter5_Slides.txt');
  out.tests.slideTest = {
    slideTotal: slideItems.length, flagged: flagged.length,
    withCorrectSource: withCorrectSource.length,
    distractorsFalselyFlagged: perSentence.filter(s => s.label === 'original' && s.flagged).length,
    summary: result.summary, perSentence
  };
  log(`Slide sentences flagged: ${flagged.length}/${slideItems.length}; with correct source name: ${withCorrectSource.length}`);
  slideItems.filter(s => !s.flagged).forEach(s => log(`  MISSED SLIDE COPY #${s.index}: ${s.expectedText}`));
  log(`Distractor originals falsely flagged: ${out.tests.slideTest.distractorsFalselyFlagged}/2`);
  log('');
})();

// ---------- Test 3: Paraphrase test ----------
(function () {
  log('=== TEST 3: PARAPHRASE TEST (5 lightly-to-heavily paraphrased sentences vs source in Library) ===');
  log('Honest expectation: light ones should flag yellow, the hard one may be missed. Whatever happens is recorded.');
  const items = fx.paraphraseTest.map(p => ({ text: p.text, label: 'paraphrase' }));
  const { result, perSentence } = evaluate(items, webLib);
  let yellow = 0, red = 0, missed = 0;
  perSentence.forEach((s, i) => {
    const p = fx.paraphraseTest[i];
    if (s.status === 'similar') yellow++;
    else if (s.status === 'exact') red++;
    else missed++;
    log(`  [${p.difficulty}] status=${s.status} similarity=${s.similarity} :: ${p.text}`);
  });
  out.tests.paraphraseTest = { total: items.length, flaggedSimilar: yellow, flaggedExact: red, missed, summary: result.summary, perSentence };
  log(`Result: similar(yellow)=${yellow}, exact(red)=${red}, missed=${missed} out of ${items.length}`);
  log('');
})();

// ---------- Test 4: Clean test ----------
(function () {
  log('=== TEST 4: CLEAN TEST (10 fully original sentences vs full Library) ===');
  const items = fx.cleanTest.map(t => ({ text: t, label: 'original' }));
  const { result, perSentence } = evaluate(items, libDocs);
  const fps = perSentence.filter(s => s.flagged);
  out.tests.cleanTest = {
    total: items.length, falsePositives: fps.length, falsePositiveDetails: fps,
    summary: result.summary, perSentence
  };
  log(`Risk: ${result.summary.totalRisk}% (band ${result.summary.band}) — target: Low band`);
  log(`False positives: ${fps.length}/${items.length}`);
  fps.forEach(s => log(`  FALSE POSITIVE #${s.index}: [${s.status} sim=${s.similarity}] ${s.expectedText}  -> matched: ${'(see results.json)'}`));
  log('');
})();

log('NOTE: These are synthetic fixtures built for V1 verification, not real Wikipedia text or a real HRM slide deck (per task constraints). They test the engine mechanics honestly; real-world rates will vary and the plan\'s accuracy table remains an estimate, not a guarantee.');

fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(__dirname, 'results.txt'), lines.join('\n'));
console.log(lines.join('\n'));
console.log('\nWrote tests/results.json and tests/results.txt');
