/* Campaign Analytics must not serve invented data.
 *
 * The screen was authored from the design with a complete set of plausible
 * figures: named guests with check-in dates and revenue, keywords with quality
 * scores, an AI note explaining a CPL fall that never happened. Under the
 * ingested driver only `campRows` was replaced, so five genuinely ingested
 * campaigns sat above four invented ad sets and five invented reservations with
 * nothing on the screen to say which was which.
 *
 * The rule these tests hold: under the ingested driver, a collection is either
 * derived from ingested records or it is empty. There is no third state where
 * a number is shown because it looked right in the design.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS, NONE } = require('../lib/repository/projections');

const campaigns = PROJECTIONS.campaigns;

const entities = () => ({
  campaignDays: [
    { campaign: 'munnar honeymoon jul', label: 'Munnar Honeymoon', platform: 'meta_ads', date: '2026-08-01', spend: 1000, impressions: 5000, clicks: 100, leads: 10 },
  ],
  leads: [{ id: 'l-1', campaign: 'munnar honeymoon jul' }],
  bookings: [{ leadId: 'l-1', checkIn: '2026-08-09', revenue: 42800 }],
  payments: [],
});

/* The authored payload, in the shape data/campaigns.js supplies it. */
const authored = () => ({
  campRows: [{ name: 'invented campaign' }],
  adsetRows: [{ name: 'HM · Lookalike 1%', spend: '₹0.92L' }],
  adRows: [{ name: 'UGC video 03' }],
  kwRows: [{ kw: 'munnar resort honeymoon', qs: '9' }],
  searchTerms: [{ term: 'munnar resort with private pool', n: '412' }],
  resRows: [{ guest: 'Ananya & Rohit Sharma', rev: '₹42,800' }],
  dRooms: [{ name: 'Honeymoon suite', rev: '₹4.20L' }],
  dPkgs: [{ name: 'Honeymoon 3N/4D', rev: '₹5.10L' }],
  dFunnel: [{ label: 'Impressions', n: '9.8L' }],
  dAi: [{ title: 'CPL fell 22% without losing volume' }],
  dMkt: [{ metric: 'ads.spend', label: 'Spend', value: '₹2.10L', delta: '+8.2%', deltaColor: 'var(--c-up)' }],
  dBiz: [{ metric: 'leads.count', label: 'Leads', value: '604', delta: '+18.4%', deltaColor: 'var(--c-up)' }],
  dRevStats: [{ label: 'Gross revenue', value: '₹12.50L' }],
  /* Structure, which is the design's and must survive. */
  campTabs: [{ label: 'Campaigns' }],
  dTabs: [{ label: 'Overview' }],
});

/* ── the invented collections ───────────────────────────────────────────── */

test('every collection with no ingested source comes back empty', () => {
  const out = campaigns(entities(), {}, authored());
  for (const key of ['adsetRows', 'adRows', 'kwRows', 'searchTerms', 'resRows', 'dRooms', 'dPkgs', 'dFunnel', 'dAi']) {
    assert.deepEqual(out[key], [], `${key} should be emptied`);
  }
});

/* The specific fabrications that were being served, named so a regression is
   recognisable rather than merely a failing count. */
test('the invented guest, keyword and insight are gone', () => {
  const out = campaigns(entities(), {}, authored());
  const text = JSON.stringify(out);
  assert.ok(!text.includes('Ananya'), 'a named guest was still being served');
  assert.ok(!text.includes('munnar resort honeymoon'), 'an invented keyword was still being served');
  assert.ok(!text.includes('CPL fell 22%'), 'an invented insight was still being served');
});

/* ── the KPI cards, which keep their row and lose their figure ──────────── */

test('a KPI card keeps its label and metric but loses the authored value', () => {
  const [card] = campaigns(entities(), {}, authored()).dMkt;
  assert.equal(card.label, 'Spend');
  assert.equal(card.metric, 'ads.spend');
  assert.equal(card.value, NONE);
});

/* The registry fills these a moment later; an authored delta beside a real
   value would attach a change to a number that never changed that way. */
test('an authored delta is dropped with the value it described', () => {
  const [card] = campaigns(entities(), {}, authored()).dBiz;
  assert.equal(card.delta, NONE);
});

