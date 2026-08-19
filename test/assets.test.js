/* Asset URLs, and why every one of them has to carry a fingerprint.
 *
 *   node --test test/assets.test.js
 *
 * `/assets/*` is served `public, max-age=31536000, immutable` (vercel.json).
 * That is safe for exactly one reason: the URL changes when the file does,
 * because `app.locals.asset` appends a hash of the contents. A reference that
 * skips the helper is a URL that never changes — and a browser told to keep it
 * for a year will do so, which is how a deploy ships a fix that the person
 * looking at the page does not receive.
 *
 * It had already happened once with a flat one-hour max-age, which is what
 * introduced the fingerprint. A year is the same bug with three more digits,
 * so this is a test rather than a comment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', 'views');
const ASSETS = path.join(__dirname, '..', 'public', 'assets');

function templates(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return templates(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

test('no template links an asset by a URL that cannot change', () => {
  const offenders = [];

  for (const file of templates(VIEWS)) {
    const body = fs.readFileSync(file, 'utf8');
    /* A bare `/assets/…` in an attribute. The helper's output is built at
       render time from `asset('name')`, so it never appears as a literal. */
    for (const m of body.matchAll(/(?:src|href)\s*=\s*["']\/assets\/([^"']+)["']/g)) {
      offenders.push(`${path.relative(VIEWS, file)} -> /assets/${m[1]}`);
    }
  }

  assert.deepEqual(offenders, [], `these are cached for a year under a URL that will not change:\n  ${offenders.join('\n  ')}`);
});

test('every asset the templates ask for exists', () => {
  /* The helper answers '0' for a missing file rather than throwing, so a typo
     produces a URL that 404s and a page with no styling — quietly. */
  const missing = [];

  for (const file of templates(VIEWS)) {
    const body = fs.readFileSync(file, 'utf8');
    for (const m of body.matchAll(/asset\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!fs.existsSync(path.join(ASSETS, m[1]))) missing.push(`${path.relative(VIEWS, file)} -> ${m[1]}`);
    }
  }

  assert.deepEqual(missing, [], `referenced but not in public/assets:\n  ${missing.join('\n  ')}`);
});
