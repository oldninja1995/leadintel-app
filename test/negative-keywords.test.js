/* Negative keyword suggestions — relevance to the campaign is the only rule.
 * The mistakes that would cost money: negating a term related to the
 * campaign's keywords, letting performance decide, and re-suggesting a term
 * that is already handled.
 */

const test = require('node:test');
const assert = require('node:assert');

const neg = require('../lib/negative-keywords');

const R = (rupees) => rupees * 100;
const row = (term, over = {}) => ({
  term, campaignId: 'c1', termStatus: 'NONE', spend: R(100), clicks: 3, impressions: 40, leads: 0, ...over,
});
const KW = [{ campaignId: 'c1', keyword: 'kerala resort' }, { campaignId: 'c1', keyword: '[munnar resort booking]' }];
const name = (id) => ({ c1: 'Resort Search', c2: 'Brand' }[id] || null);
const run = (rows, keywords = KW) => neg.suggest({ rows, keywords, campaignName: name });

test('a term sharing no word with the campaign\'s keywords is an exact negative', () => {
  const s = run([row('used car loan')])[0].suggestions;
  assert.deepStrictEqual(s.map((x) => [x.keyword, x.match]), [['used car loan', 'exact']]);
});

test('a related term is never negated, however badly it performed', () => {
  assert.deepStrictEqual(run([row('resorts near me', { spend: R(5000), leads: 0 })]), [], 'plural and filler are still related');
  assert.deepStrictEqual(run([row('kerala honeymoon')]), []);
});

test('an unrelated term is negated even if it converted — performance does not decide', () => {
  const s = run([row('car rental', { leads: 2 })])[0].suggestions;
  assert.ok(s.some((x) => x.keyword === 'car rental'));
});

test('a word in two unrelated terms and no related one is a phrase negative', () => {
  const s = run([row('car rental'), row('car service'), row('resort car parking')])[0].suggestions;
  assert.ok(!s.some((x) => x.match === 'phrase' && x.keyword === 'car'), 'car also appears in a related term');
  const s2 = run([row('bike rental'), row('bike service')])[0].suggestions;
  assert.ok(s2.some((x) => x.match === 'phrase' && x.keyword === 'bike'));
});

test('terms Google reports as already added or excluded are left out', () => {
  assert.deepStrictEqual(run([row('car loan', { termStatus: 'EXCLUDED' }), row('bike loan', { termStatus: 'ADDED' })]), []);
});

test('a campaign with no keywords to compare is reported, not guessed', () => {
  const out = run([row('anything at all', { campaignId: 'c2' })]);
  assert.deepStrictEqual(out, []);
  assert.deepStrictEqual(out.unjudged.map((c) => c.campaign), ['Brand']);
});

test('campaigns are judged against their own keywords', () => {
  const keywords = [...KW, { campaignId: 'c2', keyword: 'car rental' }];
  const out = run([row('car rental', { campaignId: 'c2' }), row('car rental')], keywords);
  assert.deepStrictEqual(out.map((c) => c.campaign), ['Resort Search']);
});

test('the CSV is a Google Ads Editor import of campaign-level negatives', () => {
  const csv = neg.toCsv([{ campaign: 'Resort, Search', suggestions: [
    { keyword: 'car loan', match: 'exact' }, { keyword: 'bike', match: 'phrase' },
  ] }]);
  assert.strictEqual(csv,
    'Campaign,Ad group,Keyword,Criterion Type\r\n'
    + '"Resort, Search",,car loan,Negative exact\r\n'
    + '"Resort, Search",,bike,Negative phrase\r\n');
});
