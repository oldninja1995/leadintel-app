/* Full Funnel Analytics — the judgements that would be easy to get quietly
 * wrong: spend multiplied by a join, a reservation counted twice, an absent
 * figure printed as zero, and a funnel that widens.
 */

const test = require('node:test');
const assert = require('node:assert');

const funnel = require('../lib/funnel-analytics');

const R = (rupees) => rupees * 100;

const day = (over = {}) => ({
  entity: 'campaignDay', campaign: 'summer', label: 'Summer', platform: 'meta_ads',
  date: '2026-09-01', spend: R(1000), impressions: 10000, clicks: 200, leads: 10, ...over,
});
const lead = (id, over = {}) => ({
  entity: 'lead', id, createdAt: '2026-09-01T10:00:00Z', channel: 'meta',
  campaign: 'summer', stage: 'Fresh', repeat: false, customer: `phone:${id}#0`, ...over,
});
const deal = (id, leadId, over = {}) => ({
  entity: 'deal', id, leadId, outcome: 'won', bookingStatus: 'confirmed', channel: 'meta', repeat: false,
  revenue: R(5000), bookingRef: null, updatedAt: '2026-09-20T00:00:00Z', ...over,
});

test('spend is summed from campaign days alone, never once per lead', () => {
  const leads = Array.from({ length: 7 }, (_, i) => lead(`l${i}`));
  const out = funnel.analyse({ leads, deals: [], campaignDays: [day(), day({ date: '2026-09-02' })] }, { channel: 'meta' });
  assert.strictEqual(out.summary.spend, R(2000));
  const summer = out.campaigns.find((c) => c.key === 'summer');
  assert.strictEqual(summer.spend, R(2000));
  assert.strictEqual(summer.leads, 7);
  assert.strictEqual(out.summary.cpl, R(2000) / 7);
});

test('two deals on one reservation are one booking and one revenue', () => {
  const deals = [
    deal('d1', 'l1', { bookingRef: 'BK-9', revenue: R(5000) }),
    deal('d2', 'l1', { bookingRef: 'BK-9', revenue: R(5000) }),
  ];
  const out = funnel.analyse({ leads: [lead('l1', { stage: 'Won' })], deals, campaignDays: [day()] }, { channel: 'meta' });
  assert.strictEqual(out.summary.bookings, 1);
  assert.strictEqual(out.summary.revenue, R(5000));
  assert.strictEqual(out.summary.roas, 5);
});

test('cancelled and lost deals are not bookings', () => {
  const deals = [
    deal('d1', 'l1', { bookingStatus: 'Cancelled' }),
    deal('d2', 'l2', { outcome: 'lost' }),
  ];
  const out = funnel.analyse({ leads: [lead('l1'), lead('l2')], deals, campaignDays: [] }, { channel: 'meta' });
  assert.strictEqual(out.summary.bookings, 0);
  assert.strictEqual(out.summary.revenue, 0);
});

test('organic has no ad side: null, not zero, and no ROAS', () => {
  const leads = [lead('o1', { channel: 'website', campaign: null }), lead('o2', { channel: null, campaign: null })];
  const out = funnel.analyse({ leads, deals: [deal('d1', 'o1', { channel: 'website' })], campaignDays: [day()] }, { channel: 'organic' });
  assert.strictEqual(out.summary.spend, null);
  assert.strictEqual(out.summary.impressions, null);
  assert.strictEqual(out.summary.roas, null);
  assert.strictEqual(out.summary.leads, 2);
  assert.strictEqual(out.summary.revenue, R(5000));
  assert.strictEqual(out.stages.find((s) => s.key === 'impressions').n, null);
  /* The first measured stage is the top of the funnel. */
  assert.strictEqual(out.stages.find((s) => s.key === 'leads').fromTop, 1);
});

test('channels split leads and spend the same way', () => {
  const leads = [lead('m1'), lead('g1', { channel: 'google', campaign: 'brand' }), lead('o1', { channel: 'referral' })];
  const days = [day(), day({ platform: 'google_ads', campaign: 'brand', spend: R(300) })];
  const meta = funnel.analyse({ leads, deals: [], campaignDays: days }, { channel: 'meta' });
  const google = funnel.analyse({ leads, deals: [], campaignDays: days }, { channel: 'google' });
  const paid = funnel.analyse({ leads, deals: [], campaignDays: days }, { channel: 'paid' });
  assert.deepStrictEqual([meta.summary.leads, google.summary.leads, paid.summary.leads], [1, 1, 2]);
  assert.deepStrictEqual([meta.summary.spend, google.summary.spend, paid.summary.spend], [R(1000), R(300), R(1300)]);
});

