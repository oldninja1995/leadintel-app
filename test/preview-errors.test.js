/* The preview frame must never fail silently.
 *
 * `/creatives/:adId/preview` had six failure paths and every one was
 * `res.status(404).end()` — an empty body, and none of them carrying the
 * `X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'self'` relaxation that the
 * success path needs. So the browser refused to render the error response too,
 * and the drawer showed an identical blank box whether the credential was
 * missing, the ad had aged out of the store, Meta had refused, or Meta could
 * not be reached. Unfalsifiable from the screen: "the preview is not working"
 * was the most anybody could say about it, including the person reporting it.
 *
 * This is a source-level guard, like the literal-bindings one: it holds the
 * *class* of the bug rather than any single instance, because the failure is
 * invisible at runtime and a new early return is exactly how it would come
 * back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/* The route body, from its handler to the next route declared after it. */
function routeSource(pattern) {
  const start = SERVER.indexOf(pattern);
  assert.notEqual(start, -1, `${pattern} should still exist`);
  const next = SERVER.indexOf('\napp.', start + pattern.length);
  return SERVER.slice(start, next === -1 ? SERVER.length : next);
}

const preview = () => routeSource("app.get('/creatives/:adId/preview'");

test('no failure path in the preview route ends with an empty body', () => {
  const silent = preview().match(/res\.status\(\d{3}\)\.end\(\)/g) || [];
  assert.deepEqual(silent, [], 'an empty response renders as a blank frame and says nothing');
});

test('every failure in the preview route explains itself', () => {
  /* One explanation per early return, so a new branch cannot borrow another
     branch's wording. */
  const returns = (preview().match(/return previewProblem\(/g) || []).length;
  assert.ok(returns >= 6, `expected the six failure paths to be explained, found ${returns}`);
});

/* The explanation is useless if the browser will not display it. This is the
   exact header pair the success path sets, and the reason the old empty 404s
   were invisible rather than merely terse. */
test('the explanation carries the framing headers it needs to be seen', () => {
  const helper = SERVER.slice(SERVER.indexOf('function previewProblem'), SERVER.indexOf('app.get(\'/creatives/:adId/preview\''));
  assert.match(helper, /X-Frame-Options['"]?,\s*['"]SAMEORIGIN/);
  assert.match(helper, /frame-ancestors 'self'/);
  /* A stale explanation is worse than none — the reasons change per request. */
  assert.match(helper, /no-store/);
});

/* Meta's own wording is the useful half of a refusal — "(#100) Missing
   permission" names the fix, "preview unavailable" does not. */
test('Meta’s own message is passed through when it gives one', () => {
  assert.match(preview(), /error_user_msg/);
});

/* Interpolating a vendor message into HTML is how an error page becomes an
   injection. */
test('the explanation escapes what it is given', () => {
  assert.match(SERVER, /const escapeHtml = \(s\) =>/);
  const helper = SERVER.slice(SERVER.indexOf('function previewProblem'), SERVER.indexOf('app.get(\'/creatives/:adId/preview\''));
  const interpolations = helper.match(/\+ (escapeHtml\()?(what|fix)\b/g) || [];
  assert.ok(interpolations.length >= 2, 'both fields should reach the page');
  for (const one of interpolations) {
    assert.match(one, /escapeHtml\(/, `"${one}" reaches the page unescaped`);
  }
});
