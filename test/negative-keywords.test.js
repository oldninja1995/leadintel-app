/* Negative keyword suggestions — the mistakes that would cost money: blocking
 * a campaign's own keyword, blocking a word that converts, and re-suggesting a
 * term that is already handled.
 */

const test = require('node:test');
const assert = require('node:assert');

const neg = require('../lib/negative-keywords');

const R = (rupees) => rupees * 100;
const row = (term, over = {}) => ({
  term, campaignId: 'c1', termStatus: 'NONE', spend: R(100), clicks: 3, impressions: 40, leads: 0, ...over,
});
const name = (id) => ({ c1: 'Resort Search', c2: 'Brand' }[id] || null);

test('a term that spent and never converted is an exact negative in its own campaign', () => {
  const out = neg.suggest({ rows: [row('free resort jobs'), row('free resort jobs', { spend: R(50) })], campaignName: name });
  const c = out[0];
  assert.strictEqual(c.campaign, 'Resort Search');
  const exact = c.suggestions.find((s) => s.match === 'exact');
  assert.strictEqual(exact.keyword, 'free resort jobs');
  assert.strictEqual(exact.spend, R(150));
});

test('a term that converted is never suggested, nor are its words', () => {
  const rows = [row('resort booking', { leads: 1 }), row('resort jobs'), row('resort jobs kerala')];
  const s = neg.suggest({ rows, campaignName: name })[0].suggestions;
  assert.ok(!s.some((x) => x.keyword === 'resort booking'));
  assert.ok(!s.some((x) => x.match === 'phrase' && x.keyword === 'resort'), 'resort is in a converting term');
  assert.ok(s.some((x) => x.match === 'phrase' && x.keyword === 'jobs'), 'jobs wasted twice and never converted');
});

test('a word in the campaign\'s own keywords is never a phrase negative', () => {
  const rows = [row('cheap resort salary'), row('cheap resort vacancy')];
  const keywords = [{ campaignId: 'c1', keyword: 'cheap resort' }];
  const s = neg.suggest({ rows, keywords, campaignName: name })[0].suggestions;
  assert.ok(!s.some((x) => x.match === 'phrase' && (x.keyword === 'cheap' || x.keyword === 'resort')));
});

test('a term matching a keyword exactly is not negated', () => {
  const rows = [row('cheap resort')];
  const keywords = [{ campaignId: 'c1', keyword: '[cheap resort]' }];
  assert.deepStrictEqual(neg.suggest({ rows, keywords, campaignName: name }), []);
});

test('terms Google reports as already added or excluded are left out', () => {
  const rows = [row('resort jobs', { termStatus: 'EXCLUDED' }), row('resort spa', { termStatus: 'ADDED' })];
  assert.deepStrictEqual(neg.suggest({ rows, campaignName: name }), []);
});

test('campaigns are judged separately', () => {
  const rows = [row('villa jobs', { campaignId: 'c2' }), row('villa jobs', { campaignId: 'c1', leads: 2 })];
  const out = neg.suggest({ rows, campaignName: name });
  assert.deepStrictEqual(out.map((c) => c.campaign), ['Brand']);
});

test('the threshold drops small waste', () => {
  const rows = [row('a big waste', { spend: R(900) }), row('tiny one', { spend: R(20) })];
  const s = neg.suggest({ rows, campaignName: name, minSpend: R(100) })[0].suggestions;
  assert.deepStrictEqual(s.filter((x) => x.match === 'exact').map((x) => x.keyword), ['a big waste']);
});

test('the CSV is a Google Ads Editor import of campaign-level negatives', () => {
  const csv = neg.toCsv([{ campaign: 'Resort, Search', suggestions: [
    { keyword: 'free jobs', match: 'exact' }, { keyword: 'salary', match: 'phrase' },
  ] }]);
  assert.strictEqual(csv,
    'Campaign,Ad group,Keyword,Criterion Type\r\n'
    + '"Resort, Search",,free jobs,Negative exact\r\n'
    + '"Resort, Search",,salary,Negative phrase\r\n');
});