test('stages are cumulative, so the funnel never widens', () => {
  /* Straight from Fresh to booked: still contacted, interested and qualified. */
  const out = funnel.analyse({ leads: [lead('l1', { stage: 'Fresh' }), lead('l2', { stage: 'Ringing no answer' })], deals: [deal('d1', 'l1')], campaignDays: [] }, { channel: 'meta' });
  const n = Object.fromEntries(out.stages.map((s) => [s.key, s.n]));
  assert.deepStrictEqual([n.leads, n.contacted, n.interested, n.qualified, n.booked], [2, 2, 1, 1, 1]);
  const ladder = out.stages.filter((s) => s.n != null).map((s) => s.n);
  for (let i = 1; i < ladder.length; i += 1) {
    if (out.stages.filter((s) => s.n != null)[i].side === 'crm' && out.stages.filter((s) => s.n != null)[i - 1].side === 'crm') {
      assert.ok(ladder[i] <= ladder[i - 1], 'a CRM stage is never larger than the one before');
    }
  }
});

test('NC ROAS counts only first-time customers', () => {
  const leads = [lead('n1', { stage: 'Won' }), lead('r1', { stage: 'Won', repeat: true })];
  const out = funnel.analyse({ leads, deals: [deal('d1', 'n1'), deal('d2', 'r1', { repeat: true })], campaignDays: [day()] }, { channel: 'meta' });
  assert.strictEqual(out.summary.roas, 10);
  assert.strictEqual(out.summary.ncRoas, 5);
});

test('leads bucket by arrival, bookings by when they closed; weeks start on Monday', () => {
  assert.strictEqual(funnel.bucketOf('2026-09-06T23:00:00Z', 'week'), '2026-08-31');
  assert.strictEqual(funnel.bucketOf('2026-09-07', 'week'), '2026-09-07');
  assert.strictEqual(funnel.bucketOf('2026-09-07', 'month'), '2026-09');
  const leads = [lead('a', { createdAt: '2026-09-01T00:00:00Z' }), lead('b', { createdAt: '2026-10-02T00:00:00Z' })];
  /* The September lead's deal closed in October: it is October's booking. */
  const out = funnel.analyse({ leads, deals: [deal('d1', 'a', { updatedAt: '2026-10-05T00:00:00Z' })], campaignDays: [] }, { channel: 'meta', grain: 'month' });
  assert.deepStrictEqual(out.periods.map((p) => [p.key, p.leads, p.bookings]), [['2026-09', 1, 0], ['2026-10', 1, 1]]);
});

test('a booking from a lead that arrived before the range still counts in it', () => {
  /* Only the range's leads are passed; the deal closed in the range belongs to
     a July lead. It is this range's booking and revenue, and the drill-down
     still names the lead. */
  const july = lead('j1', { createdAt: '2026-07-04T00:00:00Z', name: 'Jampani' });
  const out = funnel.analyse({ leads: [lead('l1')], deals: [deal('d1', 'j1', { revenue: R(45000) })], allLeads: [july, lead('l1')], campaignDays: [] }, { channel: 'meta', stage: 'booked' });
  assert.strictEqual(out.summary.leads, 1);
  assert.strictEqual(out.summary.bookings, 1);
  assert.strictEqual(out.summary.revenue, R(45000));
  assert.strictEqual(out.drill.rows[0].name, 'Jampani');
  assert.strictEqual(funnel.analyse({ deals: [deal('d1', 'j1')] }, { channel: 'google' }).summary.bookings, 0, 'placed on its lead’s channel');
});

test('a CRM campaign no ad platform reported is kept and flagged', () => {
  const out = funnel.analyse({ leads: [lead('l1', { campaign: 'old-name' })], deals: [], campaignDays: [day()] }, { channel: 'meta' });
  const orphan = out.campaigns.find((c) => c.key === 'old-name');
  assert.strictEqual(orphan.matched, false);
  assert.strictEqual(orphan.spend, null);
  assert.strictEqual(out.unmatchedLeads, 1);
});