test('a card that never had a delta does not gain one', () => {
  const [card] = campaigns(entities(), {}, authored()).dRevStats;
  assert.equal(card.value, NONE);
  assert.ok(!('delta' in card), 'a field the view does not read should not appear');
});

/* ── what must survive ──────────────────────────────────────────────────── */

test('the real campaign rows are still derived and still real', () => {
  const { campRows } = campaigns(entities(), {}, authored());
  assert.equal(campRows.length, 1);
  assert.equal(campRows[0].name, 'Munnar Honeymoon');
  assert.equal(campRows[0].impr, '5,000');
});

/* Tabs are the design's structure, not a claim about anybody's data. */
test('structure is left alone', () => {
  const out = campaigns(entities(), {}, authored());
  assert.equal(out.campTabs, undefined, 'the projection should not touch tabs at all');
  assert.equal(out.dTabs, undefined);
});

/* A screen whose authored payload never carried a collection must not have one
   invented for it by the declining itself. */
test('declining does not invent keys the screen never had', () => {
  const out = campaigns(entities(), {}, { campRows: [] });
  assert.ok(!('kwRows' in out), 'kwRows was not on this payload and should not appear');
  assert.ok(!('dMkt' in out));
});

/* The CRM's campaign label drifts from Meta's name; the ad id does not. On
   2026-10-13 five of eight Meta bookings carried "tofu conv broad", a label
   Meta never reported, and the screen showed 3. */
test('a booking is placed by the ad that produced it, not only by the CRM label', () => {
  const e = {
    campaignDays: [
      { campaign: 'tofu conversation', campaignId: 'C1', label: 'Tofu Conversation', platform: 'meta_ads', date: '2026-10-09', spend: 1000, impressions: 5000, clicks: 100, leads: 10 },
      { campaign: 'mofu conversion', campaignId: 'C2', label: 'Mofu Conversion', platform: 'meta_ads', date: '2026-10-09', spend: 500, impressions: 2000, clicks: 40, leads: 4 },
    ],
    creatives: [
      { adId: 'A103', title: 'Ad 103', campaignId: 'C1' },
      { adId: 'A7', title: 'Shared name', campaignId: 'C1' },
      { adId: 'A8', title: 'Shared name', campaignId: 'C2' },
    ],
    adsetDays: [{ adsetId: 'S7', campaignId: 'C1', date: '2026-10-09' }],
    leads: [
      { id: 'l-1', campaign: 'tofu conv broad', adId: 'A103' },
      { id: 'l-2', campaign: 'tofu conversation', adId: null },
      { id: 'l-3', campaign: 'tofu conv broad', adId: 'A999' },
      /* What this CRM actually sends: the ad set id, no ad id. */
      { id: 'l-4', campaign: 'tofu conv broad', adId: null, adsetId: 'S7' },
      /* A landing-page lead: the UTM ad name and no id. */
      { id: 'l-5', campaign: 'tofu conv broad', adName: 'Ad 103' },
      { id: 'l-6', campaign: 'tofu conv broad', adName: 'Shared name' },
    ],
    deals: [
      { leadId: 'l-1', outcome: 'won', revenue: 1600000 },
      { leadId: 'l-2', outcome: 'won', revenue: 1000000, campaign: 'tofu conversation' },
      { leadId: 'l-3', outcome: 'won', revenue: 500000, campaign: 'tofu conv broad' },
      { leadId: 'l-4', outcome: 'won', revenue: 1300000, campaign: 'tofu conv broad' },
      { leadId: 'l-5', outcome: 'won', revenue: 1000000, campaign: 'tofu conv broad' },
      { leadId: 'l-6', outcome: 'won', revenue: 1000000, campaign: 'tofu conv broad' },
    ],
    bookings: [],
    payments: [],
  };
  const { campRows } = campaigns(e, {}, authored());
  const tofu = campRows.find((r) => r.name === 'Tofu Conversation');
  assert.equal(tofu.bookings, '4', 'by ad, ad set, unique ad name and label — each deal once; an ambiguous name and an unknown ad keep their own label');
});
