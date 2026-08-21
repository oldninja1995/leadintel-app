/* Phase 10 — hardening, observability, backup and restore.
 *
 *   node --test        or        npm test
 *
 * The exit criteria are p95 within budget under load and a cold restore that
 * succeeds. The load test lives outside the suite (it needs a running server),
 * but the machinery both criteria rest on is tested here — percentiles that do
 * not lie about the tail, and a restore that verifies rather than assumes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hardening = require('../lib/http/hardening');
const { Timings, routeOf } = require('../lib/http/observability');

/* ── headers ────────────────────────────────────────────────────────────── */

test('the policy allows inline styles and refuses inline scripts', () => {
  /* The converted markup is wall-to-wall inline `style=`, so style-src must
     permit it. Nothing inlines script, so script-src does not — and saying so
     matters, because "unsafe-inline" usually means nobody looked. */
  const csp = hardening.contentSecurityPolicy();
  assert.match(csp, /style-src [^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /script-src 'self'/);
});

/* This used to read "the policy allows the font hosts the design actually
   uses", and listed fonts.googleapis.com, fonts.gstatic.com and unpkg.com. The
   design uses none of them any more — Inter and Phosphor Icons are files under
   /assets — so the assertion is now the opposite one, and it is the stronger
   of the two: the policy names no third party at all. */
test('the policy names no third-party host for styles or fonts', () => {
  const csp = hardening.contentSecurityPolicy();
  const directive = (name) => (csp.split('; ').find((d) => d.startsWith(`${name} `)) || '');
  for (const name of ['style-src', 'font-src']) {
    assert.ok(!directive(name).includes('://'), `${name} still trusts a CDN: ${directive(name)}`);
  }
});

/* The guard that would have caught the regression this replaces: a policy can
   be tightened and a template left pointing at the CDN, and the only symptom is
   an unstyled screen for whoever loads it next. Both templates are checked,
   because the sign-in page has its own <head> and drifted from the layout once
   already. */
test('no template loads a stylesheet or font from another origin', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  for (const view of ['views/layout.ejs', 'views/app/login.ejs']) {
    const markup = fs.readFileSync(path.join(__dirname, '..', view), 'utf8');
    const external = markup.match(/<link[^>]+href="https?:[^"]+"/g) || [];
    assert.deepEqual(external, [], `${view} loads ${external.join(', ')} from another origin`);
  }
  /* And nothing may sneak one back in through an @import, which is worse: the
     browser cannot discover it until the importing file has parsed. */
  for (const sheet of ['nocturne.css', 'app.css', 'app-ui.css', 'hover.css', 'inter.css', 'phosphor.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public/assets', sheet), 'utf8');
    assert.doesNotMatch(css, /@import[^;]*https?:/, `${sheet} imports from another origin`);
  }
});

