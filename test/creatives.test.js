/* Creative Intelligence, from Meta's ads.
 *
 * The screen shows nineteen fields per row and Meta supports seven of them. So
 * most of what is worth testing here is the *declining*: a projection that
 * quietly filled the other twelve would produce a screen that looks complete
 * and is partly invented, which is the one outcome this driver exists to avoid.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS } = require('../lib/repository/projections');
const canonical = require('../lib/ingest/canonical');

const creatives = PROJECTIONS.creatives;

const entitiesWith = (rows) => ({ creatives: rows });

const CREATIVE = {
  entity: 'creative', id: '99201', adId: '99201', title: 'UGC video 03',
  platform: 'meta', spend: 126000, impressions: 1000, clicks: 34, days: 7,
};

test('a measured creative reports its real spend and click-through rate', () => {
  const [row] = creatives(entitiesWith([CREATIVE]));

  assert.equal(row.title, 'UGC video 03');
  assert.equal(row.platform, 'Meta');
  assert.equal(row.spend, '₹1,260');
  assert.equal(row.ctr, '3.40%');
});

/* The distinction the whole driver turns on. */
test('a creative nothing measured declines rather than reporting zero', () => {
  const [row] = creatives(entitiesWith([
    { ...CREATIVE, spend: null, impressions: null, clicks: null, days: 0 },
  ]));

  assert.equal(row.spend, '—', 'an unmeasured ad did not spend nothing');
  assert.equal(row.ctr, '—');
});

test('the fields Meta cannot support are declined, never filled', () => {
  const [row] = creatives(entitiesWith([CREATIVE]));

  for (const field of ['type', 'dur', 'hook', 'hookRate', 'bookings', 'rev', 'roas', 'fatigue', 'winning']) {
    assert.equal(row[field], '—', `${field} must be declined, not invented`);
  }
});

/* Revenue per creative needs ad-level identity resolution joined to PMS
   bookings, and the PMS is still on fixtures — crediting real ads with fixture
   revenue would invent a return nobody earned. */
test('roas is declined rather than computed against fixture revenue', () => {
  const [row] = creatives(entitiesWith([CREATIVE]));
  assert.equal(row.roas, '—');
  assert.equal(row.rev, '—');
});

test('rows are ranked by spend, with unmeasured ones last', () => {
  const rows = creatives(entitiesWith([
    { ...CREATIVE, adId: 'a', title: 'small', spend: 100 },
    { ...CREATIVE, adId: 'b', title: 'none', spend: null },
    { ...CREATIVE, adId: 'c', title: 'big', spend: 900 },
  ]));

  assert.deepEqual(rows.map((r) => r.title), ['big', 'small', 'none']);
});

test('a creative with no name falls back to its ad id rather than blank', () => {
  const [row] = creatives(entitiesWith([{ ...CREATIVE, title: null }]));
  assert.equal(row.title, '99201');
});

test('no creatives at all is an empty screen, not a crash', () => {
  assert.deepEqual(creatives({}), []);
  assert.deepEqual(creatives({ creatives: [] }), []);
});

/* ── the canonical join ─────────────────────────────────────────────────── */

/* Identity comes from the ads edge and measurement from ad-level insights, as
   two kinds describing one thing. If the join breaks, every creative silently
   reports no spend — which looks like a quiet account rather than a bug. */
test('canonical joins a creative to the ad-level insights that measure it', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: '99201',
      body: { id: '99201', name: 'UGC video 03', status: 'ACTIVE', creative: { id: 'CR-9021' } },
    },
    {
      source: 'meta_ads',
      kind: 'ad_day',
      externalId: '99201:2026-07-14',
      body: {
        ad_id: '99201', ad_name: 'UGC video 03', date_start: '2026-07-14',
        account_currency: 'INR', spend: '700', impressions: '1000', clicks: '34',
      },
    },
    {
      source: 'meta_ads',
      kind: 'ad_day',
      externalId: '99201:2026-07-15',
      body: {
        ad_id: '99201', ad_name: 'UGC video 03', date_start: '2026-07-15',
        account_currency: 'INR', spend: '300', impressions: '500', clicks: '16',
      },
    },
  ]);

  assert.equal(entities.creatives.length, 1);
  const [c] = entities.creatives;

  assert.equal(c.adId, '99201');
  assert.equal(c.creativeId, 'CR-9021', 'the creative link must survive');
  /* ₹700 + ₹300 = ₹1,000 = 100000 paise, summed across both days. */
  assert.equal(c.spend, 100000);
  assert.equal(c.impressions, 1500);
  assert.equal(c.days, 2);
});

test('a creative with no insight rows keeps its identity and reports null spend', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: '99999',
      body: { id: '99999', name: 'never ran', status: 'PAUSED', creative: { id: 'CR-1' } },
    },
  ]);

  const [c] = entities.creatives;
  assert.equal(c.title, 'Never Ran');
  assert.equal(c.spend, null, 'no measurement is not a measurement of zero');
  assert.equal(c.days, 0);
});

/* The fixtures must stay clean — a field the request never asked for is absent,
   not malformed, and must not consume the problem channel. */
test('a creative missing optional fields raises no normalisation problem', () => {
  const entities = canonical.build([
    {
      source: 'meta_ads',
      kind: 'creative',
      externalId: 'CR-9021',
      body: { creative_id: 'CR-9021', ad_id: '99201', title: 'x', type: 'video', updated_at: '2026-07-14T09:12:00+00:00' },
    },
  ]);

  assert.deepEqual(entities.problems, []);
});