test('a paid lead with no campaign is counted apart from a mismatch', () => {
  const out = funnel.analyse({ leads: [lead('l1', { campaign: null }), lead('l2', { campaign: 'old-name' })], deals: [], campaignDays: [day()] }, { channel: 'meta' });
  assert.strictEqual(out.uncampaignedLeads, 1);
  assert.strictEqual(out.unmatchedLeads, 1);
});

test('drill-down returns the leads at a stage', () => {
  const out = funnel.analyse({ leads: [lead('l1', { stage: 'Qualified' }), lead('l2')], deals: [], campaignDays: [] }, { channel: 'meta', stage: 'qualified' });
  assert.strictEqual(out.drill.total, 1);
  assert.strictEqual(out.drill.rows[0].id, 'l1');
});

test('this CRM\'s own statuses: Not interested is not interested, Hot is qualified', () => {
  const r = (stage) => funnel.reach({ stage }, false);
  assert.deepStrictEqual(r('Not interested'), { contacted: true, interested: false, qualified: false, booked: false });
  assert.deepStrictEqual(r('Ringing no answer'), { contacted: true, interested: false, qualified: false, booked: false });
  assert.deepStrictEqual(r('Interested'), { contacted: true, interested: true, qualified: false, booked: false });
  assert.deepStrictEqual(r('Hot'), { contacted: true, interested: true, qualified: true, booked: false });
  assert.deepStrictEqual(r('Won/Converted'), { contacted: true, interested: true, qualified: true, booked: false });
  assert.deepStrictEqual(r('Fresh'), { contacted: false, interested: false, qualified: false, booked: false });
});

test('a period with no spend has no cost per lead, rather than a free one', () => {
  const out = funnel.analyse({ leads: [lead('l1')], deals: [], campaignDays: [] }, { channel: 'meta' });
  assert.strictEqual(out.summary.spend, 0);
  assert.strictEqual(out.summary.cpl, null);
  assert.strictEqual(out.summary.roas, null);
});

test('the shared INTERESTED rule every screen reads does not count a no as a yes', () => {
  const { INTERESTED } = require('../lib/metrics/registry');
  for (const no of ['Not interested', 'Not Interested', 'not-interested', 'Uninterested', 'No interest']) {
    assert.strictEqual(INTERESTED.test(no), false, no);
  }
  for (const yes of ['Interested', 'Hot', 'Won/Converted', 'Qualified', 'Booked']) {
    assert.strictEqual(INTERESTED.test(yes), true, yes);
  }
});

test('Google Ads purchases are read from Purchase-category actions only, kept apart from CRM bookings', () => {
  const conv = (action, category, over = {}) => ({ entity: 'googleConversion', date: '2026-09-01', action, category, conversions: 0, conversionValue: 0, allConversions: 0, allConversionValue: 0, ...over });
  const googleConversions = [
    conv('Booking complete', 'PURCHASE', { allConversions: 3, allConversionValue: 45000 }),
    conv('Confirm Booking', 'BEGIN_CHECKOUT', { allConversions: 9, allConversionValue: 0 }),
  ];
  const out = funnel.analyse({ leads: [], deals: [], campaignDays: [], googleConversions }, { channel: 'google' });
  assert.deepStrictEqual(out.googlePurchases, { count: 3, value: R(45000), actions: ['Booking complete'] });
  assert.strictEqual(out.summary.bookings, 0, 'never folded into CRM bookings');

  const none = funnel.analyse({ googleConversions: [googleConversions[1]] }, { channel: 'google' });
  assert.deepStrictEqual(none.googlePurchases.actions, [], 'no purchase action reads as untracked, not zero sales');
  assert.strictEqual(funnel.analyse({ googleConversions }, { channel: 'meta' }).googlePurchases, null);
});

test('a booking is dated by when it was first won, not the lead’s last edit', () => {
  const [b] = funnel.bookingsByLead([deal('d1', 'l1', { updatedAt: '2026-10-09T00:00:00Z', closedAt: '2026-03-20T00:00:00Z' })]).get('l1');
  assert.strictEqual(b.at, '2026-03-20T00:00:00Z');
  const canonical = require('../lib/ingest/canonical');
  const { deals } = canonical.build([{ source: 'telecrm', kind: 'deal', externalId: 'x', body: { deal_id: 'x', lead_id: 'x', outcome: 'won', updated_at: '2026-10-09T00:00:00Z', first_won_at: '2026-03-20T00:00:00Z', value: 100, currency: 'INR' } }]);
  assert.strictEqual(deals[0].closedAt, '2026-03-20T00:00:00.000Z');
});
