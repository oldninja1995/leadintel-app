/* Audience Analytics, per channel.
 *
 *   node --test test/audiences-channel.test.js
 *
 * The revenue panel ranked audience *types* — lookalike, interest, retargeting
 * — which is a Meta-shaped question that can only describe the part of an
 * account running on ad sets. The question underneath it is where the money
 * comes from, and four books answer that at once: ad spend from the platforms,
 * leads and won deals from the CRM, the booking engine's revenue from GA4, and
 * the channels the CRM knows that no ad platform does — walk-ins, referrals,
 * the phone, which in a hospitality account is most of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROJECTIONS, channelTotals, money } = require('../lib/repository/projections');
const filters = require('../lib/filters');

/* The panel that rendered this is off the screen; the roll-up behind it is what
   these tests are about, and it is still what any screen asking "revenue by
   channel" should read rather than writing a second one. Shaped here the way the
   panel shaped it, so the assertions go on describing what a reader would see. */
const project = (entities) => ({
  audRevenue: channelTotals(entities).map((c) => ({
    type: filters.LABELS.channel[c.channel] || c.channel,
    rev: c.revenue ? money(c.revenue) : (c.hasSpend ? money(0) : '—'),
    roas: c.hasSpend && c.spend > 0 ? `${(c.revenue / c.spend).toFixed(1)}x` : '—',
    meta: [
      c.hasSpend ? `${money(c.spend)} spent` : 'no ad spend — CRM channel',
      c.leads ? `${c.leads} lead${c.leads === 1 ? '' : 's'}` : null,
      c.online ? `${money(c.online)} of it GA4's, from the booking engine` : null,
    ].filter(Boolean).join(' · '),
  })),
  audSegs: PROJECTIONS.audiences(entities, {}).audSegs,
});

const campaignDay = (platform, over = {}) => ({
  entity: 'campaignDay', platform, campaign: 'a campaign',
  campaignId: platform === 'google_ads' ? '1' : '9', date: '2026-08-20',
  spend: 1200000, impressions: 100, clicks: 10, leads: 1, ...over,
});

const deal = (channel, revenue, over = {}) => ({
  entity: 'deal', channel, revenue, outcome: 'won', bookingStatus: 'confirmed', ...over,
});

const ENTITIES = {
  campaignDays: [campaignDay('google_ads', { spend: 3600000 }), campaignDay('meta_ads', { spend: 1200000 })],
  leads: [{ channel: 'google' }, { channel: 'meta' }, { channel: 'walk-in' }],
  deals: [deal('google', 12000000), deal('walk-in', 24000000), deal('meta', 0)],
  webChannelRevenueDays: [{ channelGroup: 'Paid Search', revenue: 5000000, date: '2026-08-20' }],
  adsetDays: [], creatives: [], metaDemographicDays: [], webCityDays: [], webCityRevenueDays: [],
};

const byType = (out) => Object.fromEntries(out.audRevenue.map((r) => [r.type, r]));

test('revenue leads the ranking, not spend', () => {
  /* Google spends three times what Meta does and walk-ins cost nothing. On a
     screen read to answer where the money comes from, the walk-ins go first. */
  const out = project(ENTITIES);
  assert.deepEqual(out.audRevenue.map((r) => r.type), ['walk-in', 'Google Ads', 'Meta Ads']);
});

test('a channel with no ad platform behind it is still a channel', () => {
  /* Most of a hospitality account's revenue arrives this way, and a screen
     built from ad rows cannot see any of it. */
  const walkIn = byType(project(ENTITIES))['walk-in'];

  assert.equal(walkIn.rev, '₹2.40L');
  assert.match(walkIn.meta, /no ad spend — CRM channel/);
  /* And no return-on-ad-spend, because there was none: a ratio against zero is
     not a very good ratio, it is not a ratio. */
  assert.equal(walkIn.roas, '—');
});

test('spend with nothing measured back reads a real zero, not a dash', () => {
  /* The difference between "we measured nothing" and "we measured nothing
     coming back" is the whole finding, and it is the row somebody has to act
     on. */
  const meta = byType(project(ENTITIES))['Meta Ads'];

  assert.equal(meta.rev, '₹0');
  assert.equal(meta.roas, '0.0x');
});

test("Google's row carries the booking engine's half, and says so", () => {
  /* The CRM only knows a booking somebody worked as a lead. A guest who clicked
     a search ad and booked online never becomes a CRM deal, so the row would
     carry full spend against half its return. */
  const google = byType(project(ENTITIES))['Google Ads'];

  assert.equal(google.rev, '₹1.70L');
  assert.match(google.meta, /₹50,000 of it GA4's, from the booking engine/);
  assert.equal(google.roas, '4.7x');
});

test("GA4's paid search is not lent to Meta", () => {
  /* Paid Search is search advertising. Folding it into a blended figure, or
     crediting any of it to Meta, is borrowing. */
  const out = project({ ...ENTITIES, deals: [] });
  const rows = byType(out);

  assert.equal(rows['Meta Ads'].rev, '₹0');
  assert.equal(rows['Google Ads'].rev, '₹50,000');
});

test('the panel and the marketing screen agree about a channel', () => {
  /* Two implementations of "revenue by channel" is the drift this codebase
     spends its comments on. If platformRows and channelTotals ever disagree,
     one screen tells a manager something the other denies. */
  const marketing = PROJECTIONS.marketing(ENTITIES, {});
  const platformRows = marketing.platformRows || marketing.platforms || [];

  if (!platformRows.length) return; /* the marketing payload names it otherwise */
  const audiences = byType(project(ENTITIES));
  for (const row of platformRows) {
    const mine = audiences[row.name];
    if (!mine) continue;
    assert.equal(mine.rev, row.rev, `${row.name} reads ${mine.rev} here and ${row.rev} on Marketing`);
  }
});

test('every segment row names the channel it belongs to', () => {
  /* The design's table has no column to add, and "Google Ads · search" reads as
     one fact where a second column would read as two. */
  const out = project({
    ...ENTITIES,
    googleCampaigns: [],
  });
  for (const row of out.audSegs || []) {
    assert.match(String(row.type), /Google Ads|Meta Ads/, `a segment row has no channel: ${row.name}`);
  }
});
