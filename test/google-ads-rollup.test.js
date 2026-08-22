/* Rolling Google's daily grains up to one row each.
 *
 *   node --test test/google-ads-rollup.test.js
 *
 * This is the arithmetic behind every figure on both Google screens, and it had
 * no test at all while it lived as a closure inside server.js. The bug that
 * moved it out is the one in the first block: a row carries measures *and*
 * descriptions, and the two want opposite treatment — measures sum over the
 * range, descriptions are only true as of a day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { rollUp, rate, orderAccountKeywords } = require('../lib/google-ads-rollup');

/* Paise in, the app's own format out — enough to tell null from formatted. */
const money = (paise) => `₹${Math.round(paise / 100)}`;

const term = (date, termStatus, spend, extra = {}) => ({
  date, term: 'kfdc munnar', termStatus, spend, impressions: 100, clicks: 10, leads: 0, ...extra,
});

/* ── descriptions come from the last day ──────────────────────────────────── */

test('a status that changed within the range reports the state it ended in', () => {
  /* Deliberately out of order, and with the stale row first: write order is
     what the map used to take, and write order is roughly oldest-first. */
  const rows = [
    term('2026-08-01', 'none', 10000),
    term('2026-08-19', 'excluded', 20000),
    term('2026-08-10', 'none', 30000),
  ];
  const [row] = rollUp(rows, (r) => r.term, (r) => ({ term: r.term, termStatus: r.termStatus }), money);

  assert.equal(row.termStatus, 'excluded', 'the negative keyword added on the 19th is not reflected');
  /* And the measures still cover the whole range, which is the half that must
     not change: a description from one day, a total from all of them. */
  assert.equal(row.spend, 60000);
  assert.equal(row.impressions, 300);
  assert.equal(row.clicks, 30);
});

test('the newest day wins however the rows are ordered', () => {
  const shape = (r) => ({ termStatus: r.termStatus });
  const newestFirst = [term('2026-08-19', 'excluded', 1), term('2026-08-01', 'none', 1)];
  const newestLast = [term('2026-08-01', 'none', 1), term('2026-08-19', 'excluded', 1)];

  assert.equal(rollUp(newestFirst, (r) => r.term, shape, money)[0].termStatus, 'excluded');
  assert.equal(rollUp(newestLast, (r) => r.term, shape, money)[0].termStatus, 'excluded');
});

test('an undated row takes the slot if it is first and yields to any dated one', () => {
  const shape = (r) => ({ qualityScore: r.qualityScore });
  const rows = [
    { date: null, term: 'k', qualityScore: 1, spend: 100, impressions: 1, clicks: 1, leads: 0 },
    { date: '2026-08-05', term: 'k', qualityScore: 7, spend: 100, impressions: 1, clicks: 1, leads: 0 },
  ];
  assert.equal(rollUp(rows, (r) => r.term, shape, money)[0].qualityScore, 7);

  /* And with nothing dated at all, the first is as good an answer as exists. */
  const undated = rows.map((r) => ({ ...r, date: null, qualityScore: r.qualityScore }));
  assert.equal(rollUp(undated, (r) => r.term, shape, money)[0].qualityScore, 1);
});

test('the bookkeeping field the loop needs does not reach the screen', () => {
  const [row] = rollUp([term('2026-08-01', 'none', 100)], (r) => r.term, (r) => ({ termStatus: r.termStatus }), money);
  assert.ok(!('describedAt' in row), 'which day supplied a status is not a claim any column makes');
});

/* ── measures ─────────────────────────────────────────────────────────────── */

test('null is unknown rather than zero, and a row of nulls is not "spent nothing"', () => {
  const rows = [
    { date: '2026-08-01', term: 'k', spend: null, impressions: null, clicks: null, leads: null },
    { date: '2026-08-02', term: 'k', spend: null, impressions: null, clicks: null, leads: null },
  ];
  const [row] = rollUp(rows, (r) => r.term, (r) => ({ term: r.term }), money);
  assert.equal(row.measured, false);
  assert.equal(row.spendText, null, 'an unmeasured term must show a dash, not ₹0');
});

test('one measured day among unmeasured ones is enough to report a figure', () => {
  const rows = [
    { date: '2026-08-01', term: 'k', spend: null, impressions: null, clicks: null, leads: null },
    { date: '2026-08-02', term: 'k', spend: 4200, impressions: 10, clicks: 2, leads: 1 },
  ];
  const [row] = rollUp(rows, (r) => r.term, (r) => ({ term: r.term }), money);
  assert.equal(row.measured, true);
  assert.equal(row.spend, 4200);
  assert.equal(row.spendText, '₹42');
});

test('a cost per something with no denominator is unknown, never infinite', () => {
  const rows = [{ date: '2026-08-01', term: 'k', spend: 71100, impressions: 84, clicks: 0, leads: 0 }];
  const [row] = rollUp(rows, (r) => r.term, (r) => ({ term: r.term }), money);
  assert.equal(row.cplText, null, 'spent money, converted nobody — that is not an infinite price');
  assert.equal(row.cpcText, null);
  assert.equal(row.convRate, null);
  assert.equal(row.ctr, '0.00%', 'it was shown 84 times and clicked 0 — that rate is real');
});