test('framing and sniffing are refused outright', () => {
  const set = hardening.headers();
  assert.equal(set['X-Frame-Options'], 'DENY');
  assert.equal(set['X-Content-Type-Options'], 'nosniff');
  assert.match(set['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('HSTS is set only where there is TLS to be strict about', () => {
  /* Teaching a browser to refuse plain HTTP on an origin that only serves
     plain HTTP is how a local install becomes unreachable. */
  assert.equal(hardening.headers({ secure: false })['Strict-Transport-Security'], undefined);
  assert.match(hardening.headers({ secure: true })['Strict-Transport-Security'], /max-age=31536000/);
});

test('the middleware sets every header it declares', () => {
  const set = {};
  const res = { setHeader: (k, v) => { set[k] = v; } };
  let continued = false;
  hardening.secureHeaders()({}, res, () => { continued = true; });

  assert.equal(continued, true);
  assert.deepEqual(Object.keys(set).sort(), Object.keys(hardening.headers()).sort());
});

/* ── rate limiting ──────────────────────────────────────────────────────── */

test('a burst past the limit is refused, and told how long to wait', () => {
  let now = 0;
  const limiter = new hardening.RateLimiter({ limit: 3, windowMs: 1000, now: () => now });

  for (let i = 0; i < 3; i += 1) assert.equal(limiter.check('a').allowed, true, `attempt ${i + 1} was refused`);

  const refused = limiter.check('a');
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 1000);
});

test('the window reopens', () => {
  let now = 0;
  const limiter = new hardening.RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  limiter.check('a');
  assert.equal(limiter.check('a').allowed, false);

  now = 1001;
  assert.equal(limiter.check('a').allowed, true);
});

test('one caller cannot exhaust another\'s allowance', () => {
  let now = 0;
  const limiter = new hardening.RateLimiter({ limit: 1, windowMs: 1000, now: () => now });
  limiter.check('a');
  assert.equal(limiter.check('b').allowed, true, 'the limit was global rather than per caller');
});

test('a refused request gets 429 and Retry-After', () => {
  let now = 0;
  const limiter = new hardening.RateLimiter({ limit: 1, windowMs: 5000, now: () => now });
  const middleware = hardening.limit(limiter, { key: () => 'k' });

  const headers = {};
  const res = {
    statusCode: 200, payload: null,
    setHeader: (k, v) => { headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; },
  };

  middleware({}, res, () => {});
  middleware({}, res, () => { throw new Error('a refused request continued'); });

  assert.equal(res.statusCode, 429);
  assert.equal(headers['Retry-After'], '5');
  assert.match(res.payload.error, /too many/);
});

test('expired windows are swept', () => {
  let now = 0;
  const limiter = new hardening.RateLimiter({ limit: 1, windowMs: 100, now: () => now });
  limiter.check('a');
  limiter.check('b');
  assert.equal(limiter.size, 2);

  now = 200;
  assert.equal(limiter.sweep(), 2);
  assert.equal(limiter.size, 0);
});

/* ── percentiles ────────────────────────────────────────────────────────── */

test('a percentile always returns a value that actually happened', () => {
  /* Nearest-rank, not interpolated — an interpolated p95 is a number no
     request ever took. */
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(Timings.percentile(samples, 50), 5);
  assert.equal(Timings.percentile(samples, 95), 10);
  assert.equal(Timings.percentile(samples, 100), 10);
  assert.equal(Timings.percentile([], 95), null);
});

test('a mean would hide the tail a budget is about', () => {
  const timings = new Timings();
  for (let i = 0; i < 94; i += 1) timings.record('/x', 5, 200);
  for (let i = 0; i < 6; i += 1) timings.record('/x', 3000, 200);

  const [route] = timings.report({ budgetMs: 200 }).routes;
  /* Mean is ~185 ms and would scrape under a 200 ms budget. p95 does not. */
  assert.equal(route.p50, 5);
  assert.ok(route.p95 > 200, 'six slow requests in a hundred vanished into the percentile');
  assert.equal(route.withinBudget, false);
});

test('a single outlier is caught by max, not by p99', () => {
  /* Worth stating plainly: nearest-rank p99 over 100 samples is the 99th
     value, so exactly one slow request sits outside it. That is percentiles
     working, not failing — and it is why `max` is reported beside them. */
  const timings = new Timings();
  for (let i = 0; i < 99; i += 1) timings.record('/x', 5, 200);
  timings.record('/x', 3000, 200);

  const [route] = timings.report({ budgetMs: 200 }).routes;
  assert.equal(route.p99, 5);
  assert.equal(route.max, 3000, 'the outlier was invisible in every reported figure');
});

test('the report says how many samples the percentile is over', () => {
  const timings = new Timings({ cap: 10 });
  for (let i = 0; i < 25; i += 1) timings.record('/x', i, 200);

  const [route] = timings.report().routes;
  assert.equal(route.count, 25);
  assert.equal(route.sampled, 10, 'the cap was not applied');
  assert.equal(route.dropped, 15, 'dropped samples were not reported');
});

test('the budget verdict is the worst route, not an average of routes', () => {
  const timings = new Timings();
  for (let i = 0; i < 20; i += 1) timings.record('/fast', 5, 200);
  for (let i = 0; i < 20; i += 1) timings.record('/slow', 900, 200);

  const report = timings.report({ budgetMs: 200 });
  assert.equal(report.worstRoute, '/slow');
  assert.equal(report.withinBudget, false, 'a fast route averaged away a slow one');
});

test('errors are counted separately from timings', () => {
  const timings = new Timings();
  timings.record('/x', 5, 200);
  timings.record('/x', 5, 500);
  assert.equal(timings.report().routes[0].errors, 1);
});

test('no requests is not "within budget"', () => {
  assert.equal(new Timings().report().withinBudget, null);
});

test('ids in a path do not fragment the samples', () => {
  /* Every generated id here is a long segment containing a digit. Matching on
     hex caught none of them, because the timestamps carry T and Z. */
  assert.equal(routeOf({ path: '/reports/dispatches/2026-08-06T12-14-21-152Z-e0cec708' }), '/reports/dispatches/:id');
  assert.equal(routeOf({ path: '/metrics/snapshots/2026-05-06T09-00-00-000Z-abcdef12/reproduce' }), '/metrics/snapshots/:id/reproduce');
  assert.equal(routeOf({ path: '/rules/fires/2026-08-06T12-00-00-000Z-roas-below-target' }), '/rules/fires/:id');
});

test('real route names are not mistaken for ids', () => {
  for (const route of ['/campaigns', '/attribution', '/metrics/coverage', '/reports/dispatches', '/workspace/attribution', '/ingest/status']) {
    assert.equal(routeOf({ path: route }), route, `${route} was collapsed as if it were an id`);
  }
});

/* ── backup and restore ─────────────────────────────────────────────────── */

const backup = require('../tools/backup');

test('walk finds every file under a tree, not only the top level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadintel-walk-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.txt'), 'y');

  const found = backup.walk(dir).map((p) => p.replace(/\\/g, '/')).sort();
  assert.deepEqual(found, ['a/b/deep.txt', 'top.txt']);
});

test('the drill is exported so a restore can be proven, not assumed', () => {
  /* The criterion is "a cold restore succeeds", which a backup alone does not
     demonstrate. Run it with: node tools/backup.js drill */
  assert.equal(typeof backup.drill, 'function');
  assert.equal(typeof backup.create, 'function');
  assert.equal(typeof backup.restore, 'function');
});

/* The one route that must be framable, and only by us.
 *
 * Every response carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`,
 * which is right for every screen and wrong for the endpoint whose whole
 * purpose is to be loaded inside a frame on our own page. The browser refuses
 * it and reports "refused to connect" naming our own host, which reads like the
 * site being down rather than a header working correctly. */
test('the ad preview relaxes framing to self, and nothing else does', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

  const route = source.slice(source.indexOf("app.get('/creatives/:adId/preview'"));
  const body = route.slice(0, route.indexOf('\napp.'));

  assert.match(body, /X-Frame-Options', 'SAMEORIGIN'/, 'the preview must be framable by our own page');
  assert.match(body, /frame-ancestors 'self'/);

  /* And the default stays shut for everything else. */
  assert.match(hardening.headers({})['X-Frame-Options'], /DENY/);
  assert.match(hardening.headers({})['Content-Security-Policy'], /frame-ancestors 'none'/);
});
