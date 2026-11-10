// MoulikCheck V3 — site static checks (Node, no extra deps).
// Verifies Khalid's §7B rule in the actual site files: no key-entry UI,
// no API-key handling/storage code, no direct provider calls — and the
// Worker proxy wiring is present.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const site = join(dirname(fileURLToPath(import.meta.url)), '../site');
const files = ['index.html', 'app.js', 'engine.js', 'sources.js', 'style.css'];
const content = {};
for (const f of files) content[f] = readFileSync(join(site, f), 'utf8');
const all = files.map((f) => content[f]).join('\n');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

// --- Absence assertions (the V3 rule) ---
for (const token of ['key-serper', 'key-tavily', 'settings-card', 'settings-save']) {
  check('absent token "' + token + '" in all site files', !all.includes(token));
}
for (const token of ['serperKey', 'tavilyKey', 'X-API-KEY', 'google.serper.dev', 'api.tavily.com']) {
  check('absent code token "' + token + '" in JS', !(content['app.js'] + content['sources.js'] + content['engine.js']).includes(token));
}
// Scoped to JS code (HTML prose legitimately says "no API key on this
// site ... (localStorage)" in the footer — that is a statement, not code).
const jsAll = content['app.js'] + '\n' + content['sources.js'] + '\n' + content['engine.js'];
check('no localStorage line in JS mentions a key/serper/tavily',
  !jsAll.split('\n').some((l) => l.includes('localStorage') && /serper|tavily/i.test(l) || (l.includes('localStorage') && /LS_KEY|API_KEY/.test(l))));
check('index.html has no password input', !/<input[^>]*type="password"/.test(content['index.html']));
check('index.html asks for no API key (no "API key" input label)',
  !/for="key-|API key \(/i.test(content['index.html']));

// --- Presence assertions (proxy wiring + kept V2 features) ---
check('sources.js defines WORKER_URL placeholder',
  content['sources.js'].includes("var WORKER_URL = 'https://moulikcheck-search.YOUR-SUBDOMAIN.workers.dev';"));
check('sources.js POSTs to WORKER_URL + \'/search\'',
  content['sources.js'].includes("WORKER_URL + '/search'"));
check('sources.js maps proxy 503 to NOT_CONFIGURED',
  content['sources.js'].includes("e503.code = 'NOT_CONFIGURED'"));
check('whole-web stage reports "not enabled (secure proxy not configured yet)"',
  content['sources.js'].includes('Not enabled (secure proxy not configured yet)'));
check('index.html keeps the Library (own sources) card', content['index.html'].includes('id="library-card"'));
check('index.html keeps the check dashboard card', content['index.html'].includes('id="check-card"'));
check('app.js still runs the web stage via sources.runWebStage', content['app.js'].includes('S.runWebStage'));
check('app.js no longer reads any key inputs ($(\'key-...\') absent)',
  !content['app.js'].includes("$('key-"));
check('privacy notice mentions the secure proxy',
  content['index.html'].includes('secure proxy'));

console.log('\nSite checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