test('rows are keyed by what the caller says, and a null key is dropped', () => {
  const rows = [
    { date: '2026-08-01', term: 'a', spend: 100, impressions: 1, clicks: 1, leads: 0 },
    { date: '2026-08-01', term: null, spend: 900, impressions: 1, clicks: 1, leads: 0 },
    { date: '2026-08-02', term: 'a', spend: 100, impressions: 1, clicks: 1, leads: 0 },
  ];
  const out = rollUp(rows, (r) => r.term, (r) => ({ term: r.term }), money);
  assert.equal(out.length, 1);
  assert.equal(out[0].spend, 200);
});

test('the heaviest spender comes first, because that is the order both screens read in', () => {
  const rows = [
    { date: '2026-08-01', term: 'cheap', spend: 100, impressions: 1, clicks: 1, leads: 0 },
    { date: '2026-08-01', term: 'dear', spend: 900, impressions: 1, clicks: 1, leads: 0 },
  ];
  assert.deepEqual(rollUp(rows, (r) => r.term, (r) => ({ term: r.term }), money).map((r) => r.term), ['dear', 'cheap']);
});

test('no rows is an empty table rather than a throw', () => {
  assert.deepEqual(rollUp(null, (r) => r.term, (r) => ({}), money), []);
  assert.deepEqual(rollUp([], (r) => r.term, (r) => ({}), money), []);
});

/* ── rate ─────────────────────────────────────────────────────────────────── */

test('a rate with no denominator is null, and one with a zero numerator is not', () => {
  assert.equal(rate(0, 84), '0.00%');
  assert.equal(rate(21, 84), '25.00%');
  assert.equal(rate(5, 0), null);
  assert.equal(rate(0, 0), null);
});

/* ── ordering the account's keyword list ──────────────────────────────────
 *
 * The list the picker on the keyword screen renders is not a rollUp: it is the
 * account's criterion list, mostly rows with no figures at all. 220 keywords of
 * which six had delivery is the case these are written against, and the trap is
 * that the other 214 are unknown rather than zero.
 */

const kw = (keyword, spend) => (spend === null
  ? { keyword, measured: false, spend: null }
  : { keyword, measured: true, spend });

test('by default the list is alphabetical, which is the order it is scanned in', () => {
  const out = orderAccountKeywords([kw('zephyr resort', 900), kw('alleppey stay', null), kw('munnar resort', 100)]);
  assert.deepEqual(out.map((k) => k.keyword), ['alleppey stay', 'munnar resort', 'zephyr resort']);
});

test('ranked by spend, the highest spender leads', () => {
  const out = orderAccountKeywords([kw('b', 100), kw('a', 900), kw('c', 500)], 'spend');
  assert.deepEqual(out.map((k) => k.keyword), ['a', 'c', 'b']);
});

test('a keyword with no reported delivery ranks below every keyword that spent', () => {
  /* The bug this is written against would be sorting a dash as a zero: a
     keyword Google did not report did not spend nothing, and putting it level
     with a keyword that genuinely spent nothing states something the data does
     not say. Below the ranking, in its own order, is the only honest place. */
  const out = orderAccountKeywords([kw('quiet a', null), kw('spent 1', 1), kw('quiet b', null), kw('spent 900', 900)], 'spend');
  assert.deepEqual(out.map((k) => k.keyword), ['spent 900', 'spent 1', 'quiet a', 'quiet b']);
});

test('the unmeasured tail keeps the alphabetical order it is scanned in', () => {
  const out = orderAccountKeywords([kw('zeta', null), kw('alpha', null), kw('mid', null)], 'spend');
  assert.deepEqual(out.map((k) => k.keyword), ['alpha', 'mid', 'zeta']);
});

test('an equal spend breaks the tie by name rather than by input order', () => {
  const out = orderAccountKeywords([kw('beta', 500), kw('alpha', 500)], 'spend');
  assert.deepEqual(out.map((k) => k.keyword), ['alpha', 'beta']);
});

test('ordering returns a new array — the picker holds the same rows', () => {
  /* The selected campaign is rendered from a copy for exactly this reason: one
     reader asking for spend must not reorder the object every other campaign's
     counts are read from. */
  const list = [kw('b', 100), kw('a', 900)];
  const out = orderAccountKeywords(list, 'spend');
  assert.notEqual(out, list);
  assert.deepEqual(list.map((k) => k.keyword), ['b', 'a']);
});

test('an unknown order is the default one, not an error', () => {
  const out = orderAccountKeywords([kw('b', 900), kw('a', 100)], 'clicks');
  assert.deepEqual(out.map((k) => k.keyword), ['a', 'b']);
  assert.deepEqual(orderAccountKeywords(null, 'spend'), []);
});
