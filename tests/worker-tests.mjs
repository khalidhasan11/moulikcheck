// MoulikCheck V3 — Worker unit tests (Node, no extra deps).
// The Worker is tested with a MOCKED global fetch and fake env objects.
// It has NOT run against real Serper/Tavily or real Cloudflare — see
// TEST_RESULTS_V3.md. Fake keys below are invented test strings only.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, '../worker/worker.js'), join(here, 'worker-under-test.mjs'));
const worker = (await import(join(here, 'worker-under-test.mjs'))).default;

const ORIGIN = 'https://khalidhasan11.github.io';
let upstreamCalls = [];
let upstreamHandler = null;
globalThis.fetch = async (url, init = {}) => {
  upstreamCalls.push({ url, init });
  if (!upstreamHandler) throw new Error('no upstream handler set');
  return upstreamHandler(url, init);
};

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function req({ origin = ORIGIN, ip = '1.1.1.1', body, rawBody, method = 'POST', path = '/search' } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin) headers['Origin'] = origin;
  return new Request('https://moulikcheck-search.test' + path, {
    method, headers,
    body: method === 'POST' ? (rawBody !== undefined ? rawBody : JSON.stringify(body)) : undefined,
  });
}
const serperOk = () => new Response(JSON.stringify({
  organic: [
    { title: 'Result One', link: 'https://example.com/a', snippet: 'Snippet one', source: 'example.com' },
    { title: 'Result Two', link: 'https://www.reddit.com/r/test/comments/1', snippet: 'Snippet two' },
  ],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tavilyOk = () => new Response(JSON.stringify({
  results: [{ title: 'Tavily Hit', url: 'https://blog.example.org/post', content: 'Page content here' }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

// (a) No secrets configured -> 503 not-configured, no upstream call
upstreamCalls = []; upstreamHandler = null;
{
  const res = await worker.fetch(req({ ip: '10.0.0.1', body: { q: '"some sentence to check today"' } }), {});
  const j = await res.json();
  check('(a) no secrets -> 503', res.status === 503, 'got ' + res.status);
  check('(a) error is "not-configured"', j.error === 'not-configured', JSON.stringify(j));
  check('(a) no upstream call made', upstreamCalls.length === 0);
}

// (b) Serper secret + mocked upstream -> 200 normalised; key sent upstream, absent from response
upstreamCalls = []; upstreamHandler = async () => serperOk();
{
  const res = await worker.fetch(req({ ip: '10.0.0.2', body: { q: '"photosynthesis is how plants make food"' } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  const text = await res.text();
  const j = JSON.parse(text);
  check('(b) Serper configured -> 200', res.status === 200, 'got ' + res.status);
  check('(b) provider = serper', j.provider === 'serper');
  check('(b) results normalised (2 items, title/link/snippet/source)',
    Array.isArray(j.results) && j.results.length === 2 &&
    j.results[0].title === 'Result One' && j.results[0].link === 'https://example.com/a' &&
    j.results[0].snippet === 'Snippet one' && j.results[0].source === 'example.com');
  check('(b) source falls back to hostname when upstream omits it', j.results[1].source === 'reddit.com');
  const up = upstreamCalls.find((c) => String(c.url).includes('google.serper.dev'));
  check('(b) upstream called Serper endpoint', !!up);
  check('(b) upstream request carried X-API-KEY with the fake key', up && up.init.headers['X-API-KEY'] === 'FAKE-TEST-KEY-123');
  check('(b) RESPONSE contains no key', !text.includes('FAKE-TEST-KEY-123'));
  check('(b) CORS header echoes the allowed origin', res.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}

// (c) Disallowed origin -> 403, no upstream call
upstreamCalls = []; upstreamHandler = async () => serperOk();
{
  const res = await worker.fetch(req({ ip: '10.0.0.3', origin: 'https://evil.example.com', body: { q: '"x y z"' } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  check('(c) disallowed origin -> 403', res.status === 403, 'got ' + res.status);
  check('(c) no upstream call made', upstreamCalls.length === 0);
}

// (d) Rate limit: 11 rapid requests from the same IP -> 11th is 429
upstreamCalls = []; upstreamHandler = async () => serperOk();
{
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await worker.fetch(req({ ip: '10.0.0.4', body: { q: '"rate limit probe sentence number ' + i + '"' } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
    statuses.push(r.status); await r.text();
  }
  check('(d) first 10 requests pass (200)', statuses.slice(0, 10).every((s) => s === 200), statuses.join(','));
  check('(d) 11th request -> 429', statuses[10] === 429, statuses.join(','));
}

// (e) Tavily fallback when Serper secret absent
upstreamCalls = [];
upstreamHandler = async (url) => (String(url).includes('api.tavily.com') ? tavilyOk() : serperOk());
{
  const res = await worker.fetch(req({ ip: '10.0.0.5', body: { q: '"tavily fallback probe sentence"' } }), { TAVILY_API_KEY: 'FAKE-TAVILY-999' });
  const text = await res.text(); const j = JSON.parse(text);
  check('(e) Tavily-only env -> 200', res.status === 200, 'got ' + res.status);
  check('(e) provider = tavily', j.provider === 'tavily');
  check('(e) results normalised (url->link, content->snippet)',
    j.results && j.results[0].link === 'https://blog.example.org/post' && j.results[0].snippet === 'Page content here' && j.results[0].source === 'blog.example.org');
  const up = upstreamCalls.find((c) => String(c.url).includes('api.tavily.com'));
  check('(e) upstream carried Bearer fake key', up && up.init.headers['Authorization'] === 'Bearer FAKE-TAVILY-999');
  check('(e) RESPONSE contains no key', !text.includes('FAKE-TAVILY-999'));
}

// (e2) Serper present but upstream 429 + Tavily present -> falls back to Tavily
upstreamCalls = [];
upstreamHandler = async (url) => (String(url).includes('api.tavily.com')
  ? tavilyOk()
  : new Response('quota', { status: 429 }));
{
  const res = await worker.fetch(req({ ip: '10.0.0.6', body: { q: '"serper quota probe sentence"' } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123', TAVILY_API_KEY: 'FAKE-TAVILY-999' });
  const j = await res.json();
  check('(e2) Serper 429 -> Tavily fallback 200', res.status === 200 && j.provider === 'tavily', 'got ' + res.status + ' ' + JSON.stringify(j).slice(0, 80));
}

// (f) Malformed body -> 400; invalid q -> 400; over-long q -> 400
upstreamHandler = async () => serperOk();
{
  const r1 = await worker.fetch(req({ ip: '10.0.0.7', rawBody: 'this is not json' }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  check('(f) malformed JSON body -> 400', r1.status === 400, 'got ' + r1.status); await r1.text();
  const r2 = await worker.fetch(req({ ip: '10.0.0.7', body: { q: 42 } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  check('(f) non-string q -> 400', r2.status === 400, 'got ' + r2.status); await r2.text();
  const r3 = await worker.fetch(req({ ip: '10.0.0.7', body: { q: 'x'.repeat(301) } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  check('(f) q over 300 chars -> 400', r3.status === 400, 'got ' + r3.status); await r3.text();
}

// (g) Bonus: OPTIONS preflight from allowed origin -> 204 + CORS headers; unknown route -> 404
{
  const res = await worker.fetch(new Request('https://moulikcheck-search.test/search', {
    method: 'OPTIONS', headers: { 'Origin': ORIGIN, 'Access-Control-Request-Method': 'POST' },
  }), {});
  check('(g) OPTIONS preflight (allowed origin) -> 204', res.status === 204, 'got ' + res.status);
  const r404 = await worker.fetch(req({ ip: '10.0.0.8', path: '/nope', body: { q: '"a b c"' } }), { SERPER_API_KEY: 'FAKE-TEST-KEY-123' });
  check('(g) unknown route -> 404', r404.status === 404, 'got ' + r404.status); await r404.text();
}

console.log('\nWorker tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
